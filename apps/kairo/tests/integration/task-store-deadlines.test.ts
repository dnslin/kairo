import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTaskTestContext,
  type TaskTestContext,
  executionMs,
  executionDeadline,
  waitDeadline,
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

describe('T19 任务账本截止边界', () => {
  it('claimTask 在队列截止前一毫秒可领取，恰好截止只能超时', async () => {
    const queued = await context.queuedFixture();
    const version = { taskId: queued.taskId, inputVersion: 1, now: queued.input.queueDeadline };
    expect(
      await context.storeA.transitionTask({
        ...version,
        now: version.now - 1,
        from: 'queued',
        to: 'timed_out',
      })
    ).toBe(false);
    expect(await context.storeA.claimTask({ ...version, executionMs })).toBeNull();
    expect(
      await context.storeA.transitionTask({ ...version, from: 'queued', to: 'timed_out' })
    ).toBe(true);

    const before = await context.queuedFixture();
    expect(
      await context.storeB.claimTask({
        taskId: before.taskId,
        inputVersion: 1,
        now: before.input.queueDeadline - 1,
        executionMs,
      })
    ).not.toBeNull();
  });

  it('updateInputVersion 在队列截止前一毫秒可更新且保留截止，恰好截止被拒绝', async () => {
    const queued = await context.queuedFixture();
    const version = { taskId: queued.taskId, inputVersion: 1, now: queued.input.queueDeadline };
    expect(await context.storeA.updateInputVersion(version)).toBe(false);
    expect(
      await context.storeA.transitionTask({ ...version, from: 'queued', to: 'timed_out' })
    ).toBe(true);

    const before = await context.queuedFixture();
    const saved = await context.storeA.getTask(before.taskId);
    expect(
      await context.storeB.updateInputVersion({
        taskId: before.taskId,
        inputVersion: 1,
        now: before.input.queueDeadline - 1,
      })
    ).toBe(true);
    expect(await context.storeA.getTask(before.taskId)).toMatchObject({
      inputVersion: 2,
      currentAttemptId: null,
      queueDeadline: saved!.queueDeadline,
      executionDeadline: saved!.executionDeadline,
    });
  });

  it('startAttempt 在执行截止前一毫秒可替换尝试，恰好截止不留下新尝试', async () => {
    const running = await context.runningWithSuccessfulAttempt();
    const version = { taskId: running.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'running',
        to: 'timed_out',
      })
    ).toBe(false);
    const attemptId = randomUUID();
    expect(
      await context.storeB.startAttempt({
        ...version,
        attemptId,
        expectedAttemptId: running.attemptId,
        runId: randomUUID(),
        configDigest: '边界配置',
      })
    ).toBeNull();
    expect(await context.storeA.getAttempt(attemptId)).toBeNull();
    expect(
      await context.storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })
    ).toBe(true);

    const before = await context.runningWithSuccessfulAttempt();
    const replacement = await context.startAttempt(before, context.storeB, {
      expectedAttemptId: before.attemptId,
      startedAt: executionDeadline - 1,
    });
    expect(await context.storeA.getTask(before.taskId)).toMatchObject({
      currentAttemptId: replacement.attemptId,
      executionDeadline,
    });
  });

  it('adoptAttempt 在执行截止前一毫秒可采用成功尝试，恰好截止只能超时', async () => {
    const running = await context.runningWithSuccessfulAttempt();
    const version = { taskId: running.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'running',
        to: 'timed_out',
      })
    ).toBe(false);
    expect(
      await context.storeB.adoptAttempt({
        answerText: '已检查答案：按当前资料处理问题。',
        ...version,
        attemptId: running.attemptId,
      })
    ).toBe(false);
    expect(
      await context.storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })
    ).toBe(true);

    const before = await context.runningWithSuccessfulAttempt();
    expect(
      await context.storeA.adoptAttempt({
        answerText: '已检查答案：按当前资料处理问题。',
        taskId: before.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        attemptId: before.attemptId,
      })
    ).toBe(true);
  });

  it('waitForUser 在执行截止前一毫秒保存一毫秒余额，恰好截止不留下等待', async () => {
    const running = await context.runningWithSuccessfulAttempt();
    const version = { taskId: running.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'running',
        to: 'timed_out',
      })
    ).toBe(false);
    const waitId = randomUUID();
    expect(
      await context.storeB.waitForUser({
        ...version,
        attemptId: running.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await context.storeA.getUserWait(waitId)).toBeNull();
    expect(
      await context.storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })
    ).toBe(true);

    const before = await context.runningWithSuccessfulAttempt();
    const lastWaitId = randomUUID();
    expect(
      await context.storeA.waitForUser({
        taskId: before.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        attemptId: before.attemptId,
        waitId: lastWaitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(true);
    expect(await context.storeB.getUserWait(lastWaitId)).toMatchObject({ remainingExecutionMs: 1 });
  });

  it('updateInputVersion 在执行截止前一毫秒清除旧尝试且保留截止，恰好截止只能超时', async () => {
    const running = await context.runningWithSuccessfulAttempt();
    const version = { taskId: running.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'running',
        to: 'timed_out',
      })
    ).toBe(false);
    expect(await context.storeB.updateInputVersion(version)).toBe(false);
    expect(
      await context.storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })
    ).toBe(true);

    const before = await context.runningWithSuccessfulAttempt();
    const saved = await context.storeA.getTask(before.taskId);
    expect(
      await context.storeB.updateInputVersion({
        taskId: before.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
      })
    ).toBe(true);
    expect(await context.storeA.getTask(before.taskId)).toMatchObject({
      inputVersion: 2,
      currentAttemptId: null,
      queueDeadline: saved!.queueDeadline,
      executionDeadline: saved!.executionDeadline,
    });
  });

  it('transitionTask 在执行截止前一毫秒可进入 sending，恰好截止只能超时', async () => {
    const ready = await context.readyToSendFixture();
    const version = { taskId: ready.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'ready_to_send',
        to: 'timed_out',
      })
    ).toBe(false);
    expect(
      await context.storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'sending' })
    ).toBe(false);
    expect(
      await context.storeA.transitionTask({ ...version, from: 'ready_to_send', to: 'timed_out' })
    ).toBe(true);

    const before = await context.readyToSendFixture();
    expect(
      await context.storeB.transitionTask({
        taskId: before.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        from: 'ready_to_send',
        to: 'sending',
      })
    ).toBe(true);
  });

  it('resolveUserWait 在等待截止前一毫秒尚不能超时，恰好截止拒绝接受和拒绝决定', async () => {
    const waiting = await context.waitingFixture();
    const answerMessage = await context.message(waiting.scope, waitDeadline - 1);
    const version = { taskId: waiting.taskId, inputVersion: 1, now: waitDeadline };
    expect(
      await context.storeB.transitionTask({
        ...version,
        now: waitDeadline - 1,
        from: 'waiting_for_user',
        to: 'timed_out',
      })
    ).toBe(false);
    for (const decision of ['accepted', 'declined'] as const) {
      expect(
        await context.storeB.resolveUserWait({
          ...version,
          waitId: waiting.waitId,
          answerMessage,
          decision,
        })
      ).toBe(false);
    }
    expect(
      await context.storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'timed_out' })
    ).toBe(true);
  });
});
