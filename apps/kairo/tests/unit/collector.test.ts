import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCollector, type Collector } from '../../src/modules/private-chat-core/collector.js';
import type {
  CollectedBatch,
  CollectorStore,
} from '../../src/modules/private-chat-core/collector-types.js';
import type { ContextService } from '../../src/modules/private-chat-core/context-service.js';
import type { RawMessage } from '../../src/modules/private-chat-core/types.js';
import type { SendService } from '../../src/modules/im-transport/send-service.js';
import type { SendDispatch } from '../../src/modules/im-transport/send-policy.js';
import type { TaskStore } from '../../src/modules/task-lifecycle/types.js';

const START = 1800000000000;
const batching = { quietMs: 5000, maxWaitMs: 60000, maxMessages: 10, maxChars: 30000 };
const collectors: Collector[] = [];
const context = {
  botId: 'bot',
  employeeId: '3585',
  sessionId: '0-3585',
  threadId: 'thread',
  version: 1,
  createdAt: START,
  idleSince: null,
  invalidatedAt: null,
};
const raw: RawMessage & { employeeId: string } = {
  sessionId: context.sessionId,
  messageId: 'message',
  direction: 'inbound',
  observedAt: START,
  text: '采购订单',
  messageType: 'text',
  attachments: {},
  employeeId: context.employeeId,
  processingResult: 'accepted',
};
const input = { status: 'accepted' as const, botId: context.botId, message: raw };
const delivered: SendDispatch = {
  intentKey: '提示',
  taskId: null,
  purpose: 'notice:input_attachment',
  sessionId: context.sessionId,
  contentDigest: '摘要',
  operationId: 'operation',
  status: 'delivered',
  sendCalls: 1,
  queryUsed: false,
  queryDueAt: null,
  resultAt: START,
  messageId: '回复',
  revision: 1,
};

function fixture(overrides: Partial<CollectedBatch> = {}, settings = batching) {
  const batch: CollectedBatch = {
    ...context,
    batchId: 'batch',
    firstObservedAt: START,
    quietDeadline: START + 5000,
    maxDeadline: START + 60000,
    status: 'collecting',
    finishedAt: null,
    rejection: null,
    settledAt: null,
    ...overrides,
  };
  let valid = true;
  const store = {
    collectMessage: vi.fn(() => Promise.resolve([batch])),
    finishBatch: vi.fn<CollectorStore['finishBatch']>(() => {
      if (!valid || batch.status === 'discarded') return Promise.resolve(null);
      if (
        batch.status === 'collecting' &&
        Date.now() >= Math.min(batch.quietDeadline, batch.maxDeadline)
      ) {
        batch.status = 'ready';
        batch.finishedAt = Math.min(batch.quietDeadline, batch.maxDeadline);
      }
      return Promise.resolve({ ...batch });
    }),
    getBatchMessages: vi.fn(() => Promise.resolve([raw])),
    listPendingBatches: vi.fn(() =>
      Promise.resolve(valid && batch.settledAt === null ? [{ ...batch }] : [])
    ),
    settleBatch: vi.fn((_id: string, at: number) => {
      batch.settledAt = at;
      return Promise.resolve();
    }),
  } satisfies CollectorStore;
  const contexts: ContextService = {
    resolve: vi.fn((_scope, reset) => {
      if (reset) {
        valid = false;
        batch.status = 'discarded';
      }
      return Promise.resolve({
        context: reset ? { ...context, threadId: 'new-thread', version: 2 } : context,
        invalidatedThreadId: reset ? context.threadId : null,
        hadUnfinishedWork: reset,
      });
    }),
    registerExecution: vi.fn(),
  };
  const tasks = { createTask: vi.fn<TaskStore['createTask']>().mockResolvedValue(null) };
  const sender = {
    send: vi.fn(() => Promise.resolve(delivered)),
    recover: vi.fn(() => Promise.resolve(delivered)),
  } satisfies Pick<SendService, 'send' | 'recover'>;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const collector = createCollector({
    botId: 'bot',
    store,
    contexts,
    tasks,
    sender,
    batching: settings,
    configDigest: '摘要',
    queueMs: 600000,
    logger,
  });
  collectors.push(collector);
  return { collector, batch, store, tasks, sender, contexts, logger };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});
