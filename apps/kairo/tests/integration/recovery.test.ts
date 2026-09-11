import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import {
  createContextTestRuntime,
  contextMessage,
  type ContextTestRuntime,
} from '../helpers/context-runtime.js';
import { createCollector, type Collector } from '../../src/modules/private-chat-core/collector.js';
import { createScheduler, type Scheduler } from '../../src/modules/task-lifecycle/scheduler.js';
import { createRecovery, cancelConnectionWork } from '../../src/modules/task-lifecycle/recovery.js';
import type {
  TaskExecutor,
  TaskExecutionResult,
} from '../../src/modules/task-lifecycle/task-runner.js';
import type { Task } from '../../src/modules/task-lifecycle/types.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import { createSendIntent } from '../../src/modules/im-transport/send-policy.js';

let db: TaskTestDatabase;
let clock: number;
let old: ContextTestRuntime;
let owner: { botId: string; employeeId: string; sessionId: string };
const resources: Array<{
  runtime: ContextTestRuntime;
  scheduler: Scheduler;
  collector: Collector;
}> = [];
const releases: Array<() => void> = [];
const logger = createLogger({ write(): void {} });

beforeAll(async () => {
  db = await createTaskTestDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
}, 30000);
beforeEach(() => {
  clock = Date.UTC(2026, 8, 10, 10);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  owner = { botId: randomUUID(), employeeId: '3585', sessionId: '0-3585' };
  old = createContextTestRuntime(db.poolA, owner);
});
afterEach(async () => {
  try {
    for (const release of releases.splice(0)) release();
    for (const item of resources.splice(0)) {
      await item.collector.close();
      await item.scheduler.close();
      item.runtime.sender.close();
    }
  } finally {
    old?.sender.close();
    vi.restoreAllMocks();
  }
});

async function seed() {
  const message = contextMessage(owner, { content: '用于恢复的原问题' });
  const accepted = await old.ingress(message);
  if (accepted.status !== 'accepted') throw new Error('测试入站未通过');
  const { context } = await old.contexts.resolve(owner, false);
  const batches = await old.chat.collectMessage(
    { status: 'message', botId: owner.botId, message: accepted.message, context },
    { quietMs: 5000, maxWaitMs: 60000, maxMessages: 10, maxChars: 30000 },
    () => clock
  );
  const batch = batches[0]!;
  clock += 5000;
  const ready = await old.chat.finishBatch(batch.batchId, () => clock);
  if (!ready?.finishedAt) throw new Error('原聚合批次未结束');
  const result = await old.tasks.enqueueTask({
    taskId: randomUUID(),
    batchId: batch.batchId,
    configDigest: '旧配置',
    now: ready.finishedAt,
    queueDeadline: ready.finishedAt + 600000,
    queueLimit: 3,
  });
  if (result.status !== 'accepted') throw new Error('原任务未入队');
  await old.chat.settleBatch(batch.batchId, clock);
  return result.task;
}
async function claim(task: Task, recovery = false) {
  const running = await old.tasks.claimTask({
    taskId: task.taskId,
    inputVersion: 1,
    now: clock,
    executionMs: 240000,
  });
  if (!running) throw new Error('测试任务未领取');
  const attempt = await old.tasks.startAttempt({
    taskId: task.taskId,
    inputVersion: 1,
    attemptId: randomUUID(),
    runId: randomUUID(),
    configDigest: '旧配置',
    expectedAttemptId: null,
    now: clock,
    recovery,
  });
  if (!attempt) throw new Error('测试尝试未开始');
  return { running, attempt };
}
function restart(execute: TaskExecutor) {
  old.sender.close();
  const runtime = createContextTestRuntime(db.poolB, owner);
  const scheduler = createScheduler({
    ...runtime,
    execute,
    configDigest: '重启后配置',
    progressMs: 10000,
    queueMs: 600000,
    executionMs: 240000,
    concurrency: { global: 3, perSessionQueue: 3 },
    logger,
  });
  const collector = createCollector({
    botId: owner.botId,
    store: runtime.chat,
    contexts: runtime.contexts,
    sender: runtime.sender,
    deliverReady: (batch, recovery) => scheduler.enqueue(batch, recovery),
    batching: { quietMs: 5000, maxWaitMs: 60000, maxMessages: 10, maxChars: 30000 },
    logger,
  });
  const connection = new AbortController();
  const recovery = createRecovery({
    tasks: runtime.tasks,
    collector,
    scheduler,
    sender: runtime.sender,
    signal: connection.signal,
    logger,
  });
  resources.push({ runtime, scheduler, collector });
  return { runtime, scheduler, collector, recovery, connection };
}

