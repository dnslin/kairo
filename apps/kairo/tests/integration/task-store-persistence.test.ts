import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool } from '../../src/db/pool.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type {
  Task,
  TaskAttempt,
  TaskStatus,
  UserWait,
} from '../../src/modules/task-lifecycle/types.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import {
  now,
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
  fixtureAt,
} from '../helpers/task-fixtures.js';

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

describe('T19 任务账本迁移、连接恢复与回滚', () => {
  it('首次及重复迁移建立任务账本且不改变已保存记录', async () => {
    const fixture = await waitingFixture(storeA, chat);
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

  it('关闭写入连接再重建可恢复十状态、全部尝试和等待字段，毫秒截止不会重置', async () => {
    const writingPool = createPostgresPool(database.databaseUrl, { max: 1 });
    const writingStore = new PostgresTaskStore(writingPool);
    interface SavedTask {
      taskId: string;
      task: Task | null;
      attemptId: string | null;
      attempt: TaskAttempt | null;
      waitId: string | null;
      wait: UserWait | null;
    }
    const saved: SavedTask[] = [];
    let writingPid: number;
    try {
      const identity = (await writingPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0];
      if (!identity) throw new Error('写入连接未返回后端进程 ID');
      writingPid = identity.pid;
      for (const status of statuses) {
        const fixture = await fixtureAt(writingStore, chat, status);
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
        const fixture = await waitingFixture(writingStore, chat, scopeFor());
        const answerMessage = await message(chat, fixture.scope, waitedAt + 123);
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
      const failedRun = await claimedFixture(writingStore, chat, scopeFor());
      const failedAttempt = await startAttempt(writingStore, failedRun);
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
      const waiting = saved.find(row => row.task?.status === 'waiting_for_user');
      if (!waiting?.task || !waiting.waitId) throw new Error('恢复记录缺少开放等待及任务');
      expect(waiting.wait).toMatchObject({
        createdAt: waitedAt,
        deadline: waitDeadline,
        remainingExecutionMs,
      });
      const answeredAt = waitedAt + 12_345;
      const answerMessage = await message(chat, waiting.task, answeredAt);
      expect(
        await recovered.resolveUserWait({
          taskId: waiting.taskId,
          inputVersion: 1,
          now: answeredAt,
          waitId: waiting.waitId,
          answerMessage,
          decision: 'accepted',
        })
      ).toBe(true);
      expect(await recovered.getTask(waiting.taskId)).toMatchObject({
        executionDeadline: answeredAt + remainingExecutionMs,
        queueDeadline: waiting.task.queueDeadline,
        status: 'running',
      });
    } finally {
      await recoveredPool.end();
    }
  }, 30_000);

  it('真实 SQL 约束错误向上传播，事务回滚后任务及尝试不变且连接仍能使用', async () => {
    const fixture = await claimedFixture(storeA, chat);
    const attempt = await successfulAttempt(storeA, fixture);
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
