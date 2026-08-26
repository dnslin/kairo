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
      "SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'org_%' OR name IN ('sessions', 'session_messages', 'message_deliveries', 'delivery_adjudications'))"
    );
    const tableNames = tablesRes.rows.map(r => r.name);
    expect(tableNames).toContain('org_departments');
    expect(tableNames).toContain('org_employees');
    expect(tableNames).toContain('org_employee_departments');
    expect(tableNames).toContain('sessions');
    expect(tableNames).toContain('session_messages');
    expect(tableNames).toContain('message_deliveries');
    expect(tableNames).toContain('delivery_adjudications');
  });

  it('should be idempotent and skip already-applied migrations on subsequent runs', async () => {
    const firstRun = await runKKBotMigrations(client);
    expect(firstRun.applied.length).toBe(KKBOT_MIGRATIONS.length);

    const secondRun = await runKKBotMigrations(client);
    expect(secondRun.applied.length).toBe(0);
    expect(secondRun.total).toBe(KKBOT_MIGRATIONS.length);
  });

  it('should do zero DDL/DML on Mastra internal tables', () => {
    // 验证所有迁移 SQL 均只操作 KKBot 自身业务表，严禁对 Mastra 内部表（如 mastra_threads, mastra_messages 等）执行任何 DDL/DML
    const mastraTablePattern = /\b(table|into|from|update|delete|drop)\s+(_?mastra_\w+)/i;
    for (const m of KKBOT_MIGRATIONS) {
      expect(m.up).not.toMatch(mastraTablePattern);
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
      '0003_message_deliveries',
      '0004_delivery_adjudications_and_retries',
      '0005_tombstones_and_compliance_deletion',
      '0006_delivery_input_messages',
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

    // 5. 验证 message_deliveries 表与索引已建立
    const deliveryTableRes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'message_deliveries'"
    );
    expect(deliveryTableRes.rows).toHaveLength(1);
  });

  it('runKKBotMigrations 在后置版本记录失败时整步 DDL 原子回滚，且不残留列与表', async () => {
    // 1. 先应用前 3 个迁移 (0001, 0002, 0003)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS _kkbot_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
    `);
    for (const m of KKBOT_MIGRATIONS.slice(0, 3)) {
      await client.executeMultiple(m.up);
      await client.execute({
        sql: 'INSERT INTO _kkbot_migrations (id, name, applied_at) VALUES (?, ?, ?)',
        args: [m.id, m.name, Date.now()],
      });
    }

    // 2. 注入 SQLite BEFORE INSERT 触发器：当尝试写入 0004 记录时抛出异常
    await client.execute(`
      CREATE TRIGGER fail_0004_migration
      BEFORE INSERT ON _kkbot_migrations
      WHEN NEW.id = '0004_delivery_adjudications_and_retries'
      BEGIN
        SELECT RAISE(ABORT, 'Simulated migration record insertion failure');
      END;
    `);

    // 3. 调用真实的 runKKBotMigrations 运行迁移
    await expect(runKKBotMigrations(client)).rejects.toThrow(
      /Simulated migration record insertion failure/
    );

    // 4. 验证原子回滚生效：0004 的 DDL 全部回滚
    // 4.1 delivery_adjudications 表绝对未被创建
    const tableRes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'delivery_adjudications'"
    );
    expect(tableRes.rows).toHaveLength(0);

    // 4.2 message_deliveries 表中的 retry_count 列绝对未残留
    const colRes = await client.execute("PRAGMA table_info(message_deliveries)");
    const columnNames = colRes.rows.map(r => r.name);
    expect(columnNames).not.toContain('retry_count');

    // 4.3 _kkbot_migrations 表中未记录 0004
    const migRes = await client.execute(
      "SELECT * FROM _kkbot_migrations WHERE id = '0004_delivery_adjudications_and_retries'"
    );
    expect(migRes.rows).toHaveLength(0);
  });

  it('数据库已记录 0001–0005 后升级仍能安全创建 0006 新表 delivery_input_messages', async () => {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS _kkbot_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
    `);
    // 应用前 5 个迁移
    for (const m of KKBOT_MIGRATIONS.slice(0, 5)) {
      await client.executeMultiple(m.up);
      await client.execute({
        sql: 'INSERT INTO _kkbot_migrations (id, name, applied_at) VALUES (?, ?, ?)',
        args: [m.id, m.name, Date.now()],
      });
    }

    // 确认此时无 delivery_input_messages 表
    const before = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'delivery_input_messages'"
    );
    expect(before.rows).toHaveLength(0);

    // 执行升级
    const res = await runKKBotMigrations(client);
    expect(res.applied).toEqual(['0006_delivery_input_messages']);

    // 验证 delivery_input_messages 表与索引已成功建立
    const after = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = 'delivery_input_messages'"
    );
    expect(after.rows).toHaveLength(1);
  });
});
