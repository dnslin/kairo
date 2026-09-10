import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, type Scheduler } from '../../src/modules/task-lifecycle/scheduler.js';
import type {
  TaskExecutor,
  TaskExecutionResult,
} from '../../src/modules/task-lifecycle/task-runner.js';
import { createCollector, type Collector } from '../../src/modules/private-chat-core/collector.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import {
  createContextTestRuntime,
  contextMessage,
  type ContextTestRuntime,
} from '../helpers/context-runtime.js';

let database: TaskTestDatabase;
let runtime: ContextTestRuntime;
let scheduler: Scheduler;
let collector: Collector | undefined;
let clock: number;
let owner: ContextScope;
const runs: Array<{
  input: Parameters<TaskExecutor>[0];
  resolve(result: TaskExecutionResult): void;
}> = [];

beforeAll(async () => {
  database = await createTaskTestDatabase();
}, 30000);
afterAll(async () => {
  await database?.close();
}, 30000);
beforeEach(() => {
  clock = Date.UTC(2026, 8, 10, 10);
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  owner = { botId: randomUUID(), employeeId: '3585', sessionId: '0-3585' };
  runtime = createContextTestRuntime(database.poolA, owner);
  runs.length = 0;
  scheduler = createScheduler({
    ...runtime,
    execute: input =>
      new Promise(resolve => {
        runs.push({ input, resolve });
      }),
    configDigest: 'T25受控执行验证',
    progressMs: 10000,
    queueMs: 600000,
    executionMs: 240000,
    concurrency: { global: 3, perSessionQueue: 3 },
    logger: createLogger({ write(): void {} }),
  });
});
afterEach(async () => {
  try {
    await collector?.close();
    collector = undefined;
    const scopes = await database.poolA.query<{ employee_id: string; session_id: string }>(
      'SELECT employee_id,session_id FROM kairo.contexts WHERE bot_id=$1 AND invalidated_at IS NULL',
      [owner.botId]
    );
    for (const scope of scopes.rows)
      await runtime.contexts.resolve(
        {
          botId: owner.botId,
          employeeId: scope.employee_id,
          sessionId: scope.session_id,
        },
        true
      );
    for (const run of runs) run.resolve({ kind: 'answer', text: '清理受控执行，不是模型回答' });
    await scheduler.close();
  } finally {
    runtime.sender.close();
    vi.restoreAllMocks();
  }
});

async function raw(scope: ContextScope, text = '合成调度问题') {
  const key = { sessionId: scope.sessionId, messageId: randomUUID() };
  await runtime.chat.insertRawMessage({
    ...key,
    direction: 'inbound',
    observedAt: clock,
    text,
    messageType: 'text',
    attachments: {},
  });
  await runtime.chat.associateEmployee(key, scope.employeeId);
  return key;
}

async function enqueue(scope = owner) {
  const { context } = await runtime.contexts.resolve(scope, false);
  const firstMessage = await raw(scope);
  const batch = await runtime.chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage,
    quietDeadline: clock + 5,
    maxDeadline: clock + 60,
  });
  clock += 6;
  const ready = await runtime.chat.finishBatch(batch.batchId, () => clock);
  if (!ready) throw new Error('受控批次未能结束');
  await scheduler.enqueue(ready);
  await scheduler.tick();
  const result = await database.poolA.query<{ task_id: string }>(
    'SELECT task_id FROM kairo.tasks WHERE batch_id=$1',
    [batch.batchId]
  );
  return { batch: ready, taskId: result.rows[0]?.task_id ?? null };
}

async function waitRuns(count: number) {
  await vi.waitFor(() => expect(runs).toHaveLength(count), { timeout: 5000, interval: 5 });
}

async function waitStatus(taskId: string, status: string) {
  await vi.waitFor(
    async () => {
      expect((await runtime.tasks.getTask(taskId))?.status).toBe(status);
    },
    { timeout: 5000, interval: 5 }
  );
}

