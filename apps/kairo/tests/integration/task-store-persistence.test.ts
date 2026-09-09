import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../src/db/pool.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type {
  Task,
  TaskAttempt,
  TaskStatus,
  UserWait,
} from '../../src/modules/task-lifecycle/types.js';
import {
  createTaskTestContext,
  type TaskTestContext,
  type TaskFixture,
  now,
  waitedAt,
  waitDeadline,
  remainingExecutionMs,
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

describe('T19 迁移、连接恢复与事务回滚', () => {
  it('首次及重复迁移建立任务账本且不改变已保存记录', async () => {
    const fixture = await context.waitingFixture();
    const before = {
      task: await context.storeA.getTask(fixture.taskId),
      attempt: await context.storeA.getAttempt(fixture.attemptId),
      wait: await context.storeA.getUserWait(fixture.waitId),
      migrations: (
        await context.database.poolA.query('SELECT name FROM kairo.pgmigrations ORDER BY name')
      ).rows,
    };
    expect(await migrateDatabase({ databaseUrl: context.database.databaseUrl })).toEqual([]);
    expect(await context.storeB.getTask(fixture.taskId)).toEqual(before.task);
    expect(await context.storeB.getAttempt(fixture.attemptId)).toEqual(before.attempt);
    expect(await context.storeB.getUserWait(fixture.waitId)).toEqual(before.wait);
    expect(
      (await context.database.poolB.query('SELECT name FROM kairo.pgmigrations ORDER BY name')).rows
    ).toEqual(before.migrations);
  }, 30000);

  it('关闭写入连接再重建可恢复十状态、全部尝试和等待字段，毫秒截止不会重置', async () => {
    const writingPool = createPostgresPool(context.database.databaseUrl, { max: 1 });
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
      const identity = (
        await writingPool.query<{
          pid: number;
        }>('SELECT pg_backend_pid() AS pid')
      ).rows[0];
      if (!identity) throw new Error('写入连接未返回后端进程 ID');
      writingPid = identity.pid;
      // 这里确实遍历全部状态；每个入口明确说明对应的前置事实。
      const scenarios: [
        TaskStatus,
        () => Promise<TaskFixture & { attemptId?: string; waitId?: string }>,
      ][] = [
        ['queued', () => context.queuedFixture(context.scopeFor(), writingStore)],
        ['running', () => context.runningWithSuccessfulAttempt(context.scopeFor(), writingStore)],
        ['waiting_for_user', () => context.waitingFixture(context.scopeFor(), writingStore)],
        ['ready_to_send', () => context.readyToSendFixture(context.scopeFor(), writingStore)],
        ['sending', () => context.sendingFixture(context.scopeFor(), writingStore)],
        ['completed', () => context.finishedSendingFixture('completed', writingStore)],
        ['failed', () => context.failedFixture(writingStore)],
        ['cancelled', () => context.cancelledFixture(writingStore)],
        ['timed_out', () => context.timedOutFixture(writingStore)],
        [
          'send_unconfirmed',
          () => context.finishedSendingFixture('send_unconfirmed', writingStore),
        ],
      ];
      for (const [status, create] of scenarios) {
        const fixture = await create();
        const attemptId = fixture.attemptId ?? null;
        const waitId = fixture.waitId ?? null;
        const task = await writingStore.getTask(fixture.taskId);
        expect(task?.status).toBe(status);
        saved.push({
          taskId: fixture.taskId,
          task,
          attemptId,
          attempt: attemptId ? await writingStore.getAttempt(attemptId) : null,
          waitId,
          wait: waitId ? await writingStore.getUserWait(waitId) : null,
        });
      }
      for (const decision of ['accepted', 'declined'] as const) {
        const fixture = await context.waitingFixture(context.scopeFor(), writingStore);
        const answerMessage = await context.message(fixture.scope, waitedAt + 123);
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
      const failedRun = await context.runningFixture(context.scopeFor(), writingStore);
      const failedAttempt = await context.startAttempt(failedRun, writingStore);
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
    const recoveredPool = createPostgresPool(context.database.databaseUrl, { max: 1 });
    try {
      const connection = (
        await recoveredPool.query<{
          name: string;
          pid: number;
        }>('SELECT current_database() AS name, pg_backend_pid() AS pid')
      ).rows[0];
      if (!connection) throw new Error('恢复连接未返回数据库身份');
      expect(connection.name).toBe(context.database.databaseName);
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
      const answeredAt = waitedAt + 12345;
      const answerMessage = await context.message(waiting.task!, answeredAt);
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
  }, 30000);

  it('真实 SQL 约束错误向上传播，事务回滚后任务及尝试不变且连接仍能使用', async () => {
    const fixture = await context.runningFixture();
    const attempt = await context.successfulAttempt(fixture);
    const input = {
      taskId: fixture.taskId,
      inputVersion: 1,
      now: waitedAt,
      attemptId: attempt.attemptId,
      waitId: randomUUID(),
      question,
      allowedQuestionIds,
    };
    const before = {
      task: await context.storeA.getTask(fixture.taskId),
      attempt: await context.storeA.getAttempt(attempt.attemptId),
    };
    // 只针对本次随机 task：让等待插入、attempt 采用先成功，最后的 task 更新再失败。
    await context.database.poolA
      .query(`ALTER TABLE kairo.tasks ADD CONSTRAINT t19_forced_wait_failure
      CHECK (task_id <> '${fixture.taskId}' OR status <> 'waiting_for_user')`);
    try {
      await expect(context.storeA.waitForUser(input)).rejects.toMatchObject({
        code: '23514',
        constraint: 't19_forced_wait_failure',
      });
      expect(await context.storeB.getTask(fixture.taskId)).toEqual(before.task);
      expect(await context.storeB.getAttempt(attempt.attemptId)).toEqual(before.attempt);
      expect(await context.storeB.getUserWait(input.waitId)).toBeNull();
    } finally {
      await context.database.poolA.query(
        'ALTER TABLE kairo.tasks DROP CONSTRAINT t19_forced_wait_failure'
      );
    }
    // 同一 max:1 池继续提交同一 waitId，验证没有残留写入或事务。
    expect(await context.storeA.waitForUser(input)).toBe(true);
    expect(await context.storeB.getUserWait(input.waitId)).toMatchObject({
      allowedQuestionIds,
      closedAt: null,
    });
  });
});
