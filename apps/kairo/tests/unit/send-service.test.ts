import {
  FakeKK9Driver,
  InMemorySendOperationStore,
  type FakeSendBehavior,
  type SendOperationStore,
  type SendResult,
  type SendStatus,
} from '@kairo/driver';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import {
  createSendIntent,
  isDispatchTerminal,
  type DispatchUpdate,
  type SendDispatch,
  type SendDispatchStore,
  type SendIntent,
  type SendRequest,
} from '../../src/modules/im-transport/send-policy.js';
import { createSendService } from '../../src/modules/im-transport/send-service.js';
import { AppError, getFailureMessage } from '../../src/modules/operability/errors.js';
import type { AppLogger } from '../../src/modules/operability/logger.js';
import type {
  ChatContext,
  PrivateChatStore,
  RawMessage,
} from '../../src/modules/private-chat-core/types.js';
import {
  TASK_TRANSITIONS,
  type Task,
  type TaskOutputScope,
  type TaskStore,
  type TransitionTaskInput,
} from '../../src/modules/task-lifecycle/types.js';

// Vitest 的全局假时钟不接管 Node promises 定时器；只替换计时边界，保留取消语义。
// 普通 Node 烟测另行实等三十秒验证原生定时器，不将本替身当作运行时证据。
vi.mock('node:timers/promises', () => ({
  setTimeout: (milliseconds: number, value: unknown, options: { signal: AbortSignal }) =>
    new Promise((resolve, reject) => {
      const cancel = (): void => {
        clearTimeout(timer);
        reject(new DOMException('等待已取消', 'AbortError'));
      };
      const timer = setTimeout(() => {
        options.signal.removeEventListener('abort', cancel);
        resolve(value);
      }, milliseconds);
      options.signal.addEventListener('abort', cancel, { once: true });
      if (options.signal.aborted) cancel();
    }),
}));
const START = 1_800_000_000_000;
const services: { close(): void }[] = [];
let eventSequence = 0;

class MemoryDispatches implements SendDispatchStore {
  readonly records = new Map<string, SendDispatch>();

  ensure(intent: SendIntent): Promise<SendDispatch> {
    return Promise.resolve().then(() => {
      const existing = [...this.records.values()].find(row => row.intentKey === intent.intentKey);
      if (existing) {
        if (
          existing.contentDigest !== intent.contentDigest ||
          existing.sessionId !== intent.sessionId ||
          existing.taskId !== intent.taskId ||
          existing.purpose !== intent.purpose
        ) {
          throw new Error('发送意图冲突');
        }
        return { ...existing };
      }
      const row: SendDispatch = {
        ...intent,
        operationId: `测试发送-${this.records.size + 1}`,
        status: 'prepared',
        sendCalls: 0,
        queryUsed: false,
        queryDueAt: null,
        resultAt: null,
        messageId: null,
        revision: 0,
      };
      this.records.set(row.operationId, row);
      return { ...row };
    });
  }

  get(operationId: string): Promise<SendDispatch | null> {
    const row = this.records.get(operationId);
    return Promise.resolve(row ? { ...row } : null);
  }