describe('T25 真实 PostgreSQL 与受控执行器', () => {
  it.each([2, 4, 5])(
    '同会话%d个任务：一个执行、最多三个排队，满额保留消息且重放不能再建任务',
    async count => {
      const entries = [await enqueue()];
      await waitRuns(1);
      for (let index = 1; index < count; index++) entries.push(await enqueue());
      const stored = await database.poolA.query<{ status: string }>(
        'SELECT status FROM kairo.tasks WHERE bot_id=$1 ORDER BY created_at,task_id',
        [owner.botId]
      );
      expect(stored.rows.map(row => row.status)).toEqual([
        'running',
        ...Array.from({ length: Math.min(count - 1, 3) }, () => 'queued'),
      ]);
      const messages = await database.poolA.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM kairo.batch_messages m
       JOIN kairo.message_batches b USING(batch_id) WHERE b.bot_id=$1`,
        [owner.botId]
      );
      expect(messages.rows[0]?.count).toBe(count);
      const notices = await database.poolA.query<{ purpose: string; count: number }>(
        `SELECT purpose,count(*)::int AS count FROM kairo.send_dispatches
       WHERE (task_id IN (SELECT task_id FROM kairo.tasks WHERE bot_id=$1)
       OR purpose='notice:queue_full' AND intent_key LIKE $2)
       GROUP BY purpose`,
        [owner.botId, `%${owner.botId}%`]
      );
      expect(notices.rows.find(row => row.purpose === 'queued')?.count).toBe(
        Math.min(count - 1, 3)
      );
      if (count === 5) {
        expect(entries[4]!.taskId).toBeNull();
        expect(await runtime.chat.getCollectedBatch(entries[4]!.batch.batchId)).toMatchObject({
          status: 'rejected',
          rejection: 'queue_full',
        });
      }
      for (let index = 0; index < Math.min(count, 4); index++) {
        expect(runs[index]!.input.task.taskId).toBe(entries[index]!.taskId);
        runs[index]!.resolve({ kind: 'answer', text: `受控答案${index}` });
        await waitStatus(entries[index]!.taskId!, 'completed');
        if (index + 1 < Math.min(count, 4)) await waitRuns(index + 2);
      }
      if (count === 5) {
        await scheduler.enqueue(entries[4]!.batch, true);
        const rejected = await database.poolA.query(
          'SELECT task_id FROM kairo.tasks WHERE batch_id=$1',
          [entries[4]!.batch.batchId]
        );
        expect(rejected.rows).toEqual([]);
        const full = await database.poolA.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM kairo.send_dispatches
         WHERE purpose='notice:queue_full' AND intent_key LIKE $1`,
          [`%${owner.botId}%`]
        );
        expect(full.rows[0]?.count).toBe(1);
      }
    }
  );

  it('三个真实账本任务跨会话并行，第四个在前项退出后自动开始', async () => {
    const entries = [];
    for (const employeeId of ['3585', '3586', '3587', '3588'])
      entries.push(await enqueue({ ...owner, employeeId, sessionId: `0-${employeeId}` }));
    await waitRuns(3);
    expect((await runtime.tasks.getTask(entries[3]!.taskId!))?.status).toBe('queued');
    runs[0]!.resolve({ kind: 'answer', text: '受控甲答案' });
    await waitRuns(4);
    expect(runs[3]!.input.task.taskId).toBe(entries[3]!.taskId);
  });

  it('员工已同意但全局满时持久等位，拿到名额才恢复剩余三分钟且后项不能越过', async () => {
    const first = await enqueue();
    await waitRuns(1);
    clock += 60000;
    runs[0]!.resolve({
      kind: 'waiting_for_user',
      question: '是否改用通用知识？',
      allowedQuestionIds: ['当前问题'],
    });
    await waitStatus(first.taskId!, 'waiting_for_user');
    await scheduler.settled();
    const wait = await runtime.tasks.getTaskWait(first.taskId!);
    expect(wait?.remainingExecutionMs).toBe(180000);
    const later = await enqueue();
    for (const employeeId of ['3586', '3587', '3588'])
      await enqueue({ ...owner, employeeId, sessionId: `0-${employeeId}` });
    await waitRuns(4);
    clock += 120000;
    const answerMessage = await raw(owner, '可以');
    expect(
      await scheduler.resolveUserWait({
        taskId: first.taskId!,
        inputVersion: 1,
        now: clock,
        waitId: wait!.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect((await runtime.tasks.getTask(first.taskId!))?.status).toBe('waiting_for_user');
    expect((await runtime.tasks.getTask(later.taskId!))?.status).toBe('queued');
    clock += 120000;
    runs[1]!.resolve({ kind: 'answer', text: '让出一个执行名额' });
    await waitRuns(5);
    expect(runs[4]!.input.task.taskId).toBe(first.taskId);
    expect(runs[4]!.input.task.executionDeadline).toBe(clock + 180000);
    expect(runs[4]!.input.task.executionBudgetMs).toBe(240000);
  });

  it('/new立即切换并取消排队，旧执行不退出时新thread等位，迟到结果不交付', async () => {
    const first = await enqueue();
    await waitRuns(1);
    const queued = await enqueue();
    const reset = await runtime.contexts.resolve(owner, true);
    expect(runs[0]!.input.signal.aborted).toBe(true);
    expect((await runtime.tasks.getTask(queued.taskId!))?.status).toBe('cancelled');
    const next = await enqueue();
    expect(next.batch.threadId).toBe(reset.context.threadId);
    await scheduler.tick();
    expect(runs).toHaveLength(1);
    runs[0]!.resolve({ kind: 'answer', text: '必须丢弃的旧答案' });
    await waitRuns(2);
    expect(runs[1]!.input.task.taskId).toBe(next.taskId);
    expect((await runtime.tasks.getTask(first.taskId!))?.status).toBe('cancelled');
    const final = await database.poolA.query(
      `SELECT operation_id FROM kairo.send_dispatches WHERE task_id=$1 AND purpose='final'`,
      [first.taskId]
    );
    expect(final.rows).toEqual([]);
    expect((await runtime.tasks.getAttempt(runs[0]!.input.attempt.attemptId))?.adopted).toBe(false);
  });

  it('排队恰好截止持久超时，通过T21只通知一次并释放后续', async () => {
    await enqueue();
    await waitRuns(1);
    const waiting = await enqueue();
    const task = await runtime.tasks.getTask(waiting.taskId!);
    clock = task!.queueDeadline - 1;
    await scheduler.tick();
    expect((await runtime.tasks.getTask(task!.taskId))?.status).toBe('queued');
    clock++;
    await scheduler.tick();
    await vi.waitFor(async () => {
      const result = await database.poolA.query<{ status: string }>(
        `SELECT status FROM kairo.send_dispatches WHERE task_id=$1 AND purpose='notice:queue_timeout'`,
        [task!.taskId]
      );
      expect(result.rows).toEqual([{ status: 'delivered' }]);
    });
    expect((await runtime.tasks.getTask(task!.taskId))?.status).toBe('timed_out');
    await scheduler.tick();
    expect(runs).toHaveLength(1);
  });

  it('领取完成后立即关闭，不启动执行且不遗留 running 或未结束尝试', async () => {
    let closing: Promise<void> | undefined;
    const claim = runtime.tasks.claimTask.bind(runtime.tasks);
    vi.spyOn(runtime.tasks, 'claimTask').mockImplementation(input => {
      const claimed = claim(input);
      // 领取续体先执行；关闭随后发生在旧版延迟的 runner.run 之前。
      void claimed.then(() => {
        globalThis.queueMicrotask(() => {
          closing = scheduler.close();
        });
      });
      return claimed;
    });
    const { taskId } = await enqueue();
    await vi.waitFor(() => expect(closing).toBeDefined());
    await closing;
    expect(runs).toEqual([]);
    expect((await runtime.tasks.getTask(taskId!))?.status).toBe('cancelled');
    const unfinished = await database.poolB.query(
      'SELECT attempt_id FROM kairo.task_attempts WHERE task_id=$1 AND finished_at IS NULL',
      [taskId]
    );
    expect(unfinished.rows).toEqual([]);
  });

  it('真实入站到Collector的原生静默结束只交付一个任务，重复入站不再建账', async () => {
    collector = createCollector({
      botId: owner.botId,
      store: runtime.chat,
      contexts: runtime.contexts,
      sender: runtime.sender,
      deliverReady: scheduler.enqueue,
      batching: { quietMs: 10, maxWaitMs: 1000, maxMessages: 10, maxChars: 30000 },
      logger: createLogger({ write(): void {} }),
    });
    const message = contextMessage(owner, { content: 'T25受控入站，不是真实KK9消息' });
    await collector.accept(await runtime.ingress(message));
    clock += 11;
    await waitRuns(1);
    await collector.settled();
    expect(await collector.accept(await runtime.ingress(message))).toEqual({ status: 'duplicate' });
    const stored = await database.poolA.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM kairo.tasks WHERE bot_id=$1',
      [owner.botId]
    );
    expect(stored.rows[0]?.count).toBe(1);
  });
});
