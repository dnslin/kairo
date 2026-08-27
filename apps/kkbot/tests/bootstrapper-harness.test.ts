import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'node:events';
import type { KK9Driver } from '@kkbot/driver';
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
    const tablesRes = await kkbotClient.execute(
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const tableNames = tablesRes.rows.map(r => (typeof r.name === 'string' ? r.name : ''));
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
        beforeAcquire: stage => {
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
        beforeFinalizer: resourceId => {
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
  it('driver.connect 尚未落定时 Shutdown 等待 acquire 并阻止后续 Coordinator 登记', async () => {
    let connectStarted = false;
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>(resolve => {
      releaseConnect = resolve;
    });
    let disconnectCount = 0;
    const driver = Object.assign(new EventEmitter(), {
      async connect() {
        connectStarted = true;
        await connectGate;
      },
      disconnect() {
        disconnectCount += 1;
        return Promise.resolve();
      },
      getHealthSnapshot() {
        return {
          startupGenerationId: 'test-generation',
          cdpStatus: 'connected',
          cdpConnectionIdentity: null,
          eventBridgeAttached: true,
          eventBridgeConnectionIdentity: null,
        };
      },
      scanCompensationWindow() {
        return Promise.resolve([]);
      },
      startPolling() {},
    }) as unknown as KK9Driver;

    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      driverFactory: () => driver,
    });
    const startPromise = boot.start();
    while (!connectStarted) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    let shutdownSettled = false;
    const shutdownPromise = boot.shutdown('connect_mid_shutdown').then(result => {
      shutdownSettled = true;
      return result;
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(shutdownSettled).toBe(false);

    releaseConnect();
    await expect(startPromise).rejects.toThrow(/Shutdown/);
    const shutdownResult = await shutdownPromise;
    expect(shutdownResult.successful).toBe(true);
    expect(disconnectCount).toBe(1);
    expect(boot.getCoordinator()).toBeNull();
    expect(boot.getGate().isOpen()).toBe(false);
  });

  it('阻塞 Driver acquire 与 Shutdown finalizer 共享单一 deadline', async () => {
    let connectStarted = false;
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>(resolve => {
      releaseConnect = resolve;
    });
    const driver = Object.assign(new EventEmitter(), {
      async connect() {
        connectStarted = true;
        await connectGate;
      },
      disconnect() {
        return Promise.resolve();
      },
      getHealthSnapshot() {
        return {
          startupGenerationId: 'deadline-generation',
          cdpStatus: 'connected',
          cdpConnectionIdentity: null,
          eventBridgeAttached: true,
          eventBridgeConnectionIdentity: null,
        };
      },
      scanCompensationWindow() {
        return Promise.resolve([]);
      },
      startPolling() {},
    }) as unknown as KK9Driver;
    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      driverFactory: () => driver,
      shutdownDeadlineMs: 80,
    });
    const startPromise = boot.start();
    while (!connectStarted) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    const startedAt = Date.now();
    const shutdownResult = await boot.shutdown('deadline_acquire');
    expect(Date.now() - startedAt).toBeLessThan(300);
    expect(boot.getGate().isOpen()).toBe(false);

    releaseConnect();
    await expect(startPromise).rejects.toThrow(/Shutdown/);
    expect(shutdownResult.executedResources).toContain('Driver');
  });
  it('should throw AggregateError when both startup and rollback finalizers encounter failures', async () => {
    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeAcquire: stage => {
          if (stage === 'Preflight') {
            throw new Error('Initial Preflight failure');
          }
        },
        beforeFinalizer: resId => {
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
      createValidTestYaml({
        dbFilePath,
        mcpCustomServers: `    unreachable-required:
      url: "http://127.0.0.1:54321/mcp"
      required: true`,
      }),
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
      createValidTestYaml({
        dbFilePath,
        mcpCustomServers: `    unreachable-optional:
      url: "http://127.0.0.1:54321/mcp"
      required: false`,
      }),
      'utf-8'
    );

    const boot = new UnifiedBootstrapper({ configPath: mcpOptConfigPath });
    await boot.start();
    expect(boot.getGate().isOpen()).toBe(true);
    await boot.shutdown();
  });

  it('should successfully discover tools from required stdio MCP server, pass Preflight, and open Work Admission Gate', async () => {
    const stdioMcpConfigPath = path.join(tempDir, 'config-stdio-mcp.yaml');
    await fs.writeFile(
      stdioMcpConfigPath,
      createValidTestYaml({ dbFilePath, useStdioMcpServer: true, mcpRequired: true }),
      'utf-8'
    );

    const boot = new UnifiedBootstrapper({ configPath: stdioMcpConfigPath });
    await boot.start();

    expect(boot.getGate().isOpen()).toBe(true);

    const mcp = boot.getMCPClient();
    expect(mcp).toBeDefined();
    const tools = await mcp?.listTools();
    expect(tools).toBeDefined();
    expect(Object.keys(tools ?? {})).toContain('local_echo');

    await boot.shutdown();
  });
});
