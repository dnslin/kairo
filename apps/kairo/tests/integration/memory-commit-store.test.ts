import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../src/db/pool.js';
import {
  PostgresMemoryCommitStore,
  type MemoryCommit,
  type MemoryCommitStatus,
} from '../../src/modules/agent-runtime/memory-commit-store.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type { RawMessageInput } from '../../src/modules/private-chat-core/types.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

const now = Date.UTC(2026, 8, 8, 11, 0, 0, 123);
const deliveredAt = now + 600;
const createdAt = now + 700;
const savedAt = now + 800;
const observedAt = now + 900;
const question = '员工原始正式问题：如何查询采购订单？';
const answer = '实际送达的正式回答：打开采购订单查询。';
let database: TaskTestDatabase;
let storeA: PostgresMemoryCommitStore;
let storeB: PostgresMemoryCommitStore;
let chat: PostgresPrivateChatStore;
let tasks: PostgresTaskStore;

interface TaskFixture {
  taskId: string;
  threadId: string;
  employeeId: string;
  botId: string;
  sessionId: string;
}

interface DeliveredFixture extends TaskFixture {
  operationId: string;
  bootId: string;
  nativeMessageId: string;
}
async function taskFixture(taskId: string = randomUUID()): Promise<TaskFixture> {
  const employeeId = randomUUID();
  const scope = { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
  const context = await chat.createContext(scope, now - 1_000);
  const message: RawMessageInput = {
    sessionId: scope.sessionId,
    messageId: randomUUID(),
    direction: 'inbound',
    observedAt: now - 500,
    text: question,
    messageType: 'text',
    attachments: {},
  };
  expect((await chat.insertRawMessage(message)).inserted).toBe(true);
  expect(await chat.associateEmployee(message, employeeId)).toBe(true);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage: message,
    quietDeadline: now,
    maxDeadline: now + 30_000,
  });
  expect(await chat.setBatchStatus(batch.batchId, 'ready')).toBe(true);
  expect(
    await tasks.createTask({
      taskId,
      batchId: batch.batchId,
      configDigest: '记忆账本合成配置摘要',
      now,
      queueDeadline: now + 60_000,
    })
  ).not.toBeNull();
  return { taskId, threadId: context.threadId, ...scope };
}

