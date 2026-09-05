import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportSchemas } from '@mastra/pg';
import { migrateDatabase } from './migrate.js';
import { createPostgresPool } from './pool.js';

const migrationPath = new URL('../../migrations/000002-mastra-storage.sql', import.meta.url);
const schemaName = 'mastra';

function normalizeSql(sql: string): string {
  return sql
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trim();
}

export function extractUpMigration(migration: string): string {
  const upMarker = '-- Up Migration';
  const downMarker = '-- Down Migration';
  const upStart = migration.indexOf(upMarker);
  const downStart = migration.indexOf(downMarker);

  if (upStart < 0 || downStart < 0 || downStart <= upStart) {
    throw new Error('000002-mastra-storage.sql 缺少有效的 Up/Down Migration 分界');
  }

  return migration.slice(upStart + upMarker.length, downStart);
}

export function assertMigrationMatchesExport(migration: string): string[] {
  const expectedSql = normalizeSql(exportSchemas(schemaName));
  const actualSql = normalizeSql(extractUpMigration(migration));

  if (actualSql !== expectedSql) {
    throw new Error(
      "000002-mastra-storage.sql 的 Up Migration 与锁定 @mastra/pg@1.22.2 的 exportSchemas('mastra') 规范化输出不一致"
    );
  }

  return [...expectedSql.matchAll(/CREATE TABLE IF NOT EXISTS "mastra"\."([^"]+)"/g)].flatMap(
    match => (match[1] ? [match[1]] : [])
  );
}

export async function verifyExportMatchesMigration(): Promise<{
  expectedTableNames: string[];
  migrationPath: string;
}> {
  const migration = await readFile(migrationPath, 'utf8');

  return {
    expectedTableNames: assertMigrationMatchesExport(migration),
    migrationPath: migrationPath.pathname,
  };
}

export async function verifyMastraSchema(): Promise<void> {
  const { expectedTableNames, migrationPath: verifiedPath } = await verifyExportMatchesMigration();
  const databaseUrl = process.env.KAIRO_TEST_DATABASE_URL;

  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error('缺少 KAIRO_TEST_DATABASE_URL，不能执行 Mastra schema 数据库校验');
  }

  const firstRun = await migrateDatabase({ databaseUrl });
  const secondRun = await migrateDatabase({ databaseUrl });
  if (secondRun.length !== 0) {
    throw new Error('Mastra schema 重复迁移未保持幂等');
  }

  const pool = createPostgresPool(databaseUrl, {
    allowExitOnIdle: true,
    max: 1,
  });

  try {
    const schema = await pool.query<{ schema_name: string }>(
      `
        SELECT schema_name
        FROM information_schema.schemata
        WHERE schema_name = $1
      `,
      [schemaName]
    );
    if (schema.rows.length !== 1) {
      throw new Error('数据库中不存在 mastra schema');
    }

    const tables = await pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM information_schema.tables
        WHERE table_schema = $1
      `,
      [schemaName]
    );
    const actualTableCount = Number(tables.rows[0]?.count ?? 0);
    if (actualTableCount !== expectedTableNames.length) {
      throw new Error(
        `mastra schema 表数量不一致：期望 ${expectedTableNames.length}，实际 ${actualTableCount}`
      );
    }

    console.log(
      `Mastra schema 校验通过：exportSchemas 与迁移 Up 内容规范化后一致（仅忽略 CRLF 与行尾空白），首次迁移 ${firstRun.length} 个，重复迁移 0 个，表 ${actualTableCount} 张。`
    );
    console.log(`已核对迁移文件：${verifiedPath}`);
    console.log('Down Migration 仅负责回滚 mastra schema，不属于 exportSchemas 输出。');
  } finally {
    await pool.end();
  }
}

const isMainModule =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMainModule) {
  await verifyMastraSchema();
}
