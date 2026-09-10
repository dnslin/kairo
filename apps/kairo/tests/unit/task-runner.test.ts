import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContextService } from '../../src/modules/private-chat-core/context-service.js';
import type { ChatContext, PrivateChatStore } from '../../src/modules/private-chat-core/types.js';
import type { SendDispatch, SendRequest } from '../../src/modules/im-transport/send-policy.js';
import { AppError } from '../../src/modules/operability/errors.js';
import {
  createTaskRunner,
  type TaskExecutionResult,
} from '../../src/modules/task-lifecycle/task-runner.js';
import type {
  Task,
  TaskAttempt,
  TaskStore,
  UserWait,
} from '../../src/modules/task-lifecycle/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture(overrides: Partial<Task> = {}) {
  const context: ChatContext = {
    employeeId: '3585',
    botId: 'bot',
    sessionId: '0-3585',
    threadId: 'thread',
    version: 7,
    createdAt: 0,
    invalidatedAt: null,
    idleSince: null,
  };
  const task: Task = {
    ...context,
    taskId: 'task',
    batchId: 'batch',
    inputVersion: 1,
    configDigest: '创建摘要',
    status: 'running',
    updatedAt: 0,
    queueDeadline: 600000,
    executionStartedAt: 0,
    executionDeadline: 240000,
    executionBudgetMs: 240000,
    queueNoticeRequired: false,
    currentWaitId: null,
    currentAttemptId: null,
    endedAt: null,
    ...overrides,
  };
  const attempts = new Map<string, TaskAttempt>();
  const waits: UserWait[] = [];
  const store = {
    getTask: vi.fn(() => Promise.resolve({ ...task })),
    startAttempt: vi.fn<TaskStore['startAttempt']>(input => {
      if (
        task.status !== 'running' ||
        input.expectedAttemptId !== task.currentAttemptId ||
        context.invalidatedAt !== null ||
        input.now >= task.executionDeadline!
      )
        return Promise.resolve(null);
      const attempt: TaskAttempt = {
        ...input,
        startedAt: input.now,
        finishedAt: null,
        errorType: null,
        adopted: false,
      };
      attempts.set(attempt.attemptId, attempt);
      task.currentAttemptId = attempt.attemptId;
      return Promise.resolve({ ...attempt });
    }),
    finishAttempt: vi.fn<TaskStore['finishAttempt']>(input => {
      const attempt = attempts.get(input.attemptId);
      if (!attempt || attempt.finishedAt !== null) return Promise.resolve(false);
      Object.assign(attempt, { finishedAt: input.finishedAt, errorType: input.errorType });
      return Promise.resolve(true);
    }),
    getAttempt: vi.fn<TaskStore['getAttempt']>(id => Promise.resolve(attempts.get(id) ?? null)),
    transitionTask: vi.fn<TaskStore['transitionTask']>(input => {
      if (task.status !== input.from || task.inputVersion !== input.inputVersion)
        return Promise.resolve(false);
      if (
        input.from === 'running' &&
        input.to === 'failed' &&
        input.expectedAttemptId !== task.currentAttemptId
      )
        return Promise.resolve(false);
      if (input.to === 'timed_out' && input.now < task.executionDeadline!)
        return Promise.resolve(false);
      task.status = input.to;
      task.endedAt = input.now;
      return Promise.resolve(true);
    }),
    adoptAttempt: vi.fn<TaskStore['adoptAttempt']>(input => {
      const attempt = attempts.get(input.attemptId);
      if (
        task.status !== 'running' ||
        task.currentAttemptId !== input.attemptId ||
        input.now >= task.executionDeadline! ||
        !attempt ||
        attempt.finishedAt === null ||
        attempt.errorType !== null
      )
        return Promise.resolve(false);
      attempt.adopted = true;
      task.status = 'ready_to_send';
      return Promise.resolve(true);
    }),
    waitForUser: vi.fn<TaskStore['waitForUser']>(input => {
      const attempt = attempts.get(input.attemptId);
      const now = typeof input.now === 'function' ? input.now() : input.now;
      if (
        task.status !== 'running' ||
        task.currentAttemptId !== input.attemptId ||
        now >= task.executionDeadline! ||
        !attempt ||
        attempt.finishedAt === null
      )
        return Promise.resolve(false);
      attempt.adopted = true;
      task.status = 'waiting_for_user';
      waits.push({
        ...input,
        createdAt: now,
        deadline: now + 600000,
        remainingExecutionMs: task.executionDeadline! - now,
        closedAt: null,
        resolution: null,
        answerMessage: null,
      });
      return Promise.resolve(true);
    }),
    withTaskOutput: (input, output) =>
      Promise.resolve(
        context.invalidatedAt === null &&
          input.contextVersion === context.version &&
          input.attemptId === task.currentAttemptId
          ? { value: output({ ...task }) }
          : null
      ),
  } satisfies Pick<
    TaskStore,
    | 'getTask'
    | 'startAttempt'
    | 'finishAttempt'
    | 'getAttempt'
    | 'transitionTask'
    | 'adoptAttempt'
    | 'waitForUser'
    | 'withTaskOutput'
  >;
  const chat = { getContext: vi.fn(() => Promise.resolve({ ...context })) };
  const prepare: Pick<PrivateChatStore, 'prepareContext'> = {
    prepareContext: () => {
      context.invalidatedAt = Date.now();
      task.status = 'cancelled';
      return Promise.resolve({
        context: { ...context, version: 8, threadId: '新thread', invalidatedAt: null },
        invalidatedThreadId: context.threadId,
        hadUnfinishedWork: true,
      });
    },
  };
  const contexts = createContextService({ store: prepare, tasks: store, idleMs: 7200000 });
  const execution = deferred<TaskExecutionResult>();
  const entered = deferred<AbortSignal>();
  const sent: SendRequest[] = [];
  const sender = {
    send: vi.fn((request: SendRequest): Promise<SendDispatch> => {
      sent.push(request);
      if (request.purpose === 'final') task.status = 'completed';
      return Promise.resolve({
        operationId: request.purpose,
        intentKey: request.purpose,
        taskId: task.taskId,
        purpose: request.purpose,
        sessionId: task.sessionId,
        contentDigest: '正文摘要',
        status: 'delivered',
        sendCalls: 1,
        queryUsed: false,
        queryDueAt: null,
        resultAt: Date.now(),
        messageId: '发送消息',
        revision: 1,
      });
    }),
  };
  const execute = vi.fn(({ signal }: { signal: AbortSignal }) => {
    entered.resolve(signal);
    return execution.promise;
  });
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const changes = vi.fn();
  const runner = createTaskRunner({
    tasks: store,
    contexts,
    chat,
    sender,
    execute,
    configDigest: '实际摘要',
    progressMs: 10000,
    logger,
    onTaskChange: changes,
  });
  return {
    task,
    context,
    attempts,
    waits,
    store,
    chat,
    contexts,
    execution,
    entered,
    sent,
    sender,
    execute,
    logger,
    changes,
    runner,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('执行名额与生命周期', () => {
  it('采用真实成功尝试，但释放执行名额不等待最终发送', async () => {
    const f = fixture();
    const delivery = deferred<SendDispatch>();
    f.sender.send.mockImplementationOnce(request => {
      f.sent.push(request);
      return delivery.promise;
    });
    const run = f.runner.run({ ...f.task });
    const signal = await f.entered.promise;
    f.execution.resolve({ kind: 'answer', text: '已检查的答案' });
    await run;
    const attempt = [...f.attempts.values()][0]!;
    expect(attempt).toMatchObject({ adopted: true, errorType: null, configDigest: '实际摘要' });
    expect(attempt.runId).not.toBe(attempt.attemptId);
    expect(f.task.status).toBe('ready_to_send');
    expect(f.sent).toEqual([
      {
        subject: { kind: 'task', taskId: 'task', inputVersion: 1 },
        purpose: 'final',
        text: '已检查的答案',
      },
    ]);
    expect(signal.aborted).toBe(false);
    let closed = false;
    const close = f.runner.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    const changes = f.changes.mock.calls.length;
    delivery.resolve({ status: 'delivered' } as SendDispatch);
    await close;
    expect(f.changes.mock.calls.length).toBeGreaterThan(changes);
  });

  it('9.999 秒和 10 秒不发进度，10.001 秒只发一次', async () => {
    const f = fixture();
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    await vi.advanceTimersByTimeAsync(9999);
    expect(f.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent.map(item => item.purpose)).toEqual(['progress']);
    await vi.advanceTimersByTimeAsync(10000);
    f.execution.resolve({ kind: 'answer', text: '答案' });
    await run;
    await f.runner.close();
    expect(f.sent.map(item => item.purpose)).toEqual(['progress', 'final']);
  });

  it.each([9999, 10000, 10001])(
    '执行在 %d 毫秒完成，最终回复与进度严格按边界交付',
    async elapsed => {
      const f = fixture();
      const run = f.runner.run({ ...f.task });
      await f.entered.promise;
      await vi.advanceTimersByTimeAsync(elapsed);
      f.execution.resolve({ kind: 'answer', text: '已检查的边界答案' });
      await run;
      await f.runner.close();
      expect(f.sent.map(item => item.purpose)).toEqual(
        elapsed > 10000 ? ['progress', 'final'] : ['final']
      );
      expect(f.task.status).toBe('completed');
    }
  );

  it('员工等待后的执行进度累计原始预算，等待问题独立持久化', async () => {
    const f = fixture({ executionDeadline: 334000, executionBudgetMs: 240000 });
    vi.setSystemTime(100000);
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    await vi.advanceTimersByTimeAsync(4000);
    expect(f.sent).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sent.map(item => item.purpose)).toEqual(['progress']);
    f.execution.resolve({
      kind: 'waiting_for_user',
      question: '是否允许通用知识？',
      allowedQuestionIds: ['缺失项'],
    });
    await run;
    await f.runner.settled();
    expect(f.task.status).toBe('waiting_for_user');
    expect(f.waits[0]).toMatchObject({
      question: '是否允许通用知识？',
      allowedQuestionIds: ['缺失项'],
      remainingExecutionMs: 229999,
    });
    expect(f.sent[1]).toMatchObject({
      purpose: `notice:user_wait:${f.waits[0]!.waitId}`,
      text: '是否允许通用知识？',
      subject: { kind: 'task' },
    });
    await vi.advanceTimersByTimeAsync(240000);
    expect(f.task.status).toBe('waiting_for_user');
    await f.runner.close();
  });

  it('执行截止先 abort，再立即终止业务，但等待迟到 Agent 和 Tool 真正退出', async () => {
    const f = fixture({ executionDeadline: 20000, executionBudgetMs: 20000 });
    let exited = false;
    const run = f.runner.run({ ...f.task }).then(() => {
      exited = true;
    });
    const signal = await f.entered.promise;
    await vi.advanceTimersByTimeAsync(20000);
    expect(signal.reason).toMatchObject({ name: 'TimeoutError' });
    expect(f.task.status).toBe('timed_out');
    expect(exited).toBe(false);
    expect([...f.attempts.values()][0]!.finishedAt).toBeNull();
    f.execution.resolve({ kind: 'answer', text: '迟到答案' });
    await run;
    await f.runner.close();
    expect([...f.attempts.values()][0]).toMatchObject({
      adopted: false,
      errorType: 'timeout',
      finishedAt: 20000,
    });
    expect(f.sent.map(item => item.purpose)).toEqual(['progress', 'notice:execution_timeout']);
    expect(f.sent.at(-1)?.text).toBe('本次查询超时，请稍后重试');
  });

  it('事件循环未执行 timer 时，恰好截止的结果也不能采用', async () => {
    const f = fixture();
    const run = f.runner.run({ ...f.task });
    const signal = await f.entered.promise;
    vi.setSystemTime(240000);
    f.execution.resolve({ kind: 'answer', text: '迟到答案' });
    await run;
    await f.runner.close();
    expect(signal.aborted).toBe(true);
    expect(f.task.status).toBe('timed_out');
    expect(f.sent.map(item => item.purpose)).toEqual(['notice:execution_timeout']);
  });

  it('/new 取消后仍保留实际名额与登记，迟到成功只有审计', async () => {
    const f = fixture();
    const run = f.runner.run({ ...f.task });
    const signal = await f.entered.promise;
    await f.contexts.resolve(f.context, true);
    expect(signal.aborted).toBe(true);
    let closed = false;
    const close = f.runner.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(300000);
    expect(closed).toBe(false);
    expect(f.sent).toEqual([]);
    f.execution.resolve({ kind: 'answer', text: '旧答案' });
    await run;
    await close;
    expect([...f.attempts.values()][0]).toMatchObject({ adopted: false, errorType: 'cancelled' });
  });

  it('close 取消真实执行且拒绝新工作，执行未退出时不能假关闭', async () => {
    const f = fixture();
    const run = f.runner.run({ ...f.task });
    const signal = await f.entered.promise;
    let closed = false;
    const close = f.runner.close().then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);
    expect(f.task.status).toBe('cancelled');
    expect(closed).toBe(false);
    await expect(f.runner.run({ ...f.task })).rejects.toMatchObject({ type: 'cancelled' });
    f.execution.resolve({ kind: 'answer', text: '关闭后答案' });
    await run;
    await close;
    expect(f.sent).toEqual([]);
  });

  it('完成 Agent 后的必要账本收尾仍计入进度和执行截止', async () => {
    const f = fixture();
    const save = deferred<boolean>();
    const saving = deferred<void>();
    f.store.finishAttempt.mockImplementationOnce(() => {
      saving.resolve();
      return save.promise;
    });
    const run = f.runner.run({ ...f.task });
    const signal = await f.entered.promise;
    f.execution.resolve({ kind: 'answer', text: '答案' });
    await saving.promise;
    await vi.advanceTimersByTimeAsync(240000);
    expect(signal.aborted).toBe(true);
    expect(f.task.status).toBe('timed_out');
    save.resolve(true);
    await run;
    await f.runner.close();
    expect(f.sent.map(item => item.purpose)).toEqual(['progress', 'notice:execution_timeout']);
  });
});

