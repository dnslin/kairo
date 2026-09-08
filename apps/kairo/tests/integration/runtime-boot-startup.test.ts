import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startKairo, type KairoApplication } from '../../src/index.js';
import { PostgresRuntimeBootStore } from '../../src/modules/operability/runtime-boot-store.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';
import { ApplicationTestDriver } from '../helpers/application-driver.js';

let database: TaskTestDatabase;
let application: KairoApplication | undefined;
beforeAll(async () => {
  database = await createTaskTestDatabase();
});
beforeEach(() => {
  vi.stubEnv('KAIRO_T12_MODEL_API_KEY', '');
  vi.stubEnv('RAGFLOW_API_KEY', '');
});
afterEach(async () => {
  await application?.close();
  application = undefined;
  vi.unstubAllEnvs();
});
afterAll(async () => {
  await database?.close();
});

describe('T20 正式应用启动与关闭账本', () => {
  it('正式入口保存 Git/config、启动时间和关闭结果，并发关闭保留首次结束时间', async () => {
    const before = Date.now();
    application = await startKairo({
      databaseUrl: database.databaseUrl,
      port: 0,
      driverFactory: () => new ApplicationTestDriver(),
    });
    const store = new PostgresRuntimeBootStore(database.poolA);
    const boot = await store.getBoot(application.bootId);
    expect(boot).toMatchObject({
      bootId: application.bootId,
      gitCommit: application.gitCommit,
      configDigest: application.configDigest,
      status: 'running',
      closedAt: null,
    });
    expect(boot!.startedAt).toBeGreaterThanOrEqual(before);
    expect(boot!.startedAt).toBeLessThanOrEqual(Date.now());
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(200);
    await Promise.all([application.close(), application.close()]);
    const closed = await store.getBoot(application.bootId);
    expect(closed?.status).toBe('closed');
    expect(closed!.closedAt).toBeGreaterThanOrEqual(boot!.startedAt);
    await application.close();
    expect(await store.getBoot(application.bootId)).toEqual(closed);
  });

  it('启动写入失败保留 live，数据库恢复后同一启动代次仍禁止 ready 且不重试写入', async () => {
    // 仅临时重命名本测试自建库中的表，不修改原库或其他工作区。
    await database.poolA.query(
      'ALTER TABLE kairo.runtime_boots RENAME TO runtime_boots_unavailable'
    );
    try {
      application = await startKairo({
        databaseUrl: database.databaseUrl,
        port: 0,
        driverFactory: () => new ApplicationTestDriver(),
      });
      expect((await fetch(`${application.url}/health/live`)).status).toBe(200);
      const ready = await fetch(`${application.url}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({
        status: 'not_ready',
        dependencies: { postgres: 'down' },
      });
    } finally {
      await database.poolA.query(
        'ALTER TABLE kairo.runtime_boots_unavailable RENAME TO runtime_boots'
      );
    }
    expect(application).toBeDefined();
    const active = application;
    expect((await fetch(`${active.url}/health/ready`)).status).toBe(503);
    expect(await new PostgresRuntimeBootStore(database.poolA).getBoot(active.bootId)).toBeNull();
    await active.close();
    application = await startKairo({
      databaseUrl: database.databaseUrl,
      port: 0,
      driverFactory: () => new ApplicationTestDriver(),
    });
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(200);
  });

  it('启动期间自有账本连接断开后，Driver 成功也不能解除本代次的失败锁定', async () => {
    const driver = new ApplicationTestDriver();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const connecting = new Promise<void>(resolve => {
      entered = resolve;
    });
    const connect = driver.connect.bind(driver);
    vi.spyOn(driver, 'connect').mockImplementation(async () => {
      entered();
      await gate;
      await connect();
    });
    let errorObserved = false;
    const emit = Pool.prototype.emit;
    const events = vi.spyOn(Pool.prototype, 'emit').mockImplementation(function (
      this: Pool,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      const result = emit.call(this, event, ...args);
      if (event === 'error') errorObserved = true;
      return result;
    });
    const starting = startKairo({
      databaseUrl: database.databaseUrl,
      port: 0,
      driverFactory: () => driver,
    });
    try {
      await connecting;
      const connections = await database.poolA.query<{ pid: number; name: string }>(
        `SELECT pid,datname AS name FROM pg_stat_activity WHERE datname=$1 AND state='idle'
         AND query LIKE 'INSERT INTO kairo.runtime_boots%'`,
        [database.databaseName]
      );
      expect(connections.rows).toHaveLength(1);
      const connection = connections.rows[0]!;
      expect(connection.name).toBe(database.databaseName);
      // 仅中断已核对属于本测试随机库的单条启动连接，不中断数据库服务或其他连接。
      await database.poolA.query('SELECT pg_terminate_backend($1)', [connection.pid]);
      await vi.waitFor(() => expect(errorObserved).toBe(true));
    } finally {
      release();
      application = await starting;
      events.mockRestore();
    }
    expect(application.bootError).toMatchObject({ type: 'storage' });
    expect((await fetch(`${application.url}/health/live`)).status).toBe(200);
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(503);
  });

  it('关闭其他资源失败仍写 failed 启动记录，原始错误向调用方传播', async () => {
    const driver = new ApplicationTestDriver();
    application = await startKairo({
      databaseUrl: database.databaseUrl,
      port: 0,
      driverFactory: () => driver,
    });
    const disconnect = driver.disconnect.bind(driver);
    const failure = new Error('合成关闭失败正文，不能进入普通日志');
    vi.spyOn(driver, 'disconnect').mockImplementation(async () => {
      await disconnect();
      throw failure;
    });
    const active = application;
    application = undefined;
    await expect(active.close()).rejects.toMatchObject({ type: 'driver', cause: failure });
    expect(await new PostgresRuntimeBootStore(database.poolA).getBoot(active.bootId)).toMatchObject(
      { status: 'failed' }
    );
  });
});
