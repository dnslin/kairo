import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedBootstrapper } from '../../src/bootstrapper.js';
import { resolveDatabaseLocation } from '../../src/path-resolver.js';
import { createClient, runKKBotMigrations } from '@kkbot/store';
import { LibSQLStore } from '@mastra/libsql';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('STORAGE-01 Contract: Single DB Dual Client & Migration Boundaries', () => {
  let tempDir: string;
  let dbFilePath: string;
  let configFile: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-storage01-'));
    dbFilePath = path.join(tempDir, 'kkbot.db');
    configFile = path.join(tempDir, 'config.yaml');

    const validYaml = `
kk:
  cdp:
    url: "http://127.0.0.1:9222"
  debounceMs: 1500
  maxWaitMs: 5000
  takeoverMinutes: 10

storage:
  url: "file:${dbFilePath.replace(/\\/g, '/')}"

mastra:
  observability:
    enabled: true
    redactSensitiveData: true

mcp:
  perServerTimeoutMs: 5000
  servers:
    local:
      required: true
agent:
  id: kk-assistant
  soulPath: ./config/soul.md
  maxSteps: 5
  memory:
    lastMessages: 10
    observationalMemory: false

knowledge:
  sources: ./data/knowledge/sources
  normalized: ./data/knowledge/normalized
  lexical:
    enabled: true
  embedding:
    enabled: false
  rerank:
    enabled: false

limits:
  timezone: Asia/Shanghai
  globalDailyTokens: 1000000
  userDailyTokens: 50000
  userDailyRequests: 100

retention:
  mediaDays: 30
  deliverableDays: 30
  logDays: 7
`;
    await fs.writeFile(configFile, validYaml, 'utf-8');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('STORAGE-01.1: 路径别名只解析为一个规范化绝对路径与唯一 file: URL，不产生第二个数据库文件', async () => {
    const loc1 = resolveDatabaseLocation(dbFilePath);
    const loc2 = resolveDatabaseLocation(`./${path.basename(dbFilePath)}`, tempDir);
    const loc3 = resolveDatabaseLocation(`file:./${path.basename(dbFilePath)}`, tempDir);

    expect(loc1.absolutePath).toBe(loc2.absolutePath);
    expect(loc2.absolutePath).toBe(loc3.absolutePath);
    expect(loc1.fileUrl).toBe(loc2.fileUrl);
    expect(loc2.fileUrl).toBe(loc3.fileUrl);

    // 启动 bootstrapper
    const boot = new UnifiedBootstrapper({ configPath: configFile });
    await boot.start();

    // 检查目录内文件数量：只有 kkbot.db (及 sqlite 的 -wal / -shm / kkbot.lock)，绝无第二个 .db 文件
    const files = await fs.readdir(tempDir);
    const dbFiles = files.filter((f) => f.endsWith('.db'));
    expect(dbFiles.length).toBe(1);
    expect(dbFiles[0]).toBe('kkbot.db');

    await boot.shutdown();
  });

  it('STORAGE-01.2: 全进程仅创建 1 个 KKBot Client、1 个 LibSQLStore 与 1 个 Mastra 实例', async () => {
    const boot = new UnifiedBootstrapper({ configPath: configFile });
    await boot.start();

    const client1 = boot.getKKBotClient();
    const store = boot.getLibSQLStore();
    const mastra = boot.getMastra();

    expect(client1).toBeDefined();
    expect(store).toBeDefined();
    expect(mastra).toBeDefined();

    // KKBot Client 与 Mastra LibSQLStore 不是同一个 Client 对象引用（独立连接，避免合并关闭与事务责任）
    expect((store as unknown as { client?: unknown }).client).not.toBe(client1);

    await boot.shutdown();
  });

  it('STORAGE-01.3: KKBot migrations 先完成，Mastra storage.init() 随后完成', async () => {
    const loc = resolveDatabaseLocation(dbFilePath);
    const kkbotClient = createClient({ url: loc.fileUrl });

    // 步骤 1: KKBot migrations
    const migResult = await runKKBotMigrations(kkbotClient);
    expect(migResult.applied.length).toBeGreaterThan(0);

    // 验证 KKBot 表已就绪
    const kkbotTables = await kkbotClient.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const names1 = kkbotTables.rows.map((r) => (typeof r.name === 'string' ? r.name : ''));
    expect(names1).toContain('_kkbot_migrations');
    expect(names1).toContain('org_departments');

    // 步骤 2: Mastra Storage 初始化
    const storage = new LibSQLStore({ id: 'test-storage', url: loc.fileUrl });
    await storage.init();

    // 验证 Mastra 表已就绪
    const allTables = await kkbotClient.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const names2 = allTables.rows.map((r) => (typeof r.name === 'string' ? r.name : ''));
    expect(names2.some((n) => n.startsWith('mastra_'))).toBe(true);

    kkbotClient.close();
  });

  it('STORAGE-01.4: 双 Client 在 WAL 模式下的并发写入与读取互不阻塞', async () => {
    const loc = resolveDatabaseLocation(dbFilePath);

    const clientA = createClient({ url: loc.fileUrl });
    const clientB = createClient({ url: loc.fileUrl });

    await clientA.execute('PRAGMA journal_mode = WAL;');
    await clientA.execute('PRAGMA busy_timeout = 5000;');
    await clientB.execute('PRAGMA busy_timeout = 5000;');

    await runKKBotMigrations(clientA);

    // 并发写入与读取
    await Promise.all([
      clientA.execute({
        sql: "INSERT INTO org_departments (id, name, updated_at) VALUES ('dept_1', '研发部', ?)",
        args: [Date.now()],
      }),
      clientB.execute({
        sql: "INSERT INTO org_departments (id, name, updated_at) VALUES ('dept_2', '产品部', ?)",
        args: [Date.now()],
      }),
    ]);

    const resA = await clientA.execute('SELECT COUNT(*) as count FROM org_departments');
    const resB = await clientB.execute('SELECT COUNT(*) as count FROM org_departments');

    expect(Number(resA.rows[0].count)).toBe(2);
    expect(Number(resB.rows[0].count)).toBe(2);

    clientA.close();
    clientB.close();
  });

  it('STORAGE-01.5: Mastra 接管 Storage 前后，关闭所有权只转移一次且不重复关闭', async () => {
    const boot = new UnifiedBootstrapper({ configPath: configFile });
    await boot.start();

    const ledger = boot.getLedger();
    const storeEntry = ledger.get('LibSQLStore');
    expect(storeEntry?.owner).toBe('Mastra');
    expect(storeEntry?.finalizer).toBeNull(); // 由 Mastra 统一关闭

    const shutdownResult = await boot.shutdown();
    expect(shutdownResult.successful).toBe(true);
  });
});
