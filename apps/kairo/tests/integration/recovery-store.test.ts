import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartAttemptInput } from '../../src/modules/task-lifecycle/types.js';
import {
  createTaskTestContext,
  type TaskTestContext,
  type TaskFixture,
  now,
  executionDeadline,
} from '../helpers/task-fixtures.js';

let context: TaskTestContext;
beforeAll(async () => {
  // 复用 createTaskTestDatabase 的双连接随机临时库，不迁移配置原库。
  context = await createTaskTestContext();
}, 30_000);
afterAll(async () => {
  await context?.database.close();
}, 30_000);

function recoveryInput(
  fixture: TaskFixture,
  expectedAttemptId: string | null = null,
  overrides: Partial<StartAttemptInput> = {}
): StartAttemptInput {
  return {
    taskId: fixture.taskId,
    inputVersion: 1,
    now: now + 500,
    attemptId: randomUUID(),
    expectedAttemptId,
    runId: randomUUID(),
    configDigest: '重启时当前配置摘要',
    recovery: true,
    ...overrides,
  };
}

describe('T26 恢复账本', () => {
  it('领取后尚无尝试也只允许一次恢复，并保留原截止与当前运行配置', async () => {
    const fixture = await context.runningFixture();
    const input = recoveryInput(fixture);
    expect(await context.storeA.startAttempt(input)).toMatchObject({
      attemptId: input.attemptId,
      configDigest: input.configDigest,
    });
    expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
      recoveryUsed: true,
      answerText: null,
      currentAttemptId: input.attemptId,
      executionDeadline,
    });
    const second = recoveryInput(fixture, input.attemptId, { now: now + 600 });
    expect(await context.storeB.startAttempt(second)).toBeNull();
    expect(await context.storeA.getAttempt(second.attemptId)).toBeNull();
    expect(await context.storeA.getAttempt(input.attemptId)).toMatchObject({
      runId: input.runId,
      configDigest: '重启时当前配置摘要',
    });
    expect(await context.storeB.failRecovery({ ...second, now: now + 700 })).toBe(true);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'failed',
      currentAttemptId: input.attemptId,
      endedAt: now + 700,
      executionDeadline,
    });
    expect(await context.storeA.getAttempt(input.attemptId)).toMatchObject({
      finishedAt: null,
      adopted: false,
    });
  });

  it('已有尝试的首次恢复替代旧指针，双连接并发只有一个胜出且不留下失败尝试', async () => {
    const fixture = await context.runningFixture();
    const old = await context.startAttempt(fixture);
    const a = recoveryInput(fixture, old.attemptId);
    const b = recoveryInput(fixture, old.attemptId);
    const results = await Promise.all([
      context.storeA.startAttempt(a),
      context.storeB.startAttempt(b),
    ]);
    expect(results.filter(result => result !== null)).toHaveLength(1);
    const winner = results[0] ? a : b;
    const loser = results[0] ? b : a;
    expect(await context.storeA.getAttempt(loser.attemptId)).toBeNull();
    expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
      currentAttemptId: winner.attemptId,
      recoveryUsed: true,
      executionDeadline,
    });
  });

  it('CAS 失败与重复 attempt ID 不消耗恢复额度', async () => {
    const fixture = await context.runningFixture();
    const old = await context.startAttempt(fixture);
    expect(await context.storeB.startAttempt(recoveryInput(fixture))).toBeNull();
    expect(
      await context.storeB.startAttempt(
        recoveryInput(fixture, old.attemptId, { attemptId: old.attemptId })
      )
    ).toBeNull();
    expect((await context.storeA.getTask(fixture.taskId))?.recoveryUsed).toBe(false);
    expect(await context.storeA.startAttempt(recoveryInput(fixture, old.attemptId))).not.toBeNull();
  });

  it('普通员工等待恢复不消耗额度，已消耗额度也不阻止正常等待恢复', async () => {
    for (const used of [false, true]) {
      const fixture = await context.runningFixture();
      const input = recoveryInput(fixture, null, { recovery: used, now: now + 200 });
      expect(await context.storeA.startAttempt(input)).not.toBeNull();
      expect(
        await context.storeA.finishAttempt({
          attemptId: input.attemptId,
          finishedAt: now + 300,
          errorType: null,
        })
      ).toBe(true);
      const waitId = randomUUID();
      expect(
        await context.storeA.waitForUser({
          taskId: fixture.taskId,
          inputVersion: 1,
          attemptId: input.attemptId,
          now: now + 400,
          waitId,
          question: '是否继续处理当前问题？',
          allowedQuestionIds: ['当前问题'],
        })
      ).toBe(true);
      const answerMessage = await context.message(fixture.scope, now + 600, { text: '同意' });
      expect(
        await context.storeB.resolveUserWait({
          taskId: fixture.taskId,
          inputVersion: 1,
          now: now + 600,
          waitId,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(true);
      const resumed = await context.storeB.resumeTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 800,
      });
      expect(resumed).toMatchObject({ recoveryUsed: used });
      const ordinary = recoveryInput(fixture, null, { now: now + 900 });
      delete ordinary.recovery;
      expect(await context.storeA.startAttempt(ordinary)).not.toBeNull();
      expect((await context.storeB.getTask(fixture.taskId))?.recoveryUsed).toBe(used);
      const next = recoveryInput(fixture, ordinary.attemptId, { now: now + 1000 });
      if (used) expect(await context.storeB.startAttempt(next)).toBeNull();
      else expect(await context.storeB.startAttempt(next)).not.toBeNull();
    }
  });

  it('输入版本更新清空旧正文但不恢复额度，旧版本不能重新执行', async () => {
    const fixture = await context.runningFixture();
    const input = recoveryInput(fixture);
    expect(await context.storeA.startAttempt(input)).not.toBeNull();
    // 模拟历史版本遗留的候选正文；版本切换必须主动清除，不能向新版本泄漏。
    await context.database.poolA.query(
      'UPDATE kairo.tasks SET answer_text = $2 WHERE task_id = $1',
      [fixture.taskId, '旧版本已检查正文']
    );
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 600 };
    expect(await context.storeB.updateInputVersion(version)).toBe(true);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      inputVersion: 2,
      answerText: null,
      recoveryUsed: true,
      currentAttemptId: null,
      executionDeadline,
    });
    expect(await context.storeA.startAttempt(recoveryInput(fixture))).toBeNull();
    expect(
      await context.storeA.startAttempt(recoveryInput(fixture, null, { inputVersion: 2 }))
    ).toBeNull();
  });

  it('原执行截止等号拒绝恢复与恢复失败，保留超时裁决', async () => {
    for (const used of [false, true]) {
      const fixture = await context.runningFixture();
      const first = used ? recoveryInput(fixture) : null;
      if (first) expect(await context.storeA.startAttempt(first)).not.toBeNull();
      const input = recoveryInput(fixture, first?.attemptId ?? null, { now: executionDeadline });
      expect(await context.storeB.startAttempt(input)).toBeNull();
      expect(await context.storeB.failRecovery(input)).toBe(false);
      expect(await context.storeA.getAttempt(input.attemptId)).toBeNull();
      expect(
        await context.storeA.transitionTask({
          ...input,
          now: executionDeadline,
          from: 'running',
          to: 'timed_out',
        })
      ).toBe(true);
      expect(await context.storeB.getTask(fixture.taskId)).toMatchObject({
        status: 'timed_out',
        endedAt: executionDeadline,
        executionDeadline,
        recoveryUsed: used,
      });
    }
  });

  it('恢复额度耗尽可无 attempt 指针失败，并发只结束一次且更新 idle', async () => {
    const fixture = await context.runningFixture();
    expect(await context.storeA.startAttempt(recoveryInput(fixture))).not.toBeNull();
    expect(
      await context.storeA.updateInputVersion({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 600,
      })
    ).toBe(true);
    const version = { taskId: fixture.taskId, inputVersion: 2, now: now + 700 };
    const results = await Promise.all([
      context.storeA.failRecovery(version),
      context.storeB.failRecovery(version),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'failed',
      endedAt: version.now,
      currentAttemptId: null,
      recoveryUsed: true,
      executionDeadline,
    });
    expect(await context.chat.getCurrentContext(fixture.scope)).toMatchObject({
      idleSince: version.now,
    });
    expect(await context.storeA.failRecovery({ ...version, now: now + 900 })).toBe(false);
    expect(await context.chat.getCurrentContext(fixture.scope)).toMatchObject({
      idleSince: version.now,
    });
  });

  it('恢复失败与切换上下文竞争保持锁顺序，旧尝试只可补记审计', async () => {
    const fixture = await context.runningFixture();
    const input = recoveryInput(fixture);
    expect(await context.storeA.startAttempt(input)).not.toBeNull();
    const [switched, failed] = await Promise.all([
      context.chat.prepareContext(fixture.scope, () => now + 700, {
        reset: true,
        idleMs: 7_200_000,
      }),
      context.storeB.failRecovery({ taskId: fixture.taskId, inputVersion: 1, now: now + 700 }),
    ]);
    expect(switched.context.threadId).not.toBe(fixture.context.threadId);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      status: failed ? 'failed' : 'cancelled',
      endedAt: now + 700,
    });
    expect(
      await context.storeA.finishAttempt({
        attemptId: input.attemptId,
        finishedAt: now + 800,
        errorType: null,
      })
    ).toBe(true);
    expect(
      await context.storeB.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 900,
        attemptId: input.attemptId,
        answerText: '旧上下文的迟到答案',
      })
    ).toBe(false);
    expect((await context.storeA.getAttempt(input.attemptId))?.adopted).toBe(false);
    expect((await context.chat.getCurrentContext(fixture.scope))?.idleSince).toBeNull();
  });

  it('无额度、旧版本、失效 context 与非 running 状态不能恢复失败或复活终态', async () => {
    const unused = await context.runningFixture();
    expect(
      await context.storeA.failRecovery({ taskId: unused.taskId, inputVersion: 1, now: now + 700 })
    ).toBe(false);
    const fixture = await context.runningFixture();
    expect(await context.storeA.startAttempt(recoveryInput(fixture))).not.toBeNull();
    expect(
      await context.storeB.failRecovery({ taskId: fixture.taskId, inputVersion: 2, now: now + 700 })
    ).toBe(false);
    await context.database.poolA.query(
      'UPDATE kairo.contexts SET invalidated_at = $2 WHERE thread_id = $1',
      [fixture.context.threadId, new Date(now + 600)]
    );
    expect(
      await context.storeB.failRecovery({ taskId: fixture.taskId, inputVersion: 1, now: now + 700 })
    ).toBe(false);
    for (const createFixture of [
      context.queuedFixture,
      context.waitingFixture,
      context.readyToSendFixture,
      context.sendingFixture,
      context.cancelledFixture,
      context.timedOutFixture,
      context.failedFixture,
      () => context.finishedSendingFixture('completed'),
      () => context.finishedSendingFixture('send_unconfirmed'),
    ]) {
      const other = await createFixture();
      // 单独检验状态门禁，不能因未占用额度而提前拒绝掩盖状态错误。
      await context.database.poolA.query(
        'UPDATE kairo.tasks SET recovery_used = true, execution_deadline = $2 WHERE task_id = $1',
        [other.taskId, new Date(executionDeadline)]
      );
      const before = await context.storeA.getTask(other.taskId);
      expect(
        await context.storeB.failRecovery({ taskId: other.taskId, inputVersion: 1, now: now + 700 })
      ).toBe(false);
      expect(await context.storeA.getTask(other.taskId)).toEqual(before);
    }
  });

  it('已采用正文跨连接可读，旧 attempt、重复采用与过期答案不能覆盖', async () => {
    const fixture = await context.runningFixture();
    const old = await context.successfulAttempt(fixture);
    const fresh = recoveryInput(fixture, old.attemptId);
    expect(await context.storeB.startAttempt(fresh)).not.toBeNull();
    expect(
      await context.storeB.finishAttempt({
        attemptId: fresh.attemptId,
        finishedAt: now + 600,
        errorType: null,
      })
    ).toBe(true);
    const adoption = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 700,
      attemptId: fresh.attemptId,
      answerText: '已检查答案：仅依据当前资料回答。\n保留原始换行。',
    };
    expect(
      await context.storeA.adoptAttempt({
        ...adoption,
        attemptId: old.attemptId,
        answerText: '旧尝试正文',
      })
    ).toBe(false);
    expect(await context.storeB.adoptAttempt(adoption)).toBe(true);
    expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
      status: 'ready_to_send',
      answerText: adoption.answerText,
    });
    expect(await context.storeA.adoptAttempt({ ...adoption, answerText: '重复覆盖' })).toBe(false);
    expect(
      await context.storeA.adoptAttempt({
        ...adoption,
        attemptId: old.attemptId,
        answerText: '迟到覆盖',
      })
    ).toBe(false);
    expect((await context.storeB.getTask(fixture.taskId))?.answerText).toBe(adoption.answerText);
    expect(
      (
        await context.database.poolA.query(
          'SELECT task_id FROM kairo.formal_answers WHERE task_id = $1',
          [fixture.taskId]
        )
      ).rows
    ).toEqual([]);
    expect(
      (
        await context.database.poolA.query(
          'SELECT task_id FROM kairo.memory_commits WHERE task_id = $1',
          [fixture.taskId]
        )
      ).rows
    ).toEqual([]);
    const expired = await context.runningWithSuccessfulAttempt();
    expect(
      await context.storeB.adoptAttempt({
        taskId: expired.taskId,
        inputVersion: 1,
        attemptId: expired.attemptId,
        now: executionDeadline,
        answerText: '过期答案',
      })
    ).toBe(false);
    expect((await context.storeA.getTask(expired.taskId))?.answerText).toBeNull();
    expect((await context.storeA.getAttempt(expired.attemptId))?.adopted).toBe(false);
  });

  it('恢复创建和恢复失败均在锁等待结束后判断原执行截止', async () => {
    for (const action of ['start', 'fail'] as const) {
      const fixture = await context.runningFixture();
      const input = recoveryInput(fixture);
      if (action === 'fail') expect(await context.storeA.startAttempt(input)).not.toBeNull();
      const pid = (
        await context.database.poolB.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      ).rows[0]!.pid;
      const blocker = await context.database.poolA.connect();
      let clock = executionDeadline - 1;
      let sampled = 0;
      let pending: Promise<unknown> | undefined;
      const sample = () => {
        sampled++;
        return clock;
      };
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT thread_id FROM kairo.contexts WHERE thread_id = $1 FOR UPDATE',
          [fixture.context.threadId]
        );
        pending =
          action === 'start'
            ? context.storeB.startAttempt({ ...input, now: sample })
            : context.storeB.failRecovery({ taskId: fixture.taskId, inputVersion: 1, now: sample });
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
        clock = executionDeadline;
        await blocker.query('COMMIT');
        expect(await pending).toBe(action === 'start' ? null : false);
        expect(sampled).toBe(1);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
      }
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        status: 'running',
        executionDeadline,
        recoveryUsed: action === 'fail',
      });
    }
  });

  it('断线原子取消本 Bot 全部活跃任务和开放等待，保留上下文、其他 Bot 与终态', async () => {
    const botId = randomUUID();
    const scope = () => ({ ...context.scopeFor(), botId });
    const active = [
      await context.queuedFixture(scope()),
      await context.runningFixture(scope()),
      await context.waitingFixture(scope()),
      await context.readyToSendFixture(scope()),
      await context.sendingFixture(scope()),
    ];
    const terminals = [];
    for (const status of [
      'completed',
      'failed',
      'cancelled',
      'timed_out',
      'send_unconfirmed',
    ] as const) {
      const terminal =
        status === 'timed_out'
          ? await context.runningFixture(scope())
          : await context.sendingFixture(scope());
      const transition =
        status === 'timed_out'
          ? { from: 'running' as const, to: status, now: executionDeadline }
          : { from: 'sending' as const, to: status, now: now + 600 };
      expect(
        await context.storeA.transitionTask({
          taskId: terminal.taskId,
          inputVersion: 1,
          ...transition,
        })
      ).toBe(true);
      terminals.push({
        fixture: terminal,
        task: await context.storeA.getTask(terminal.taskId),
        context: await context.chat.getCurrentContext(terminal.scope),
      });
    }
    const other = await context.waitingFixture();
    const otherBefore = await context.storeA.getTask(other.taskId);
    const otherWait = await context.storeA.getTaskWait(other.taskId);
    const cancelledAt = now + 900;
    await Promise.all([
      context.storeA.cancelUnfinished(botId, cancelledAt),
      context.storeB.cancelUnfinished(botId, cancelledAt),
    ]);
    for (const fixture of active) {
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        status: 'cancelled',
        endedAt: cancelledAt,
      });
      expect(await context.chat.getCurrentContext(fixture.scope)).toMatchObject({
        threadId: fixture.context.threadId,
        version: fixture.context.version,
        invalidatedAt: null,
        idleSince: cancelledAt,
      });
    }
    expect(await context.storeB.getTaskWait(active[2]!.taskId)).toMatchObject({
      resolution: 'cancelled',
      closedAt: cancelledAt,
    });
    for (const terminal of terminals) {
      expect(await context.storeB.getTask(terminal.fixture.taskId)).toEqual(terminal.task);
      expect(await context.chat.getCurrentContext(terminal.fixture.scope)).toEqual(
        terminal.context
      );
    }
    expect(await context.storeB.getTask(other.taskId)).toEqual(otherBefore);
    expect(await context.storeB.getTaskWait(other.taskId)).toEqual(otherWait);
    await context.storeB.cancelUnfinished(botId, cancelledAt + 100);
    expect((await context.chat.getCurrentContext(active[0]!.scope))?.idleSince).toBe(cancelledAt);
  });

  it('断线废弃聚合与孤立 ready，只收尾 rejected；已有任务批次和失效上下文保持原状', async () => {
    const botId = randomUUID();
    const scope = () => ({ ...context.scopeFor(), botId });
    const collecting = await context.batchFixture(scope());
    const ready = await context.batchFixture(scope());
    expect(await context.chat.setBatchStatus(ready.batch.batchId, 'ready')).toBe(true);
    const rejected = await context.batchFixture(scope());
    expect(await context.chat.setBatchStatus(rejected.batch.batchId, 'rejected')).toBe(true);
    const invalid = await context.batchFixture(scope());
    await context.chat.invalidateContext(invalid.scope, invalid.context.version, now + 500);
    const invalidBefore = await context.chat.getBatch(invalid.batch.batchId);
    const owned = await context.runningFixture(scope());
    const ownedBefore = await context.chat.getBatch(owned.batch.batchId);
    await context.storeB.cancelUnfinished(botId, now + 700);
    for (const fixture of [collecting, ready]) {
      expect(await context.chat.getBatch(fixture.batch.batchId)).toMatchObject({
        status: 'discarded',
      });
      expect(await context.chat.getCurrentContext(fixture.scope)).toMatchObject({
        threadId: fixture.context.threadId,
        idleSince: now + 700,
      });
    }
    expect(await context.chat.getBatch(rejected.batch.batchId)).toMatchObject({
      status: 'rejected',
    });
    expect(
      (
        await context.database.poolA.query<{ settled_at: Date }>(
          'SELECT settled_at FROM kairo.message_batches WHERE batch_id = $1',
          [rejected.batch.batchId]
        )
      ).rows[0]!.settled_at.getTime()
    ).toBe(now + 700);
    expect(await context.chat.getBatch(invalid.batch.batchId)).toEqual(invalidBefore);
    expect(await context.chat.getBatch(owned.batch.batchId)).toEqual(ownedBefore);
    await context.storeA.cancelUnfinished(botId, now + 800);
    expect((await context.chat.getCurrentContext(rejected.scope))?.idleSince).toBe(now + 700);
  });

  it('断线与恢复尝试、答案采用和领取竞争后不能留下旧可运行任务', async () => {
    const botId = randomUUID();
    for (const action of ['start', 'adopt', 'claim'] as const) {
      const scope = { ...context.scopeFor(), botId };
      const fixture =
        action === 'claim'
          ? await context.queuedFixture(scope)
          : await context.runningFixture(scope);
      const attempt = action === 'adopt' ? await context.successfulAttempt(fixture) : null;
      await Promise.all([
        context.storeA.cancelUnfinished(botId, now + 700),
        action === 'start'
          ? context.storeB.startAttempt(recoveryInput(fixture))
          : action === 'adopt'
            ? context.storeB.adoptAttempt({
                taskId: fixture.taskId,
                inputVersion: 1,
                now: now + 600,
                attemptId: attempt!.attemptId,
                answerText: '失效代次答案',
              })
            : context.storeB.claimTask({
                taskId: fixture.taskId,
                inputVersion: 1,
                now: now + 600,
                executionMs: 120000,
              }),
      ]);
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        status: 'cancelled',
        endedAt: now + 700,
      });
      expect(await context.storeB.startAttempt(recoveryInput(fixture))).toBeNull();
      expect((await context.chat.getCurrentContext(scope))?.threadId).toBe(
        fixture.context.threadId
      );
    }
  });
});
