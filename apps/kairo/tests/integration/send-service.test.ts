import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { FakeKK9Driver, type FakeSendBehavior, type SendOperationStore } from '@kairo/driver';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool } from '../../src/db/pool.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import { AppError, getFailureMessage } from '../../src/modules/operability/errors.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import { PostgresSendOperationStore } from '../../src/modules/im-transport/postgres-send-operation-store.js';
import { PostgresSendDispatchStore } from '../../src/modules/im-transport/postgres-send-dispatch-store.js';
import { createSendService } from '../../src/modules/im-transport/send-service.js';
import { createSendIntent, type SendRequest } from '../../src/modules/im-transport/send-policy.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

let database: TaskTestDatabase;
let chat: PostgresPrivateChatStore;
let tasks: PostgresTaskStore;
let dispatches: PostgresSendDispatchStore;
const logger = createLogger({ write(): void {} });

async function fixture(purpose: SendRequest['purpose'] = 'final', existingScope?: ContextScope) {
  const now = Date.now();
  const employeeId = randomUUID();
  const scope = existingScope ?? { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
  const context = await chat.createContext(scope, now - 1000);
  const message = { sessionId: scope.sessionId, messageId: randomUUID() };
  await chat.insertRawMessage({
    ...message,
    direction: 'inbound',
    observedAt: now - 500,
    text: '发送集成测试问题',
    messageType: 'text',
    attachments: {},
  });
  await chat.associateEmployee(message, scope.employeeId);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage: message,
    quietDeadline: now,
    maxDeadline: now + 60_000,
  });
  await chat.setBatchStatus(batch.batchId, 'ready');
  const taskId = randomUUID();
  await tasks.createTask({
    taskId,
    batchId: batch.batchId,
    configDigest: '集成配置摘要',
    now,
    queueDeadline: now + 600_000,
  });
  if (purpose !== 'queued') {
    await tasks.claimTask({ taskId, inputVersion: 1, now, executionMs: 240_000 });
    if (purpose === 'final') {
      const attemptId = randomUUID();
      await tasks.startAttempt({
        taskId,
        inputVersion: 1,
        now,
        attemptId,
        runId: randomUUID(),
        configDigest: '集成配置摘要',
        expectedAttemptId: null,
      });
      await tasks.finishAttempt({ attemptId, finishedAt: now, errorType: null });
      await tasks.adoptAttempt({ taskId, inputVersion: 1, now, attemptId });
    }
  }
  const request: SendRequest = {
    subject: { kind: 'task', taskId, inputVersion: 1 },
    purpose,
    text: '发送集成测试答案',
  };
  return { scope, context, taskId, request, message };
}

function service(
  pool = database.poolA,
  createDriver = (store: SendOperationStore) => new FakeKK9Driver(store)
) {
  return createSendService({
    createDriver,
    driverStore: new PostgresSendOperationStore(pool),
    dispatches: new PostgresSendDispatchStore(pool),
    tasks: new PostgresTaskStore(pool),
    contexts: new PostgresPrivateChatStore(pool),
    logger,
  });
}

beforeAll(async () => {
  // 复用既有随机临时库机制；从不迁移 KAIRO_TEST_DATABASE_URL 指向的原库。
  database = await createTaskTestDatabase();
  chat = new PostgresPrivateChatStore(database.poolA);
  tasks = new PostgresTaskStore(database.poolA);
  dispatches = new PostgresSendDispatchStore(database.poolA);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await database?.close();
});