describe('执行与通知错误观测', () => {
  it('最终发送拒绝不阻塞 run，但 settled 和 close 都保留原错误', async () => {
    const f = fixture();
    const failure = new Error('最终发送存储失败');
    f.sender.send.mockRejectedValueOnce(failure);
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    f.execution.resolve({ kind: 'answer', text: '答案' });
    await run;
    await expect(f.runner.settled()).rejects.toBe(failure);
    await expect(f.runner.close()).rejects.toBe(failure);
    expect(f.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ event: '运行失败', taskId: 'task', errorType: 'internal' })
    );
  });

  it('进度发送已启动后失败，不能因为清除执行 timer 而丢失错误', async () => {
    const f = fixture();
    const progress = deferred<SendDispatch>();
    f.sender.send.mockImplementationOnce(() => progress.promise);
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    await vi.advanceTimersByTimeAsync(10001);
    f.execution.resolve({ kind: 'answer', text: '答案' });
    await run;
    const failure = new Error('进度发送失败');
    progress.reject(failure);
    await expect(f.runner.close()).rejects.toBe(failure);
  });

  it('执行和失败落账同时失败时保留两项原错误，不采用结果', async () => {
    const f = fixture();
    const executionError = new AppError('model');
    const storageError = new AppError('storage');
    f.store.finishAttempt.mockRejectedValueOnce(storageError);
    const run = f.runner.run({ ...f.task });
    const observed = run.catch(error => error as unknown);
    await f.entered.promise;
    f.execution.reject(executionError);
    const error = await observed;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([executionError, storageError]);
    expect(f.task.status).toBe('failed');
    expect(f.sent.some(item => item.purpose === 'final')).toBe(false);
    await expect(f.runner.close()).rejects.toBe(error);
  });

  it('登记失败不能调用执行器或遗留没有执行的 running 任务', async () => {
    const f = fixture();
    const failure = new AppError('storage');
    vi.spyOn(f.contexts, 'registerExecution').mockRejectedValueOnce(failure);
    await expect(f.runner.run({ ...f.task })).rejects.toBe(failure);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.task.status).toBe('failed');
    expect([...f.attempts.values()][0]).toMatchObject({ errorType: 'storage', adopted: false });
    await expect(f.runner.close()).rejects.toBe(failure);
  });

  it('登记前已过执行截止时不执行，结束超时且发送固定回执', async () => {
    const f = fixture();
    vi.setSystemTime(240000);
    await f.runner.run({ ...f.task });
    await f.runner.close();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.task.status).toBe('timed_out');
    expect(f.sent.map(item => item.purpose)).toEqual(['notice:execution_timeout']);
  });
});

