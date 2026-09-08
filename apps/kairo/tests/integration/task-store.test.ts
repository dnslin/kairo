import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool } from '../../src/db/pool.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type {
  ChatContext,
  ContextScope,
  MessageBatch,
  MessageKey,
  RawMessageInput,
} from '../../src/modules/private-chat-core/types.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type {
  CreateTaskInput,
  Task,
  TaskAttempt,
  TaskStatus,
  TransitionTaskInput,
  UserWait,
} from '../../src/modules/task-lifecycle/types.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

const now = Date.UTC(2026, 8, 8, 10, 0, 0, 123);
const claimedAt = now + 100;
const executionMs = 120_789;
const executionDeadline = claimedAt + executionMs;
const waitedAt = now + 400;
const waitDeadline = waitedAt + 600_000;
const remainingExecutionMs = executionDeadline - waitedAt;
const question = '是否只处理当前缺失子问题？';
const allowedQuestionIds = ['当前问题/缺失项甲', '当前问题/缺失项乙'];

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
const statuses = Object.keys(legalEdges) as TaskStatus[];
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

function scopeFor(): ContextScope {
  const employeeId = randomUUID();
  return { employeeId, botId: `bot-${randomUUID()}`, sessionId: `0-${employeeId}` };
}

async function message(
  scope: ContextScope,
  observedAt: number,
  overrides: Partial<RawMessageInput> = {},
  associate = true
): Promise<MessageKey> {
  const input: RawMessageInput = {
    sessionId: scope.sessionId,
    messageId: randomUUID(),
    direction: 'inbound',
    observedAt,
    text: '集成测试合成消息',
    messageType: 'text',
    attachments: {},
    ...overrides,
  };
  expect((await chat.insertRawMessage(input)).inserted).toBe(true);
  if (associate) expect(await chat.associateEmployee(input, scope.employeeId)).toBe(true);
  return { sessionId: input.sessionId, messageId: input.messageId };
}

async function batchFixture(scope = scopeFor()) {
  const context = await chat.createContext(scope, now - 1_000);
  const firstMessage = await message(scope, now - 500);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage,
    quietDeadline: now,
    maxDeadline: now + 30_000,
  });
  return { scope, context, batch, firstMessage };
}

async function queuedFixture(scope = scopeFor(), store = storeA): Promise<Fixture> {
  const fixture = await batchFixture(scope);
  expect(await chat.setBatchStatus(fixture.batch.batchId, 'ready')).toBe(true);
  const input = {
    taskId: randomUUID(),
    batchId: fixture.batch.batchId,
    configDigest: '建任务时配置摘要',
    now,
    queueDeadline: now + 60_321,
  };
  const task = await store.createTask(input);
  expect(task).not.toBeNull();
  return { ...fixture, input, taskId: input.taskId };
}

interface Fixture {
  scope: ContextScope;
  context: ChatContext;
  batch: MessageBatch;
  firstMessage: MessageKey;
  input: CreateTaskInput;
  taskId: string;
}

async function runningFixture(scope = scopeFor(), store = storeA) {
  const fixture = await queuedFixture(scope, store);
  expect(
    await store.claimTask({ taskId: fixture.taskId, inputVersion: 1, now: claimedAt, executionMs })
  ).toBe(true);
  return fixture;
}

async function startAttempt(
  fixture: Fixture,
  store = storeA,
  options: { inputVersion?: number; expectedAttemptId?: string | null; startedAt?: number } = {}
) {
  const input = {
    taskId: fixture.taskId,
    inputVersion: options.inputVersion ?? 1,
    now: options.startedAt ?? now + 200,
    attemptId: randomUUID(),
    expectedAttemptId: options.expectedAttemptId ?? null,
    runId: randomUUID(),
    configDigest: '实际运行配置摘要',
  };
  const attempt = await store.startAttempt(input);
  expect(attempt).toEqual({
    attemptId: input.attemptId,
    taskId: fixture.taskId,
    inputVersion: input.inputVersion,
    runId: input.runId,
    configDigest: input.configDigest,
    startedAt: input.now,
    finishedAt: null,
    errorType: null,
    adopted: false,
  });
  return { input, attemptId: input.attemptId };
}

