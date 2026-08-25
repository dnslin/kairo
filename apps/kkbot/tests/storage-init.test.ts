import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LibSQLStore } from '@mastra/libsql';
import { createClient, runKKBotMigrations } from '@kkbot/store';
import { resolveDatabaseLocation } from '../src/path-resolver.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('Storage Initialization & Migration Sequencing', () => {
  let tempDir: string;
  let dbFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-store-seq-test-'));
    dbFilePath = path.join(tempDir, 'kkbot.db');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should execute KKBot migrations first and Mastra Storage init second on the same file', async () => {
    const loc = resolveDatabaseLocation(dbFilePath);
    expect(loc.isMemory).toBe(false);

    // 1. KKBot Client
    const kkbotClient = createClient({ url: loc.fileUrl });

    // Enable WAL mode on KKBot Client
    await kkbotClient.execute('PRAGMA journal_mode = WAL;');
    await kkbotClient.execute('PRAGMA busy_timeout = 5000;');

    // 2. Run KKBot migrations
    const migrationResult = await runKKBotMigrations(kkbotClient);
    expect(migrationResult.applied.length).toBeGreaterThan(0);

    // 3. LibSQLStore with its own Client
    const storage = new LibSQLStore({
      id: 'mastra-storage',
      url: loc.fileUrl,
    });

    // 4. Run storage.init()
    await storage.init();

    // 5. Verify both KKBot tables and Mastra tables coexist in the same database file
    const tablesRes = await kkbotClient.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = tablesRes.rows.map((r) => (typeof r.name === 'string' ? r.name : ''));

    // KKBot tables
    expect(tableNames).toContain('_kkbot_migrations');
    expect(tableNames).toContain('org_departments');
    expect(tableNames).toContain('sessions');

    // Mastra tables
    const mastraTables = tableNames.filter((t) => t.startsWith('mastra_'));
    expect(mastraTables.length).toBeGreaterThan(0);

    // 6. Independent closure
    kkbotClient.close();
    // LibSQLStore close / cleanup
    if (typeof (storage as { close?: () => void }).close === 'function') {
      (storage as { close: () => void }).close();
    }
  });
});
