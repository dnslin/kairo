import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  allowedQuestionIds,
  createTaskTestContext,
  question,
  waitedAt,
  waitDeadline,
  type TaskTestContext,
} from '../helpers/task-fixtures.js';

let context: TaskTestContext;
beforeAll(async () => {
  context = await createTaskTestContext();
}, 30_000);
afterEach(() => {
  vi.restoreAllMocks();
});
afterAll(async () => {
  await context?.database.close();
}, 30_000);

async function twoWaitRounds() {
  const fixture = await context.runningWithSuccessfulAttempt();
  const prefix = randomUUID();
  const firstWaitId = `${prefix}-z`;
  const secondWaitId = `${prefix}-a`;
  const version = { taskId: fixture.taskId, inputVersion: 1 };
  expect(
    await context.storeA.waitForUser({
      ...version,
      attemptId: fixture.attemptId,
      waitId: firstWaitId,
      now: waitedAt,
      question,
      allowedQuestionIds,
    })
  ).toBe(true);
  const answerMessage = await context.message(fixture.scope, waitedAt);
  expect(
    await context.storeA.resolveUserWait({
      ...version,
      now: waitedAt,
      waitId: firstWaitId,
      answerMessage,
      decision: 'accepted',
    })
  ).toBe(true);
  expect(await context.storeA.resumeTask({ ...version, now: waitedAt })).not.toBeNull();
  const attempt = await context.startAttempt(fixture, context.storeA, { startedAt: waitedAt });
  expect(
    await context.storeA.finishAttempt({
      attemptId: attempt.attemptId,
      finishedAt: waitedAt,
      errorType: null,
    })
  ).toBe(true);
  expect(
    await context.storeA.waitForUser({
      ...version,
      attemptId: attempt.attemptId,
      waitId: secondWaitId,
      now: waitedAt,
      question: '第二轮独立确认？',
      allowedQuestionIds,
    })
  ).toBe(true);
  return { ...fixture, version, firstWaitId, secondWaitId };
}

describe('T25 PostgreSQL 当前员工等待指针', () => {
  it('同毫秒两轮且旧 ID 更大时，第二轮未回答绝不借用第一轮 accepted 恢复', async () => {
    const fixture = await twoWaitRounds();
    expect(await context.storeB.resumeTask({ ...fixture.version, now: waitedAt + 1 })).toBeNull();
    expect(await context.storeB.getTaskWait(fixture.taskId)).toMatchObject({
      waitId: fixture.secondWaitId,
      createdAt: waitedAt,
      closedAt: null,
      resolution: null,
    });
    expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
      status: 'waiting_for_user',
      currentWaitId: fixture.secondWaitId,
    });
    expect(await context.storeB.getUserWait(fixture.firstWaitId)).toMatchObject({
      resolution: 'accepted',
      closedAt: waitedAt,
    });
  });

  it('同毫秒取消必须关闭第二轮开放等待，并保留第一轮回答审计', async () => {
    const fixture = await twoWaitRounds();
    expect(
      await context.storeB.transitionTask({
        ...fixture.version,
        now: waitedAt + 1,
        from: 'waiting_for_user',
        to: 'cancelled',
      })
    ).toBe(true);
    expect(await context.storeA.getUserWait(fixture.secondWaitId)).toMatchObject({
      resolution: 'cancelled',
      closedAt: waitedAt + 1,
    });
    expect(await context.storeA.getUserWait(fixture.firstWaitId)).toMatchObject({
      resolution: 'accepted',
      closedAt: waitedAt,
    });
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({ status: 'cancelled' });
  });

  it('等待交付仅允许当前开放轮次，已回答旧轮次不回调且普通输出合同不被等待条件污染', async () => {
    const fixture = await twoWaitRounds();
    vi.spyOn(Date, 'now').mockReturnValue(waitedAt + 1);
    const delivered: string[] = [];
    const oldScope = { ...fixture.version, userWaitId: fixture.firstWaitId };
    expect(
      await context.storeB.withTaskOutput(oldScope, () => delivered.push('旧轮次'))
    ).toBeNull();
    const currentScope = { ...fixture.version, userWaitId: fixture.secondWaitId };
    expect(
      await context.storeB.withTaskOutput(currentScope, () => delivered.push('当前轮次'))
    ).toEqual({ value: 1 });
    const answerMessage = await context.message(fixture.scope, waitedAt + 2);
    expect(
      await context.storeA.resolveUserWait({
        ...fixture.version,
        now: waitedAt + 2,
        waitId: fixture.secondWaitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect(
      await context.storeB.withTaskOutput(currentScope, () => delivered.push('已回答'))
    ).toBeNull();
    expect(
      await context.storeB.withTaskOutput(fixture.version, () => delivered.push('普通输出'))
    ).toEqual({ value: 2 });
    expect(delivered).toEqual(['当前轮次', '普通输出']);
  });

  it('等待交付在真实 SQL 锁释放后按交付时刻检查截止，恰好到期不得调用消费者', async () => {
    const fixture = await context.waitingFixture();
    const blocker = await context.database.poolA.connect();
    const pid = (
      await context.database.poolB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
    ).rows[0]!.pid;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(waitDeadline - 1);
    const scope = { taskId: fixture.taskId, inputVersion: 1, userWaitId: fixture.waitId };
    let deliveries = 0;
    let pending: Promise<{ value: number } | null> | undefined;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT thread_id FROM kairo.contexts WHERE thread_id = $1 FOR UPDATE', [
        fixture.context.threadId,
      ]);
      pending = context.storeB.withTaskOutput(scope, () => ++deliveries);
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
      clock.mockReturnValue(waitDeadline);
      await blocker.query('COMMIT');
      expect(await pending).toBeNull();
      expect(deliveries).toBe(0);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await pending;
    }
  });
});
