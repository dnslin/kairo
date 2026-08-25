import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedBootstrapper } from '../src/bootstrapper.js';
import { createValidTestYaml } from './fixtures.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('UnifiedBootstrapper Composition Root & Harness', () => {
  let tempDir: string;
  let configFile: string;
  let dbFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-boot-test-'));
    dbFilePath = path.join(tempDir, 'kkbot.db');
    configFile = path.join(tempDir, 'config.yaml');
    await fs.writeFile(configFile, createValidTestYaml({ dbFilePath }), 'utf-8');
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should complete static validation without acquiring resources or creating files', async () => {
    const bootstrapper = new UnifiedBootstrapper({ configPath: configFile });
    const config = await bootstrapper.staticValidate();

    expect(config.kk.cdp.url).toBe('http://127.0.0.1:9222');

    // Verify database file was NOT created during static validation
    const dbExists = await fs
      .stat(dbFilePath)
      .then(() => true)
      .catch(() => false);
    expect(dbExists).toBe(false);

    // Verify gate is closed
    expect(bootstrapper.getGate().isOpen()).toBe(false);
  });

  it('should start up fully with single database, dual clients, Mastra and MCPClient', async () => {
    const bootstrapper = new UnifiedBootstrapper({ configPath: configFile });

    await bootstrapper.start();

    // 1. Gate must be open after successful start
    expect(bootstrapper.getGate().isOpen()).toBe(true);

    // 2. Acquisition Ledger must record acquired resources
    const ledger = bootstrapper.getLedger();
    expect(ledger.has('InstanceLock')).toBe(true);
    expect(ledger.has('KKBotClient')).toBe(true);
    expect(ledger.has('LibSQLStore')).toBe(true);
    expect(ledger.has('Mastra')).toBe(true);

    // Storage ownership transferred to Mastra
    expect(ledger.get('LibSQLStore')?.owner).toBe('Mastra');
    expect(ledger.get('LibSQLStore')?.finalizer).toBeNull();

    // 3. Database file created and contains KKBot migrations and Mastra tables
    const kkbotClient = bootstrapper.getKKBotClient();
    const tablesRes = await kkbotClient.execute("SELECT name FROM sqlite_master WHERE type='table'");
    const tableNames = tablesRes.rows.map((r) => (typeof r.name === 'string' ? r.name : ''));
    expect(tableNames).toContain('_kkbot_migrations');
    expect(tableNames).toContain('org_departments');
    expect(tableNames).toContain('sessions');

    // 4. Preflight did not create messages or business facts
    const msgCount = await kkbotClient.execute('SELECT COUNT(*) as cnt FROM session_messages');
    expect(Number(msgCount.rows[0].cnt)).toBe(0);

    // 5. Graceful shutdown
    const shutdownResult = await bootstrapper.shutdown('test_done');
    expect(shutdownResult.successful).toBe(true);
    expect(bootstrapper.getGate().isOpen()).toBe(false);
  });

  it('should reject a second instance on the same data directory', async () => {
    const boot1 = new UnifiedBootstrapper({ configPath: configFile });
    const boot2 = new UnifiedBootstrapper({ configPath: configFile });

    await boot1.start();

    // Second instance must fail to acquire lock and shut down cleanly
    await expect(boot2.start()).rejects.toThrow();

    expect(boot2.getGate().isOpen()).toBe(false);

    await boot1.shutdown();
  });

  it('should execute reverse topological shutdown when failure is injected during acquire', async () => {
    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeAcquire: (stage) => {
          if (stage === 'Mastra') {
            throw new Error('Simulated Mastra creation failure');
          }
        },
      },
    });

    await expect(boot.start()).rejects.toThrow('Simulated Mastra creation failure');

    // Gate must remain closed
    expect(boot.getGate().isOpen()).toBe(false);

    // Lock must have been released during rollback
    const lockFilePath = path.join(tempDir, 'kkbot.lock');
    const lockExists = await fs
      .stat(lockFilePath)
      .then(() => true)
      .catch(() => false);
    expect(lockExists).toBe(false);
  });

  it('should tolerate finalizer failures and continue executing remaining finalizers', async () => {
    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeFinalizer: (resourceId) => {
          if (resourceId === 'Mastra') {
            throw new Error('Simulated Mastra shutdown failure');
          }
        },
      },
    });

    await boot.start();
    expect(boot.getGate().isOpen()).toBe(true);

    const shutdownResult = await boot.shutdown();
    expect(boot.getGate().isOpen()).toBe(false);

    // Mastra finalizer failed, but KKBotClient and InstanceLock were still executed
    expect(shutdownResult.errors.length).toBeGreaterThan(0);
    expect(shutdownResult.executedResources).toContain('KKBotClient');
    expect(shutdownResult.executedResources).toContain('InstanceLock');
  });

  it('should be idempotent on shutdown calls', async () => {
    const boot = new UnifiedBootstrapper({ configPath: configFile });
    await boot.start();

    const res1 = await boot.shutdown();
    const res2 = await boot.shutdown();

    expect(res1).toBe(res2);
    expect(boot.getGate().isOpen()).toBe(false);
  });

  it('should throw AggregateError when both startup and rollback finalizers encounter failures', async () => {
    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeAcquire: (stage) => {
          if (stage === 'Preflight') {
            throw new Error('Initial Preflight failure');
          }
        },
        beforeFinalizer: (resId) => {
          if (resId === 'KKBotClient') {
            throw new Error('Rollback finalizer failure');
          }
        },
      },
    });

    await expect(boot.start()).rejects.toThrow(AggregateError);
    expect(boot.getGate().isOpen()).toBe(false);
  });

  it('should block Work Admission Gate when required MCP discovery fails', async () => {
    const mcpConfigPath = path.join(tempDir, 'config-mcp-req.yaml');
    await fs.writeFile(
      mcpConfigPath,
      createValidTestYaml({ dbFilePath, includeMcp: true, mcpRequired: true }),
      'utf-8'
    );

    const boot = new UnifiedBootstrapper({ configPath: mcpConfigPath });
    await expect(boot.start()).rejects.toThrow(/必需的 MCP Server .* discovery 失败/);
    expect(boot.getGate().isOpen()).toBe(false);
  });

  it('should allow Work Admission Gate to open when optional MCP discovery fails with degradation', async () => {
    const mcpOptConfigPath = path.join(tempDir, 'config-mcp-opt.yaml');
    await fs.writeFile(
      mcpOptConfigPath,
      createValidTestYaml({ dbFilePath, includeMcp: true, mcpRequired: false }),
      'utf-8'
    );

    const boot = new UnifiedBootstrapper({ configPath: mcpOptConfigPath });
    await boot.start();
    expect(boot.getGate().isOpen()).toBe(true);
    await boot.shutdown();
  });
});
