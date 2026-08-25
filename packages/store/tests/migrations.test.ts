import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import {
  runKKBotMigrations,
  KKBOT_MIGRATIONS,
  MIGRATION_0001_INITIAL_SQL,
} from '../src/database/migrations.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('KKBot Database Migrations', () => {
  let tempDir: string;
  let dbFile: string;
  let client: Client;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-migration-test-'));
    dbFile = path.join(tempDir, 'test.db');
    client = createClient({ url: `file:${dbFile}` });
  });

  afterEach(async () => {
    client.close();
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should run all migrations on a fresh empty database', async () => {
    const result = await runKKBotMigrations(client);
    expect(result.applied.length).toBe(KKBOT_MIGRATIONS.length);
    expect(result.total).toBe(KKBOT_MIGRATIONS.length);

    // Verify _kkbot_migrations table exists and records applied migrations
    const res = await client.execute('SELECT id, name FROM _kkbot_migrations ORDER BY id ASC');
    expect(res.rows.length).toBe(KKBOT_MIGRATIONS.length);
    expect(res.rows[0].id).toBe('0001_initial_schema');

    // Verify KKBot tables exist
    const tablesRes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'org_%' OR name IN ('sessions', 'session_messages')"
    );
    const tableNames = tablesRes.rows.map(r => r.name);
    expect(tableNames).toContain('org_departments');
    expect(tableNames).toContain('org_employees');
    expect(tableNames).toContain('org_employee_departments');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('session_messages');
  });

  it('should be idempotent and skip already-applied migrations on subsequent runs', async () => {
    const firstRun = await runKKBotMigrations(client);
    expect(firstRun.applied.length).toBe(KKBOT_MIGRATIONS.length);

    const secondRun = await runKKBotMigrations(client);
    expect(secondRun.applied.length).toBe(0);
    expect(secondRun.total).toBe(KKBOT_MIGRATIONS.length);
  });

  it('should do zero DDL/DML on Mastra internal tables', () => {
    // Check all migration SQLs
    for (const m of KKBOT_MIGRATIONS) {
      expect(m.up).not.toMatch(/mastra_/i);
      expect(m.up).not.toMatch(/_mastra_/i);
    }
  });

  it('should properly upgrade an existing database from 0001 to 0002 (adding origin column and unique index)', async () => {
    // 1. 模拟旧库环境：创建迁移表并仅记录 0001_initial_schema，执行 0001 的 DDL (旧版无 origin 列，旧普通索引)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS _kkbot_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
    `);
    await client.executeMultiple(MIGRATION_0001_INITIAL_SQL);
    await client.execute({
      sql: 'INSERT INTO _kkbot_migrations (id, name, applied_at) VALUES (?, ?, ?)',
      args: [
        '0001_initial_schema',
        'Initial KKBot schema for organization and sessions',
        Date.now(),
      ],
    });

    // 插入旧数据 (没有 origin 字段)
    await client.execute({
      sql: `INSERT INTO session_messages (session_id, message_id, sender, content, message_type, created_at)
            VALUES ('old_ses_1', 'old_msg_1', '老员工', '旧数据消息', 'text', ?)`,
      args: [Date.now()],
    });

    // 2. 执行版本化迁移
    const migrationResult = await runKKBotMigrations(client);
    expect(migrationResult.applied).toEqual([
      '0002_inbound_identity_and_groupsession_shortcircuit',
    ]);
    expect(migrationResult.total).toBe(KKBOT_MIGRATIONS.length);

    // 3. 验证 session_messages 已拥有 origin 列且旧数据默认为 'external'
    const oldMsgRes = await client.execute(
      "SELECT * FROM session_messages WHERE session_id = 'old_ses_1'"
    );
    expect(oldMsgRes.rows).toHaveLength(1);
    expect(oldMsgRes.rows[0].origin).toBe('external');

    // 4. 验证唯一索引生效：尝试插入重复 (session_id, message_id)
    const insertDuplicate = client.execute({
      sql: `INSERT INTO session_messages (session_id, message_id, sender, content, message_type, origin, created_at)
            VALUES ('old_ses_1', 'old_msg_1', '老员工', '重复插入', 'text', 'external', ?)`,
      args: [Date.now()],
    });
    await expect(insertDuplicate).rejects.toThrow();
  });
});