describe('锁等待与取消竞态', () => {
  it('等待事务取锁时已过执行截止，不能用调用前时刻暂停预算', async () => {
    const f = fixture();
    const waiting = deferred<void>();
    const lock = deferred<void>();
    const saveWait = f.store.waitForUser.getMockImplementation()!;
    f.store.waitForUser.mockImplementationOnce(async input => {
      waiting.resolve();
      await lock.promise;
      return saveWait(input);
    });
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    f.execution.resolve({
      kind: 'waiting_for_user',
      question: '允许吗？',
      allowedQuestionIds: ['缺失项'],
    });
    await waiting.promise;
    vi.setSystemTime(240000);
    lock.resolve();
    await run;
    await f.runner.close();
    expect(f.waits).toEqual([]);
    expect(f.task.status).toBe('timed_out');
    expect(f.sent.map(item => item.purpose)).toEqual(['notice:execution_timeout']);
  });

  it('已锁内暂停的等待不因提交回执跨执行截止而超时', async () => {
    const f = fixture();
    const saved = deferred<void>();
    const commit = deferred<void>();
    const saveWait = f.store.waitForUser.getMockImplementation()!;
    f.store.waitForUser.mockImplementationOnce(async input => {
      const result = await saveWait(input);
      saved.resolve();
      await commit.promise;
      return result;
    });
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    f.execution.resolve({
      kind: 'waiting_for_user',
      question: '允许吗？',
      allowedQuestionIds: ['缺失项'],
    });
    await saved.promise;
    await vi.advanceTimersByTimeAsync(240000);
    commit.resolve();
    await run;
    await f.runner.close();
    expect(f.task.status).toBe('waiting_for_user');
    expect(f.sent.some(item => item.purpose === 'notice:execution_timeout')).toBe(false);
    expect(f.sent.at(-1)?.text).toBe('允许吗？');
  });

  it('答案采用提交回执跨截止时不交付最终答案', async () => {
    const f = fixture();
    const saved = deferred<void>();
    const commit = deferred<void>();
    const adopt = f.store.adoptAttempt.getMockImplementation()!;
    f.store.adoptAttempt.mockImplementationOnce(async input => {
      const result = await adopt(input);
      saved.resolve();
      await commit.promise;
      return result;
    });
    const run = f.runner.run({ ...f.task });
    await f.entered.promise;
    f.execution.resolve({ kind: 'answer', text: '不能交付' });
    await saved.promise;
    vi.setSystemTime(240000);
    commit.resolve();
    await run;
    await f.runner.close();
    expect(f.task.status).toBe('timed_out');
    expect(f.sent.map(item => item.purpose)).toEqual(['notice:execution_timeout']);
  });

  it('等待持久化失败原样传播并结束当前尝试，不发送未保存的问题', async () => {
    const f = fixture();
    const failure = new AppError('storage');
    f.store.waitForUser.mockRejectedValueOnce(failure);
    const run = f.runner.run({ ...f.task });
    const observed = run.catch(error => error as unknown);
    await f.entered.promise;
    f.execution.resolve({
      kind: 'waiting_for_user',
      question: '未保存问题',
      allowedQuestionIds: ['缺失项'],
    });
    expect(await observed).toBe(failure);
    expect(f.task.status).toBe('failed');
    expect(f.waits).toEqual([]);
    expect(f.sent.some(item => item.purpose.startsWith('notice:user_wait'))).toBe(false);
    await expect(f.runner.close()).rejects.toBe(failure);
  });

  it('超时落账错误不会提前释放尚未退出的执行，退出后报告原错误', async () => {
    const f = fixture({ executionDeadline: 20000, executionBudgetMs: 20000 });
    const failure = new AppError('storage');
    f.store.transitionTask.mockRejectedValueOnce(failure);
    let ended = false;
    const observed = f.runner.run({ ...f.task }).catch(error => {
      ended = true;
      return error as unknown;
    });
    const signal = await f.entered.promise;
    await vi.advanceTimersByTimeAsync(20000);
    expect(signal.aborted).toBe(true);
    expect(ended).toBe(false);
    f.execution.resolve({ kind: 'answer', text: '迟到答案' });
    expect(await observed).toBe(failure);
    expect(f.sent.some(item => item.purpose === 'final')).toBe(false);
    await expect(f.runner.close()).rejects.toBe(failure);
  });
});

describe('取消错误归属', () => {
  it('/new 后执行器拒绝原始取消原因属于正常收尾', async () => {
    const f = fixture();
    const run = f.runner.run({ ...f.task });
    const signal = await f.entered.promise;
    await f.contexts.resolve(f.context, true);
    f.execution.reject(signal.reason);
    await run;
    await f.runner.close();
    expect(f.task.status).toBe('cancelled');
    expect([...f.attempts.values()][0]).toMatchObject({ errorType: 'cancelled', adopted: false });
    expect(f.logger.error).not.toHaveBeenCalled();
  });

  it('/new 同时发生的存储错误仍保留，不能仅凭已取消信号吞掉', async () => {
    const f = fixture();
    const failure = new AppError('storage');
    const observed = f.runner.run({ ...f.task }).catch(error => error as unknown);
    await f.entered.promise;
    await f.contexts.resolve(f.context, true);
    f.execution.reject(failure);
    expect(await observed).toBe(failure);
    expect(f.task.status).toBe('cancelled');
    expect([...f.attempts.values()][0]?.errorType).toBe('storage');
    await expect(f.runner.close()).rejects.toBe(failure);
  });
});