describe('T21 真实 PostgreSQL 发送协调', () => {
  it('两个真实连接竞争同一意图，调用 Driver 前已有唯一 operationId，重复事件不重发', async () => {
    const f = await fixture();
    const drivers: FakeKK9Driver[] = [];
    const factory = (store: SendOperationStore) => {
      const driver = new FakeKK9Driver(store);
      drivers.push(driver);
      driver.setSendBehavior({
        mode: 'custom',
        handler: async (_body, options) => {
          const record = await new PostgresSendDispatchStore(database.poolB).get(
            options!.operationId!
          );
          expect(record).toMatchObject({ status: 'sending', taskId: f.taskId, sendCalls: 1 });
          return { success: true, status: 'delivered', messageId: '原生送达编号' };
        },
      });
      return driver;
    };
    const a = service(database.poolA, factory);
    const b = service(database.poolB, factory);
    const results = await Promise.all([a.send(f.request), b.send(f.request)]);
    expect(results[0].operationId).toBe(results[1].operationId);
    expect(await a.send(f.request)).toMatchObject({ status: 'delivered', sendCalls: 1 });
    expect(drivers.reduce((count, driver) => count + driver.recordedCalls.length, 0)).toBe(1);
    expect((await tasks.getTask(f.taskId))?.status).toBe('completed');
    await expect(a.send({ ...f.request, text: '不同答案' })).rejects.toThrow();
    a.close();
    b.close();
  });

  it.each([
    [
      '失败后送达',
      [
        { mode: 'pre_trigger_failure', error: '发送前故障' },
        { mode: 'success', messageId: '成功重试' },
      ],
      'delivered',
      'completed',
    ],
    [
      '失败两次',
      [
        { mode: 'pre_trigger_failure', error: '第一次故障' },
        { mode: 'pre_trigger_failure', error: '第二次故障' },
      ],
      'failed',
      'failed',
    ],
  ] as const)('%s：重启新实例不恢复已用重试预算', async (_name, behaviors, outcome, taskStatus) => {
    const f = await fixture();
    let driver!: FakeKK9Driver;
    const a = service(database.poolA, store => {
      driver = new FakeKK9Driver(store);
      driver.setSendBehavior({ mode: 'sequence', behaviors: [...behaviors] as FakeSendBehavior[] });
      return driver;
    });
    const result = await a.send(f.request);
    expect(result).toMatchObject({ status: outcome, sendCalls: 2 });
    expect(driver.recordedCalls.map(call => call.options?.operationId)).toEqual([
      result.operationId,
      result.operationId,
    ]);
    a.close();
    const b = service(database.poolB);
    expect(await b.recover(f.request)).toEqual(result);
    expect((await tasks.getTask(f.taskId))?.status).toBe(taskStatus);
    b.close();
  });

  it('真实上下文在 ready_to_send 到 sending 之间作废，旧回答不调用 Driver', async () => {
    const f = await fixture();
    let driver!: FakeKK9Driver;
    const transition = tasks.transitionTask.bind(tasks);
    const a = createSendService({
      createDriver: store => {
        driver = new FakeKK9Driver(store);
        return driver;
      },
      driverStore: new PostgresSendOperationStore(database.poolA),
      dispatches,
      contexts: chat,
      logger,
      tasks: {
        getTask: tasks.getTask.bind(tasks),
        transitionTask: async input => {
          const changed = await transition(input);
          if (changed && input.to === 'sending') {
            await chat.invalidateContext(f.scope, f.context.version, Date.now());
            await chat.createContext(f.scope, Date.now());
          }
          return changed;
        },
      },
    });
    expect((await a.send(f.request)).status).toBe('cancelled');
    expect(driver.recordedCalls).toEqual([]);
    expect((await tasks.getTask(f.taskId))?.status).toBe('cancelled');
    a.close();
  });

  it('查询机会已持久化但响应丢失：新连接恢复不补查，终态拒绝迟到覆盖', async () => {
    const f = await fixture();
    const initial = await dispatches.ensure(createSendIntent(f.request, f.scope.sessionId));
    await tasks.transitionTask({
      taskId: f.taskId,
      inputVersion: 1,
      now: Date.now(),
      from: 'ready_to_send',
      to: 'sending',
    });
    const querying = await dispatches.compareAndSet(initial.operationId, initial.revision, {
      status: 'querying',
      sendCalls: 1,
      queryUsed: true,
      queryDueAt: Date.now() - 1000,
      messageId: null,
    });
    expect(querying).not.toBeNull();
    const pool = createPostgresPool(database.databaseUrl, { max: 1 });
    let driver!: FakeKK9Driver;
    try {
      const a = service(pool, store => {
        driver = new FakeKK9Driver(store);
        return driver;
      });
      const query = vi.spyOn(driver, 'getSendStatus');
      const recovered = await a.recover(f.request);
      expect(recovered).toMatchObject({ status: 'send_unconfirmed', queryUsed: true });
      expect(query).not.toHaveBeenCalled();
      expect(driver.recordedCalls).toEqual([]);
      expect((await tasks.getTask(f.taskId))?.status).toBe('send_unconfirmed');
      expect(
        await dispatches.compareAndSet(initial.operationId, querying!.revision, {
          ...querying!,
          status: 'delivered',
          messageId: '迟到送达',
        })
      ).toBeNull();
      expect(
        await dispatches.compareAndSet(initial.operationId, recovered.revision, {
          ...recovered,
          status: 'delivered',
          messageId: '终态覆盖尝试',
        })
      ).toBeNull();
      expect(await dispatches.get(initial.operationId)).toEqual(recovered);
      a.close();
    } finally {
      await pool.end();
    }
  });

  it.each(['delivered', 'failed', 'unknown'] as const)(
    '原发送未知，新实例仅查询一次得到 %s',
    async observed => {
      const f = await fixture();
      const driverStore = new PostgresSendOperationStore(database.poolA);
      let first!: FakeKK9Driver;
      const a = service(database.poolA, store => {
        first = new FakeKK9Driver(store);
        first.setSendBehavior({ mode: 'post_trigger_lost_response', error: '发送回执丢失' });
        return first;
      });
      const sending = a.send(f.request);
      const rejected = expect(sending).rejects.toThrow();
      let record = await dispatches.ensure(createSendIntent(f.request, f.scope.sessionId));
      await vi.waitFor(async () => {
        record = (await dispatches.get(record.operationId))!;
        expect(record.status).toBe('unknown');
      });
      a.close();
      await rejected;
      expect(record.queryDueAt).not.toBeNull();
      const originalDue = record.queryDueAt!;
      await driverStore.update(record.operationId, {
        status: observed,
        isPreTrigger: observed === 'failed',
        ...(observed === 'delivered' ? { messageId: '查询确认编号' } : {}),
      });
      vi.spyOn(Date, 'now').mockReturnValue(originalDue + 1);
      let second!: FakeKK9Driver;
      const b = service(database.poolB, store => {
        second = new FakeKK9Driver(store);
        return second;
      });
      const query = vi.spyOn(second, 'getSendStatus');
      const result = await b.recover(f.request);
      expect(result.status).toBe(observed === 'unknown' ? 'send_unconfirmed' : 'delivered');
      expect(result.queryDueAt).toBe(originalDue);
      expect(result.operationId).toBe(record.operationId);
      expect(query).toHaveBeenCalledExactlyOnceWith(record.operationId);
      expect(second.recordedCalls.length).toBe(observed === 'failed' ? 1 : 0);
      expect((await driverStore.get(record.operationId))?.operationId).toBe(record.operationId);
      if (observed === 'unknown') {
        expect((await tasks.getTask(f.taskId))?.status).toBe('send_unconfirmed');
        const following = await fixture('final', f.scope);
        expect(following.context.threadId).toBe(f.context.threadId);
        expect((await b.send(following.request)).status).toBe('delivered');
        expect((await tasks.getTask(following.taskId))?.status).toBe('completed');
      }
      b.close();
    }
  );

  it('同任务排队、进度与最终用途分别唯一，通知不改变任务运行状态', async () => {
    const f = await fixture('queued');
    const a = service();
    const queued = await a.send(f.request);
    expect((await tasks.getTask(f.taskId))?.status).toBe('queued');
    await tasks.claimTask({
      taskId: f.taskId,
      inputVersion: 1,
      now: Date.now(),
      executionMs: 240_000,
    });
    const progress = await a.send({ ...f.request, purpose: 'progress', text: '正在查询' });
    expect((await tasks.getTask(f.taskId))?.status).toBe('running');
    const attemptId = randomUUID();
    await tasks.startAttempt({
      taskId: f.taskId,
      inputVersion: 1,
      now: Date.now(),
      attemptId,
      runId: randomUUID(),
      configDigest: '配置',
      expectedAttemptId: null,
    });
    await tasks.finishAttempt({ attemptId, finishedAt: Date.now(), errorType: null });
    await tasks.adoptAttempt({ taskId: f.taskId, inputVersion: 1, now: Date.now(), attemptId });
    const final = await a.send({ ...f.request, purpose: 'final', text: '最终答案' });
    expect(new Set([queued.operationId, progress.operationId, final.operationId]).size).toBe(3);
    expect((await tasks.getTask(f.taskId))?.status).toBe('completed');
    a.close();
  });

  it('连接池不可用时错误向调用者传播，不当作失败发送或启动故障提示', async () => {
    const f = await fixture();
    const pool = createPostgresPool(database.databaseUrl, { max: 1 });
    await pool.end();
    let driver!: FakeKK9Driver;
    const a = createSendService({
      createDriver: store => {
        driver = new FakeKK9Driver(store);
        return driver;
      },
      driverStore: new PostgresSendOperationStore(pool),
      dispatches: new PostgresSendDispatchStore(pool),
      tasks,
      contexts: chat,
      logger,
    });
    await expect(a.send(f.request)).rejects.toThrow();
    expect(driver.recordedCalls).toEqual([]);
    expect((await tasks.getTask(f.taskId))?.status).toBe('ready_to_send');
    a.close();
  });

  it('全部业务连接不可用时只有固定故障提示尽力发送，恢复后不补发', async () => {
    const f = await fixture();
    const unavailable = createPostgresPool(database.databaseUrl, { max: 1 });
    await unavailable.end();
    let driver!: FakeKK9Driver;
    const a = service(unavailable, store => {
      driver = new FakeKK9Driver(store);
      return driver;
    });
    await expect(a.send(f.request)).rejects.toThrow();
    const event = { botId: f.scope.botId, ...f.message };
    const countsBefore = await database.poolA.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM kairo.tasks'
    );
    const first = await a.sendStorageFailure(event, new AppError('storage'));
    expect(first?.status).toBe('delivered');
    expect(driver.recordedCalls.map(call => call.payload)).toEqual([getFailureMessage('storage')]);
    expect(await dispatches.get(first!.operationId!)).toBeNull();
    expect(
      await new PostgresSendOperationStore(database.poolA).get(first!.operationId!)
    ).toBeNull();
    a.close();
    let restoredDriver!: FakeKK9Driver;
    const restored = service(database.poolB, store => {
      restoredDriver = new FakeKK9Driver(store);
      return restoredDriver;
    });
    expect(await restored.sendStorageFailure(event, new AppError('storage'))).toBeNull();
    expect(restoredDriver.recordedCalls).toEqual([]);
    const countsAfter = await database.poolA.query<{ count: string }>(
      'SELECT COUNT(*)::text AS count FROM kairo.tasks'
    );
    expect(countsAfter.rows).toEqual(countsBefore.rows);
    restored.close();
  });

  it('真实 SQL 约束错误原样传播且不留下半截预算，重复迁移保留记录', async () => {
    const f = await fixture();
    const initial = await dispatches.ensure(createSendIntent(f.request, f.scope.sessionId));
    await expect(
      dispatches.compareAndSet(initial.operationId, initial.revision, {
        ...initial,
        status: 'sending',
        sendCalls: 3,
      })
    ).rejects.toMatchObject({ code: '23514' });
    expect(await dispatches.get(initial.operationId)).toEqual(initial);
    await migrateDatabase({ databaseUrl: database.databaseUrl });
    expect(await dispatches.get(initial.operationId)).toEqual(initial);
    const a = service();
    expect((await a.send(f.request)).status).toBe('delivered');
    a.close();
  });
});
