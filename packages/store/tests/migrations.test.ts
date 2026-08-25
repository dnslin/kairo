import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { runKKBotMigrations, KKBOT_MIGRATIONS } from '../src/database/migrations.js';
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
    const tableNames = tablesRes.rows.map((r) => r.name);
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
});
