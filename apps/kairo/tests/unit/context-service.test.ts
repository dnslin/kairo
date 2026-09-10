import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createControlMessageHandler,
  isNewCommand,
} from '../../src/modules/private-chat-core/control-message.js';
import { createContextService } from '../../src/modules/private-chat-core/context-service.js';
import type {
  ChatContext,
  PrivateChatStore,
  RawMessage,
} from '../../src/modules/private-chat-core/types.js';
import type { Task, TaskStore } from '../../src/modules/task-lifecycle/types.js';
import type { SendService } from '../../src/modules/im-transport/send-service.js';

const message: RawMessage = {
  sessionId: '0-3585',
  messageId: '命令消息',
  direction: 'inbound',
  observedAt: 1,
  text: '/new',
  messageType: 'text',
  attachments: {},
  employeeId: '3585',
  processingResult: 'accepted',
};

describe('控制命令边界', () => {
  it('只识别整条纯文本及首尾空白', () => {
    expect(isNewCommand(message)).toBe(true);
    expect(isNewCommand({ ...message, text: ' \n\t/new\r\n ' })).toBe(true);
  });
  it('普通句子、参数、其他命令和大小写不触发', () => {
    for (const text of [
      '请执行 /new',
      '/new 参数',
      '/new\n下一句',
      '/clear',
      '/cancel',
      '/xxx',
      '/NEW',
      '',
    ]) {
      expect(isNewCommand({ ...message, text })).toBe(false);
    }
  });
  it('非纯文本及附件均不触发，空图片列表仍是无附件', () => {
    expect(isNewCommand({ ...message, messageType: 'rich-text' })).toBe(false);
    expect(isNewCommand({ ...message, messageType: null })).toBe(false);
    expect(
      isNewCommand({ ...message, attachments: { fileInfo: { fileName: '附件', fileSize: '1' } } })
    ).toBe(false);
    expect(isNewCommand({ ...message, attachments: { images: [{ url: '图片地址' }] } })).toBe(
      false
    );
    expect(isNewCommand({ ...message, attachments: { images: [] } })).toBe(true);
  });
});

afterEach(() => vi.restoreAllMocks());

function serviceFixture() {
  const current: ChatContext = {
    employeeId: '3585',
    botId: 'bot',
    sessionId: '0-3585',
    threadId: '旧thread',
    version: 1,
    createdAt: 0,
    invalidatedAt: null,
    idleSince: null,
  };
  const task: Task = {
    ...current,
    taskId: '任务',
    batchId: '批次',
    inputVersion: 1,
    configDigest: '摘要',
    status: 'running',
    updatedAt: 0,
    queueDeadline: 1000,
    executionBudgetMs: 100_000,
    queueNoticeRequired: false,
    executionStartedAt: 1,
    executionDeadline: Date.now() + 100000,
    currentAttemptId: '执行',
    currentWaitId: null,
    endedAt: null,
  };
  const store: Pick<PrivateChatStore, 'prepareContext'> = {
    prepareContext: vi.fn(() =>
      Promise.resolve({
        context: { ...current, threadId: '新thread', version: 2 },
        invalidatedThreadId: current.threadId,
        hadUnfinishedWork: true,
      })
    ),
  };
  const tasks: Pick<TaskStore, 'withTaskOutput'> = {
    withTaskOutput(input, output) {
      return Promise.resolve(
        input.contextVersion === current.version &&
          current.invalidatedAt === null &&
          input.attemptId === task.currentAttemptId
          ? { value: output(task) }
          : null
      );
    },
  };
  const service = createContextService({ store, tasks, idleMs: 7200000 });
  const scope = { taskId: task.taskId, inputVersion: 1, contextVersion: 1, attemptId: '执行' };
  return { service, store, tasks, current, task, scope };
}

describe('上下文执行绑定', () => {
  it('切换提交后触发真实 AbortSignal，不等待旧执行结束', async () => {
    const f = serviceFixture();
    const controller = new AbortController();
    const release = await f.service.registerExecution(f.scope, controller);
    const result = await f.service.resolve(f.current, true);
    expect(result.context.threadId).toBe('新thread');
    expect(controller.signal.aborted).toBe(true);
    release();
  });
  it('失败事务不宣称已取消，也不停止仍有效的执行', async () => {
    const f = serviceFixture();
    const controller = new AbortController();
    const release = await f.service.registerExecution(f.scope, controller);
    const failure = new Error('事务提交失败');
    vi.spyOn(f.store, 'prepareContext').mockRejectedValueOnce(failure);
    await expect(f.service.resolve(f.current, true)).rejects.toBe(failure);
    expect(controller.signal.aborted).toBe(false);
    release();
  });
  it('释放的旧执行不再收到取消，旧版本新登记则明确拒绝并 abort', async () => {
    const f = serviceFixture();
    const controller = new AbortController();
    const release = await f.service.registerExecution(f.scope, controller);
    release();
    await f.service.resolve(f.current, true);
    expect(controller.signal.aborted).toBe(false);
    f.current.invalidatedAt = Date.now();
    const late = new AbortController();
    await expect(f.service.registerExecution(f.scope, late)).rejects.toMatchObject({
      type: 'cancelled',
    });
    expect(late.signal.aborted).toBe(true);
  });
  it('拒绝门禁结果不创建上下文；普通内容交给下一阶段，命令只返回切换结果', async () => {
    const f = serviceFixture();
    const sent: string[] = [];
    const sender: Pick<SendService, 'send'> = {
      send: vi.fn(request => {
        sent.push(request.text);
        return Promise.reject(new Error('发送边界测试错误'));
      }),
    };
    const handle = createControlMessageHandler({ contexts: f.service, sender });
    expect(await handle({ status: 'not_allowed' })).toEqual({ status: 'not_allowed' });
    expect(f.store.prepareContext).not.toHaveBeenCalled();
    const ordinary = await handle({
      status: 'accepted',
      botId: 'bot',
      message: { ...message, employeeId: '3585', text: '/new 参数' },
    });
    expect(ordinary.status).toBe('message');
    expect(sent).toEqual([]);
    await expect(
      handle({ status: 'accepted', botId: 'bot', message: { ...message, employeeId: '3585' } })
    ).rejects.toThrow('发送边界测试错误');
    expect(sent).toEqual(['已开始新对话，之前未完成的任务已取消。']);
  });
});
