import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import {
  executionDeadline,
  waitedAt,
  waitDeadline,
  remainingExecutionMs,
  question,
  allowedQuestionIds,
  scopeFor,
  message,
  claimedFixture,
  startAttempt,
  successfulAttempt,
  waitingFixture,
  runningFixture,
} from '../helpers/task-fixtures.js';

let database: TaskTestDatabase;
let storeA: PostgresTaskStore;
let storeB: PostgresTaskStore;
let chat: PostgresPrivateChatStore;

beforeAll(async () => {
  database = await createTaskTestDatabase();
  storeA = new PostgresTaskStore(database.poolA);
  storeB = new PostgresTaskStore(database.poolB);
  chat = new PostgresPrivateChatStore(database.poolA);
}, 30_000);

afterAll(async () => {
  await database?.close();
}, 30_000);

describe('T19 员工等待、授权预算与消费竞争', () => {
  it('等待采用澄清尝试并保存问题范围，同意关联原始回答且只恢复剩余执行预算', async () => {
    const fixture = await waitingFixture(storeA, chat);
    expect(await storeB.getUserWait(fixture.waitId)).toEqual({
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
    expect(await storeB.getAttempt(fixture.attemptId)).toMatchObject({ adopted: true });
    const acceptedAt = waitDeadline - 1;
    const answerMessage = await message(chat, fixture.scope, acceptedAt);
    expect(
      await storeB.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: acceptedAt,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    const resumed = await storeA.getTask(fixture.taskId);
    expect(resumed).toMatchObject({
      status: 'running',
      currentAttemptId: null,
      executionDeadline: acceptedAt + remainingExecutionMs,
      queueDeadline: fixture.input.queueDeadline,
      endedAt: null,
    });
    if (!resumed || resumed.executionDeadline === null) throw new Error('等待恢复未保存执行截止');
    expect(resumed.executionDeadline - acceptedAt).toBe(remainingExecutionMs);
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: 'accepted',
      closedAt: acceptedAt,
      answerMessage,
      allowedQuestionIds,
    });
    expect(
      await storeA.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: acceptedAt,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
    expect(await storeB.getTask(fixture.taskId)).toEqual(resumed);
    // 第二轮等待消耗恢复后的实际运行时间，不能把预算恢复为原始全额。
    const fresh = await startAttempt(storeA, fixture, { startedAt: acceptedAt + 111 });
    expect(
      await storeA.finishAttempt({
        attemptId: fresh.attemptId,
        finishedAt: acceptedAt + 222,
        errorType: null,
      })
    ).toBe(true);
    const secondWaitId = randomUUID();
    expect(
      await storeA.waitForUser({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: acceptedAt + 333,
        attemptId: fresh.attemptId,
        waitId: secondWaitId,
        question,
        allowedQuestionIds: ['当前问题/缺失项乙'],
      })
    ).toBe(true);
    expect(await storeB.getUserWait(secondWaitId)).toMatchObject({
      remainingExecutionMs: remainingExecutionMs - 333,
      deadline: acceptedAt + 333 + 600_000,
    });
  });

  it('等待 declined 原子关闭记录，旧回答不能恢复终态', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const at = waitedAt + 500;
    const answerMessage = await message(chat, fixture.scope, at);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: at };
    expect(
      await storeB.resolveUserWait({
        ...version,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'declined',
      })
    ).toBe(true);
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: 'declined',
      closedAt: at,
      answerMessage: answerMessage,
    });
    expect(await storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'cancelled',
      endedAt: at,
    });
    expect(
      await storeA.resolveUserWait({
        ...version,
        now: at + 1,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
  });

  it('等待 cancelled 原子关闭记录，旧回答不能恢复终态', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const at = waitedAt + 500;
    const answerMessage = await message(chat, fixture.scope, at);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: at };
    expect(
      await storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'cancelled' })
    ).toBe(true);
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: 'cancelled',
      closedAt: at,
      answerMessage: null,
    });
    expect(await storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'cancelled',
      endedAt: at,
    });
    expect(
      await storeA.resolveUserWait({
        ...version,
        now: at + 1,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
  });

  it('等待 timed_out 原子关闭记录，旧回答不能恢复终态', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const at = waitDeadline;
    const answerMessage = await message(chat, fixture.scope, at);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: at };
    expect(
      await storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'timed_out' })
    ).toBe(true);
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: 'timed_out',
      closedAt: at,
      answerMessage: null,
    });
    expect(await storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'timed_out',
      endedAt: at,
    });
    expect(
      await storeA.resolveUserWait({
        ...version,
        now: at + 1,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
  });

  it('等待只接受本员工会话的入站原始消息，并拒绝无身份、缺失、过早和未来回答', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const at = waitedAt + 1_000;
    const otherEmployee = scopeFor();
    const invalidAnswers = [
      await message(chat, otherEmployee, at),
      await message(chat, fixture.scope, at, {}, false),
      await message(chat, fixture.scope, at, { direction: 'outbound' }),
      await message(chat, fixture.scope, at, { direction: 'unknown' }),
      await message(chat, fixture.scope, waitedAt - 1),
      await message(chat, fixture.scope, at + 1),
      { sessionId: fixture.scope.sessionId, messageId: randomUUID() },
    ];
    const beforeTask = await storeA.getTask(fixture.taskId);
    const beforeWait = await storeA.getUserWait(fixture.waitId);
    for (const answerMessage of invalidAnswers) {
      expect(
        await storeB.resolveUserWait({
          taskId: fixture.taskId,
          inputVersion: 1,
          now: at,
          waitId: fixture.waitId,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(false);
      expect(await storeA.getTask(fixture.taskId)).toEqual(beforeTask);
      expect(await storeA.getUserWait(fixture.waitId)).toEqual(beforeWait);
    }
    const answerMessage = await message(chat, fixture.scope, waitedAt);
    expect(
      await storeB.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 2,
        now: at,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
    const otherTask = await claimedFixture(storeA, chat);
    expect(
      await storeB.resolveUserWait({
        taskId: otherTask.taskId,
        inputVersion: 1,
        now: at,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(false);
    expect(
      await storeB.resolveUserWait({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: at,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect((await storeA.getUserWait(fixture.waitId))?.answerMessage).toEqual(answerMessage);
  });

  it('同一 bot/session 并发等待仅一个成功，失败不能留下半截等待或采用记录', async () => {
    const scope = scopeFor();
    const first = await claimedFixture(storeA, chat, scope);
    const second = await claimedFixture(storeA, chat, scope);
    const firstAttempt = await successfulAttempt(storeA, first);
    const secondAttempt = await successfulAttempt(storeA, second);
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
      storeA.waitForUser(inputs[0]),
      storeB.waitForUser(inputs[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    const loser = inputs[results[0] ? 1 : 0];
    expect(await storeA.getUserWait(winner.waitId)).toMatchObject({ closedAt: null });
    expect(await storeA.getUserWait(loser.waitId)).toBeNull();
    expect(await storeA.getTask(loser.taskId)).toMatchObject({
      status: 'running',
      currentAttemptId: loser.attemptId,
      executionDeadline,
    });
    expect(await storeA.getAttempt(loser.attemptId)).toMatchObject({ adopted: false });
    expect(
      await storeB.transitionTask({
        taskId: winner.taskId,
        inputVersion: 1,
        now: waitedAt + 1,
        from: 'waiting_for_user',
        to: 'cancelled',
      })
    ).toBe(true);
    expect(await storeB.waitForUser({ ...loser, now: waitedAt + 2 })).toBe(true);
  });

  it('同一原始回答不能消费两个等待，不同 bot 的相同私聊可各自开放等待', async () => {
    const firstScope = scopeFor();
    const secondScope = { ...firstScope, botId: randomUUID() };
    const first = await waitingFixture(storeA, chat, firstScope);
    const second = await waitingFixture(storeA, chat, secondScope);
    const answerMessage = await message(chat, firstScope, waitedAt + 100);
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
      storeA.resolveUserWait(inputs[0]),
      storeB.resolveUserWait(inputs[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    const loser = inputs[results[0] ? 1 : 0];
    expect(await storeA.getUserWait(winner.waitId)).toMatchObject({
      resolution: 'accepted',
      answerMessage,
    });
    expect(await storeA.getUserWait(loser.waitId)).toMatchObject({
      resolution: null,
      closedAt: null,
      answerMessage: null,
    });
    expect(await storeA.getTask(loser.taskId)).toMatchObject({
      status: 'waiting_for_user',
      executionDeadline,
    });
  });

  it('两个不同回答竞争同一等待只消费一次，败方不能覆盖决定与执行截止', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const answers = [
      await message(chat, fixture.scope, waitedAt + 100),
      await message(chat, fixture.scope, waitedAt + 200),
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
      storeA.resolveUserWait(inputs[0]),
      storeB.resolveUserWait(inputs[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      resolution: winner.decision,
      answerMessage: winner.answerMessage,
      closedAt: winner.now,
    });
    expect(await storeA.getTask(fixture.taskId)).toMatchObject(
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

  it('执行截止拒绝开启等待，前一毫秒不能超时，恰好截止可超时', async () => {
    const fixture = await runningFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'running',
        to: 'timed_out',
      })
    ).toBe(false);
    const waitId = randomUUID();
    expect(
      await storeB.waitForUser({
        ...version,
        attemptId: fixture.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await storeA.getUserWait(waitId)).toBeNull();
    expect(await storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })).toBe(
      true
    );
  });

  it('执行截止前一毫秒仍可等待且只保存一毫秒预算', async () => {
    const waitBefore = await runningFixture(storeA, chat);
    const lastWaitId = randomUUID();
    expect(
      await storeA.waitForUser({
        taskId: waitBefore.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        attemptId: waitBefore.attemptId,
        waitId: lastWaitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(true);
    expect(await storeB.getUserWait(lastWaitId)).toMatchObject({ remainingExecutionMs: 1 });
  });

  it('等待截止拒绝同意和拒绝回答，只允许超时；前一毫秒不能超时', async () => {
    const waiting = await waitingFixture(storeA, chat);
    const answerMessage = await message(chat, waiting.scope, waitDeadline - 1);
    const waitVersion = { taskId: waiting.taskId, inputVersion: 1, now: waitDeadline };
    expect(
      await storeB.transitionTask({
        ...waitVersion,
        now: waitDeadline - 1,
        from: 'waiting_for_user',
        to: 'timed_out',
      })
    ).toBe(false);
    for (const decision of ['accepted', 'declined'] as const) {
      expect(
        await storeB.resolveUserWait({
          ...waitVersion,
          waitId: waiting.waitId,
          answerMessage,
          decision,
        })
      ).toBe(false);
    }
    expect(
      await storeB.transitionTask({ ...waitVersion, from: 'waiting_for_user', to: 'timed_out' })
    ).toBe(true);
  });
});