describe('T26 真实 PostgreSQL、正式组件与受控执行器恢复', () => {
  it('原running恢复一次使用新配置和旧截止，正文落盘后只交付一次', async () => {
    const task = await seed();
    const { running } = await claim(task);
    clock += 30000;
    const executions: Parameters<TaskExecutor>[0][] = [];
    const next = restart(input => {
      executions.push(input);
      return Promise.resolve({ kind: 'answer', text: '已检查的恢复答案' });
    });
    await next.recovery.recover();
    await next.scheduler.settled();
    expect(executions).toHaveLength(1);
    expect(executions[0]?.task.executionDeadline).toBe(running.executionDeadline);
    expect(executions[0]?.attempt.configDigest).toBe('重启后配置');
    expect(await old.tasks.getTask(task.taskId)).toMatchObject({
      status: 'completed',
      recoveryUsed: true,
      answerText: '已检查的恢复答案',
    });
    const attempts = await db.poolA.query(
      'SELECT attempt_id FROM kairo.task_attempts WHERE task_id=$1',
      [task.taskId]
    );
    expect(attempts.rows).toHaveLength(2);
    await next.recovery.recover();
    expect(executions).toHaveLength(1);
  });

  it('再次进程重启不能追加尝试，失败通知经唯一发送意图', async () => {
    const task = await seed();
    await claim(task, true);
    const execute = vi.fn<TaskExecutor>();
    const next = restart(execute);
    await next.recovery.recover();
    await next.scheduler.settled();
    expect((await old.tasks.getTask(task.taskId))?.status).toBe('failed');
    expect(execute).not.toHaveBeenCalled();
    const notices = await db.poolA.query(
      'SELECT status FROM kairo.send_dispatches WHERE task_id=$1 AND purpose=$2',
      [task.taskId, 'notice:recovery_failure']
    );
    expect(notices.rows).toEqual([{ status: 'delivered' }]);
    await next.recovery.recover();
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['queued', 'running'] as const)('%s恰好原截止超时，不增加执行预算', async status => {
    const task = await seed();
    const deadline =
      status === 'running' ? (await claim(task)).running.executionDeadline! : task.queueDeadline;
    clock = deadline;
    const execute = vi.fn<TaskExecutor>();
    const next = restart(execute);
    await next.recovery.recover();
    await next.scheduler.settled();
    expect((await old.tasks.getTask(task.taskId))?.status).toBe('timed_out');
    expect(execute).not.toHaveBeenCalled();
  });

  it('未到期queued仍由原队列领取，未到期等待仍阻塞后项', async () => {
    const task = await seed();
    const { attempt } = await claim(task);
    await old.tasks.finishAttempt({
      attemptId: attempt.attemptId,
      finishedAt: clock,
      errorType: null,
    });
    const waitId = randomUUID();
    await old.tasks.waitForUser({
      taskId: task.taskId,
      inputVersion: 1,
      attemptId: attempt.attemptId,
      now: clock,
      waitId,
      question: '是否继续？',
      allowedQuestionIds: ['原问题'],
    });
    const queued = await seed();
    const originalWait = await old.tasks.getUserWait(waitId);
    const execute = vi.fn<TaskExecutor>(() =>
      Promise.resolve({ kind: 'answer', text: '排队答案' })
    );
    const next = restart(execute);
    await next.recovery.recover();
    expect(execute).not.toHaveBeenCalled();
    expect(await next.runtime.tasks.getUserWait(waitId)).toEqual(originalWait);
    expect((await next.runtime.tasks.getTask(queued.taskId))?.queueDeadline).toBe(
      queued.queueDeadline
    );
    clock = originalWait!.deadline;
    await next.scheduler.tick();
    await next.scheduler.settled();
    expect((await old.tasks.getTask(task.taskId))?.status).toBe('timed_out');
    expect((await old.tasks.getTask(queued.taskId))?.status).toBe('completed');
  });

  it('已同意等待重启后只恢复保存的剩余时间，不按旧等待截止超时', async () => {
    const task = await seed();
    const { attempt } = await claim(task);
    clock += 1000;
    await old.tasks.finishAttempt({
      attemptId: attempt.attemptId,
      finishedAt: clock,
      errorType: null,
    });
    const waitId = randomUUID();
    await old.tasks.waitForUser({
      taskId: task.taskId,
      inputVersion: 1,
      attemptId: attempt.attemptId,
      now: clock,
      waitId,
      question: '是否继续？',
      allowedQuestionIds: ['原问题'],
    });
    clock += 100;
    const answer = await old.ingress(contextMessage(owner, { content: '可以' }));
    if (answer.status !== 'accepted') throw new Error('回答未入库');
    await old.tasks.resolveUserWait({
      taskId: task.taskId,
      inputVersion: 1,
      waitId,
      now: clock,
      answerMessage: answer.message,
      decision: 'accepted',
    });
    const wait = await old.tasks.getUserWait(waitId);
    clock = wait!.deadline + 1000;
    const resumedAt = clock;
    const executions: Parameters<TaskExecutor>[0][] = [];
    const next = restart(input => {
      executions.push(input);
      return Promise.resolve({ kind: 'answer', text: '员工已同意的答案' });
    });
    await next.recovery.recover();
    await next.scheduler.settled();
    expect(executions[0]?.task.executionDeadline).toBe(resumedAt + wait!.remainingExecutionMs);
    expect((await old.tasks.getTask(task.taskId))?.recoveryUsed).toBe(false);
    expect((await old.tasks.getTask(task.taskId))?.status).toBe('completed');
  });

  it('断线取消与迟到结果隔离，保留原context且不释放未退出执行', async () => {
    const task = await seed();
    let resolve!: (result: TaskExecutionResult) => void;
    let entered: Parameters<TaskExecutor>[0] | undefined;
    const next = restart(input => {
      entered = input;
      return new Promise(done => {
        resolve = done;
      });
    });
    releases.push(() => resolve?.({ kind: 'answer', text: '清理迟到结果' }));
    await next.scheduler.resume(next.connection.signal);
    await vi.waitFor(() => expect(entered).toBeDefined(), { timeout: 5000, interval: 5 });
    next.connection.abort();
    await cancelConnectionWork({
      botId: owner.botId,
      tasks: next.runtime.tasks,
      scheduler: next.scheduler,
      collector: next.collector,
      sender: next.runtime.sender,
    });
    expect(entered?.signal.aborted).toBe(true);
    expect((await old.tasks.getTask(task.taskId))?.status).toBe('cancelled');
    expect((await old.chat.getContext(task.threadId))?.invalidatedAt).toBeNull();
    resolve({ kind: 'answer', text: '旧代次迟到答案不得发送' });
    await next.scheduler.settled();
    expect((await old.tasks.getTask(task.taskId))?.answerText).toBeNull();
    const final = await db.poolA.query(
      'SELECT operation_id FROM kairo.send_dispatches WHERE task_id=$1 AND purpose=$2',
      [task.taskId, 'final']
    );
    expect(final.rows).toEqual([]);
  });

  it.each(['delivered', 'failed', 'unknown'] as const)(
    'sending重启先查%s，复用原正文及T21剩余预算',
    async status => {
      const task = await seed();
      const { attempt } = await claim(task);
      await old.tasks.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: clock,
        errorType: null,
      });
      await old.tasks.adoptAttempt({
        taskId: task.taskId,
        inputVersion: 1,
        now: clock,
        attemptId: attempt.attemptId,
        answerText: '只允许恢复这份已检查正文',
      });
      const request = {
        subject: { kind: 'task' as const, taskId: task.taskId, inputVersion: 1 },
        purpose: 'final' as const,
        text: '只允许恢复这份已检查正文',
      };
      const intent = await old.dispatches.ensure(createSendIntent(request, task.sessionId));
      await old.dispatches.compareAndSet(intent.operationId, intent.revision, {
        status: 'sending',
        sendCalls: 1,
        queryUsed: false,
        queryDueAt: clock + 30000,
        messageId: null,
        resultAt: null,
      });
      await old.tasks.transitionTask({
        taskId: task.taskId,
        inputVersion: 1,
        from: 'ready_to_send',
        to: 'sending',
        now: clock,
      });
      clock += 30000;
      const execute = vi.fn<TaskExecutor>();
      const next = restart(execute);
      const query = vi.spyOn(next.runtime.driver, 'getSendStatus').mockResolvedValue({
        success: status === 'delivered',
        status,
        operationId: intent.operationId,
        ...(status === 'delivered' ? { messageId: '查询确认的原生编号' } : {}),
      });
      await next.recovery.recover();
      await next.scheduler.settled();
      expect(query).toHaveBeenCalledExactlyOnceWith(intent.operationId);
      expect(execute).not.toHaveBeenCalled();
      expect((await old.tasks.getTask(task.taskId))?.status).toBe(
        status === 'unknown' ? 'send_unconfirmed' : 'completed'
      );
      expect(next.runtime.driver.recordedCalls.map(call => call.options?.operationId)).toEqual(
        status === 'failed' ? [intent.operationId] : []
      );
      expect(await old.dispatches.get(intent.operationId)).toMatchObject({
        queryUsed: true,
        sendCalls: status === 'failed' ? 2 : 1,
        queryDueAt: clock,
      });
    }
  );

  it.each([1000, 5000])('collecting重启停机%d毫秒仍沿用原静默截止', async elapsed => {
    const message = await old.ingress(contextMessage(owner, { content: '尚未完成的原聚合' }));
    if (message.status !== 'accepted') throw new Error('聚合输入未通过');
    const { context } = await old.contexts.resolve(owner, false);
    const [batch] = await old.chat.collectMessage(
      { status: 'message', botId: owner.botId, message: message.message, context },
      { quietMs: 5000, maxWaitMs: 60000, maxMessages: 10, maxChars: 30000 },
      () => clock
    );
    clock += elapsed;
    const execute = vi.fn<TaskExecutor>(() =>
      Promise.resolve({ kind: 'answer', text: '恢复聚合的答案' })
    );
    const next = restart(execute);
    await next.recovery.recover();
    await next.scheduler.settled();
    const stored = await old.chat.getCollectedBatch(batch!.batchId);
    expect(stored).toMatchObject({
      quietDeadline: batch!.quietDeadline,
      maxDeadline: batch!.maxDeadline,
    });
    if (elapsed < 5000) {
      expect(stored?.status).toBe('collecting');
      expect(execute).not.toHaveBeenCalled();
    } else {
      expect(stored?.finishedAt).toBe(batch!.quietDeadline);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(execute.mock.calls[0]?.[0].task.queueDeadline).toBe(batch!.quietDeadline + 600000);
    }
  });

  it.each(['ready_to_send', 'sending'] as const)(
    '%s缺少可恢复正文时失败并通知，不永久阻塞会话',
    async status => {
      const task = await seed();
      const { attempt } = await claim(task);
      await old.tasks.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: clock,
        errorType: null,
      });
      await old.tasks.adoptAttempt({
        taskId: task.taskId,
        inputVersion: 1,
        attemptId: attempt.attemptId,
        answerText: '已检查正文',
        now: clock,
      });
      if (status === 'sending')
        await old.tasks.transitionTask({
          taskId: task.taskId,
          inputVersion: 1,
          from: 'ready_to_send',
          to: 'sending',
          now: clock,
        });
      // 模拟旧记录没有保存正文；不能从摘要猜造正文，也不能重跑Agent补答案。
      await db.poolA.query('UPDATE kairo.tasks SET answer_text=NULL WHERE task_id=$1', [
        task.taskId,
      ]);
      const execute = vi.fn<TaskExecutor>();
      const next = restart(execute);
      await next.recovery.recover();
      await next.scheduler.settled();
      expect((await old.tasks.getTask(task.taskId))?.status).toBe('failed');
      expect(execute).not.toHaveBeenCalled();
      const notices = await db.poolA.query(
        'SELECT purpose,status FROM kairo.send_dispatches WHERE task_id=$1',
        [task.taskId]
      );
      expect(notices.rows).toEqual([{ purpose: 'notice:recovery_failure', status: 'delivered' }]);
    }
  );
});