afterEach(async () => {
  try {
    await Promise.all(collectors.splice(0).map(collector => collector.close()));
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});

describe('聚合器定时与交付', () => {
  it('短静默五秒才建任务，每条普通消息更新截止', async () => {
    const f = fixture();
    await f.collector.accept(input);
    await vi.advanceTimersByTimeAsync(4000);
    f.batch.quietDeadline = START + 9000;
    await f.collector.accept({
      ...input,
      message: { ...raw, messageId: '第二条', observedAt: Date.now() },
    });
    await vi.advanceTimersByTimeAsync(4999);
    expect(f.tasks.createTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.collector.settled();
    expect(f.tasks.createTask).toHaveBeenCalledOnce();
    expect(f.tasks.createTask.mock.calls[0]?.[0]).toMatchObject({
      batchId: 'batch',
      now: START + 9000,
      queueDeadline: START + 609000,
    });
  });
  it('已有静默参数设为十秒时，七条连续消息在第六十秒由最长截止提交', async () => {
    const f = fixture({ quietDeadline: START + 10000 }, { ...batching, quietMs: 10000 });
    await f.collector.accept(input);
    for (let time = 9000; time < 60000; time += 9000) {
      await vi.advanceTimersByTimeAsync(9000);
      f.batch.quietDeadline = Date.now() + 10000;
      await f.collector.accept({
        ...input,
        message: { ...raw, messageId: String(time), observedAt: Date.now() },
      });
    }
    await vi.advanceTimersByTimeAsync(5999);
    expect(f.tasks.createTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await f.collector.settled();
    expect(f.tasks.createTask).toHaveBeenCalledOnce();
    expect(f.batch.finishedAt).toBe(START + 60000);
  });
  it('纯空白和非accepted结果既不接入也不刷新原计时', async () => {
    const f = fixture();
    await f.collector.accept(input);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await f.collector.accept({ ...input, message: { ...raw, text: ' \n\t' } })).toEqual({
      status: 'empty',
    });
    for (const status of [
      'duplicate',
      'outbound',
      'unknown',
      'not_allowed',
      'identity_failed',
      'unsupported_session',
    ] as const) {
      expect(await f.collector.accept({ status })).toEqual({ status });
    }
    expect(f.store.collectMessage).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.tasks.createTask).toHaveBeenCalledOnce();
  });
  it('/new被现有控制流程消费，迟到计时器不复活旧批', async () => {
    const f = fixture();
    await f.collector.accept(input);
    const result = await f.collector.accept({
      ...input,
      message: { ...raw, messageId: '命令', text: '/new' },
    });
    expect(result.status).toBe('new_context');
    await vi.advanceTimersByTimeAsync(60000);
    await f.collector.recover();
    expect(f.tasks.createTask).not.toHaveBeenCalled();
    expect(f.store.collectMessage).toHaveBeenCalledOnce();
    expect(f.sender.send).toHaveBeenCalledOnce();
  });
  it('拒绝批次只通过T21提示，不创建任务', async () => {
    const f = fixture({ status: 'rejected', rejection: 'attachment', finishedAt: START });
    await f.collector.accept(input);
    expect(f.tasks.createTask).not.toHaveBeenCalled();
    expect(f.sender.send).toHaveBeenCalledWith({
      subject: {
        kind: 'event',
        botId: 'bot',
        sessionId: '0-3585',
        messageId: 'message',
        threadId: 'thread',
      },
      purpose: 'notice:input_attachment',
      text: '当前暂不支持文件处理，请先使用文字描述需求',
    });
    expect(f.batch.settledAt).toBe(START);
  });
  it.each([
    { name: '静默剩余', at: 3000, quiet: 5000, max: 60000, wait: 2000 },
    { name: '最长剩余', at: 58000, quiet: 63000, max: 60000, wait: 2000 },
  ])('恢复$name只等待持久截止剩余时间', async ({ at, quiet, max, wait }) => {
    vi.setSystemTime(START + at);
    const f = fixture({ quietDeadline: START + quiet, maxDeadline: START + max });
    await Promise.all([f.collector.recover(), f.collector.recover()]);
    await vi.advanceTimersByTimeAsync(wait - 1);
    expect(f.tasks.createTask).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.tasks.createTask).toHaveBeenCalledOnce();
    await f.collector.recover();
    expect(f.tasks.createTask).toHaveBeenCalledOnce();
  });
  it('全部到期恢复立即结束，任务期限仍来自原截止', async () => {
    vi.setSystemTime(START + 90000);
    const f = fixture();
    await f.collector.recover();
    expect(f.tasks.createTask).toHaveBeenCalledOnce();
    expect(f.tasks.createTask.mock.calls[0]?.[0]).toMatchObject({
      now: START + 5000,
      queueDeadline: START + 605000,
    });
  });
  it('拒绝收尾未完成时恢复原提示，完成后重复恢复不补发', async () => {
    const f = fixture({ status: 'rejected', rejection: 'too_long', finishedAt: START });
    await Promise.all([f.collector.recover(), f.collector.recover()]);
    await f.collector.recover();
    expect(f.sender.recover).toHaveBeenCalledOnce();
    expect(f.sender.send).not.toHaveBeenCalled();
    expect(f.tasks.createTask).not.toHaveBeenCalled();
  });
  it.each(['成功', '失败'] as const)('前序收尾%s后，同批附件拒绝仍独立完成', async outcome => {
    const f = fixture();
    let release!: (value: CollectedBatch) => void;
    let entered!: () => void;
    const predecessorError = new Error('前序收尾失败');
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    f.store.finishBatch.mockImplementationOnce(() => {
      entered();
      return new Promise<CollectedBatch>((resolve, reject) => {
        release = value => (outcome === '失败' ? reject(predecessorError) : resolve(value));
      });
    });
    const first = f.collector.accept(input).catch((error: unknown) => error);
    await started;
    const snapshot = { ...f.batch };
    f.batch.status = 'rejected';
    f.batch.rejection = 'attachment';
    f.batch.finishedAt = START;
    let appended!: () => void;
    const appendedSignal = new Promise<void>(resolve => {
      appended = resolve;
    });
    f.store.collectMessage.mockImplementationOnce(() => {
      appended();
      return Promise.resolve([f.batch]);
    });
    const second = f.collector.accept({
      ...input,
      message: { ...raw, messageId: '附件', messageType: 'file' },
    });
    await appendedSignal;
    await Promise.resolve();
    release(snapshot);
    const [firstResult] = await Promise.all([first, second]);
    if (outcome === '失败') expect(firstResult).toBe(predecessorError);
    else expect(firstResult).toMatchObject({ status: 'collected' });
    expect(f.sender.send).toHaveBeenCalledOnce();
    expect(f.tasks.createTask).not.toHaveBeenCalled();
  });
  it('计时器数据库错误可由settled观察，不静默丢失', async () => {
    const f = fixture();
    const error = new Error('数据库不可用');
    await f.collector.accept(input);
    f.store.finishBatch.mockRejectedValueOnce(error);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(f.collector.settled()).rejects.toThrow('数据库不可用');
    expect(f.logger.error).toHaveBeenCalled();
    expect(f.tasks.createTask).not.toHaveBeenCalled();
  });
  it('批量恢复一批先失败，close仍等待另一批在途工作并保留全部错误', async () => {
    const f = fixture({ status: 'ready', finishedAt: START });
    const second = { ...f.batch, batchId: '第二批' };
    f.store.listPendingBatches.mockResolvedValue([f.batch, second]);
    f.store.finishBatch.mockImplementation(batchId =>
      Promise.resolve(batchId === second.batchId ? second : f.batch)
    );
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const firstError = new Error('第一批错误');
    const secondError = new Error('第二批错误');
    f.tasks.createTask.mockImplementation(async input => {
      if (input.batchId === f.batch.batchId) throw firstError;
      entered();
      await held;
      throw secondError;
    });
    const recovery = f.collector.recover().catch((error: unknown) => error);
    await started;
    await vi.advanceTimersByTimeAsync(0);
    let closed = false;
    const closing = f.collector.close().then(() => {
      closed = true;
    });
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(closed).toBe(false);
    } finally {
      release();
      await closing;
    }
    const error = await recovery;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([firstError, secondError]);
  });
  it('关闭清除本实例定时器，原批次留给新实例恢复', async () => {
    const f = fixture();
    await f.collector.accept(input);
    await f.collector.close();
    await vi.advanceTimersByTimeAsync(60000);
    expect(f.tasks.createTask).not.toHaveBeenCalled();
    expect(f.batch.status).toBe('collecting');
    await expect(f.collector.accept(input)).rejects.toThrow();
    await expect(f.collector.recover()).rejects.toThrow();
  });
});