  compareAndSet(
    operationId: string,
    revision: number,
    update: DispatchUpdate
  ): Promise<SendDispatch | null> {
    const row = this.records.get(operationId);
    if (!row || row.revision !== revision || isDispatchTerminal(row.status))
      return Promise.resolve(null);
    const next = { ...row, ...update, revision: revision + 1 };
    this.records.set(operationId, next);
    return Promise.resolve({ ...next });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

function observation(status: SendStatus, operationId?: string): SendResult {
  return {
    success: status === 'delivered',
    status,
    operationId,
    isPreTrigger: status === 'failed',
    ...(status === 'delivered' ? { messageId: '已送达消息' } : {}),
  };
}

function behavior(status: SendStatus): FakeSendBehavior {
  if (status === 'delivered') return { mode: 'success', messageId: '已送达消息' };
  if (status === 'failed') return { mode: 'pre_trigger_failure', error: '触发前明确失败' };
  return { mode: 'post_trigger_timeout', error: '触发后未确认' };
}

function fixture(sendStatuses: SendStatus[] = ['delivered'], queryStatus: SendStatus = 'unknown') {
  const dispatches = new MemoryDispatches();
  const driverStore = new InMemorySendOperationStore();
  const state: {
    task: Task;
    context: ChatContext;
    transitionHook?: (input: TransitionTaskInput) => void;
    taskOutputHook?: () => void | Promise<void>;
    contextOutputHook?: () => void | Promise<void>;
    outputCommitHook?: () => void | Promise<void>;
  } = {
    task: {
      taskId: '任务一',
      batchId: '批次一',
      threadId: '上下文一',
      inputVersion: 1,
      employeeId: '员工一',
      botId: '机器人一',
      sessionId: '0-1001',
      configDigest: '配置摘要',
      status: 'ready_to_send',
      createdAt: START - 100,
      updatedAt: START - 10,
      queueDeadline: START + 10_000,
      executionStartedAt: START - 50,
      executionDeadline: START + 60_000,
      currentAttemptId: '执行一',
      endedAt: null,
    },
    context: {
      threadId: '上下文一',
      employeeId: '员工一',
      botId: '机器人一',
      sessionId: '0-1001',
      version: 1,
      createdAt: START - 100,
      invalidatedAt: null,
      idleSince: null,
    },
  };
  const request: SendRequest = {
    subject: { kind: 'task', taskId: state.task.taskId, inputVersion: 1 },
    purpose: 'final',
    text: '业务回答正文',
  };
  const tasks: Pick<TaskStore, 'getTask' | 'transitionTask' | 'withTaskOutput'> = {
    getTask: vi.fn(taskId =>
      Promise.resolve(taskId === state.task.taskId ? { ...state.task } : null)
    ),
    withTaskOutput: async <T>(input: TaskOutputScope, output: (task: Task) => T) => {
      await state.taskOutputHook?.();
      const task = state.task;
      const context = state.context;
      if (
        task.taskId !== input.taskId ||
        task.inputVersion !== input.inputVersion ||
        task.threadId !== context.threadId ||
        task.employeeId !== context.employeeId ||
        task.botId !== context.botId ||
        task.sessionId !== context.sessionId ||
        context.invalidatedAt !== null ||
        (input.contextVersion !== undefined && input.contextVersion !== context.version) ||
        (input.attemptId !== undefined && input.attemptId !== task.currentAttemptId)
      )
        return null;
      const value = output({ ...task });
      await state.outputCommitHook?.();
      return { value };
    },
    transitionTask: vi.fn((input: TransitionTaskInput) => {
      const allowed: readonly string[] = TASK_TRANSITIONS[state.task.status];
      if (
        input.taskId !== state.task.taskId ||
        input.inputVersion !== state.task.inputVersion ||
        input.from !== state.task.status ||
        !allowed.includes(input.to)
      )
        return Promise.resolve(false);
      state.transitionHook?.(input);
      state.task = { ...state.task, status: input.to, updatedAt: input.now };
      if (TASK_TRANSITIONS[input.to].length === 0) {
        state.task.endedAt = input.now;
        if (state.context.invalidatedAt === null)
          state.context.idleSince = Math.max(
            state.context.idleSince ?? -Infinity,
            input.idleSince ?? input.now
          );
      }
      return Promise.resolve(true);
    }),
  };
  const raw: RawMessage = {
    sessionId: state.task.sessionId,
    messageId: '原始消息一',
    direction: 'inbound',
    observedAt: START - 100,
    text: '员工问题',
    messageType: null,
    attachments: {},
    employeeId: state.task.employeeId,
    processingResult: null,
  };
  const contexts: Pick<PrivateChatStore, 'getContext' | 'getRawMessage' | 'withContextOutput'> = {
    getContext: vi.fn(threadId =>
      Promise.resolve(threadId === state.context.threadId ? { ...state.context } : null)
    ),
    withContextOutput: async <T>(threadId: string, output: (context: ChatContext) => T) => {
      await state.contextOutputHook?.();
      if (state.context.threadId !== threadId || state.context.invalidatedAt !== null) return null;
      const value = output({ ...state.context });
      await state.outputCommitHook?.();
      return { value };
    },
    getRawMessage: vi.fn(key =>
      Promise.resolve(
        key.sessionId === raw.sessionId && key.messageId === raw.messageId ? { ...raw } : null
      )
    ),
  };
  const logger: AppLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const drivers: FakeKK9Driver[] = [];
  const sends: MockInstance<FakeKK9Driver['sendText']>[] = [];
  const queries: MockInstance<FakeKK9Driver['getSendStatus']>[] = [];
  function open(
    options: {
      behaviors?: FakeSendBehavior[];
      query?: (operationId: string, store: SendOperationStore) => Promise<SendResult>;
    } = {}
  ) {
    let fake!: FakeKK9Driver;
    const service = createSendService({
      dispatches,
      driverStore,
      tasks,
      contexts,
      logger,
      createDriver: store => {
        fake = new FakeKK9Driver(store);
        fake.setSendBehavior({
          mode: 'sequence',
          behaviors: options.behaviors ?? sendStatuses.map(behavior),
        });
        sends.push(vi.spyOn(fake, 'sendText'));
        queries.push(
          vi.spyOn(fake, 'getSendStatus').mockImplementation(async operationId => {
            if (options.query) return options.query(operationId, store);
            const result = observation(queryStatus, operationId);
            // 查询边界同步观测结果，保留真实 Driver Store 对同 ID 重试的约束。
            await store.update(operationId, {
              status: queryStatus,
              isPreTrigger: queryStatus === 'failed',
              messageId: result.messageId,
            });
            return result;
          })
        );
        drivers.push(fake);
        return fake;
      },
    });
    services.push(service);
    return { service, fake };
  }
  async function seed(update: Partial<DispatchUpdate>) {
    const row = await dispatches.ensure(createSendIntent(request, state.task.sessionId));
    return (await dispatches.compareAndSet(row.operationId, row.revision, { ...row, ...update }))!;
  }
  return {
    state,
    request,
    dispatches,
    driverStore,
    tasks,
    contexts,
    logger,
    drivers,
    sends,
    queries,
    open,
    seed,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  for (const service of services.splice(0)) service.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('统一出站协调器结果树', () => {
  const branches: {
    path: string;
    sends: SendStatus[];
    query?: SendStatus;
    final: SendDispatch['status'];
  }[] = [
    { path: 'D', sends: ['delivered'], final: 'delivered' },
    { path: 'F-D', sends: ['failed', 'delivered'], final: 'delivered' },
    { path: 'F-F', sends: ['failed', 'failed'], final: 'failed' },
    { path: 'F-U-D', sends: ['failed', 'unknown'], query: 'delivered', final: 'delivered' },
    { path: 'F-U-F', sends: ['failed', 'unknown'], query: 'failed', final: 'failed' },
    { path: 'F-U-U', sends: ['failed', 'unknown'], query: 'unknown', final: 'send_unconfirmed' },
    { path: 'U-D', sends: ['unknown'], query: 'delivered', final: 'delivered' },
    { path: 'U-U', sends: ['unknown'], query: 'unknown', final: 'send_unconfirmed' },
    { path: 'U-F-D', sends: ['unknown', 'delivered'], query: 'failed', final: 'delivered' },
    { path: 'U-F-F', sends: ['unknown', 'failed'], query: 'failed', final: 'failed' },
    { path: 'U-F-U', sends: ['unknown', 'unknown'], query: 'failed', final: 'send_unconfirmed' },
  ];

  it.each(branches)('$path 遵守整条意图的发送和查询预算', async branch => {
    const f = fixture(branch.sends, branch.query);
    const { service, fake } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    if (branch.query) {
      await vi.advanceTimersByTimeAsync(29_999);
      expect(f.queries[0]).not.toHaveBeenCalled();
      expect(f.state.task.status).toBe('sending');
      await vi.advanceTimersByTimeAsync(1);
    }
    const result = await pending;
    expect(result.status).toBe(branch.final);
    expect(result.sendCalls).toBe(branch.sends.length);
    expect(result.queryUsed).toBe(branch.query !== undefined);
    expect(f.state.task.status).toBe(branch.final === 'delivered' ? 'completed' : branch.final);
    expect(f.sends[0]).toHaveBeenCalledTimes(branch.sends.length);
    expect(fake.recordedCalls).toHaveLength(branch.sends.length);
    expect(f.queries[0]).toHaveBeenCalledTimes(branch.query ? 1 : 0);
    for (const call of fake.recordedCalls) {
      expect(call.payload).toBe(f.request.text);
      expect(call.options).toMatchObject({
        operationId: result.operationId,
        targetSessionId: f.state.task.sessionId,
      });
    }
    if (branch.query) expect(f.queries[0]).toHaveBeenCalledWith(result.operationId);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.sends[0]).toHaveBeenCalledTimes(branch.sends.length);
    expect(f.queries[0]).toHaveBeenCalledTimes(branch.query ? 1 : 0);
  });
});

describe('意图隔离与并发幂等', () => {
  it('完成后的同一请求返回既有结果，不再次发送', async () => {
    const f = fixture();
    const { service } = f.open();
    const first = await service.send(f.request);
    const repeated = await service.send({ ...f.request });
    expect(repeated).toEqual(first);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('字段书写顺序不同的同一请求仍可重放，不新增发送', async () => {
    const f = fixture();
    const { service } = f.open();
    const first = await service.send(f.request);
    const replay: SendRequest = {
      ...f.request,
      subject: { inputVersion: 1, taskId: f.state.task.taskId, kind: 'task' },
    };
    expect(await service.recover(replay)).toEqual(first);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('迟到旧输入版本不能抢占当前任务的最终回答用途', async () => {
    const f = fixture();
    f.state.task.inputVersion = 2;
    const { service } = f.open();
    await expect(service.send(f.request)).rejects.toMatchObject({ type: 'cancelled' });
    expect(f.dispatches.records.size).toBe(0);
    const result = await service.send({
      ...f.request,
      subject: { kind: 'task', taskId: f.state.task.taskId, inputVersion: 2 },
    });
    expect(result.status).toBe('delivered');
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('同实例并发共享结果，但进行中的正文和输入版本冲突仍拒绝', async () => {
    const f = fixture();
    const gate = deferred<SendResult>();
    const { service } = f.open({ behaviors: [{ mode: 'custom', handler: () => gate.promise }] });
    const first = service.send(f.request);
    const second = service.send({ ...f.request });
    await vi.advanceTimersByTimeAsync(0);
    await expect(service.send({ ...f.request, text: '另一份正文' })).rejects.toThrow();
    await expect(
      service.send({
        ...f.request,
        subject: { kind: 'task', taskId: f.state.task.taskId, inputVersion: 2 },
      })
    ).rejects.toThrow();
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    gate.resolve(observation('delivered'));
    expect(await second).toEqual(await first);
    expect(f.state.task.status).toBe('completed');
  });

  it('既有终态也不能被不同正文重新解释', async () => {
    const f = fixture();
    const { service } = f.open();
    await service.send(f.request);
    await expect(service.send({ ...f.request, text: '修改后的答案' })).rejects.toThrow();
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.state.task.status).toBe('completed');
  });

  it.each(['sending', 'querying'] as const)('跨实例普通 send 不抢占 %s', async status => {
    const f = fixture();
    f.state.task.status = 'sending';
    const existing = await f.seed({
      status,
      sendCalls: 1,
      queryUsed: status === 'querying',
      queryDueAt: START + 30_000,
    });
    const left = f.open();
    const right = f.open();
    const results = await Promise.all([
      left.service.send(f.request),
      right.service.send(f.request),
    ]);
    expect(results.map(result => result.operationId)).toEqual([
      existing.operationId,
      existing.operationId,
    ]);
    expect(results.map(result => result.status)).toEqual([status, status]);
    expect(f.drivers.flatMap(driver => driver.recordedCalls)).toEqual([]);
    for (const query of f.queries) expect(query).not.toHaveBeenCalled();
    expect(f.state.task.status).toBe('sending');
  });

  it('queued、progress、notice 与 final 独立，只有 final 终结任务', async () => {
    const f = fixture();
    const { service } = f.open();
    const operationIds = new Set<string>();
    for (const purpose of ['queued', 'progress', 'notice:说明'] as const) {
      f.state.task.status = purpose === 'queued' ? 'queued' : 'running';
      const statusBefore = f.state.task.status;
      const result = await service.send({ ...f.request, purpose });
      expect(result.status).toBe('delivered');
      operationIds.add(result.operationId);
      expect(f.state.task.status).toBe(statusBefore);
    }
    f.state.task.status = 'ready_to_send';
    const final = await service.send(f.request);
    operationIds.add(final.operationId);
    expect(operationIds.size).toBe(4);
    expect(f.sends[0]).toHaveBeenCalledTimes(4);
    expect(f.state.task.status).toBe('completed');
  });

  it('无任务事件允许独立 notice，但拒绝 final', async () => {
    const f = fixture();
    const { service } = f.open();
    const subject = {
      kind: 'event' as const,
      botId: f.state.task.botId,
      sessionId: f.state.task.sessionId,
      messageId: '原始消息一',
      threadId: f.state.context.threadId,
    };
    const result = await service.send({ subject, purpose: 'notice:输入提示', text: '请补充信息' });
    expect(result.status).toBe('delivered');
    expect(result.taskId).toBeNull();
    expect(f.state.task.status).toBe('ready_to_send');
    await expect(service.send({ subject, purpose: 'final', text: '不合法答案' })).rejects.toThrow();
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });
});

describe('最终判定时刻与空闲起点', () => {
  it('Driver 回执先于交付事务提交时，等待数据库不推迟送达起点', async () => {
    const f = fixture();
    const commit = deferred<void>();
    f.state.outputCommitHook = () => commit.promise;
    const { service } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect([...f.dispatches.records.values()][0]?.resultAt).toBeNull();
    vi.setSystemTime(START + 90_000);
    commit.resolve();
    const result = await pending;
    expect(result.resultAt).toBe(START);
    expect(f.state.context.idleSince).toBe(START);
    expect(f.state.task.endedAt).toBe(START + 90_000);
  });

  it('未知发送尚未最终判定时没有空闲起点，查询未知才开始计时', async () => {
    const f = fixture(['unknown']);
    const { service } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect([...f.dispatches.records.values()][0]).toMatchObject({
      status: 'unknown',
      resultAt: null,
    });
    expect(f.state.context.idleSince).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ status: 'send_unconfirmed', resultAt: START + 30_000 });
    expect(f.state.context.idleSince).toBe(START + 30_000);
  });

  it.each(['delivered', 'unknown'] as const)(
    '%s 结果已持久化但任务未结束，恢复沿用首次结果时刻',
    async observed => {
      const f = fixture([observed]);
      const interrupted = new Error('保存最终结果后任务事务中断');
      f.state.transitionHook = input => {
        if (input.to === 'completed' || input.to === 'send_unconfirmed') throw interrupted;
      };
      const old = f.open();
      const pending = old.service.send(f.request);
      const rejected = expect(pending).rejects.toBe(interrupted);
      await vi.advanceTimersByTimeAsync(observed === 'unknown' ? 30_000 : 0);
      await rejected;
      const resultAt = Date.now();
      const saved = [...f.dispatches.records.values()][0]!;
      expect(saved.resultAt).toBe(resultAt);
      expect(f.state.context.idleSince).toBeNull();
      old.service.close();
      f.state.transitionHook = undefined;
      vi.setSystemTime(resultAt + 3 * 60 * 60_000);
      const next = f.open();
      expect(await next.service.recover(f.request)).toEqual(saved);
      expect(f.state.context.idleSince).toBe(resultAt);
      expect(f.state.task.endedAt).toBe(Date.now());
      vi.setSystemTime(Date.now() + 60_000);
      expect(await next.service.recover(f.request)).toEqual(saved);
      expect(f.state.context.idleSince).toBe(resultAt);
      expect(f.sends[1]).not.toHaveBeenCalled();
      expect(f.queries[1]).not.toHaveBeenCalled();
    }
  );

  it('缺少真实判定时刻的既有送达结果明确拒绝恢复，不猜测历史时间', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    const saved = await f.seed({ status: 'delivered', messageId: '旧记录', resultAt: null });
    const { service } = f.open();
    await expect(service.recover(f.request)).rejects.toThrow();
    expect(await f.dispatches.get(saved.operationId)).toEqual(saved);
    expect(f.state.context.idleSince).toBeNull();
    expect(f.state.task.status).toBe('sending');
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('明确失败恢复以任务结束时刻计空闲，不使用发送判定时刻', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    await f.seed({ status: 'failed', resultAt: START - 5_000 });
    const { service } = f.open();
    await service.recover(f.request);
    expect(f.state.task.status).toBe('failed');
    expect(f.state.task.endedAt).toBe(START);
    expect(f.state.context.idleSince).toBe(START);
  });
});

describe('任务和上下文竞争', () => {
  it.each(['queued', 'progress', 'final', 'notice:说明'] as const)(
    '%s 在交付锁获取前上下文失效时不调用 Driver',
    async purpose => {
      const f = fixture();
      f.state.task.status =
        purpose === 'queued' ? 'queued' : purpose === 'final' ? 'ready_to_send' : 'running';
      f.state.taskOutputHook = () => {
        f.state.context.invalidatedAt = Date.now();
      };
      const { service } = f.open();
      expect((await service.send({ ...f.request, purpose })).status).toBe('cancelled');
      expect(f.sends[0]).not.toHaveBeenCalled();
      expect(f.state.context.idleSince).toBeNull();
    }
  );

  it.each(['queued', 'progress', 'final'] as const)(
    '%s 在交付前期限经过时不使用预检查快照',
    async purpose => {
      const f = fixture();
      f.state.task.status =
        purpose === 'queued' ? 'queued' : purpose === 'progress' ? 'running' : 'ready_to_send';
      f.state.taskOutputHook = () => {
        vi.setSystemTime(START + 60_000);
      };
      const { service } = f.open();
      expect((await service.send({ ...f.request, purpose })).status).toBe('cancelled');
      expect(f.sends[0]).not.toHaveBeenCalled();
    }
  );

  it('交付锁内任务已经取消时拒绝固定提示，不仅检查上下文有效性', async () => {
    const f = fixture();
    f.state.taskOutputHook = () => {
      f.state.task.status = 'cancelled';
    };
    const { service } = f.open();
    expect((await service.send({ ...f.request, purpose: 'notice:说明' })).status).toBe('cancelled');
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('原始事件提示在交付锁前作废 thread 时不能迟到发送', async () => {
    const f = fixture();
    f.state.contextOutputHook = () => {
      f.state.context.invalidatedAt = Date.now();
    };
    const { service } = f.open();
    const result = await service.send({
      subject: {
        kind: 'event',
        botId: f.state.context.botId,
        sessionId: f.state.context.sessionId,
        messageId: '原始消息一',
        threadId: f.state.context.threadId,
      },
      purpose: 'notice:输入提示',
      text: '请补充信息',
    });
    expect(result.status).toBe('cancelled');
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('ready_to_send 转换过程中 /new 作废上下文时不触发 Driver', async () => {
    const f = fixture();
    f.state.transitionHook = input => {
      if (input.to === 'sending') f.state.context.invalidatedAt = Date.now();
    };
    const { service } = f.open();
    const result = await service.send(f.request);
    expect(result.status).toBe('cancelled');
    expect(f.sends[0]).not.toHaveBeenCalled();
    expect(f.state.task.status).not.toBe('completed');
  });

  it('第一次明确失败后上下文作废，不能重试', async () => {
    const f = fixture();
    const { service } = f.open({
      behaviors: [
        {
          mode: 'custom',
          handler: () => {
            f.state.context.invalidatedAt = Date.now();
            return observation('failed');
          },
        },
        behavior('delivered'),
      ],
    });
    const result = await service.send(f.request);
    expect(result.status).toBe('cancelled');
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.state.task.status).not.toBe('completed');
  });

  it('触发后才取消的任务不会被迟到送达复活', async () => {
    const f = fixture();
    const gate = deferred<SendResult>();
    const { service } = f.open({ behaviors: [{ mode: 'custom', handler: () => gate.promise }] });
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    f.state.task.status = 'cancelled';
    f.state.context.invalidatedAt = Date.now();
    gate.resolve(observation('delivered'));
    const result = await pending;
    expect(result.status).toBe('cancelled');
    expect(f.state.task.status).toBe('cancelled');
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('sending 已触发时执行期限经过，不把实际送达改为超时', async () => {
    const f = fixture(['unknown'], 'delivered');
    f.state.task.executionDeadline = START + 1;
    const { service } = f.open();
    const pending = service.send(f.request);
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await pending).status).toBe('delivered');
    expect(f.state.task.status).toBe('completed');
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('已经进入 sending 后明确失败的同 ID 重试不重判执行期限', async () => {
    const f = fixture();
    f.state.task.executionDeadline = START + 1;
    const { service } = f.open({
      behaviors: [
        {
          mode: 'custom',
          handler: () => {
            vi.setSystemTime(START + 100);
            return observation('failed');
          },
        },
        behavior('delivered'),
      ],
    });
    expect((await service.send(f.request)).status).toBe('delivered');
    expect(f.sends[0]).toHaveBeenCalledTimes(2);
    expect(f.state.task.status).toBe('completed');
  });
});

describe('关闭和显式恢复', () => {
  it('关闭等待后新服务沿用绝对查询时间，不获得新的三十秒窗口', async () => {
    const f = fixture(['unknown'], 'delivered');
    const old = f.open();
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.queryDueAt).toBe(START + 30_000);
    old.service.close();
    await vi.advanceTimersByTimeAsync(10_000);
    const next = f.open();
    const pending = next.service.recover(f.request);
    await vi.advanceTimersByTimeAsync(9_999);
    for (const query of f.queries) expect(query).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe('delivered');
    expect(result.operationId).toBe(row.operationId);
    expect(result.sendCalls).toBe(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.queries[1]).toHaveBeenCalledExactlyOnceWith(row.operationId);
    expect(f.sends[1]).not.toHaveBeenCalled();
    await abandoned;
  });

  it('关闭不关闭 Driver，迟到发送结果不能覆盖恢复的未确认终态', async () => {
    const f = fixture();
    const gate = deferred<SendResult>();
    const old = f.open({ behaviors: [{ mode: 'custom', handler: () => gate.promise }] });
    const disconnect = vi.spyOn(old.fake, 'disconnect');
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(0);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.status).toBe('sending');
    expect(row.sendCalls).toBe(1);
    old.service.close();
    const next = f.open();
    const pending = next.service.recover(f.request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.queries[1]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const recovered = await pending;
    expect(recovered.status).toBe('send_unconfirmed');
    gate.resolve(observation('delivered'));
    await abandoned;
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.dispatches.get(row.operationId)).toEqual(recovered);
    expect(f.state.task.status).toBe('send_unconfirmed');
    expect(disconnect).not.toHaveBeenCalled();
    expect(f.sends[1]).not.toHaveBeenCalled();
  });

  it('querying 中崩溃已经消耗唯一查询，恢复直接未确认且忽略旧查询迟到结果', async () => {
    const f = fixture(['unknown']);
    const queryGate = deferred<SendResult>();
    const old = f.open({ query: () => queryGate.promise });
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(30_000);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.status).toBe('querying');
    expect(row.queryUsed).toBe(true);
    expect(f.queries[0]).toHaveBeenCalledTimes(1);
    old.service.close();
    const next = f.open();
    const recovered = await next.service.recover(f.request);
    expect(recovered.status).toBe('send_unconfirmed');
    expect(recovered.operationId).toBe(row.operationId);
    expect(f.queries[1]).not.toHaveBeenCalled();
    expect(f.sends[1]).not.toHaveBeenCalled();
    queryGate.resolve(observation('delivered', row.operationId));
    await abandoned;
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.dispatches.get(row.operationId)).toEqual(recovered);
    expect(f.state.task.status).toBe('send_unconfirmed');
  });

  it('第二次发送预算已占用时恢复不能再发第三次', async () => {
    const f = fixture(['failed', 'unknown'], 'failed');
    const old = f.open();
    const abandoned = old.service.send(f.request).catch(() => null);
    await vi.advanceTimersByTimeAsync(10_000);
    const row = [...f.dispatches.records.values()][0]!;
    expect(row.sendCalls).toBe(2);
    old.service.close();
    const next = f.open();
    const pending = next.service.recover(f.request);
    await vi.advanceTimersByTimeAsync(20_000);
    const recovered = await pending;
    expect(recovered.status).toBe('failed');
    expect(recovered.sendCalls).toBe(2);
    expect(recovered.queryUsed).toBe(true);
    expect(f.sends[0]).toHaveBeenCalledTimes(2);
    expect(f.sends[1]).not.toHaveBeenCalled();
    expect(f.queries[1]).toHaveBeenCalledExactlyOnceWith(row.operationId);
    await abandoned;
  });

  it('prepared 尚未占用发送预算时可以正常恢复发送', async () => {
    const f = fixture();
    const row = await f.seed({ status: 'prepared' });
    const { service } = f.open();
    const result = await service.recover(f.request);
    expect(result.status).toBe('delivered');
    expect(result.operationId).toBe(row.operationId);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('retryable 崩溃恢复先查询，不能把已记失败当作直接重发许可', async () => {
    const f = fixture();
    f.state.task.status = 'sending';
    const row = await f.seed({ status: 'retryable', sendCalls: 1, queryDueAt: START + 30_000 });
    const { service } = f.open({
      query: operationId => Promise.resolve(observation('delivered', operationId)),
    });
    const pending = service.recover(f.request);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.sends[0]).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe('delivered');
    expect(result.sendCalls).toBe(1);
    expect(f.queries[0]).toHaveBeenCalledExactlyOnceWith(row.operationId);
    expect(f.sends[0]).not.toHaveBeenCalled();
  });

  it('查询已确认失败并保存后中断，恢复仅使用剩余一次发送预算', async () => {
    const f = fixture(['unknown'], 'failed');
    const write = f.dispatches.compareAndSet.bind(f.dispatches);
    const interruption = new Error('已保存查询结果后中断');
    const intercepted = vi
      .spyOn(f.dispatches, 'compareAndSet')
      .mockImplementation(async (id, revision, update) => {
        const saved = await write(id, revision, update);
        if (saved?.status === 'retryable' && saved.queryUsed) throw interruption;
        return saved;
      });
    const old = f.open();
    const pending = old.service.send(f.request).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toBe(interruption);
    old.service.close();
    intercepted.mockRestore();
    const next = f.open({ behaviors: [behavior('delivered')] });
    const result = await next.service.recover(f.request);
    expect(result).toMatchObject({ status: 'delivered', sendCalls: 2, queryUsed: true });
    expect(f.sends[1]).toHaveBeenCalledExactlyOnceWith(f.request.text, {
      operationId: result.operationId,
      targetSessionId: f.state.task.sessionId,
    });
    expect(f.queries[1]).not.toHaveBeenCalled();
  });

  it('Driver 抛错不算明确失败，保留预算供只读恢复', async () => {
    const f = fixture();
    const cause = new Error('Driver 回执异常');
    const { service } = f.open({
      behaviors: [
        {
          mode: 'custom',
          handler: () => {
            throw cause;
          },
        },
      ],
    });
    await expect(service.send(f.request)).rejects.toMatchObject({ type: 'driver', cause });
    const saved = [...f.dispatches.records.values()][0]!;
    expect(saved).toMatchObject({ status: 'sending', sendCalls: 1, queryUsed: false });
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
    expect(f.queries[0]).not.toHaveBeenCalled();
  });

  it('查询抛错保留 cause 并结束为未确认，重复恢复不补查', async () => {
    const f = fixture(['unknown']);
    const cause = new Error('只读查询连接异常');
    const { service } = f.open({
      query: () => Promise.reject(cause),
    });
    const pending = service.send(f.request);
    const rejected = expect(pending).rejects.toMatchObject({ type: 'driver', cause });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect(f.state.task.status).toBe('send_unconfirmed');
    expect((await service.recover(f.request)).status).toBe('send_unconfirmed');
    expect(f.queries[0]).toHaveBeenCalledTimes(1);
    expect(f.sends[0]).toHaveBeenCalledTimes(1);
  });

  it('查询故障后保存未确认又失败时同时保留两个原因', async () => {
    const f = fixture(['unknown']);
    const driverCause = new Error('查询断连');
    const storageCause = new Error('保存终态数据库断连');
    const { service } = f.open({
      query: () => {
        vi.spyOn(f.dispatches, 'compareAndSet').mockRejectedValue(storageCause);
        return Promise.reject(driverCause);
      },
    });
    const pending = service.send(f.request);
    const rejected = expect(pending).rejects.toMatchObject({
      errors: [expect.objectContaining({ type: 'driver', cause: driverCause }), storageCause],
    });
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    expect([...f.dispatches.records.values()][0]?.status).toBe('querying');
    expect(f.queries[0]).toHaveBeenCalledTimes(1);
  });

  it('关闭与查询异常同时到达时不丢弃原查询 cause', async () => {
    const f = fixture(['unknown']);
    const cause = new Error('关闭期间查询断连');
    const gate = deferred<SendResult>();
    const { service } = f.open({
      query: async () => {
        await gate.promise;
        throw cause;
      },
    });
    const pending = service.send(f.request);
    const rejected = expect(pending).rejects.toMatchObject({ type: 'driver', cause });
    await vi.advanceTimersByTimeAsync(30_000);
    service.close();
    gate.resolve(observation('unknown'));
    await rejected;
    expect([...f.dispatches.records.values()][0]?.status).toBe('querying');
  });
});

describe('存储故障固定提示例外', () => {
  it.each(['delivered', 'failed', 'unknown'] as const)(
    '%s 也只发送一次固定正文，跨服务同进程去重且不碰业务存储',
    async status => {
      const f = fixture([status]);
      const fail = () => {
        throw new Error('业务存储不可访问');
      };
      const business = [
        vi.spyOn(f.driverStore, 'claim').mockImplementation(fail),
        vi.spyOn(f.driverStore, 'get').mockImplementation(fail),
        vi.spyOn(f.driverStore, 'update').mockImplementation(fail),
        vi.spyOn(f.dispatches, 'ensure').mockImplementation(fail),
        vi.spyOn(f.dispatches, 'get').mockImplementation(fail),
        vi.spyOn(f.dispatches, 'compareAndSet').mockImplementation(fail),
        vi.mocked(f.tasks.getTask).mockImplementation(fail),
        vi.mocked(f.tasks.transitionTask).mockImplementation(fail),
        vi.mocked(f.contexts.getContext).mockImplementation(fail),
        vi.mocked(f.contexts.getRawMessage).mockImplementation(fail),
      ];
      const event = {
        botId: '故障机器人',
        sessionId: '0-2001',
        messageId: `故障事件-${++eventSequence}`,
      };
      const error = new AppError('storage', {
        cause: new Error('机密 SQL、正文和连接凭据不能发送'),
      });
      const first = f.open();
      const second = f.open();
      const results = await Promise.all([
        first.service.sendStorageFailure(event, error),
        second.service.sendStorageFailure({ ...event }, error),
      ]);
      await vi.advanceTimersByTimeAsync(60_000);
      await second.service.sendStorageFailure(event, new AppError('storage'));
      const calls = f.drivers.flatMap(driver => driver.recordedCalls);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.payload).toBe(getFailureMessage('storage'));
      expect(calls[0]!.options?.targetSessionId).toBe(event.sessionId);
      const operationId = calls[0]!.options?.operationId;
      expect(operationId).toEqual(expect.any(String));
      const result = results.find(value => value !== null)!;
      expect(result.status).toBe(status);
      expect(result.operationId).toBe(operationId);
      for (const query of f.queries) expect(query).not.toHaveBeenCalled();
      for (const method of business) expect(method).not.toHaveBeenCalled();
      expect(f.state.task.status).toBe('ready_to_send');
    }
  );

  it('相同消息号不同会话的存储故障不是同一事件', async () => {
    const f = fixture();
    const { service, fake } = f.open();
    const messageId = `跨会话故障-${++eventSequence}`;
    const first = await service.sendStorageFailure(
      { botId: '机器人', sessionId: '0-3001', messageId },
      new AppError('storage')
    );
    const second = await service.sendStorageFailure(
      { botId: '机器人', sessionId: '0-3002', messageId },
      new AppError('storage')
    );
    expect(first?.operationId).not.toBe(second?.operationId);
    expect(fake.recordedCalls.map(call => call.payload)).toEqual([
      getFailureMessage('storage'),
      getFailureMessage('storage'),
    ]);
    expect(f.dispatches.records.size).toBe(0);
  });

  it('非 storage AppError 不允许进入绕过持久化的提示通道', async () => {
    const f = fixture();
    const { service } = f.open();
    const event = {
      botId: '机器人',
      sessionId: '0-3001',
      messageId: `非法故障-${++eventSequence}`,
    };
    await expect(service.sendStorageFailure(event, new AppError('driver'))).rejects.toThrow();
    await expect(
      service.sendStorageFailure(event, new Error('伪装存储故障') as AppError)
    ).rejects.toThrow();
    expect(f.sends[0]).not.toHaveBeenCalled();
    expect(f.queries[0]).not.toHaveBeenCalled();
    expect(f.dispatches.records.size).toBe(0);
  });
});