async function successfulAttempt(fixture: Fixture, store = storeA) {
  const attempt = await startAttempt(fixture, store);
  expect(
    await store.finishAttempt({
      attemptId: attempt.attemptId,
      finishedAt: now + 300,
      errorType: null,
    })
  ).toBe(true);
  return attempt;
}

async function waitingFixture(scope = scopeFor(), store = storeA) {
  const fixture = await runningFixture(scope, store);
  const attempt = await successfulAttempt(fixture, store);
  const waitId = randomUUID();
  expect(
    await store.waitForUser({
      taskId: fixture.taskId,
      inputVersion: 1,
      now: waitedAt,
      attemptId: attempt.attemptId,
      waitId,
      question,
      allowedQuestionIds,
    })
  ).toBe(true);
  return { ...fixture, attemptId: attempt.attemptId, waitId };
}

async function fixtureAt(status: TaskStatus, store = storeA) {
  if (status === 'waiting_for_user') return waitingFixture(scopeFor(), store);
  const fixture = await queuedFixture(scopeFor(), store);
  const result = { ...fixture, attemptId: null as string | null, waitId: null as string | null };
  if (status === 'queued') return result;
  if (status === 'timed_out' || status === 'cancelled') {
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        from: 'queued',
        to: status,
        now: status === 'timed_out' ? fixture.input.queueDeadline : now + 500,
      })
    ).toBe(true);
    return result;
  }
  expect(
    await store.claimTask({ taskId: fixture.taskId, inputVersion: 1, now: claimedAt, executionMs })
  ).toBe(true);
  const attempt = await successfulAttempt(fixture, store);
  result.attemptId = attempt.attemptId;
  if (status === 'running') return result;
  if (status === 'failed') {
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        from: 'running',
        to: 'failed',
        expectedAttemptId: attempt.attemptId,
        now: now + 500,
      })
    ).toBe(true);
    return result;
  }
  expect(
    await store.adoptAttempt({
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 400,
      attemptId: attempt.attemptId,
    })
  ).toBe(true);
  if (status === 'ready_to_send') return result;
  expect(
    await store.transitionTask({
      taskId: fixture.taskId,
      inputVersion: 1,
      from: 'ready_to_send',
      to: 'sending',
      now: now + 500,
    })
  ).toBe(true);
  if (status === 'sending') return result;
  expect(
    await store.transitionTask({
      taskId: fixture.taskId,
      inputVersion: 1,
      from: 'sending',
      to: status,
      now: now + 600,
    })
  ).toBe(true);
  return result;
}

beforeAll(async () => {
  database = await createTaskTestDatabase();
  storeA = new PostgresTaskStore(database.poolA);
  storeB = new PostgresTaskStore(database.poolB);
  chat = new PostgresPrivateChatStore(database.poolA);
}, 30_000);

afterAll(async () => {
  await database?.close();
}, 30_000);

