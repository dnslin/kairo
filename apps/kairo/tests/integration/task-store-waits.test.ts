import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTaskTestContext,
  type TaskTestContext,
  executionDeadline,
  waitedAt,
  waitDeadline,
  remainingExecutionMs,
  question,
  allowedQuestionIds,
} from '../helpers/task-fixtures.js';

let context: TaskTestContext;
beforeAll(async () => {
  context = await createTaskTestContext();
}, 30_000);
afterAll(async () => {
  await context?.database.close();
}, 30_000);

describe('T19 任务账本-waits', () => {
  it('等待采用澄清尝试并保存问题范围，同意关联原始回答且只恢复剩余执行预算', async () => {
    const fixture = await context.waitingFixture();
    expect(await context.storeB.getUserWait(fixture.waitId)).toEqual({
      waitId: fixture.waitId,
      taskId: fixture.taskId,
      inputVersion: 1,
      question,
      allowedQuestionIds,
      createdAt: waitedAt,
      deadline: waitDeadline,
      remainingExecutionMs,
      closedAt: null,
      resolution: null,
      answerMessage: null,
    });
    expect(await context.storeB.getAttempt(fixture.attemptId)).toMatchObject({ adopted: true });
    const acceptedAt = waitDeadline - 1;
    const answerMessage = await context.message(fixture.scope, acceptedAt);
    expect(
      await context.storeB.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: acceptedAt,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    const resumed = await context.storeA.getTask(fixture.taskId);
    expect(resumed).toMatchObject({
      status: 'running',
      currentAttemptId: null,
      executionDeadline: acceptedAt + remainingExecutionMs,
      queueDeadline: fixture.input.queueDeadline,
      endedAt: null,
    });
    expect(resumed!.executionDeadline! - acceptedAt).toBe(remainingExecutionMs);
    expect(await context.storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: 'accepted',
      closedAt: acceptedAt,
      answerMessage,
      allowedQuestionIds,
    });
    expect(
      await context.storeA.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: acceptedAt,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
    expect(await context.storeB.getTask(fixture.taskId)).toEqual(resumed);
    // 第二轮等待消耗恢复后的实际运行时间，不能把预算恢复为原始全额。
    const fresh = await context.startAttempt(fixture, context.storeA, {
      startedAt: acceptedAt + 111,
    });
    expect(
      await context.storeA.finishAttempt({
        attemptId: fresh.attemptId,
        finishedAt: acceptedAt + 222,
        errorType: null,
      })
    ).toBe(true);
    const secondWaitId = randomUUID();
    expect(
      await context.storeA.waitForUser({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: acceptedAt + 333,
        attemptId: fresh.attemptId,
        waitId: secondWaitId,
        question,
        allowedQuestionIds: ['当前问题/缺失项乙'],
      })
    ).toBe(true);
    expect(await context.storeB.getUserWait(secondWaitId)).toMatchObject({
      remainingExecutionMs: remainingExecutionMs - 333,
      deadline: acceptedAt + 333 + 600000,
    });
  });

  it('拒绝、显式取消和等待超时均原子关闭等待，旧回答不能恢复终态', async () => {
    for (const resolution of ['declined', 'cancelled', 'timed_out'] as const) {
      const fixture = await context.waitingFixture();
      const at = resolution === 'timed_out' ? waitDeadline : waitedAt + 500;
      const answerMessage = await context.message(fixture.scope, at);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: at };
      const changed =
        resolution === 'declined'
          ? await context.storeB.resolveUserWait({
              ...version,
              waitId: fixture.waitId,
              answerMessage,
              decision: 'declined',
            })
          : await context.storeB.transitionTask({
              ...version,
              from: 'waiting_for_user',
              to: resolution,
            });
      expect(changed, resolution).toBe(true);
      expect(await context.storeA.getUserWait(fixture.waitId)).toMatchObject({
        resolution,
        closedAt: at,
        answerMessage: resolution === 'declined' ? answerMessage : null,
      });
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        status: resolution === 'timed_out' ? 'timed_out' : 'cancelled',
        endedAt: at,
      });
      expect(
        await context.storeA.resolveUserWait({
          ...version,
          now: at + 1,
          waitId: fixture.waitId,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(false);
    }
  });

  it('等待只接受本员工会话的入站原始消息，并拒绝无身份、缺失、过早和未来回答', async () => {
    const fixture = await context.waitingFixture();
    const at = waitedAt + 1000;
    const otherEmployee = context.scopeFor();
    const invalidAnswers = [
      await context.message(otherEmployee, at),
      await context.message(fixture.scope, at, {}, false),
      await context.message(fixture.scope, at, { direction: 'outbound' }),
      await context.message(fixture.scope, at, { direction: 'unknown' }),
      await context.message(fixture.scope, waitedAt - 1),
      await context.message(fixture.scope, at + 1),
      { sessionId: fixture.scope.sessionId, messageId: randomUUID() },
    ];
    const beforeTask = await context.storeA.getTask(fixture.taskId);
    const beforeWait = await context.storeA.getUserWait(fixture.waitId);
    for (const answerMessage of invalidAnswers) {
      expect(
        await context.storeB.resolveUserWait({
          taskId: fixture.taskId,
          inputVersion: 1,
          now: at,
          waitId: fixture.waitId,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(false);
      expect(await context.storeA.getTask(fixture.taskId)).toEqual(beforeTask);
      expect(await context.storeA.getUserWait(fixture.waitId)).toEqual(beforeWait);
    }
    const answerMessage = await context.message(fixture.scope, waitedAt);
    expect(
      await context.storeB.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 2,
        now: at,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
    const otherTask = await context.runningFixture();
    expect(
      await context.storeB.resolveUserWait({
        taskId: otherTask.taskId,
        inputVersion: 1,
        now: at,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
    expect(
      await context.storeB.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: at,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect((await context.storeA.getUserWait(fixture.waitId))?.answerMessage).toEqual(
      answerMessage
    );
  });

  it('同一 bot/session 并发等待仅一个成功，失败不能留下半截等待或采用记录', async () => {
    const scope = context.scopeFor();
    const first = await context.runningFixture(scope);
    const second = await context.runningFixture(scope);
    const firstAttempt = await context.successfulAttempt(first);
    const secondAttempt = await context.successfulAttempt(second);
    const inputs = [
      {
        taskId: first.taskId,
        inputVersion: 1,
        now: waitedAt,
        attemptId: firstAttempt.attemptId,
        waitId: randomUUID(),
        question,
        allowedQuestionIds,
      },
      {
        taskId: second.taskId,
        inputVersion: 1,
        now: waitedAt,
        attemptId: secondAttempt.attemptId,
        waitId: randomUUID(),
        question,
        allowedQuestionIds,
      },
    ] as const;
    const results = await Promise.all([
      context.storeA.waitForUser(inputs[0]),
      context.storeB.waitForUser(inputs[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    const loser = inputs[results[0] ? 1 : 0];
    expect(await context.storeA.getUserWait(winner.waitId)).toMatchObject({ closedAt: null });
    expect(await context.storeA.getUserWait(loser.waitId)).toBeNull();
    expect(await context.storeA.getTask(loser.taskId)).toMatchObject({
      status: 'running',
      currentAttemptId: loser.attemptId,
      executionDeadline,
    });
    expect(await context.storeA.getAttempt(loser.attemptId)).toMatchObject({ adopted: false });
    expect(
      await context.storeB.transitionTask({
        taskId: winner.taskId,
        inputVersion: 1,
        now: waitedAt + 1,
        from: 'waiting_for_user',
        to: 'cancelled',
      })
    ).toBe(true);
    expect(await context.storeB.waitForUser({ ...loser, now: waitedAt + 2 })).toBe(true);
  });

  it('同一原始回答不能消费两个等待，不同 bot 的相同私聊可各自开放等待', async () => {
    const firstScope = context.scopeFor();
    const secondScope = { ...firstScope, botId: randomUUID() };
    const first = await context.waitingFixture(firstScope);
    const second = await context.waitingFixture(secondScope);
    const answerMessage = await context.message(firstScope, waitedAt + 100);
    const inputs = [
      {
        taskId: first.taskId,
        inputVersion: 1,
        now: waitedAt + 200,
        waitId: first.waitId,
        answerMessage,
        decision: 'accepted',
      },
      {
        taskId: second.taskId,
        inputVersion: 1,
        now: waitedAt + 200,
        waitId: second.waitId,
        answerMessage,
        decision: 'accepted',
      },
    ] as const;
    const results = await Promise.all([
      context.storeA.resolveUserWait(inputs[0]),
      context.storeB.resolveUserWait(inputs[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    const loser = inputs[results[0] ? 1 : 0];
    expect(await context.storeA.getUserWait(winner.waitId)).toMatchObject({
      resolution: 'accepted',
      answerMessage,
    });
    expect(await context.storeA.getUserWait(loser.waitId)).toMatchObject({
      resolution: null,
      closedAt: null,
      answerMessage: null,
    });
    expect(await context.storeA.getTask(loser.taskId)).toMatchObject({
      status: 'waiting_for_user',
      executionDeadline,
    });
  });

  it('两个不同回答竞争同一等待只消费一次，败方不能覆盖决定与执行截止', async () => {
    const fixture = await context.waitingFixture();
    const answers = [
      await context.message(fixture.scope, waitedAt + 100),
      await context.message(fixture.scope, waitedAt + 200),
    ] as const;
    const inputs = [
      {
        taskId: fixture.taskId,
        inputVersion: 1,
        now: waitedAt + 300,
        waitId: fixture.waitId,
        answerMessage: answers[0],
        decision: 'accepted' as const,
      },
      {
        taskId: fixture.taskId,
        inputVersion: 1,
        now: waitedAt + 400,
        waitId: fixture.waitId,
        answerMessage: answers[1],
        decision: 'declined' as const,
      },
    ] as const;
    const results = await Promise.all([
      context.storeA.resolveUserWait(inputs[0]),
      context.storeB.resolveUserWait(inputs[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    expect(await context.storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: winner.decision,
      answerMessage: winner.answerMessage,
      closedAt: winner.now,
    });
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject(
      winner.decision === 'accepted'
        ? {
            status: 'running',
            endedAt: null,
            currentAttemptId: null,
            executionDeadline: winner.now + remainingExecutionMs,
          }
        : { status: 'cancelled', endedAt: winner.now, executionDeadline }
    );
  });
});