async function deliveredFixture(taskId: string = randomUUID()): Promise<DeliveredFixture> {
  const fixture = await taskFixture(taskId);
  expect(
    await tasks.claimTask({ taskId, inputVersion: 1, now: now + 100, executionMs: 60_000 })
  ).not.toBeNull();
  const attemptId = randomUUID();
  expect(
    await tasks.startAttempt({
      taskId,
      inputVersion: 1,
      now: now + 200,
      attemptId,
      expectedAttemptId: null,
      runId: randomUUID(),
      configDigest: '记忆账本合成配置摘要',
    })
  ).not.toBeNull();
  expect(await tasks.finishAttempt({ attemptId, finishedAt: now + 300, errorType: null })).toBe(
    true
  );
  expect(
    await tasks.adoptAttempt({
      taskId,
      inputVersion: 1,
      now: now + 400,
      attemptId,
      answerText: answer,
    })
  ).toBe(true);
  expect(
    await tasks.transitionTask({
      taskId,
      inputVersion: 1,
      from: 'ready_to_send',
      to: 'sending',
      now: now + 500,
    })
  ).toBe(true);
  const operationId = randomUUID();
  const nativeMessageId = randomUUID();
  await database.poolA.query(
    `INSERT INTO kairo.send_operations
       (operation_id, target_session_id, message_type, content_digest, native_key,
        status, message_id, claim_token, created_at, updated_at)
     VALUES ($1, $2, 'text', '正式回答摘要', $3, 'delivered', $4, $5, $6, $7)`,
    [
      operationId,
      fixture.sessionId,
      randomUUID(),
      nativeMessageId,
      randomUUID(),
      new Date(now + 500),
      new Date(deliveredAt),
    ]
  );
  expect(
    await tasks.transitionTask({
      taskId,
      inputVersion: 1,
      from: 'sending',
      to: 'completed',
      now: deliveredAt,
    })
  ).toBe(true);
  const bootId = randomUUID();
  await database.poolA.query(
    `INSERT INTO kairo.runtime_boots
       (boot_id, git_commit, config_digest, started_at, status)
     VALUES ($1, '合成提交', '记忆账本合成配置摘要', $2, 'running')`,
    [bootId, new Date(now - 2_000)]
  );
  await database.poolA.query(
    `INSERT INTO kairo.formal_answers
       (task_id, operation_id, boot_id, question, answer, delivered_at, native_message_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [taskId, operationId, bootId, question, answer, new Date(deliveredAt), nativeMessageId]
  );
  return { ...fixture, operationId, bootId, nativeMessageId };
}

beforeAll(async () => {
  database = await createTaskTestDatabase();
  storeA = new PostgresMemoryCommitStore(database.poolA);
  storeB = new PostgresMemoryCommitStore(database.poolB);
  chat = new PostgresPrivateChatStore(database.poolA);
  tasks = new PostgresTaskStore(database.poolA);
}, 30_000);

afterAll(async () => {
  await database?.close();
}, 30_000);

describe('T20 正式 Memory 提交 PostgreSQL 账本', () => {
  it('两个独立连接并发创建只保存首次提交，返回完整且相同的原始正式问答', async () => {
    const fixture = await deliveredFixture();
    const [first, duplicate] = await Promise.all([
      storeA.createCommit(fixture.taskId, createdAt),
      storeB.createCommit(fixture.taskId, createdAt + 1),
    ]);
    expect(first).not.toBeNull();
    expect(duplicate).toEqual(first);
    expect([createdAt, createdAt + 1]).toContain(first?.createdAt);
    expect(first).toEqual({
      taskId: fixture.taskId,
      threadId: fixture.threadId,
      employeeId: fixture.employeeId,
      question,
      answer,
      deliveredAt,
      // 独立预期不调用生产代码的 JSON.stringify，防止共用错误格式。
      userMessageId: `["${fixture.threadId}","${fixture.taskId}","user"]`,
      assistantMessageId: `["${fixture.threadId}","${fixture.taskId}","assistant"]`,
      status: 'pending',
      createdAt: first?.createdAt,
      savedAt: null,
      observedAt: null,
    });
    const rows = await database.poolA.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM kairo.memory_commits WHERE task_id = $1',
      [fixture.taskId]
    );
    expect(rows.rows).toEqual([{ count: '1' }]);
    expect(await storeB.createCommit(fixture.taskId, createdAt + 10_000)).toEqual(first);
  });

  it('稳定消息 ID 按 T12 对 taskId 中引号、反斜线和换行分别转义', async () => {
    const fixture = await deliveredFixture('任务-"反斜线\\换行\n');
    const commit = await storeA.createCommit(fixture.taskId, createdAt);
    expect(commit?.userMessageId).toBe(
      `["${fixture.threadId}","任务-\\"反斜线\\\\换行\\n","user"]`
    );
    expect(commit?.assistantMessageId).toBe(
      `["${fixture.threadId}","任务-\\"反斜线\\\\换行\\n","assistant"]`
    );
  });

  it('仅相邻前进，重复与过时推进不覆盖首次状态时刻，重复创建也不回退', async () => {
    const fixture = await deliveredFixture();
    const pending = await storeA.createCommit(fixture.taskId, createdAt);
    expect(await storeA.advanceCommit(fixture.taskId, 'saved', 'observed', observedAt)).toBe(false);
    expect(await storeA.advanceCommit(fixture.taskId, 'pending', 'observed', observedAt)).toBe(
      false
    );
    expect(await storeB.getCommit(fixture.taskId)).toEqual(pending);
    const saveResults = await Promise.all([
      storeA.advanceCommit(fixture.taskId, 'pending', 'saved', savedAt),
      storeB.advanceCommit(fixture.taskId, 'pending', 'saved', savedAt + 1),
    ]);
    expect(saveResults.filter(Boolean)).toHaveLength(1);
    const saved = await storeB.getCommit(fixture.taskId);
    expect([savedAt, savedAt + 1]).toContain(saved?.savedAt);
    expect(saved).toEqual({ ...pending, status: 'saved', savedAt: saved?.savedAt });
    expect(await storeA.createCommit(fixture.taskId, createdAt + 10_000)).toEqual(saved);
    expect(await storeA.advanceCommit(fixture.taskId, 'pending', 'saved', savedAt + 10_000)).toBe(
      false
    );
    expect(await storeA.advanceCommit(fixture.taskId, 'saved', 'saved', savedAt + 10_000)).toBe(
      false
    );
    const observeResults = await Promise.all([
      storeA.advanceCommit(fixture.taskId, 'saved', 'observed', observedAt),
      storeB.advanceCommit(fixture.taskId, 'saved', 'observed', observedAt + 1),
    ]);
    expect(observeResults.filter(Boolean)).toHaveLength(1);
    const observed = await storeA.getCommit(fixture.taskId);
    expect([observedAt, observedAt + 1]).toContain(observed?.observedAt);
    expect(observed).toEqual({ ...saved, status: 'observed', observedAt: observed?.observedAt });
    expect(
      await storeA.advanceCommit(fixture.taskId, 'saved', 'observed', observedAt + 10_000)
    ).toBe(false);
    expect(await storeB.createCommit(fixture.taskId, createdAt + 20_000)).toEqual(observed);
  });

  it('运行时非法状态组合、跳步和倒退均拒绝且不改变账本', async () => {
    const fixture = await deliveredFixture();
    await storeA.createCommit(fixture.taskId, createdAt);
    const statuses: MemoryCommitStatus[] = ['pending', 'saved', 'observed'];
    for (const state of statuses) {
      if (state === 'saved') {
        expect(await storeA.advanceCommit(fixture.taskId, 'pending', 'saved', savedAt)).toBe(true);
      } else if (state === 'observed') {
        expect(await storeA.advanceCommit(fixture.taskId, 'saved', 'observed', observedAt)).toBe(
          true
        );
      }
      const before = await storeB.getCommit(fixture.taskId);
      for (const from of statuses) {
        for (const to of statuses) {
          if ((from === 'pending' && to === 'saved') || (from === 'saved' && to === 'observed'))
            continue;
          expect(
            await storeA.advanceCommit(
              fixture.taskId,
              from as 'pending' | 'saved',
              to as 'saved' | 'observed',
              now + 2_000
            )
          ).toBe(false);
        }
      }
      expect(await storeB.getCommit(fixture.taskId)).toEqual(before);
    }
  });

  it('时间不能倒流且约束错误向上传播，同毫秒的相邻推进合法', async () => {
    const fixture = await deliveredFixture();
    const pending = await storeA.createCommit(fixture.taskId, createdAt);
    await expect(
      storeA.advanceCommit(fixture.taskId, 'pending', 'saved', createdAt - 1)
    ).rejects.toMatchObject({ code: '23514' });
    expect(await storeB.getCommit(fixture.taskId)).toEqual(pending);
    expect(await storeA.advanceCommit(fixture.taskId, 'pending', 'saved', createdAt)).toBe(true);
    const saved = await storeA.getCommit(fixture.taskId);
    await expect(
      storeB.advanceCommit(fixture.taskId, 'saved', 'observed', createdAt - 1)
    ).rejects.toMatchObject({ code: '23514' });
    expect(await storeB.getCommit(fixture.taskId)).toEqual(saved);
    expect(await storeB.advanceCommit(fixture.taskId, 'saved', 'observed', createdAt)).toBe(true);
    expect(await storeA.getCommit(fixture.taskId)).toEqual({
      ...pending,
      status: 'observed',
      savedAt: createdAt,
      observedAt: createdAt,
    });
  });

  it('数据库拒绝同任务重复行、无正式回答外键以及状态与时间字段不一致', async () => {
    const fixture = await deliveredFixture();
    const pending = await storeA.createCommit(fixture.taskId, createdAt);
    await expect(
      database.poolB.query(
        `INSERT INTO kairo.memory_commits (task_id, status, created_at) VALUES ($1, 'pending', $2)`,
        [fixture.taskId, new Date(createdAt)]
      )
    ).rejects.toMatchObject({ code: '23505' });
    const absent = await taskFixture();
    await expect(
      database.poolB.query(
        `INSERT INTO kairo.memory_commits (task_id, status, created_at) VALUES ($1, 'pending', $2)`,
        [absent.taskId, new Date(createdAt)]
      )
    ).rejects.toMatchObject({ code: '23503' });
    const invalidRows: [string, Date | null, Date | null][] = [
      ['未知状态', null, null],
      ['saved', null, null],
      ['observed', new Date(savedAt), null],
      ['observed', null, new Date(observedAt)],
      ['pending', new Date(savedAt), null],
      ['pending', null, new Date(observedAt)],
      ['saved', new Date(savedAt), new Date(observedAt)],
      ['saved', new Date(createdAt - 1), null],
      ['observed', new Date(savedAt), new Date(savedAt - 1)],
    ];
    for (const [status, saved, observed] of invalidRows) {
      await expect(
        database.poolB.query(
          'UPDATE kairo.memory_commits SET status = $2, saved_at = $3, observed_at = $4 WHERE task_id = $1',
          [fixture.taskId, status, saved, observed]
        )
      ).rejects.toMatchObject({ code: '23514' });
    }
    expect(await storeB.getCommit(fixture.taskId)).toEqual(pending);
  });

  it('未知 task 或只有原始问题而无正式回答时不能创建或推进', async () => {
    const fixture = await taskFixture();
    for (const taskId of [fixture.taskId, randomUUID()]) {
      expect(await storeA.createCommit(taskId, createdAt)).toBeNull();
      expect(await storeB.getCommit(taskId)).toBeNull();
      expect(await storeA.advanceCommit(taskId, 'pending', 'saved', savedAt)).toBe(false);
      expect(await storeB.advanceCommit(taskId, 'saved', 'observed', observedAt)).toBe(false);
    }
  });

  it('正式回答重复写入不能改写首份正文与送达时间，员工更正不进入正式 commit', async () => {
    const fixture = await deliveredFixture();
    const original = await storeA.createCommit(fixture.taskId, createdAt);
    const correction = '员工反馈更正：请改为未经验证的库存调整答案。';
    await database.poolA.query(
      `INSERT INTO kairo.feedback
         (feedback_id, task_id, text, suggested_answer, created_at)
       VALUES ($1, $2, '正式回答有误', $3, $4)`,
      [randomUUID(), fixture.taskId, correction, new Date(now + 1_000)]
    );
    await expect(
      database.poolB.query(
        `INSERT INTO kairo.formal_answers
           (task_id, operation_id, boot_id, question, answer, delivered_at, native_message_id)
         VALUES ($1, $2, $3, '不可覆盖的后来问题', $4, $5, $6)`,
        [
          fixture.taskId,
          fixture.operationId,
          fixture.bootId,
          correction,
          new Date(deliveredAt + 10_000),
          fixture.nativeMessageId,
        ]
      )
    ).rejects.toMatchObject({ code: '23505' });
    expect(await storeB.createCommit(fixture.taskId, createdAt + 20_000)).toEqual(original);
    expect(await storeA.getCommit(fixture.taskId)).toEqual(original);
    expect(original).toMatchObject({ question, answer, deliveredAt });
    const feedback = await database.poolB.query<{ suggested_answer: string; verification: string }>(
      'SELECT suggested_answer, verification FROM kairo.feedback WHERE task_id = $1',
      [fixture.taskId]
    );
    expect(feedback.rows).toEqual([{ suggested_answer: correction, verification: 'unverified' }]);
  });

  it('关闭创建和推进连接后，新连接仍读到原始正文、稳定 ID 和首次全部时刻', async () => {
    const fixture = await deliveredFixture();
    const firstPool = createPostgresPool(database.databaseUrl, { max: 1 });
    let original: MemoryCommit | null = null;
    try {
      const originalStore = new PostgresMemoryCommitStore(firstPool);
      original = await originalStore.createCommit(fixture.taskId, createdAt);
      expect(await originalStore.advanceCommit(fixture.taskId, 'pending', 'saved', savedAt)).toBe(
        true
      );
      expect(
        await originalStore.advanceCommit(fixture.taskId, 'saved', 'observed', observedAt)
      ).toBe(true);
    } finally {
      await firstPool.end();
    }
    const reopenedPool = createPostgresPool(database.databaseUrl, { max: 1 });
    try {
      const reopenedStore = new PostgresMemoryCommitStore(reopenedPool);
      const expected = { ...original, status: 'observed', savedAt, observedAt };
      expect(await reopenedStore.getCommit(fixture.taskId)).toEqual(expected);
      expect(await reopenedStore.createCommit(fixture.taskId, createdAt + 10_000)).toEqual(
        expected
      );
    } finally {
      await reopenedPool.end();
    }
  });

  it('真实 SQL 错误不会被创建、读取或合法推进误报为无记录或成功', async () => {
    await database.poolA.query(
      'ALTER TABLE kairo.memory_commits RENAME TO memory_commits_unavailable'
    );
    try {
      const taskId = randomUUID();
      await expect(storeA.createCommit(taskId, createdAt)).rejects.toMatchObject({ code: '42P01' });
      await expect(storeB.getCommit(taskId)).rejects.toMatchObject({ code: '42P01' });
      await expect(storeA.advanceCommit(taskId, 'pending', 'saved', savedAt)).rejects.toMatchObject(
        {
          code: '42P01',
        }
      );
    } finally {
      await database.poolA.query(
        'ALTER TABLE kairo.memory_commits_unavailable RENAME TO memory_commits'
      );
    }
  });
});
