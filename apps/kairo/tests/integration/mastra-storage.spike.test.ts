import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Mastra } from '@mastra/core/mastra';
import type { MastraDBMessage } from '@mastra/core/memory';
import { createMastraStorage } from '../../src/mastra/storage.js';
import { assertMigrationMatchesExport } from '../../src/db/export-mastra-schema.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool, type PostgresPool } from '../../src/db/pool.js';

const sourceDatabaseUrl = process.env.KAIRO_TEST_DATABASE_URL;

if (!sourceDatabaseUrl) {
  throw new Error('缺少 KAIRO_TEST_DATABASE_URL，不能执行真实 PostgreSQL 集成测试');
}

const testDatabaseName = `kairo_t11_${randomUUID().replaceAll('-', '')}`;
let testDatabaseUrl: string;
let adminPool: PostgresPool;
let verificationPool: PostgresPool;

function getDatabaseUrl(databaseName: string): string {
  const databaseUrl = new URL(sourceDatabaseUrl);
  databaseUrl.pathname = `/${databaseName}`;
  return databaseUrl.toString();
}

async function createTemporaryDatabase(databaseName: string): Promise<string> {
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  return getDatabaseUrl(databaseName);
}

async function dropTemporaryDatabase(databaseName: string): Promise<void> {
  await adminPool.query(`DROP DATABASE "${databaseName}"`);
}

describe('Mastra PostgreSQL 单账号开发集成合同', () => {
  beforeAll(async () => {
    adminPool = createPostgresPool(sourceDatabaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    testDatabaseUrl = await createTemporaryDatabase(testDatabaseName);
    await migrateDatabase({ databaseUrl: testDatabaseUrl });
    verificationPool = createPostgresPool(testDatabaseUrl, {
      allowExitOnIdle: true,
      max: 2,
    });
  });

  afterAll(async () => {
    await verificationPool?.end();
    await dropTemporaryDatabase(testDatabaseName);
    await adminPool?.end();
  });

  it('Mastra 实例初始化不会为缺失 schema 发出 DDL', async () => {
    const databaseName = `kairo_t11_init_${randomUUID().replaceAll('-', '')}`;
    const databaseUrl = await createTemporaryDatabase(databaseName);
    const storage = createMastraStorage(databaseUrl);

    try {
      const mastra = new Mastra({ storage });
      const configuredStorage = mastra.getStorage();
      expect(configuredStorage).toBeDefined();
      await configuredStorage?.init();

      const schema = await storage.db.query<{ schema_name: string }>(
        `
          SELECT schema_name
          FROM information_schema.schemata
          WHERE schema_name = 'mastra'
        `
      );
      expect(schema.rows).toHaveLength(0);
      const nonSystemObjects = await storage.db.query<{
        schema_name: string;
        object_name: string;
      }>(
        `
          SELECT n.nspname AS schema_name, c.relname AS object_name
          FROM pg_catalog.pg_class AS c
          JOIN pg_catalog.pg_namespace AS n ON n.oid = c.relnamespace
          WHERE c.relname LIKE 'mastra_%'
            AND n.nspname <> 'information_schema'
            AND n.nspname NOT LIKE 'pg_%'
          ORDER BY n.nspname, c.relname
        `
      );
      expect(nonSystemObjects.rows).toHaveLength(0);
    } finally {
      await storage.close();
      await dropTemporaryDatabase(databaseName);
    }
  });

  it('迁移后创建 mastra schema 并可安全重复迁移', async () => {
    const rerun = await migrateDatabase({ databaseUrl: testDatabaseUrl });
    expect(rerun).toHaveLength(0);

    const schema = await verificationPool.query<{ schema_name: string }>(
      `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = 'mastra'
      `
    );
    expect(schema.rows).toHaveLength(1);

    const tables = await verificationPool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'mastra'
          AND table_name IN ('mastra_threads', 'mastra_messages')
        ORDER BY table_name
      `
    );
    expect(tables.rows.map(row => row.table_name)).toEqual(['mastra_messages', 'mastra_threads']);
  });

  it('schema 导出漂移时升级校验会明确失败', async () => {
    const migration = await readFile(
      new URL('../../migrations/000002-mastra-storage.sql', import.meta.url),
      'utf8'
    );
    const driftedMigration = migration.replace(
      '-- Down Migration',
      'CREATE TABLE IF NOT EXISTS "mastra"."unreviewed_incremental_table" ("id" TEXT);\n\n-- Down Migration'
    );

    expect(driftedMigration).not.toBe(migration);
    expect(() => assertMigrationMatchesExport(driftedMigration)).toThrow(/规范化输出不一致/);
  });

  it('正式 disableInit storage 可以完成 thread 和 message 最小读写', async () => {
    const storage = createMastraStorage(testDatabaseUrl);
    const threadId = `t11-thread-${randomUUID()}`;
    const resourceId = `t11-resource-${randomUUID()}`;
    const messageId = `t11-message-${randomUUID()}`;
    const now = new Date();
    const message: MastraDBMessage = {
      id: messageId,
      role: 'user',
      createdAt: now,
      threadId,
      resourceId,
      content: {
        format: 2,
        parts: [{ type: 'text', text: 'T11 单账号开发验证' }],
      },
    };

    try {
      await storage.init();
      const memory = await storage.getStore('memory');
      expect(memory).toBeDefined();
      if (!memory) throw new Error('Mastra memory store 未初始化');

      await memory.saveThread({
        thread: {
          id: threadId,
          resourceId,
          title: 'T11 单账号开发验证',
          createdAt: now,
          updatedAt: now,
        },
      });
      await memory.saveMessages({ messages: [message] });

      await expect(memory.getThreadById({ threadId })).resolves.toMatchObject({
        id: threadId,
        resourceId,
      });
      await expect(memory.listMessages({ threadId, perPage: false })).resolves.toMatchObject({
        messages: [expect.objectContaining({ id: messageId })],
      });
      const storedThread = await verificationPool.query<{ id: string }>(
        'SELECT "id" FROM "mastra"."mastra_threads" WHERE "id" = $1',
        [threadId]
      );
      expect(storedThread.rows).toEqual([{ id: threadId }]);

      const storedMessage = await verificationPool.query<{ id: string }>(
        'SELECT "id" FROM "mastra"."mastra_messages" WHERE "id" = $1',
        [messageId]
      );
      expect(storedMessage.rows).toEqual([{ id: messageId }]);
    } finally {
      await storage.close();
    }
  });
});
