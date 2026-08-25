import type { Client } from '@libsql/client';
import { SchemaInitError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import { SCHEMA_SQL } from './schema.js';

const log = createChildLogger('migrations');

export interface Migration {
  id: string;
  name: string;
  up: string;
}

/**
 * KKBot 内部版本化迁移脚本定义列表
 * 注意：所有 SQL 均为纯 KKBot 业务表，对 Mastra 内部表（mastra_*）实行零 DDL、零 DML
 */
export const KKBOT_MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    name: 'Initial KKBot schema for organization and sessions',
    up: SCHEMA_SQL,
  },
];

export interface MigrationResult {
  applied: string[];
  total: number;
}

/**
 * 执行 KKBot 正式数据库迁移
 * 先确保创建迁移记录表 _kkbot_migrations，然后按序执行所有未应用的迁移脚本。
 *
 * @param client KKBot 专有 LibSQL Client 实例
 */
export async function runKKBotMigrations(client: Client): Promise<MigrationResult> {
  try {
    log.debug('开始检查并执行 KKBot 数据库迁移...');

    // 1. 创建迁移追踪表
    await client.execute(`
      CREATE TABLE IF NOT EXISTS _kkbot_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
    `);

    // 2. 查询已应用的迁移
    const appliedResult = await client.execute('SELECT id FROM _kkbot_migrations');
    const appliedSet = new Set(
      appliedResult.rows.map((row) => (typeof row.id === 'string' ? row.id : ''))
    );

    const newlyApplied: string[] = [];

    // 3. 顺序执行未应用的迁移
    for (const migration of KKBOT_MIGRATIONS) {
      if (!appliedSet.has(migration.id)) {
        log.info({ migrationId: migration.id, name: migration.name }, '正在应用 KKBot 数据库迁移...');

        // 执行迁移 DDL 脚本
        await client.executeMultiple(migration.up);

        // 记录迁移完成事实
        await client.execute({
          sql: 'INSERT INTO _kkbot_migrations (id, name, applied_at) VALUES (?, ?, ?)',
          args: [migration.id, migration.name, Date.now()],
        });

        newlyApplied.push(migration.id);
        log.info({ migrationId: migration.id }, 'KKBot 数据库迁移应用成功');
      }
    }

    log.debug(
      { newlyAppliedCount: newlyApplied.length, total: KKBOT_MIGRATIONS.length },
      'KKBot 数据库迁移流程全部完成'
    );

    return {
      applied: newlyApplied,
      total: KKBOT_MIGRATIONS.length,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err }, 'KKBot 数据库迁移执行失败');
    throw new SchemaInitError(`KKBot 数据库迁移执行失败: ${err.message}`, err);
  }
}
