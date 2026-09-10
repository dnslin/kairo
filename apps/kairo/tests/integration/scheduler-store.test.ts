import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Task } from '../../src/modules/task-lifecycle/types.js';
import {
  createTaskTestContext,
  type TaskTestContext,
  now,
  claimedAt,
  executionMs,
  executionDeadline,
  waitedAt,
  waitDeadline,
  remainingExecutionMs,
} from '../helpers/task-fixtures.js';

let context: TaskTestContext;
beforeAll(async () => {
  context = await createTaskTestContext();
}, 30_000);
afterAll(async () => {
  await context?.database.close();
}, 30_000);

async function readyBatch(scope = context.scopeFor(), createdAt = now) {
  const fixture = await context.batchFixture(scope);
  expect(await context.chat.setBatchStatus(fixture.batch.batchId, 'ready')).toBe(true);
  await context.database.poolA.query(
    'UPDATE kairo.message_batches SET finished_at = $2 WHERE batch_id = $1',
    [fixture.batch.batchId, new Date(createdAt)]
  );
  return {
    ...fixture,
    input: {
      taskId: randomUUID(),
      batchId: fixture.batch.batchId,
      configDigest: '调度存储配置摘要',
      now: createdAt,
      queueDeadline: createdAt + 60_000,
      queueLimit: 3,
    },
  };
}

