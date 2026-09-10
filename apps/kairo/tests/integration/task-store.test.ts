import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TaskStatus, TransitionTaskInput } from '../../src/modules/task-lifecycle/types.js';
import {
  createTaskTestContext,
  type TaskFixture,
  type TaskTestContext,
  now,
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

// 独立合同预期；不能从生产状态表推导，否则同一个错误会同时改变实现和预期。
const legalEdges: Record<TaskStatus, readonly Exclude<TaskStatus, 'queued'>[]> = {
  queued: ['running', 'cancelled', 'timed_out'],
  running: ['waiting_for_user', 'ready_to_send', 'failed', 'cancelled', 'timed_out'],
  waiting_for_user: ['running', 'cancelled', 'timed_out'],
  ready_to_send: ['sending', 'cancelled', 'timed_out'],
  sending: ['completed', 'failed', 'cancelled', 'send_unconfirmed'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  send_unconfirmed: [],
};
const statuses = [
  'queued',
  'running',
  'waiting_for_user',
  'ready_to_send',
  'sending',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'send_unconfirmed',
] as const;
const terminalStatuses = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'send_unconfirmed',
] as const;

// 仅状态矩阵使用穷举工厂；不同状态确实可能没有尝试或等待记录。
type MatrixFixture = TaskFixture & {
  attemptId?: string;
  waitId?: string;
};
const matrixFactories: Record<TaskStatus, () => Promise<MatrixFixture>> = {
  queued: () => context.queuedFixture(),
  running: () => context.runningWithSuccessfulAttempt(),
  waiting_for_user: () => context.waitingFixture(),
  ready_to_send: () => context.readyToSendFixture(),
  sending: () => context.sendingFixture(),
  completed: () => context.finishedSendingFixture('completed'),
  failed: () => context.failedFixture(),
  cancelled: () => context.cancelledFixture(),
  timed_out: () => context.timedOutFixture(),
  send_unconfirmed: () => context.finishedSendingFixture('send_unconfirmed'),
};

describe('T19 任务账本', () => {
  it('任务只从有效非空 ready batch 创建，完整身份由 T18 上下文派生且一个批次只有一个任务', async () => {
    const fixture = await context.queuedFixture();
    const expected = {
      ...fixture.scope,
      taskId: fixture.taskId,
      batchId: fixture.batch.batchId,
      threadId: fixture.context.threadId,
      inputVersion: 1,
      configDigest: fixture.input.configDigest,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      queueDeadline: fixture.input.queueDeadline,
      executionBudgetMs: null,
      queueNoticeRequired: false,
      executionStartedAt: null,
      executionDeadline: null,
      currentAttemptId: null,
      currentWaitId: null,
      endedAt: null,
    };
    expect(await context.storeB.getTask(fixture.taskId)).toEqual(expected);
    expect(
      await context.storeB.createTask({
        ...fixture.input,
        taskId: randomUUID(),
        configDigest: '不可覆盖的摘要',
      })
    ).toBeNull();
    expect(await context.storeA.getTask(fixture.taskId)).toEqual(expected);
    expect(await context.storeA.getTask(randomUUID())).toBeNull();
    expect(await context.storeA.getAttempt(randomUUID())).toBeNull();
    expect(await context.storeA.getUserWait(randomUUID())).toBeNull();
  });

  it('collecting、空 ready batch、失效 context 和不存在 batch 均不能留下空任务', async () => {
    for (const scenario of ['collecting', 'empty', 'invalidated', 'missing'] as const) {
      const fixture = await context.batchFixture();
      if (scenario !== 'collecting')
        expect(await context.chat.setBatchStatus(fixture.batch.batchId, 'ready')).toBe(true);
      if (scenario === 'empty') {
        // 只破坏自有测试库的批次成员，验证任务入口而非重新验收 T18。
        await context.database.poolA.query('DELETE FROM kairo.batch_messages WHERE batch_id = $1', [
          fixture.batch.batchId,
        ]);
      }
      if (scenario === 'invalidated')
        expect(
          await context.chat.invalidateContext(fixture.scope, fixture.context.version, now)
        ).toBe(true);
      const input = {
        taskId: randomUUID(),
        batchId: scenario === 'missing' ? randomUUID() : fixture.batch.batchId,
        configDigest: '测试配置摘要',
        now,
        queueDeadline: now + 60000,
      };
      expect(await context.storeA.createTask(input), scenario).toBeNull();
      expect(await context.storeB.getTask(input.taskId), scenario).toBeNull();
    }
  });

  it('真实 A/B 后端并发领取仅一方成功，开始时间和执行截止保留胜出者值', async () => {
    const fixture = await context.queuedFixture();
    const connections = await Promise.all(
      [context.database.poolA, context.database.poolB].map(pool =>
        pool.query<{
          name: string;
          pid: number;
        }>('SELECT current_database() AS name, pg_backend_pid() AS pid')
      )
    );
    const [connectionA, connectionB] = connections.map(result => result.rows[0]);
    if (!connectionA || !connectionB) throw new Error('真实连接未返回数据库身份');
    expect([connectionA.name, connectionB.name]).toEqual([
      context.database.databaseName,
      context.database.databaseName,
    ]);
    expect(connectionA.pid).not.toBe(connectionB.pid);
    const claims = [
      { taskId: fixture.taskId, inputVersion: 1, now: now + 111, executionMs: 12345 },
      { taskId: fixture.taskId, inputVersion: 1, now: now + 222, executionMs: 23456 },
    ] as const;
    const results = await Promise.all([
      context.storeA.claimTask(claims[0]),
      context.storeB.claimTask(claims[1]),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = claims[results[0] ? 0 : 1];
    const saved = await context.storeB.getTask(fixture.taskId);
    expect(saved).toMatchObject({
      status: 'running',
      executionStartedAt: winner.now,
      executionDeadline: winner.now + winner.executionMs,
    });
    expect(
      await context.storeA.claimTask({ ...claims[0], now: now + 333, executionMs: 999999 })
    ).toBeNull();
    expect(await context.storeB.getTask(fixture.taskId)).toEqual(saved);
  });

  it('合法状态边 queued → running', async () => {
    const fixture = await context.queuedFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await context.storeB.claimTask({ ...version, executionMs })).not.toBeNull();
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('running');
  });

  it('合法状态边 queued → cancelled', async () => {
    const fixture = await context.queuedFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'queued', to: 'cancelled' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 queued → timed_out', async () => {
    const fixture = await context.queuedFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: fixture.input.queueDeadline };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'queued', to: 'timed_out' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
  });

  it('合法状态边 running → waiting_for_user', async () => {
    const fixture = await context.runningWithSuccessfulAttempt();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.waitForUser({
        ...version,
        attemptId: fixture.attemptId,
        waitId: randomUUID(),
        question,
        allowedQuestionIds,
      })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('waiting_for_user');
  });

  it('合法状态边 running → ready_to_send', async () => {
    const fixture = await context.runningWithSuccessfulAttempt();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await context.storeB.adoptAttempt({ ...version, attemptId: fixture.attemptId })).toBe(
      true
    );
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('ready_to_send');
  });

  it('合法状态边 running → failed', async () => {
    const fixture = await context.runningWithSuccessfulAttempt();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({
        ...version,
        from: 'running',
        to: 'failed',
        expectedAttemptId: fixture.attemptId,
      })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('failed');
  });

  it('合法状态边 running → cancelled', async () => {
    const fixture = await context.runningWithSuccessfulAttempt();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'running', to: 'cancelled' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 running → timed_out', async () => {
    const fixture = await context.runningWithSuccessfulAttempt();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'running', to: 'timed_out' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
  });

  it('合法状态边 waiting_for_user → running', async () => {
    const fixture = await context.waitingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    const answerMessage = await context.message(fixture.scope, version.now);
    expect(
      await context.storeB.resolveUserWait({
        ...version,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect(await context.storeA.resumeTask(version)).not.toBeNull();
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('running');
    expect(await context.storeA.getUserWait(fixture.waitId)).toMatchObject({
      closedAt: version.now,
      resolution: 'accepted',
    });
  });

  it('合法状态边 waiting_for_user → cancelled', async () => {
    const fixture = await context.waitingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'cancelled' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
    expect(await context.storeA.getUserWait(fixture.waitId)).toMatchObject({
      closedAt: version.now,
      resolution: 'cancelled',
    });
  });

  it('合法状态边 waiting_for_user → timed_out', async () => {
    const fixture = await context.waitingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: waitDeadline };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'timed_out' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
    expect(await context.storeA.getUserWait(fixture.waitId)).toMatchObject({
      closedAt: version.now,
      resolution: 'timed_out',
    });
  });

  it('合法状态边 ready_to_send → sending', async () => {
    const fixture = await context.readyToSendFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'sending' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('sending');
  });

  it('合法状态边 ready_to_send → cancelled', async () => {
    const fixture = await context.readyToSendFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'cancelled' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 ready_to_send → timed_out', async () => {
    const fixture = await context.readyToSendFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'timed_out' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
  });

  it('合法状态边 sending → completed', async () => {
    const fixture = await context.sendingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'sending', to: 'completed' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('completed');
  });

  it('合法状态边 sending → failed', async () => {
    const fixture = await context.sendingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await context.storeB.transitionTask({ ...version, from: 'sending', to: 'failed' })).toBe(
      true
    );
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('failed');
  });

  it('合法状态边 sending → cancelled', async () => {
    const fixture = await context.sendingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'sending', to: 'cancelled' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 sending → send_unconfirmed', async () => {
    const fixture = await context.sendingFixture();
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await context.storeB.transitionTask({ ...version, from: 'sending', to: 'send_unconfirmed' })
    ).toBe(true);
    expect((await context.storeA.getTask(fixture.taskId))?.status).toBe('send_unconfirmed');
  });

  it('十状态全矩阵拒绝非法跨状态、同态和普通接口绕过专用边，失败不修改任务', async () => {
    for (const from of statuses) {
      const fixture = await matrixFactories[from]();
      const before = await context.storeA.getTask(fixture.taskId);
      for (const to of statuses) {
        const specialTarget =
          to === 'running' || to === 'ready_to_send' || to === 'waiting_for_user';
        if (legalEdges[from].some(successor => successor === to) && !specialTarget) continue;
        expect(
          await context.storeB.transitionTask({
            taskId: fixture.taskId,
            inputVersion: 1,
            now: now + 700,
            from,
            // 故意模拟 JavaScript 调用者绕过 TS 联合类型，验证运行时状态门禁。
            to,
          } as TransitionTaskInput),
          `${from} -> ${to}`
        ).toBe(false);
        expect(await context.storeA.getTask(fixture.taskId), `${from} -> ${to}`).toEqual(before);
      }
      const mismatchedFrom = from === 'running' ? 'queued' : 'running';
      expect(
        await context.storeB.transitionTask({
          taskId: fixture.taskId,
          inputVersion: 1,
          now: now + 700,
          from: mismatchedFrom,
          to: 'cancelled',
        })
      ).toBe(false);
      expect(await context.storeA.getTask(fixture.taskId)).toEqual(before);
    }
  }, 30000);

  it('五终态不可领取、改输入、创建或采用尝试、开启或恢复等待', async () => {
    for (const status of terminalStatuses) {
      const fixture = await matrixFactories[status]();
      const before = await context.storeA.getTask(fixture.taskId);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 800 };
      const attemptId = randomUUID();
      const waitId = randomUUID();
      const answerMessage = await context.message(fixture.scope, version.now);
      expect(await context.storeB.claimTask({ ...version, executionMs }), status).toBeNull();
      expect(await context.storeB.updateInputVersion(version), status).toBe(false);
      expect(
        await context.storeB.startAttempt({
          ...version,
          attemptId,
          runId: randomUUID(),
          configDigest: '终态不能运行',
          expectedAttemptId: before!.currentAttemptId,
        }),
        status
      ).toBeNull();
      expect(await context.storeB.getAttempt(attemptId), status).toBeNull();
      expect(
        await context.storeB.adoptAttempt({
          ...version,
          attemptId: fixture.attemptId ?? attemptId,
        }),
        status
      ).toBe(false);
      expect(
        await context.storeB.waitForUser({
          ...version,
          attemptId: fixture.attemptId ?? attemptId,
          waitId,
          question,
          allowedQuestionIds,
        }),
        status
      ).toBe(false);
      expect(await context.storeB.getUserWait(waitId), status).toBeNull();
      expect(
        await context.storeB.resolveUserWait({
          ...version,
          waitId,
          answerMessage,
          decision: 'accepted',
        }),
        status
      ).toBe(false);
      expect(await context.storeA.getTask(fixture.taskId), status).toEqual(before);
    }
  }, 30000);

  it('sending 的结果不使用执行截止推断，过期后仍可记录四种发送终态', async () => {
    for (const to of ['completed', 'failed', 'cancelled', 'send_unconfirmed'] as const) {
      const fixture = await context.sendingFixture();
      const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline + 60000 };
      expect(
        await context.storeA.transitionTask({ ...version, from: 'sending', to: 'timed_out' })
      ).toBe(false);
      expect(await context.storeB.transitionTask({ ...version, from: 'sending', to })).toBe(true);
      expect(await context.storeA.getTask(fixture.taskId)).toMatchObject({
        status: to,
        endedAt: version.now,
      });
    }
  });

  it('非 running 状态不能创建或采用尝试、开启等待，跨任务尝试不能借用', async () => {
    for (const status of ['queued', 'waiting_for_user', 'ready_to_send', 'sending'] as const) {
      const fixture = await matrixFactories[status]();
      const before = await context.storeA.getTask(fixture.taskId);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
      const attemptId = randomUUID();
      const waitId = randomUUID();
      expect(
        await context.storeB.startAttempt({
          ...version,
          attemptId,
          expectedAttemptId: before!.currentAttemptId,
          runId: randomUUID(),
          configDigest: '状态门禁配置',
        }),
        status
      ).toBeNull();
      expect(await context.storeB.getAttempt(attemptId), status).toBeNull();
      expect(
        await context.storeB.adoptAttempt({
          ...version,
          attemptId: fixture.attemptId ?? attemptId,
        }),
        status
      ).toBe(false);
      expect(
        await context.storeB.waitForUser({
          ...version,
          attemptId: fixture.attemptId ?? attemptId,
          waitId,
          question,
          allowedQuestionIds,
        }),
        status
      ).toBe(false);
      expect(await context.storeB.getUserWait(waitId), status).toBeNull();
      if (status !== 'queued')
        expect(await context.storeB.claimTask({ ...version, executionMs }), status).toBeNull();
      expect(await context.storeA.getTask(fixture.taskId), status).toEqual(before);
    }
    const owner = await context.runningWithSuccessfulAttempt();
    const borrower = await context.runningWithSuccessfulAttempt();
    const version = { taskId: borrower.taskId, inputVersion: 1, now: now + 700 };
    const waitId = randomUUID();
    expect(await context.storeB.adoptAttempt({ ...version, attemptId: owner.attemptId })).toBe(
      false
    );
    expect(
      await context.storeB.waitForUser({
        ...version,
        attemptId: owner.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await context.storeA.getUserWait(waitId)).toBeNull();
    expect(await context.storeA.getAttempt(owner.attemptId)).toMatchObject({ adopted: false });
    expect(await context.storeA.getTask(borrower.taskId)).toMatchObject({
      status: 'running',
      currentAttemptId: borrower.attemptId,
    });
  });
});
