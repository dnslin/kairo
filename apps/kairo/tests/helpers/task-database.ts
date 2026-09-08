import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool } from '../../src/db/pool.js';

export interface TaskTestDatabase {
  databaseName: string;
  databaseUrl: string;
  poolA: Pool;
  poolB: Pool;
  close(): Promise<void>;
}

export async function createTaskTestDatabase(): Promise<TaskTestDatabase> {
  const configuredUrl = process.env.KAIRO_TEST_DATABASE_URL;
  if (!configuredUrl?.trim()) {
    throw new Error('缺少 KAIRO_TEST_DATABASE_URL，不能执行 T19 真实 PostgreSQL 集成测试');
  }

  const databaseName = `kairo_t19_${randomUUID().replaceAll('-', '')}`;
  const temporaryUrl = new URL(configuredUrl);
  temporaryUrl.pathname = `/${databaseName}`;
  const databaseUrl = temporaryUrl.toString();
  const admin = createPostgresPool(configuredUrl, { max: 1 });
  let createdDatabase = false;
  let poolA: Pool | undefined;
  let poolB: Pool | undefined;
  let closing: Promise<void> | undefined;

  async function cleanup(): Promise<void> {
    const errors: unknown[] = [];
    const results = await Promise.allSettled([poolA?.end(), poolB?.end()]);
    for (const result of results) {
      if (result.status === 'rejected') errors.push(result.reason);
    }
    // 即使关闭池失败，也尝试删除自创库；不强制断开连接或删除配置中的原库。
    if (createdDatabase) {
      try {
        await admin.query(`DROP DATABASE "${databaseName}"`);
        createdDatabase = false;
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await admin.end();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, 'T19 临时数据库资源清理失败');
    }
  }

  function close(): Promise<void> {
    closing ??= cleanup();
    return closing;
  }

  try {
    // 库名仅由固定前缀和随机 UUID 组成，管理连接不对原库执行迁移。
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    createdDatabase = true;
    poolA = createPostgresPool(databaseUrl, { max: 1 });
    poolB = createPostgresPool(databaseUrl, { max: 1 });
    const [connectionA, connectionB] = await Promise.all([
      poolA.query<{ name: string; pid: number }>(
        'SELECT current_database() AS name, pg_backend_pid() AS pid'
      ),
      poolB.query<{ name: string; pid: number }>(
        'SELECT current_database() AS name, pg_backend_pid() AS pid'
      ),
    ]);
    const identityA = connectionA.rows[0];
    const identityB = connectionB.rows[0];
    if (identityA?.name !== databaseName || identityB?.name !== databaseName) {
      throw new Error('T19 数据库隔离核验失败：连接未指向本次随机库');
    }
    if (
      !Number.isInteger(identityA.pid) ||
      !Number.isInteger(identityB.pid) ||
      identityA.pid <= 0 ||
      identityB.pid <= 0 ||
      identityA.pid === identityB.pid
    ) {
      throw new Error('T19 数据库隔离核验失败：两个连接必须具有不同的有效 PID');
    }
    await migrateDatabase({ databaseUrl });
    console.info('T19 临时数据库隔离核验通过', {
      databaseName,
      pidA: identityA.pid,
      pidB: identityB.pid,
    });
    return { databaseName, databaseUrl, poolA, poolB, close };
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'T19 临时数据库初始化及清理失败');
    }
    throw error;
  }
}
