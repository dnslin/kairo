import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type { TransitionTaskInput } from '../../src/modules/task-lifecycle/types.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import {
  now,
  executionMs,
  executionDeadline,
  question,
  allowedQuestionIds,
  queuedFixture,
  claimedFixture,
  startAttempt,
  successfulAttempt,
  runningFixture,
  fixtureAt,
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

describe('T19 执行尝试、版本与迟到结果', () => {
  it('queued/running 改输入版本不延长截止，旧版本尝试和旧领取条件全部失效', async () => {
    for (const state of ['queued', 'running'] as const) {
      const fixture =
        state === 'queued' ? await queuedFixture(storeA, chat) : await claimedFixture(storeA, chat);
      const oldAttempt = state === 'running' ? await successfulAttempt(storeA, fixture) : null;
      const before = await storeA.getTask(fixture.taskId);
      if (!before) throw new Error('任务夹具未保存');
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 450 };
      expect(await storeB.updateInputVersion(version)).toBe(true);
      expect(await storeA.getTask(fixture.taskId)).toMatchObject({
        inputVersion: 2,
        currentAttemptId: null,
        status: state,
        queueDeadline: before.queueDeadline,
        executionDeadline: before.executionDeadline,
      });
      expect(await storeA.updateInputVersion(version)).toBe(false);
      expect(await storeA.claimTask({ ...version, executionMs })).toBe(false);
      expect(await storeA.transitionTask({ ...version, from: state, to: 'cancelled' })).toBe(false);
      const rejectedAttemptId = randomUUID();
      expect(
        await storeA.startAttempt({
          ...version,
          attemptId: rejectedAttemptId,
          expectedAttemptId: null,
          runId: randomUUID(),
          configDigest: '旧输入',
        })
      ).toBeNull();
      expect(await storeB.getAttempt(rejectedAttemptId)).toBeNull();
      if (oldAttempt) {
        const waitId = randomUUID();
        expect(await storeA.adoptAttempt({ ...version, attemptId: oldAttempt.attemptId })).toBe(
          false
        );
        expect(
          await storeA.adoptAttempt({
            ...version,
            inputVersion: 2,
            attemptId: oldAttempt.attemptId,
          })
        ).toBe(false);
        expect(
          await storeA.waitForUser({
            ...version,
            inputVersion: 2,
            attemptId: oldAttempt.attemptId,
            waitId,
            question,
            allowedQuestionIds,
          })
        ).toBe(false);
        expect(await storeB.getUserWait(waitId)).toBeNull();
        const fresh = await startAttempt(storeB, fixture, {
          inputVersion: 2,
          startedAt: now + 500,
        });
        expect(
          await storeB.finishAttempt({
            attemptId: fresh.attemptId,
            finishedAt: now + 600,
            errorType: null,
          })
        ).toBe(true);
        expect(
          await storeB.adoptAttempt({
            taskId: fixture.taskId,
            inputVersion: 2,
            attemptId: fresh.attemptId,
            now: now + 700,
          })
        ).toBe(true);
        expect(await storeA.getAttempt(oldAttempt.attemptId)).toMatchObject({
          inputVersion: 1,
          adopted: false,
        });
      } else {
        expect(await storeA.claimTask({ ...version, inputVersion: 2, executionMs })).toBe(true);
      }
    }
    for (const status of ['waiting_for_user', 'ready_to_send', 'sending'] as const) {
      const fixture = await fixtureAt(storeA, chat, status);
      const before = await storeA.getTask(fixture.taskId);
      if (!before) throw new Error('任务夹具未保存');
      expect(
        await storeB.updateInputVersion({ taskId: fixture.taskId, inputVersion: 1, now: now + 700 })
      ).toBe(false);
      expect(await storeA.getTask(fixture.taskId)).toEqual(before);
    }
  });

  it('同版本替代尝试使旧 currentAttemptId 失效，并发 CAS 不留下失败尝试', async () => {
    const fixture = await claimedFixture(storeA, chat);
    const oldAttempt = await successfulAttempt(storeA, fixture);
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
      storeA.startAttempt(inputs[0]),
      storeB.startAttempt(inputs[1]),
    ]);
    expect(results.filter(result => result !== null)).toHaveLength(1);
    const winner = inputs[results[0] ? 0 : 1];
    const loser = inputs[results[0] ? 1 : 0];
    expect(await storeA.getAttempt(loser.attemptId)).toBeNull();
    expect(await storeA.getTask(fixture.taskId)).toMatchObject({
      currentAttemptId: winner.attemptId,
      inputVersion: 1,
      executionDeadline,
    });
    expect(
      await storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        attemptId: oldAttempt.attemptId,
      })
    ).toBe(false);
    const waitId = randomUUID();
    expect(
      await storeB.waitForUser({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        attemptId: oldAttempt.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await storeA.getUserWait(waitId)).toBeNull();
    expect(
      await storeB.finishAttempt({
        attemptId: winner.attemptId,
        finishedAt: now + 600,
        errorType: null,
      })
    ).toBe(true);
    expect(
      await storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 700,
        attemptId: winner.attemptId,
      })
    ).toBe(true);
    expect(await storeA.getAttempt(oldAttempt.attemptId)).toMatchObject({ adopted: false });
    expect(await storeA.getAttempt(winner.attemptId)).toMatchObject({
      adopted: true,
      runId: winner.runId,
      configDigest: winner.configDigest,
    });
  });

  it('旧尝试迟到失败只能补记审计，不能终止同版本替代尝试或阻止其成功采用', async () => {
    const fixture = await claimedFixture(storeA, chat);
    const oldAttempt = await startAttempt(storeA, fixture);
    const replacement = await startAttempt(storeB, fixture, {
      expectedAttemptId: oldAttempt.attemptId,
      startedAt: now + 250,
    });
    const before = await storeB.getTask(fixture.taskId);
    expect(
      await storeA.finishAttempt({
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
    expect(await storeA.transitionTask(staleFailure)).toBe(false);
    expect(await storeB.getTask(fixture.taskId)).toEqual(before);
    expect(await storeA.getAttempt(oldAttempt.attemptId)).toMatchObject({
      finishedAt: now + 300,
      errorType: 'model',
      adopted: false,
    });
    expect(
      await storeB.finishAttempt({
        attemptId: replacement.attemptId,
        finishedAt: now + 500,
        errorType: null,
      })
    ).toBe(true);
    expect(
      await storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 600,
        attemptId: replacement.attemptId,
      })
    ).toBe(true);
    expect(await storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'ready_to_send',
      currentAttemptId: replacement.attemptId,
      endedAt: null,
    });
    expect(await storeB.getAttempt(replacement.attemptId)).toMatchObject({ adopted: true });
  });

  it('执行失败必须明确绑定现有当前尝试，缺失或空标识不能绕过条件', async () => {
    const fixture = await claimedFixture(storeA, chat);
    const base = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 400,
      from: 'running',
      to: 'failed',
    } as const;
    // 验证 JavaScript 旧调用者及尚无当前 attempt 的运行阶段，不能让 null 等值误通过。
    for (const hasAttempt of [false, true]) {
      const attempt = hasAttempt ? await startAttempt(storeA, fixture) : null;
      const before = await storeA.getTask(fixture.taskId);
      for (const expectedAttemptId of [undefined, null, randomUUID()]) {
        expect(
          await storeB.transitionTask({ ...base, expectedAttemptId } as TransitionTaskInput)
        ).toBe(false);
        expect(await storeA.getTask(fixture.taskId)).toEqual(before);
      }
      if (attempt) {
        expect(
          await storeA.finishAttempt({
            attemptId: attempt.attemptId,
            finishedAt: now + 300,
            errorType: 'model',
          })
        ).toBe(true);
        expect(await storeB.transitionTask({ ...base, expectedAttemptId: attempt.attemptId })).toBe(
          true
        );
        expect(await storeA.getTask(fixture.taskId)).toMatchObject({
          status: 'failed',
          endedAt: base.now,
        });
      }
    }
  });

  it('未结束、结束失败和重复结束不能伪造成功采用，结束时刻不能早于开始', async () => {
    const fixture = await claimedFixture(storeA, chat);
    const attempt = await startAttempt(storeA, fixture);
    const adoption = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 500,
      attemptId: attempt.attemptId,
    };
    const waitId = randomUUID();
    expect(await storeB.adoptAttempt(adoption)).toBe(false);
    expect(await storeB.waitForUser({ ...adoption, waitId, question, allowedQuestionIds })).toBe(
      false
    );
    expect(await storeA.getUserWait(waitId)).toBeNull();
    expect(
      await storeB.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: attempt.input.now - 1,
        errorType: null,
      })
    ).toBe(false);
    expect(await storeA.getAttempt(attempt.attemptId)).toMatchObject({
      finishedAt: null,
      errorType: null,
      adopted: false,
    });
    expect(
      await storeB.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: attempt.input.now,
        errorType: 'model',
      })
    ).toBe(true);
    expect(
      await storeA.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: now + 400,
        errorType: null,
      })
    ).toBe(false);
    expect(await storeB.adoptAttempt(adoption)).toBe(false);
    expect(await storeB.waitForUser({ ...adoption, waitId, question, allowedQuestionIds })).toBe(
      false
    );
    expect(await storeA.getAttempt(attempt.attemptId)).toMatchObject({
      finishedAt: attempt.input.now,
      errorType: 'model',
      adopted: false,
    });
    expect(await storeA.getUserWait(waitId)).toBeNull();
    expect(
      await storeA.finishAttempt({
        attemptId: randomUUID(),
        finishedAt: now + 400,
        errorType: null,
      })
    ).toBe(false);
  });

  it('终止与迟到结果竞争保留结束审计，但不能采用或重新开启任务', async () => {
    for (const terminal of ['cancelled', 'timed_out'] as const) {
      const fixture = await claimedFixture(storeA, chat);
      const attempt = await startAttempt(storeA, fixture);
      const at = terminal === 'timed_out' ? executionDeadline : now + 500;
      const results = await Promise.all([
        storeA.transitionTask({
          taskId: fixture.taskId,
          inputVersion: 1,
          from: 'running',
          to: terminal,
          now: at,
        }),
        storeB.finishAttempt({ attemptId: attempt.attemptId, finishedAt: at + 1, errorType: null }),
      ]);
      expect(results).toEqual([true, true]);
      expect(
        await storeB.finishAttempt({
          attemptId: attempt.attemptId,
          finishedAt: at + 2,
          errorType: 'cancelled',
        })
      ).toBe(false);
      expect(
        await storeB.adoptAttempt({
          taskId: fixture.taskId,
          inputVersion: 1,
          attemptId: attempt.attemptId,
          now: at + 2,
        })
      ).toBe(false);
      expect(await storeA.getTask(fixture.taskId)).toMatchObject({ status: terminal, endedAt: at });
      expect(await storeA.getAttempt(attempt.attemptId)).toMatchObject({
        finishedAt: at + 1,
        errorType: null,
        adopted: false,
      });
    }
  });

  it('两个连接并发取消与采用时仅一方胜出，取消提交后迟到采用不能覆盖终态', async () => {
    const fixture = await claimedFixture(storeA, chat);
    const attempt = await successfulAttempt(storeA, fixture);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 500 };
    const [cancelled, adopted] = await Promise.all([
      storeA.transitionTask({ ...version, from: 'running', to: 'cancelled' }),
      storeB.adoptAttempt({ ...version, attemptId: attempt.attemptId }),
    ]);
    expect([cancelled, adopted].filter(Boolean)).toHaveLength(1);
    expect(await storeA.getAttempt(attempt.attemptId)).toMatchObject({ adopted });
    if (cancelled) {
      expect(await storeB.getTask(fixture.taskId)).toMatchObject({
        status: 'cancelled',
        endedAt: version.now,
      });
    } else {
      expect(await storeB.getTask(fixture.taskId)).toMatchObject({
        status: 'ready_to_send',
        endedAt: null,
      });
      expect(
        await storeA.transitionTask({ ...version, from: 'ready_to_send', to: 'cancelled' })
      ).toBe(true);
    }
    const terminal = await storeA.getTask(fixture.taskId);
    expect(
      await storeB.adoptAttempt({ ...version, now: now + 600, attemptId: attempt.attemptId })
    ).toBe(false);
    expect(await storeA.getTask(fixture.taskId)).toEqual(terminal);
  });

  it('非 running 状态不能创建或采用尝试、开启等待，跨任务尝试不能借用', async () => {
    for (const status of ['queued', 'waiting_for_user', 'ready_to_send', 'sending'] as const) {
      const fixture = await fixtureAt(storeA, chat, status);
      const before = await storeA.getTask(fixture.taskId);
      if (!before) throw new Error('任务夹具未保存');
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
      const attemptId = randomUUID();
      const waitId = randomUUID();
      expect(
        await storeB.startAttempt({
          ...version,
          attemptId,
          expectedAttemptId: before.currentAttemptId,
          runId: randomUUID(),
          configDigest: '状态门禁配置',
        }),
        status
      ).toBeNull();
      expect(await storeB.getAttempt(attemptId), status).toBeNull();
      expect(
        await storeB.adoptAttempt({ ...version, attemptId: fixture.attemptId ?? attemptId }),
        status
      ).toBe(false);
      expect(
        await storeB.waitForUser({
          ...version,
          attemptId: fixture.attemptId ?? attemptId,
          waitId,
          question,
          allowedQuestionIds,
        }),
        status
      ).toBe(false);
      expect(await storeB.getUserWait(waitId), status).toBeNull();
      if (status !== 'queued')
        expect(await storeB.claimTask({ ...version, executionMs }), status).toBe(false);
      expect(await storeA.getTask(fixture.taskId), status).toEqual(before);
    }
    const owner = await runningFixture(storeA, chat);
    const borrower = await runningFixture(storeA, chat);
    const version = { taskId: borrower.taskId, inputVersion: 1, now: now + 700 };
    const waitId = randomUUID();
    expect(await storeB.adoptAttempt({ ...version, attemptId: owner.attemptId })).toBe(false);
    expect(
      await storeB.waitForUser({
        ...version,
        attemptId: owner.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await storeA.getUserWait(waitId)).toBeNull();
    expect(await storeA.getAttempt(owner.attemptId)).toMatchObject({ adopted: false });
    expect(await storeA.getTask(borrower.taskId)).toMatchObject({
      status: 'running',
      currentAttemptId: borrower.attemptId,
    });
  });

  it('执行截止拒绝创建尝试，前一毫秒不能超时，恰好截止可超时', async () => {
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
    const attemptId = randomUUID();
    expect(
      await storeB.startAttempt({
        ...version,
        attemptId,
        expectedAttemptId: fixture.attemptId,
        runId: randomUUID(),
        configDigest: '边界配置',
      })
    ).toBeNull();
    expect(await storeA.getAttempt(attemptId)).toBeNull();
    expect(await storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })).toBe(
      true
    );
  });

  it('执行截止拒绝采用尝试，前一毫秒不能超时，恰好截止可超时', async () => {
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
    expect(await storeB.adoptAttempt({ ...version, attemptId: fixture.attemptId })).toBe(false);
    expect(await storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })).toBe(
      true
    );
  });

  it('执行截止拒绝修改运行输入，前一毫秒不能超时，恰好截止可超时', async () => {
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
    expect(await storeB.updateInputVersion(version)).toBe(false);
    expect(await storeA.transitionTask({ ...version, from: 'running', to: 'timed_out' })).toBe(
      true
    );
  });

  it('执行截止前一毫秒仍可采用成功尝试', async () => {
    const adoptBefore = await runningFixture(storeA, chat);
    expect(
      await storeA.adoptAttempt({
        taskId: adoptBefore.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        attemptId: adoptBefore.attemptId,
      })
    ).toBe(true);
  });

  it('running 截止前一毫秒仍可更新输入且不延长截止', async () => {
    const fixture = await runningFixture(storeA, chat);
    const before = await storeA.getTask(fixture.taskId);
    if (!before) throw new Error('输入版本边界任务未保存');
    expect(
      await storeB.updateInputVersion({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
      })
    ).toBe(true);
    expect(await storeA.getTask(fixture.taskId)).toMatchObject({
      inputVersion: 2,
      currentAttemptId: null,
      queueDeadline: before.queueDeadline,
      executionDeadline: before.executionDeadline,
    });
  });
});