describe('T25 PostgreSQL 调度存储', () => {
  it('双连接竞争最多接纳三个 queued，满队列拒绝持久化且重放不重新入队', async () => {
    const scope = context.scopeFor();
    const batches = [];
    for (let index = 0; index < 4; index++) batches.push(await readyBatch(scope, now + index));
    const results = await Promise.all(
      batches.map((batch, index) =>
        (index % 2 === 0 ? context.storeA : context.storeB).enqueueTask(batch.input)
      )
    );
    expect(results.filter(result => result.status === 'accepted')).toHaveLength(3);
    expect(results.filter(result => result.status === 'full')).toHaveLength(1);
    const active = (await context.storeA.listActiveTasks()).filter(
      task => task.botId === scope.botId
    );
    expect(active.map(task => task.status)).toEqual(['queued', 'queued', 'queued']);
    expect(active.filter(task => task.queueNoticeRequired)).toHaveLength(2);
    const rejected = batches[results.findIndex(result => result.status === 'full')]!;
    const row = await context.database.poolA.query(
      'SELECT status, rejection_reason, finished_at FROM kairo.message_batches WHERE batch_id = $1',
      [rejected.batch.batchId]
    );
    expect(row.rows[0]).toEqual({
      status: 'rejected',
      rejection_reason: 'queue_full',
      finished_at: new Date(rejected.input.now),
    });
    expect(await context.chat.getRawMessage(rejected.firstMessage)).not.toBeNull();
    expect(await context.storeA.getTask(rejected.input.taskId)).toBeNull();
    expect(
      await context.storeA.transitionTask({
        taskId: active[0]!.taskId,
        inputVersion: 1,
        now: now + 10,
        from: 'queued',
        to: 'cancelled',
      })
    ).toBe(true);
    expect(await context.storeB.enqueueTask({ ...rejected.input, taskId: randomUUID() })).toEqual({
      status: 'full',
    });
    await context.chat.prepareContext(scope, () => now + 20, { reset: true, idleMs: null });
    expect(await context.storeA.enqueueTask(rejected.input)).toEqual({ status: 'stale' });
    expect(
      (await context.storeA.listActiveTasks()).filter(task => task.botId === scope.botId)
    ).toEqual([]);
  });

  it('同批次双连接只创建一个任务，重放保留原任务和原排队提示决定', async () => {
    const batch = await readyBatch();
    const results = await Promise.all([
      context.storeA.enqueueTask(batch.input),
      context.storeB.enqueueTask({ ...batch.input, taskId: randomUUID() }),
    ]);
    expect(results[0].status).toBe('accepted');
    expect(results[1]).toEqual(results[0]);
    if (results[0].status !== 'accepted') throw new Error('批次未成功入队');
    const original = results[0].task;
    expect(original.queueNoticeRequired).toBe(false);
    const next = await readyBatch(batch.scope, now + 1);
    expect((await context.storeA.enqueueTask(next.input)).status).toBe('accepted');
    expect(await context.storeB.enqueueTask({ ...batch.input, now: now + 2 })).toEqual(results[0]);
    await context.chat.prepareContext(batch.scope, () => now + 3, { reset: true, idleMs: null });
    expect(await context.storeA.enqueueTask(batch.input)).toEqual({ status: 'stale' });
    const collecting = await context.batchFixture();
    expect(
      await context.storeA.enqueueTask({
        ...batch.input,
        batchId: collecting.batch.batchId,
        taskId: randomUUID(),
      })
    ).toEqual({ status: 'stale' });
    expect(await context.chat.setBatchStatus(collecting.batch.batchId, 'discarded')).toBe(true);
    expect(
      await context.storeB.enqueueTask({
        ...batch.input,
        batchId: collecting.batch.batchId,
        taskId: randomUUID(),
      })
    ).toEqual({ status: 'stale' });
  });

  it('同会话按 createdAt/taskId 领取，双连接只赢一次且发送未终态继续阻塞', async () => {
    const scope = context.scopeFor();
    const first = await readyBatch(scope);
    const second = await readyBatch(scope, now + 1);
    await context.storeA.enqueueTask(first.input);
    await context.storeA.enqueueTask(second.input);
    const firstClaim = { taskId: first.input.taskId, inputVersion: 1, now: claimedAt, executionMs };
    const secondClaim = { ...firstClaim, taskId: second.input.taskId };
    expect(await context.storeB.claimTask(secondClaim)).toBeNull();
    const claims = await Promise.all([
      context.storeA.claimTask(firstClaim),
      context.storeB.claimTask(firstClaim),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await context.storeA.claimTask(secondClaim)).toBeNull();
    const attemptId = randomUUID();
    expect(
      await context.storeA.startAttempt({
        ...firstClaim,
        now: now + 200,
        attemptId,
        expectedAttemptId: null,
        runId: randomUUID(),
        configDigest: '实际执行摘要',
      })
    ).not.toBeNull();
    expect(
      await context.storeA.finishAttempt({ attemptId, finishedAt: now + 300, errorType: null })
    ).toBe(true);
    expect(await context.storeA.adoptAttempt({ ...firstClaim, now: now + 400, attemptId })).toBe(
      true
    );
    expect(await context.storeB.claimTask(secondClaim)).toBeNull();
    expect(
      await context.storeA.transitionTask({
        ...firstClaim,
        now: now + 500,
        from: 'ready_to_send',
        to: 'sending',
      })
    ).toBe(true);
    expect(await context.storeB.claimTask(secondClaim)).toBeNull();
    expect(
      await context.storeA.transitionTask({
        ...firstClaim,
        now: now + 600,
        from: 'sending',
        to: 'send_unconfirmed',
      })
    ).toBe(true);
    expect(await context.storeB.claimTask({ ...secondClaim, now: now + 601 })).not.toBeNull();
  });

  it('创建时刻相同时按 taskId 排序而非入队顺序领取', async () => {
    const scope = context.scopeFor();
    const first = await readyBatch(scope);
    const second = await readyBatch(scope);
    const prefix = randomUUID();
    first.input.taskId = `${prefix}-b`;
    second.input.taskId = `${prefix}-a`;
    await context.storeA.enqueueTask(first.input);
    await context.storeB.enqueueTask(second.input);
    expect(
      (await context.storeA.listActiveTasks())
        .filter(task => task.botId === scope.botId)
        .map(task => task.taskId)
    ).toEqual([second.input.taskId, first.input.taskId]);
    expect(
      await context.storeA.claimTask({
        taskId: first.input.taskId,
        inputVersion: 1,
        now: claimedAt,
        executionMs,
      })
    ).toBeNull();
    expect(
      await context.storeB.claimTask({
        taskId: second.input.taskId,
        inputVersion: 1,
        now: claimedAt,
        executionMs,
      })
    ).not.toBeNull();
  });

  it('领取在 context 锁释放后采样时钟，排队截止已到就不能启动', async () => {
    const batch = await readyBatch();
    await context.storeA.enqueueTask(batch.input);
    const blocker = await context.database.poolA.connect();
    const pid = (
      await context.database.poolB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0]!.pid;
    let sampled = 0;
    let clock = claimedAt;
    let pending: Promise<Task | null> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT thread_id FROM kairo.contexts WHERE thread_id = $1 FOR UPDATE', [
        batch.context.threadId,
      ]);
      pending = context.storeB.claimTask({
        taskId: batch.input.taskId,
        inputVersion: 1,
        executionMs,
        now: () => {
          sampled++;
          return clock;
        },
      });
      await expect
        .poll(
          async () =>
            (
              await blocker.query<{ blocked: boolean }>(
                'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
                [pid]
              )
            ).rows[0]!.blocked
        )
        .toBe(true);
      expect(sampled).toBe(0);
      clock = batch.input.queueDeadline;
      await blocker.query('COMMIT');
      expect(await pending).toBeNull();
      expect(sampled).toBe(1);
      expect(await context.storeB.getTask(batch.input.taskId)).toMatchObject({
        status: 'queued',
        executionBudgetMs: null,
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });

  it('员工等待在 context 锁后才暂停预算，锁等待时间计入实际执行', async () => {
    const fixture = await context.runningWithSuccessfulAttempt();
    const blocker = await context.database.poolA.connect();
    const pid = (
      await context.database.poolB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0]!.pid;
    const waitId = randomUUID();
    let sampled = 0;
    let clock = waitedAt;
    let pending: Promise<boolean> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT thread_id FROM kairo.contexts WHERE thread_id = $1 FOR UPDATE', [
        fixture.context.threadId,
      ]);
      pending = context.storeB.waitForUser({
        taskId: fixture.taskId,
        inputVersion: 1,
        attemptId: fixture.attemptId,
        waitId,
        question: '是否继续处理？',
        allowedQuestionIds: ['当前问题'],
        now: () => {
          sampled++;
          return clock;
        },
      });
      await expect
        .poll(
          async () =>
            (
              await blocker.query<{ blocked: boolean }>(
                'SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked',
                [pid]
              )
            ).rows[0]!.blocked
        )
        .toBe(true);
      expect(sampled).toBe(0);
      clock += 1_234;
      await blocker.query('COMMIT');
      expect(await pending).toBe(true);
      expect(await context.storeB.getTaskWait(fixture.taskId)).toMatchObject({
        waitId,
        createdAt: clock,
        deadline: clock + 600_000,
        remainingExecutionMs: executionDeadline - clock,
      });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });

  it('accepted 只关闭回答等待，超过旧截止仍保留预算，双连接实际恢复只成功一次', async () => {
    const fixture = await context.waitingFixture();
    const acceptedAt = waitedAt + 100;
    const answerMessage = await context.message(fixture.scope, acceptedAt);
    const version = { taskId: fixture.taskId, inputVersion: 1 };
    expect(
      await context.storeA.resolveUserWait({
        ...version,
        now: acceptedAt,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
      status: 'waiting_for_user',
      executionDeadline,
      executionStartedAt: claimedAt,
      executionBudgetMs: executionMs,
    });
    expect(await context.storeB.getTaskWait(fixture.taskId)).toMatchObject({
      waitId: fixture.waitId,
      resolution: 'accepted',
      remainingExecutionMs,
      answerMessage,
    });
    expect(
      await context.storeB.transitionTask({
        ...version,
        now: waitDeadline + 1,
        from: 'waiting_for_user',
        to: 'timed_out',
      })
    ).toBe(false);
    const resumedAt = waitDeadline + 100_000;
    const resumes = await Promise.all([
      context.storeA.resumeTask({ ...version, now: () => resumedAt }),
      context.storeB.resumeTask({ ...version, now: () => resumedAt + 1 }),
    ]);
    expect(resumes.filter(Boolean)).toHaveLength(1);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'running',
      executionDeadline: resumedAt + (resumes[0] ? 0 : 1) + remainingExecutionMs,
      executionStartedAt: claimedAt,
      executionBudgetMs: executionMs,
      currentAttemptId: null,
    });
  });

  it('accepted 待槽可取消且保留回答审计，恢复与 /new 竞争不复活失效上下文', async () => {
    for (const reset of [false, true]) {
      const fixture = await context.waitingFixture();
      const version = { taskId: fixture.taskId, inputVersion: 1 };
      const answerMessage = await context.message(fixture.scope, waitedAt + 100);
      expect(
        await context.storeA.resolveUserWait({
          ...version,
          now: waitedAt + 100,
          waitId: fixture.waitId,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(true);
      const accepted = await context.storeA.getTaskWait(fixture.taskId);
      if (reset) {
        await Promise.all([
          context.chat.prepareContext(fixture.scope, () => waitDeadline + 10, {
            reset: true,
            idleMs: null,
          }),
          context.storeB.resumeTask({ ...version, now: () => waitDeadline + 10 }),
        ]);
      } else {
        expect(
          await context.storeB.transitionTask({
            ...version,
            now: waitDeadline + 10,
            from: 'waiting_for_user',
            to: 'cancelled',
          })
        ).toBe(true);
      }
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({ status: 'cancelled' });
      expect(await context.storeB.resumeTask({ ...version, now: waitDeadline + 20 })).toBeNull();
      expect(await context.storeA.getTaskWait(fixture.taskId)).toEqual(accepted);
    }
  });
});
