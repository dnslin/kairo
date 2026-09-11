import {
  FakeKK9Driver,
  InMemorySendOperationStore,
  type FakeSendBehavior,
  type SendOperationStore,
  type SendResult,
  type SendStatus,
} from '@kairo/driver';
import { afterEach, beforeEach, vi, type MockInstance } from 'vitest';
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
export const START = 1_800_000_000_000;
const services: { close(): void }[] = [];

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

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

export function observation(status: SendStatus, operationId?: string): SendResult {
  return {
    success: status === 'delivered',
    status,
    operationId,
    isPreTrigger: status === 'failed',
    ...(status === 'delivered' ? { messageId: '已送达消息' } : {}),
  };
}

export function behavior(status: SendStatus): FakeSendBehavior {
  if (status === 'delivered') return { mode: 'success', messageId: '已送达消息' };
  if (status === 'failed') return { mode: 'pre_trigger_failure', error: '触发前明确失败' };
  return { mode: 'post_trigger_timeout', error: '触发后未确认' };
}

export function fixture(
  sendStatuses: SendStatus[] = ['delivered'],
  queryStatus: SendStatus = 'unknown'
) {
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
      executionBudgetMs: 60_050,
      queueNoticeRequired: false,
      executionStartedAt: START - 50,
      executionDeadline: START + 60_000,
      currentAttemptId: '执行一',
      currentWaitId: null,
      answerText: '已检查的最终答案',
      recoveryUsed: false,
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

export function setupSendServiceTests(): void {
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
}
