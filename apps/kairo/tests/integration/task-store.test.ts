import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type { TaskStatus, TransitionTaskInput } from '../../src/modules/task-lifecycle/types.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import {
  now,
  executionMs,
  executionDeadline,
  waitDeadline,
  question,
  allowedQuestionIds,
  message,
  batchFixture,
  queuedFixture,
  startAttempt,
  waitingFixture,
  runningFixture,
  readyFixture,
  sendingFixture,
  fixtureAt,
} from '../helpers/task-fixtures.js';

// 验收预期独立列出，不从生产状态表生成，避免同一错误同时污染实现与测试。
const legalEdges: Record<TaskStatus, readonly TaskStatus[]> = {
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
] as const satisfies readonly TaskStatus[];

const terminalStatuses: TaskStatus[] = [
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'send_unconfirmed',
];
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

describe('T19 任务创建、领取与状态合同', () => {
  it('任务只从有效非空 ready batch 创建，完整身份由 T18 上下文派生且一个批次只有一个任务', async () => {
    const fixture = await queuedFixture(storeA, chat);
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
      executionStartedAt: null,
      executionDeadline: null,
      currentAttemptId: null,
      endedAt: null,
    };
    expect(await storeB.getTask(fixture.taskId)).toEqual(expected);
    expect(
      await storeB.createTask({
        ...fixture.input,
        taskId: randomUUID(),
        configDigest: '不可覆盖的摘要',
      })
    ).toBeNull();
    expect(await storeA.getTask(fixture.taskId)).toEqual(expected);
    expect(await storeA.getTask(randomUUID())).toBeNull();
    expect(await storeA.getAttempt(randomUUID())).toBeNull();
    expect(await storeA.getUserWait(randomUUID())).toBeNull();
  });

  it('collecting、空 ready batch、失效 context 和不存在 batch 均不能留下空任务', async () => {
    for (const scenario of ['collecting', 'empty', 'invalidated', 'missing'] as const) {
      const fixture = await batchFixture(chat);
      if (scenario !== 'collecting')
        expect(await chat.setBatchStatus(fixture.batch.batchId, 'ready')).toBe(true);
      if (scenario === 'empty') {
        // 只破坏自有测试库的批次成员，验证任务入口而非重新验收 T18。
        await database.poolA.query('DELETE FROM kairo.batch_messages WHERE batch_id = $1', [
          fixture.batch.batchId,
        ]);
      }
      if (scenario === 'invalidated')
        expect(await chat.invalidateContext(fixture.scope, fixture.context.version, now)).toBe(
          true
        );
      const input = {
        taskId: randomUUID(),
        batchId: scenario === 'missing' ? randomUUID() : fixture.batch.batchId,
        configDigest: '测试配置摘要',
        now,
        queueDeadline: now + 60_000,
      };
      expect(await storeA.createTask(input), scenario).toBeNull();
      expect(await storeB.getTask(input.taskId), scenario).toBeNull();
    }
  });

  it('真实 A/B 后端并发领取仅一方成功，开始时间和执行截止保留胜出者值', async () => {
    const fixture = await queuedFixture(storeA, chat);
    const connections = await Promise.all(
      [database.poolA, database.poolB].map(pool =>
        pool.query<{ name: string; pid: number }>(
          'SELECT current_database() AS name, pg_backend_pid() AS pid'
        )
      )
    );
    const [connectionA, connectionB] = connections.map(result => result.rows[0]);
    if (!connectionA || !connectionB) throw new Error('真实连接未返回数据库身份');
    expect([connectionA.name, connectionB.name]).toEqual([
      database.databaseName,
      database.databaseName,
    ]);
    expect(connectionA.pid).not.toBe(connectionB.pid);
    const claims = [
      { taskId: fixture.taskId, inputVersion: 1, now: now + 111, executionMs: 12_345 },
      { taskId: fixture.taskId, inputVersion: 1, now: now + 222, executionMs: 23_456 },
    ] as const;
    const results = await Promise.all([storeA.claimTask(claims[0]), storeB.claimTask(claims[1])]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = claims[results[0] ? 0 : 1];
    const saved = await storeB.getTask(fixture.taskId);
    expect(saved).toMatchObject({
      status: 'running',
      executionStartedAt: winner.now,
      executionDeadline: winner.now + winner.executionMs,
    });
    expect(await storeA.claimTask({ ...claims[0], now: now + 333, executionMs: 999_999 })).toBe(
      false
    );
    expect(await storeB.getTask(fixture.taskId)).toEqual(saved);
  });

  it('合法状态边 queued → running', async () => {
    const fixture = await queuedFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.claimTask({ ...version, executionMs })).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('running');
  });

  it('合法状态边 queued → cancelled', async () => {
    const fixture = await queuedFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.transitionTask({ ...version, from: 'queued', to: 'cancelled' })).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 queued → timed_out', async () => {
    const fixture = await queuedFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: fixture.input.queueDeadline };
    expect(await storeB.transitionTask({ ...version, from: 'queued', to: 'timed_out' })).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
  });

  it('合法状态边 running → waiting_for_user', async () => {
    const fixture = await runningFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await storeB.waitForUser({
        ...version,
        attemptId: fixture.attemptId,
        waitId: randomUUID(),
        question,
        allowedQuestionIds,
      })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('waiting_for_user');
  });

  it('合法状态边 running → ready_to_send', async () => {
    const fixture = await runningFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.adoptAttempt({ ...version, attemptId: fixture.attemptId })).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('ready_to_send');
  });

  it('合法状态边 running → failed', async () => {
    const fixture = await runningFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await storeB.transitionTask({
        ...version,
        from: 'running',
        to: 'failed',
        expectedAttemptId: fixture.attemptId,
      })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('failed');
  });

  it('合法状态边 running → cancelled', async () => {
    const fixture = await runningFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.transitionTask({ ...version, from: 'running', to: 'cancelled' })).toBe(
      true
    );
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 running → timed_out', async () => {
    const fixture = await runningFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
    expect(await storeB.transitionTask({ ...version, from: 'running', to: 'timed_out' })).toBe(
      true
    );
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
  });

  it('合法状态边 waiting_for_user → running', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    const answerMessage = await message(chat, fixture.scope, version.now);
    expect(
      await storeB.resolveUserWait({
        ...version,
        waitId: fixture.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('running');
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      closedAt: version.now,
      resolution: 'accepted',
    });
  });

  it('合法状态边 waiting_for_user → cancelled', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'cancelled' })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      closedAt: version.now,
      resolution: 'cancelled',
    });
  });

  it('合法状态边 waiting_for_user → timed_out', async () => {
    const fixture = await waitingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: waitDeadline };
    expect(
      await storeB.transitionTask({ ...version, from: 'waiting_for_user', to: 'timed_out' })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
    expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
      closedAt: version.now,
      resolution: 'timed_out',
    });
  });

  it('合法状态边 ready_to_send → sending', async () => {
    const fixture = await readyFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'sending' })).toBe(
      true
    );
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('sending');
  });

  it('合法状态边 ready_to_send → cancelled', async () => {
    const fixture = await readyFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'cancelled' })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 ready_to_send → timed_out', async () => {
    const fixture = await readyFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'timed_out' })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('timed_out');
  });

  it('合法状态边 sending → completed', async () => {
    const fixture = await sendingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.transitionTask({ ...version, from: 'sending', to: 'completed' })).toBe(
      true
    );
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('completed');
  });

  it('合法状态边 sending → failed', async () => {
    const fixture = await sendingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.transitionTask({ ...version, from: 'sending', to: 'failed' })).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('failed');
  });

  it('合法状态边 sending → cancelled', async () => {
    const fixture = await sendingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(await storeB.transitionTask({ ...version, from: 'sending', to: 'cancelled' })).toBe(
      true
    );
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('cancelled');
  });

  it('合法状态边 sending → send_unconfirmed', async () => {
    const fixture = await sendingFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
    expect(
      await storeB.transitionTask({ ...version, from: 'sending', to: 'send_unconfirmed' })
    ).toBe(true);
    expect((await storeA.getTask(fixture.taskId))?.status).toBe('send_unconfirmed');
  });

  it('十状态全矩阵拒绝非法跨状态、同态和普通接口绕过专用边，失败不修改任务', async () => {
    for (const from of statuses) {
      const fixture = await fixtureAt(storeA, chat, from);
      const before = await storeA.getTask(fixture.taskId);
      for (const to of statuses) {
        const specialTarget =
          to === 'running' || to === 'ready_to_send' || to === 'waiting_for_user';
        if (legalEdges[from].includes(to) && !specialTarget) continue;
        expect(
          await storeB.transitionTask({
            taskId: fixture.taskId,
            inputVersion: 1,
            now: now + 700,
            from,
            // 故意模拟 JavaScript 调用者绕过 TS 联合类型，验证运行时状态门禁。
            to,
          } as TransitionTaskInput),
          `${from} -> ${to}`
        ).toBe(false);
        expect(await storeA.getTask(fixture.taskId), `${from} -> ${to}`).toEqual(before);
      }
      const mismatchedFrom = from === 'running' ? 'queued' : 'running';
      expect(
        await storeB.transitionTask({
          taskId: fixture.taskId,
          inputVersion: 1,
          now: now + 700,
          from: mismatchedFrom,
          to: 'cancelled',
        })
      ).toBe(false);
      expect(await storeA.getTask(fixture.taskId)).toEqual(before);
    }
  }, 30_000);

  it('五终态不可领取、改输入、创建或采用尝试、开启或恢复等待', async () => {
    for (const status of terminalStatuses) {
      const fixture = await fixtureAt(storeA, chat, status);
      const before = await storeA.getTask(fixture.taskId);
      if (!before) throw new Error('任务夹具未保存');
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 800 };
      const attemptId = randomUUID();
      const waitId = randomUUID();
      const answerMessage = await message(chat, fixture.scope, version.now);
      expect(await storeB.claimTask({ ...version, executionMs }), status).toBe(false);
      expect(await storeB.updateInputVersion(version), status).toBe(false);
      expect(
        await storeB.startAttempt({
          ...version,
          attemptId,
          runId: randomUUID(),
          configDigest: '终态不能运行',
          expectedAttemptId: before.currentAttemptId,
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
      expect(
        await storeB.resolveUserWait({ ...version, waitId, answerMessage, decision: 'accepted' }),
        status
      ).toBe(false);
      expect(await storeA.getTask(fixture.taskId), status).toEqual(before);
    }
  }, 30_000);

  it('sending 的结果不使用执行截止推断，过期后仍可记录四种发送终态', async () => {
    for (const to of ['completed', 'failed', 'cancelled', 'send_unconfirmed'] as const) {
      const fixture = await sendingFixture(storeA, chat);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline + 60_000 };
      expect(await storeA.transitionTask({ ...version, from: 'sending', to: 'timed_out' })).toBe(
        false
      );
      expect(await storeB.transitionTask({ ...version, from: 'sending', to })).toBe(true);
      expect(await storeA.getTask(fixture.taskId)).toMatchObject({
        status: to,
        endedAt: version.now,
      });
    }
  });

  it('队列截止拒绝领取及改版本，只允许超时；前一毫秒仍可领取', async () => {
    const queued = await queuedFixture(storeA, chat);
    const queueVersion = {
      taskId: queued.taskId,
      inputVersion: 1,
      now: queued.input.queueDeadline,
    };
    expect(
      await storeA.transitionTask({
        ...queueVersion,
        now: queueVersion.now - 1,
        from: 'queued',
        to: 'timed_out',
      })
    ).toBe(false);
    expect(await storeA.claimTask({ ...queueVersion, executionMs })).toBe(false);
    expect(await storeA.updateInputVersion(queueVersion)).toBe(false);
    expect(await storeA.transitionTask({ ...queueVersion, from: 'queued', to: 'timed_out' })).toBe(
      true
    );
    const queuedBefore = await queuedFixture(storeA, chat);
    expect(
      await storeB.claimTask({
        taskId: queuedBefore.taskId,
        inputVersion: 1,
        now: queuedBefore.input.queueDeadline - 1,
        executionMs,
      })
    ).toBe(true);
  });

  it('执行截止拒绝进入 sending，前一毫秒不能超时，恰好截止可超时', async () => {
    const fixture = await readyFixture(storeA, chat);
    const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
    expect(
      await storeA.transitionTask({
        ...version,
        now: executionDeadline - 1,
        from: 'ready_to_send',
        to: 'timed_out',
      })
    ).toBe(false);
    expect(await storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'sending' })).toBe(
      false
    );
    expect(
      await storeA.transitionTask({ ...version, from: 'ready_to_send', to: 'timed_out' })
    ).toBe(true);
  });

  it('截止前一毫秒允许开始替代尝试及进入 sending', async () => {
    const running = await runningFixture(storeA, chat);
    const replacement = await startAttempt(storeB, running, {
      expectedAttemptId: running.attemptId,
      startedAt: executionDeadline - 1,
    });
    expect(await storeA.getTask(running.taskId)).toMatchObject({
      currentAttemptId: replacement.attemptId,
      executionDeadline,
    });
    const ready = await readyFixture(storeA, chat);
    expect(
      await storeB.transitionTask({
        taskId: ready.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        from: 'ready_to_send',
        to: 'sending',
      })
    ).toBe(true);
  });

  it('queued 截止前一毫秒仍可更新输入且不延长截止', async () => {
    const fixture = await queuedFixture(storeA, chat);
    const before = await storeA.getTask(fixture.taskId);
    if (!before) throw new Error('输入版本边界任务未保存');
    expect(
      await storeB.updateInputVersion({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: fixture.input.queueDeadline - 1,
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
