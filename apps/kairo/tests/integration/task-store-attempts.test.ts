import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TransitionTaskInput } from '../../src/modules/task-lifecycle/types.js';
import {
  createTaskTestContext,
  type TaskTestContext,
  now,
  executionMs,
  executionDeadline,
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

describe('T19 任务账本-attempts', () => {
  it('queued/running 改输入版本不延长截止，旧版本尝试和旧领取条件全部失效', async () => {
    for (const state of ['queued', 'running'] as const) {
      const fixture =
        state === 'queued' ? await context.queuedFixture() : await context.runningFixture();
      const oldAttempt = state === 'running' ? await context.successfulAttempt(fixture) : null;
      const before = await context.storeA.getTask(fixture.taskId);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 450 };
      expect(await context.storeB.updateInputVersion(version)).toBe(true);
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        inputVersion: 2,
        currentAttemptId: null,
        status: state,
        queueDeadline: before!.queueDeadline,
        executionDeadline: before!.executionDeadline,
      });
      expect(await context.storeA.updateInputVersion(version)).toBe(false);
      expect(await context.storeA.claimTask({ ...version, executionMs })).toBe(false);
      expect(
        await context.storeA.transitionTask({ ...version, from: state, to: 'cancelled' })
      ).toBe(false);
      const rejectedAttemptId = randomUUID();
      expect(
        await context.storeA.startAttempt({
          ...version,
          attemptId: rejectedAttemptId,
          expectedAttemptId: null,
          runId: randomUUID(),
          configDigest: '旧输入',
        })
      ).toBeNull();
      expect(await context.storeB.getAttempt(rejectedAttemptId)).toBeNull();
      if (oldAttempt) {
        const waitId = randomUUID();
        expect(
          await context.storeA.adoptAttempt({ ...version, attemptId: oldAttempt.attemptId })
        ).toBe(false);
        expect(
          await context.storeA.adoptAttempt({
            ...version,
            inputVersion: 2,
            attemptId: oldAttempt.attemptId,
          })
        ).toBe(false);
        expect(
          await context.storeA.waitForUser({
            ...version,
            inputVersion: 2,
            attemptId: oldAttempt.attemptId,
            waitId,
            question,
            allowedQuestionIds,
          })
        ).toBe(false);
        expect(await context.storeB.getUserWait(waitId)).toBeNull();
        const fresh = await context.startAttempt(fixture, context.storeB, {
          inputVersion: 2,
          startedAt: now + 500,
        });
        expect(
          await context.storeB.finishAttempt({
            attemptId: fresh.attemptId,
            finishedAt: now + 600,
            errorType: null,
          })
        ).toBe(true);
        expect(
          await context.storeB.adoptAttempt({
            taskId: fixture.taskId,
            inputVersion: 2,
            attemptId: fresh.attemptId,
            now: now + 700,
          })
        ).toBe(true);
        expect(await context.storeA.getAttempt(oldAttempt.attemptId)).toMatchObject({
          inputVersion: 1,
          adopted: false,
        });
      } else {
        expect(await context.storeA.claimTask({ ...version, inputVersion: 2, executionMs })).toBe(
          true
        );
      }
    }
    for (const createFixture of [
      context.waitingFixture,
      context.readyToSendFixture,
      context.sendingFixture,
    ]) {
      const fixture = await createFixture();
      const before = await context.storeA.getTask(fixture.taskId);
      expect(
        await context.storeB.updateInputVersion({
          taskId: fixture.taskId,
          inputVersion: 1,
          now: now + 700,
        })
      ).toBe(false);
      expect(await context.storeA.getTask(fixture.taskId)).toEqual(before);
    }
  });

  it('同版本替代尝试使旧 currentAttemptId 失效，并发 CAS 不留下失败尝试', async () => {
    const fixture = await context.runningFixture();
    const oldAttempt = await context.successfulAttempt(fixture);
    const attemptInput = (index: number) => ({
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 450 + index,
      attemptId: randomUUID(),
      expectedAttemptId: oldAttempt.attemptId,
      runId: randomUUID(),
      configDigest: `替代配置-${index}`,
    });
    const inputs = [attemptInput(0), attemptInput(1)] as const;
    const results = await Promise.all([
      context.storeA.startAttempt(inputs[0]),
      context.storeB.startAttempt(inputs[1]),
    ]);
    expect(results.filter(result => result !== null)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    const loser = inputs[results[0] ? 1 : 0];
    expect(await context.storeA.getAttempt(loser.attemptId)).toBeNull();
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      currentAttemptId: winner.attemptId,
      inputVersion: 1,
      executionDeadline,
    });
    expect(
      await context.storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        attemptId: oldAttempt.attemptId,
      })
    ).toBe(false);
    const waitId = randomUUID();
    expect(
      await context.storeB.waitForUser({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        attemptId: oldAttempt.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await context.storeA.getUserWait(waitId)).toBeNull();
    expect(
      await context.storeB.finishAttempt({
        attemptId: winner.attemptId,
        finishedAt: now + 600,
        errorType: null,
      })
    ).toBe(true);
    expect(
      await context.storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 700,
        attemptId: winner.attemptId,
      })
    ).toBe(true);
    expect(await context.storeA.getAttempt(oldAttempt.attemptId)).toMatchObject({ adopted: false });
    expect(await context.storeA.getAttempt(winner.attemptId)).toMatchObject({
      adopted: true,
      runId: winner.runId,
      configDigest: winner.configDigest,
    });
  });

  it('旧尝试迟到失败只能补记审计，不能终止同版本替代尝试或阻止其成功采用', async () => {
    const fixture = await context.runningFixture();
    const oldAttempt = await context.startAttempt(fixture);
    const replacement = await context.startAttempt(fixture, context.storeB, {
      expectedAttemptId: oldAttempt.attemptId,
      startedAt: now + 250,
    });
    const before = await context.storeB.getTask(fixture.taskId);
    expect(
      await context.storeA.finishAttempt({
        attemptId: oldAttempt.attemptId,
        finishedAt: now + 300,
        errorType: 'model',
      })
    ).toBe(true);
    const staleFailure = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 400,
      from: 'running' as const,
      to: 'failed' as const,
      expectedAttemptId: oldAttempt.attemptId,
    };
    expect(await context.storeA.transitionTask(staleFailure)).toBe(false);
    expect(await context.storeB.getTask(fixture.taskId)).toEqual(before);
    expect(await context.storeA.getAttempt(oldAttempt.attemptId)).toMatchObject({
      finishedAt: now + 300,
      errorType: 'model',
      adopted: false,
    });
    expect(
      await context.storeB.finishAttempt({
        attemptId: replacement.attemptId,
        finishedAt: now + 500,
        errorType: null,
      })
    ).toBe(true);
    expect(
      await context.storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 600,
        attemptId: replacement.attemptId,
      })
    ).toBe(true);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'ready_to_send',
      currentAttemptId: replacement.attemptId,
      endedAt: null,
    });
    expect(await context.storeB.getAttempt(replacement.attemptId)).toMatchObject({ adopted: true });
  });

  it('执行失败必须明确绑定现有当前尝试，缺失或空标识不能绕过条件', async () => {
    const fixture = await context.runningFixture();
    const base = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 400,
      from: 'running',
      to: 'failed',
    } as const;
    // 验证 JavaScript 旧调用者及尚无当前 attempt 的运行阶段，不能让 null 等值误通过。
    for (const hasAttempt of [false, true]) {
      const attempt = hasAttempt ? await context.startAttempt(fixture) : null;
      const before = await context.storeA.getTask(fixture.taskId);
      for (const expectedAttemptId of [undefined, null, randomUUID()]) {
        expect(
          await context.storeB.transitionTask({ ...base, expectedAttemptId } as TransitionTaskInput)
        ).toBe(false);
        expect(await context.storeA.getTask(fixture.taskId)).toEqual(before);
      }
      if (attempt) {
        expect(
          await context.storeA.finishAttempt({
            attemptId: attempt.attemptId,
            finishedAt: now + 300,
            errorType: 'model',
          })
        ).toBe(true);
        expect(
          await context.storeB.transitionTask({ ...base, expectedAttemptId: attempt.attemptId })
        ).toBe(true);
        expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
          status: 'failed',
          endedAt: base.now,
        });
      }
    }
  });

  it('空字符串当前尝试不能作为执行失败标识，替代为有效尝试后可正常失败', async () => {
    const fixture = await context.runningFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 200 };
    expect(
      await context.storeA.startAttempt({
        ...version,
        attemptId: '',
        expectedAttemptId: null,
        runId: randomUUID(),
        configDigest: '空标识边界',
      })
    ).not.toBeNull();
    const before = await context.storeA.getTask(fixture.taskId);
    expect(
      await context.storeB.transitionTask({
        ...version,
        from: 'running',
        to: 'failed',
        expectedAttemptId: '',
      })
    ).toBe(false);
    expect(await context.storeA.getTask(fixture.taskId)).toEqual(before);
    const replacement = await context.startAttempt(fixture, context.storeB, {
      expectedAttemptId: '',
    });
    expect(
      await context.storeA.transitionTask({
        ...version,
        from: 'running',
        to: 'failed',
        expectedAttemptId: replacement.attemptId,
      })
    ).toBe(true);
  });

  it('未结束、结束失败和重复结束不能伪造成功采用，结束时刻不能早于开始', async () => {
    const fixture = await context.runningFixture();
    const attempt = await context.startAttempt(fixture);
    const adoption = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 500,
      attemptId: attempt.attemptId,
    };
    const waitId = randomUUID();
    expect(await context.storeB.adoptAttempt(adoption)).toBe(false);
    expect(
      await context.storeB.waitForUser({ ...adoption, waitId, question, allowedQuestionIds })
    ).toBe(false);
    expect(await context.storeA.getUserWait(waitId)).toBeNull();
    expect(
      await context.storeB.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: attempt.input.now - 1,
        errorType: null,
      })
    ).toBe(false);
    expect(await context.storeA.getAttempt(attempt.attemptId)).toMatchObject({
      finishedAt: null,
      errorType: null,
      adopted: false,
    });
    expect(
      await context.storeB.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: attempt.input.now,
        errorType: 'model',
      })
    ).toBe(true);
    expect(
      await context.storeA.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: now + 400,
        errorType: null,
      })
    ).toBe(false);
    expect(await context.storeB.adoptAttempt(adoption)).toBe(false);
    expect(
      await context.storeB.waitForUser({ ...adoption, waitId, question, allowedQuestionIds })
    ).toBe(false);
    expect(await context.storeA.getAttempt(attempt.attemptId)).toMatchObject({
      finishedAt: attempt.input.now,
      errorType: 'model',
      adopted: false,
    });
    expect(await context.storeA.getUserWait(waitId)).toBeNull();
    expect(
      await context.storeA.finishAttempt({
        attemptId: randomUUID(),
        finishedAt: now + 400,
        errorType: null,
      })
    ).toBe(false);
  });

  it('终止与迟到结果竞争保留结束审计，但不能采用或重新开启任务', async () => {
    for (const terminal of ['cancelled', 'timed_out'] as const) {
      const fixture = await context.runningFixture();
      const attempt = await context.startAttempt(fixture);
      const at = terminal === 'timed_out' ? executionDeadline : now + 500;
      const results = await Promise.all([
        context.storeA.transitionTask({
          taskId: fixture.taskId,
          inputVersion: 1,
          from: 'running',
          to: terminal,
          now: at,
        }),
        context.storeB.finishAttempt({
          attemptId: attempt.attemptId,
          finishedAt: at + 1,
          errorType: null,
        }),
      ]);
      expect(results).toEqual([true, true]);
      expect(
        await context.storeB.finishAttempt({
          attemptId: attempt.attemptId,
          finishedAt: at + 2,
          errorType: 'cancelled',
        })
      ).toBe(false);
      expect(
        await context.storeB.adoptAttempt({
          taskId: fixture.taskId,
          inputVersion: 1,
          attemptId: attempt.attemptId,
          now: at + 2,
        })
      ).toBe(false);
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        status: terminal,
        endedAt: at,
      });
      expect(await context.storeA.getAttempt(attempt.attemptId)).toMatchObject({
        finishedAt: at + 1,
        errorType: null,
        adopted: false,
      });
    }
  });

  it('两个连接并发取消与采用时仅一方胜出，取消提交后迟到采用不能覆盖终态', async () => {
    const fixture = await context.runningFixture();
    const attempt = await context.successfulAttempt(fixture);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 500 };
    const [cancelled, adopted] = await Promise.all([
      context.storeA.transitionTask({ ...version, from: 'running', to: 'cancelled' }),
      context.storeB.adoptAttempt({ ...version, attemptId: attempt.attemptId }),
    ]);
    expect([cancelled, adopted].filter(Boolean)).toHaveLength(1);
    expect(await context.storeA.getAttempt(attempt.attemptId)).toMatchObject({ adopted });
    if (cancelled) {
      expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
        status: 'cancelled',
        endedAt: version.now,
      });
    } else {
      expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
        status: 'ready_to_send',
        endedAt: null,
      });
      expect(
        await context.storeA.transitionTask({ ...version, from: 'ready_to_send', to: 'cancelled' })
      ).toBe(true);
    }
    const terminal = await context.storeA.getTask(fixture.taskId);
    expect(
      await context.storeB.adoptAttempt({
        ...version,
        now: now + 600,
        attemptId: attempt.attemptId,
      })
    ).toBe(false);
    expect(await context.storeA.getTask(fixture.taskId)).toEqual(terminal);
  });
});