describe('T19 任务、执行尝试与员工等待 PostgreSQL 账本', () => {
  it('首次及重复迁移建立任务账本且不改变已保存记录', async () => {
    const fixture = await waitingFixture();
    const before = {
      task: await storeA.getTask(fixture.taskId),
      attempt: await storeA.getAttempt(fixture.attemptId),
      wait: await storeA.getUserWait(fixture.waitId),
      migrations: (await database.poolA.query('SELECT name FROM kairo.pgmigrations ORDER BY name'))
        .rows,
    };
    expect(await migrateDatabase({ databaseUrl: database.databaseUrl })).toEqual([]);
    expect(await storeB.getTask(fixture.taskId)).toEqual(before.task);
    expect(await storeB.getAttempt(fixture.attemptId)).toEqual(before.attempt);
    expect(await storeB.getUserWait(fixture.waitId)).toEqual(before.wait);
    expect(
      (await database.poolB.query('SELECT name FROM kairo.pgmigrations ORDER BY name')).rows
    ).toEqual(before.migrations);
  }, 30_000);

  it('任务只从有效非空 ready batch 创建，完整身份由 T18 上下文派生且一个批次只有一个任务', async () => {
    const fixture = await queuedFixture();
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
      const fixture = await batchFixture();
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
    const fixture = await queuedFixture();
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

  it('全部合法状态边通过各自专用或通用接口完成，等待退出同时闭合记录', async () => {
    for (const from of statuses) {
      for (const to of legalEdges[from]) {
        const fixture = await fixtureAt(from);
        const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
        const label = `${from} -> ${to}`;
        let changed: boolean;
        if (from === 'queued' && to === 'running') {
          changed = await storeB.claimTask({ ...version, executionMs });
        } else if (from === 'running' && to === 'ready_to_send') {
          changed = await storeB.adoptAttempt({ ...version, attemptId: fixture.attemptId! });
        } else if (from === 'running' && to === 'waiting_for_user') {
          changed = await storeB.waitForUser({
            ...version,
            attemptId: fixture.attemptId!,
            waitId: randomUUID(),
            question,
            allowedQuestionIds,
          });
        } else if (from === 'waiting_for_user' && to === 'running') {
          const answerMessage = await message(fixture.scope, version.now);
          changed = await storeB.resolveUserWait({
            ...version,
            waitId: fixture.waitId!,
            answerMessage,
            decision: 'accepted',
          });
        } else {
          const at =
            to === 'timed_out'
              ? from === 'queued'
                ? fixture.input.queueDeadline
                : from === 'waiting_for_user'
                  ? waitDeadline
                  : executionDeadline
              : version.now;
          changed = await storeB.transitionTask({
            ...version,
            now: at,
            from,
            to,
            ...(from === 'running' && to === 'failed'
              ? { expectedAttemptId: fixture.attemptId }
              : {}),
          } as TransitionTaskInput);
        }
        expect(changed, label).toBe(true);
        expect((await storeA.getTask(fixture.taskId))?.status, label).toBe(to);
        if (from === 'waiting_for_user') {
          expect(await storeA.getUserWait(fixture.waitId!)).toMatchObject({
            closedAt: to === 'timed_out' ? waitDeadline : version.now,
            resolution: to === 'running' ? 'accepted' : to,
          });
        }
      }
    }
  }, 30_000);

  it('十状态全矩阵拒绝非法跨状态、同态和普通接口绕过专用边，失败不修改任务', async () => {
    for (const from of statuses) {
      const fixture = await fixtureAt(from);
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
      const fixture = await fixtureAt(status);
      const before = await storeA.getTask(fixture.taskId);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 800 };
      const attemptId = randomUUID();
      const waitId = randomUUID();
      const answerMessage = await message(fixture.scope, version.now);
      expect(await storeB.claimTask({ ...version, executionMs }), status).toBe(false);
      expect(await storeB.updateInputVersion(version), status).toBe(false);
      expect(
        await storeB.startAttempt({
          ...version,
          attemptId,
          runId: randomUUID(),
          configDigest: '终态不能运行',
          expectedAttemptId: before!.currentAttemptId,
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

  it('queued/running 改输入版本不延长截止，旧版本尝试和旧领取条件全部失效', async () => {
    for (const state of ['queued', 'running'] as const) {
      const fixture = state === 'queued' ? await queuedFixture() : await runningFixture();
      const oldAttempt = state === 'running' ? await successfulAttempt(fixture) : null;
      const before = await storeA.getTask(fixture.taskId);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 450 };
      expect(await storeB.updateInputVersion(version)).toBe(true);
      expect(await storeA.getTask(fixture.taskId)).toMatchObject({
        inputVersion: 2,
        currentAttemptId: null,
        status: state,
        queueDeadline: before!.queueDeadline,
        executionDeadline: before!.executionDeadline,
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
        const fresh = await startAttempt(fixture, storeB, {
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
      const fixture = await fixtureAt(status);
      const before = await storeA.getTask(fixture.taskId);
      expect(
        await storeB.updateInputVersion({ taskId: fixture.taskId, inputVersion: 1, now: now + 700 })
      ).toBe(false);
      expect(await storeA.getTask(fixture.taskId)).toEqual(before);
    }
  });

  it('同版本替代尝试使旧 currentAttemptId 失效，并发 CAS 不留下失败尝试', async () => {
    const fixture = await runningFixture();
    const oldAttempt = await successfulAttempt(fixture);
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
    const fixture = await runningFixture();
    const oldAttempt = await startAttempt(fixture);
    const replacement = await startAttempt(fixture, storeB, {
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
    const fixture = await runningFixture();
    const base = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: now + 400,
      from: 'running',
      to: 'failed',
    } as const;
    // 验证 JavaScript 旧调用者及尚无当前 attempt 的运行阶段，不能让 null 等值误通过。
    for (const hasAttempt of [false, true]) {
      const attempt = hasAttempt ? await startAttempt(fixture) : null;
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
    const fixture = await runningFixture();
    const attempt = await startAttempt(fixture);
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
      const fixture = await runningFixture();
      const attempt = await startAttempt(fixture);
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
    const fixture = await runningFixture();
    const attempt = await successfulAttempt(fixture);
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

  it('等待采用澄清尝试并保存问题范围，同意关联原始回答且只恢复剩余执行预算', async () => {
    const fixture = await waitingFixture();
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
    const answerMessage = await message(fixture.scope, acceptedAt);
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
    expect(resumed!.executionDeadline! - acceptedAt).toBe(remainingExecutionMs);
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
    const fresh = await startAttempt(fixture, storeA, { startedAt: acceptedAt + 111 });
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

  it('拒绝、显式取消和等待超时均原子关闭等待，旧回答不能恢复终态', async () => {
    for (const resolution of ['declined', 'cancelled', 'timed_out'] as const) {
      const fixture = await waitingFixture();
      const at = resolution === 'timed_out' ? waitDeadline : waitedAt + 500;
      const answerMessage = await message(fixture.scope, at);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: at };
      const changed =
        resolution === 'declined'
          ? await storeB.resolveUserWait({
              ...version,
              waitId: fixture.waitId,
              answerMessage,
              decision: 'declined',
            })
          : await storeB.transitionTask({ ...version, from: 'waiting_for_user', to: resolution });
      expect(changed, resolution).toBe(true);
      expect(await storeA.getUserWait(fixture.waitId)).toMatchObject({
        resolution,
        closedAt: at,
        answerMessage: resolution === 'declined' ? answerMessage : null,
      });
      expect(await storeA.getTask(fixture.taskId)).toMatchObject({
        status: resolution === 'timed_out' ? 'timed_out' : 'cancelled',
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
    }
  });

  it('等待只接受本员工会话的入站原始消息，并拒绝无身份、缺失、过早和未来回答', async () => {
    const fixture = await waitingFixture();
    const at = waitedAt + 1_000;
    const otherEmployee = scopeFor();
    const invalidAnswers = [
      await message(otherEmployee, at),
      await message(fixture.scope, at, {}, false),
      await message(fixture.scope, at, { direction: 'outbound' }),
      await message(fixture.scope, at, { direction: 'unknown' }),
      await message(fixture.scope, waitedAt - 1),
      await message(fixture.scope, at + 1),
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
    const answerMessage = await message(fixture.scope, waitedAt);
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
    const otherTask = await runningFixture();
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
    const first = await runningFixture(scope);
    const second = await runningFixture(scope);
    const firstAttempt = await successfulAttempt(first);
    const secondAttempt = await successfulAttempt(second);
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
    const first = await waitingFixture(firstScope);
    const second = await waitingFixture(secondScope);
    const answerMessage = await message(firstScope, waitedAt + 100);
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

  it('队列、执行和等待的恰好截止边界只允许超时，前一毫秒仍可执行对应动作', async () => {
    const queued = await queuedFixture();
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
    const queuedBefore = await queuedFixture();
    expect(
      await storeB.claimTask({
        taskId: queuedBefore.taskId,
        inputVersion: 1,
        now: queuedBefore.input.queueDeadline - 1,
        executionMs,
      })
    ).toBe(true);

    for (const action of ['start', 'adopt', 'wait', 'version', 'send'] as const) {
      const fixture = await fixtureAt(action === 'send' ? 'ready_to_send' : 'running');
      const version = { taskId: fixture.taskId, inputVersion: 1, now: executionDeadline };
      expect(
        await storeA.transitionTask({
          ...version,
          now: executionDeadline - 1,
          from: action === 'send' ? 'ready_to_send' : 'running',
          to: 'timed_out',
        })
      ).toBe(false);
      const waitId = randomUUID();
      const attemptId = randomUUID();
      if (action === 'start') {
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
      } else if (action === 'adopt') {
        expect(await storeB.adoptAttempt({ ...version, attemptId: fixture.attemptId! })).toBe(
          false
        );
      } else if (action === 'wait') {
        expect(
          await storeB.waitForUser({
            ...version,
            attemptId: fixture.attemptId!,
            waitId,
            question,
            allowedQuestionIds,
          })
        ).toBe(false);
        expect(await storeA.getUserWait(waitId)).toBeNull();
      } else if (action === 'version') {
        expect(await storeB.updateInputVersion(version)).toBe(false);
      } else {
        expect(
          await storeB.transitionTask({ ...version, from: 'ready_to_send', to: 'sending' })
        ).toBe(false);
      }
      expect(
        await storeA.transitionTask({
          ...version,
          from: action === 'send' ? 'ready_to_send' : 'running',
          to: 'timed_out',
        })
      ).toBe(true);
    }
    const adoptBefore = await fixtureAt('running');
    expect(
      await storeA.adoptAttempt({
        taskId: adoptBefore.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        attemptId: adoptBefore.attemptId!,
      })
    ).toBe(true);
    const waitBefore = await fixtureAt('running');
    const lastWaitId = randomUUID();
    expect(
      await storeA.waitForUser({
        taskId: waitBefore.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        attemptId: waitBefore.attemptId!,
        waitId: lastWaitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(true);
    expect(await storeB.getUserWait(lastWaitId)).toMatchObject({ remainingExecutionMs: 1 });
    const waiting = await waitingFixture();
    const answerMessage = await message(waiting.scope, waitDeadline - 1);
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

  it('sending 的结果不使用执行截止推断，过期后仍可记录四种发送终态', async () => {
    for (const to of ['completed', 'failed', 'cancelled', 'send_unconfirmed'] as const) {
      const fixture = await fixtureAt('sending');
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

  it('非 running 状态不能创建或采用尝试、开启等待，跨任务尝试不能借用', async () => {
    for (const status of ['queued', 'waiting_for_user', 'ready_to_send', 'sending'] as const) {
      const fixture = await fixtureAt(status);
      const before = await storeA.getTask(fixture.taskId);
      const version = { taskId: fixture.taskId, inputVersion: 1, now: now + 700 };
      const attemptId = randomUUID();
      const waitId = randomUUID();
      expect(
        await storeB.startAttempt({
          ...version,
          attemptId,
          expectedAttemptId: before!.currentAttemptId,
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
    const owner = await fixtureAt('running');
    const borrower = await fixtureAt('running');
    const version = { taskId: borrower.taskId, inputVersion: 1, now: now + 700 };
    const waitId = randomUUID();
    expect(await storeB.adoptAttempt({ ...version, attemptId: owner.attemptId! })).toBe(false);
    expect(
      await storeB.waitForUser({
        ...version,
        attemptId: owner.attemptId!,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(false);
    expect(await storeA.getUserWait(waitId)).toBeNull();
    expect(await storeA.getAttempt(owner.attemptId!)).toMatchObject({ adopted: false });
    expect(await storeA.getTask(borrower.taskId)).toMatchObject({
      status: 'running',
      currentAttemptId: borrower.attemptId,
    });
  });

  it('两个不同回答竞争同一等待只消费一次，败方不能覆盖决定与执行截止', async () => {
    const fixture = await waitingFixture();
    const answers = [
      await message(fixture.scope, waitedAt + 100),
      await message(fixture.scope, waitedAt + 200),
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

  it('截止前一毫秒允许开始尝试、进入 sending 及修改 queued/running 输入', async () => {
    const running = await fixtureAt('running');
    const replacement = await startAttempt(running, storeB, {
      expectedAttemptId: running.attemptId,
      startedAt: executionDeadline - 1,
    });
    expect(await storeA.getTask(running.taskId)).toMatchObject({
      currentAttemptId: replacement.attemptId,
      executionDeadline,
    });
    const ready = await fixtureAt('ready_to_send');
    expect(
      await storeB.transitionTask({
        taskId: ready.taskId,
        inputVersion: 1,
        now: executionDeadline - 1,
        from: 'ready_to_send',
        to: 'sending',
      })
    ).toBe(true);
    for (const status of ['queued', 'running'] as const) {
      const fixture = await fixtureAt(status);
      const before = await storeA.getTask(fixture.taskId);
      const at = status === 'queued' ? fixture.input.queueDeadline - 1 : executionDeadline - 1;
      expect(
        await storeB.updateInputVersion({ taskId: fixture.taskId, inputVersion: 1, now: at })
      ).toBe(true);
      expect(await storeA.getTask(fixture.taskId)).toMatchObject({
        inputVersion: 2,
        currentAttemptId: null,
        queueDeadline: before!.queueDeadline,
        executionDeadline: before!.executionDeadline,
      });
    }
  });

  it('关闭写入连接再重建可恢复十状态、全部尝试和等待字段，毫秒截止不会重置', async () => {
    const writingPool = createPostgresPool(database.databaseUrl, { max: 1 });
    const writingStore = new PostgresTaskStore(writingPool);
    const saved: {
      taskId: string;
      task: Task | null;
      attemptId: string | null;
      attempt: TaskAttempt | null;
      waitId: string | null;
      wait: UserWait | null;
    }[] = [];
    let writingPid: number;
    try {
      const identity = (await writingPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0];
      if (!identity) throw new Error('写入连接未返回后端进程 ID');
      writingPid = identity.pid;
      for (const status of statuses) {
        const fixture = await fixtureAt(status, writingStore);
        const task = await writingStore.getTask(fixture.taskId);
        expect(task?.status).toBe(status);
        saved.push({
          taskId: fixture.taskId,
          task,
          attemptId: fixture.attemptId,
          attempt: fixture.attemptId ? await writingStore.getAttempt(fixture.attemptId) : null,
          waitId: fixture.waitId,
          wait: fixture.waitId ? await writingStore.getUserWait(fixture.waitId) : null,
        });
      }
      for (const decision of ['accepted', 'declined'] as const) {
        const fixture = await waitingFixture(scopeFor(), writingStore);
        const answerMessage = await message(fixture.scope, waitedAt + 123);
        expect(
          await writingStore.resolveUserWait({
            taskId: fixture.taskId,
            inputVersion: 1,
            now: waitedAt + 456,
            waitId: fixture.waitId,
            answerMessage,
            decision,
          })
        ).toBe(true);
        const wait = await writingStore.getUserWait(fixture.waitId);
        expect(wait).toMatchObject({
          resolution: decision,
          closedAt: waitedAt + 456,
          answerMessage,
        });
        saved.push({
          taskId: fixture.taskId,
          task: await writingStore.getTask(fixture.taskId),
          attemptId: fixture.attemptId,
          attempt: await writingStore.getAttempt(fixture.attemptId),
          waitId: fixture.waitId,
          wait,
        });
      }
      const failedRun = await runningFixture(scopeFor(), writingStore);
      const failedAttempt = await startAttempt(failedRun, writingStore);
      expect(
        await writingStore.finishAttempt({
          attemptId: failedAttempt.attemptId,
          finishedAt: now + 333,
          errorType: 'model',
        })
      ).toBe(true);
      const failedAudit = await writingStore.getAttempt(failedAttempt.attemptId);
      expect(failedAudit).toMatchObject({
        finishedAt: now + 333,
        errorType: 'model',
        adopted: false,
      });
      saved.push({
        taskId: failedRun.taskId,
        task: await writingStore.getTask(failedRun.taskId),
        attemptId: failedAttempt.attemptId,
        attempt: failedAudit,
        waitId: null,
        wait: null,
      });
    } finally {
      await writingPool.end();
    }
    const recoveredPool = createPostgresPool(database.databaseUrl, { max: 1 });
    try {
      const connection = (
        await recoveredPool.query<{ name: string; pid: number }>(
          'SELECT current_database() AS name, pg_backend_pid() AS pid'
        )
      ).rows[0];
      if (!connection) throw new Error('恢复连接未返回数据库身份');
      expect(connection.name).toBe(database.databaseName);
      expect(connection.pid).not.toBe(writingPid);
      const recovered = new PostgresTaskStore(recoveredPool);
      for (const row of saved) {
        expect(await recovered.getTask(row.taskId)).toEqual(row.task);
        if (row.attemptId) expect(await recovered.getAttempt(row.attemptId)).toEqual(row.attempt);
        if (row.waitId) expect(await recovered.getUserWait(row.waitId)).toEqual(row.wait);
      }
      const waiting = saved.find(row => row.task?.status === 'waiting_for_user')!;
      expect(waiting.wait).toMatchObject({
        createdAt: waitedAt,
        deadline: waitDeadline,
        remainingExecutionMs,
      });
      const answeredAt = waitedAt + 12_345;
      const answerMessage = await message(waiting.task!, answeredAt);
      expect(
        await recovered.resolveUserWait({
          taskId: waiting.taskId,
          inputVersion: 1,
          now: answeredAt,
          waitId: waiting.waitId!,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(true);
      expect(await recovered.getTask(waiting.taskId)).toMatchObject({
        executionDeadline: answeredAt + remainingExecutionMs,
        queueDeadline: waiting.task!.queueDeadline,
        status: 'running',
      });
    } finally {
      await recoveredPool.end();
    }
  }, 30_000);

  it('真实 SQL 约束错误向上传播，事务回滚后任务及尝试不变且连接仍能使用', async () => {
    const fixture = await runningFixture();
    const attempt = await successfulAttempt(fixture);
    const input = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: waitedAt,
      attemptId: attempt.attemptId,
      waitId: randomUUID(),
      question,
      allowedQuestionIds: [],
    };
    const before = {
      task: await storeA.getTask(fixture.taskId),
      attempt: await storeA.getAttempt(attempt.attemptId),
    };
    // 使用真实 PostgreSQL 非空范围 CHECK 触发事务内错误，不替换查询或连接池。
    await expect(storeA.waitForUser(input)).rejects.toMatchObject({ code: '23514' });
    expect(await storeB.getTask(fixture.taskId)).toEqual(before.task);
    expect(await storeB.getAttempt(attempt.attemptId)).toEqual(before.attempt);
    expect(await storeB.getUserWait(input.waitId)).toBeNull();
    // 同一 max:1 池继续成功提交，证明失败事务已经回滚并释放连接。
    expect(await storeA.waitForUser({ ...input, allowedQuestionIds })).toBe(true);
    expect(await storeB.getUserWait(input.waitId)).toMatchObject({
      allowedQuestionIds,
      closedAt: null,
    });
  });
});
