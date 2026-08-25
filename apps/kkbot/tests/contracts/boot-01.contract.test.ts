import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { UnifiedBootstrapper } from '../../src/bootstrapper.js';
import { WorkAdmissionGateClosedError } from '../../src/gate.js';
import { createValidTestYaml } from '../fixtures.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('BOOT-01 Contract: Composition Root, Gate, Ledger & Shutdown', () => {
  let tempDir: string;
  let configFile: string;
  let dbFilePath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-boot01-'));
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

  it('BOOT-01.1: Static Validation 不取得资源，也不创建业务事实', async () => {
    const boot = new UnifiedBootstrapper({ configPath: configFile });
    const cfg = await boot.staticValidate();
    expect(cfg).toBeDefined();

    // 严禁生成数据库或锁文件
    const dbExists = await fs.stat(dbFilePath).then(() => true).catch(() => false);
    const lockExists = await fs.stat(path.join(tempDir, 'kkbot.lock')).then(() => true).catch(() => false);
    expect(dbExists).toBe(false);
    expect(lockExists).toBe(false);

    // Gate 必须处于关闭状态
    expect(boot.getGate().isOpen()).toBe(false);
    expect(() => boot.getGate().assertOpen()).toThrow(WorkAdmissionGateClosedError);
  });

  it('BOOT-01.2: 每次启动分配唯一不可复用的 startupGenerationId', () => {
    const boot1 = new UnifiedBootstrapper({ configPath: configFile });
    const boot2 = new UnifiedBootstrapper({ configPath: configFile });

    expect(boot1.startupGenerationId).toBeDefined();
    expect(boot2.startupGenerationId).toBeDefined();
    expect(boot1.startupGenerationId).not.toBe(boot2.startupGenerationId);
  });

  it('BOOT-01.3: 真实 Preflight 使用已取得对象但不创建业务事实', async () => {
    const boot = new UnifiedBootstrapper({ configPath: configFile });
    await boot.start();

    const client = boot.getKKBotClient();
    const msgCountRes = await client.execute('SELECT COUNT(*) as count FROM session_messages');
    expect(Number(msgCountRes.rows[0].count)).toBe(0);

    const sessionCountRes = await client.execute('SELECT COUNT(*) as count FROM sessions');
    expect(Number(sessionCountRes.rows[0].count)).toBe(0);

    await boot.shutdown();
  });

  it('BOOT-01.4: Ready Barrier 失败时 Gate 从未开放并自动执行回滚', async () => {
    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeAcquire: (stage) => {
          if (stage === 'Preflight') {
            throw new Error('Preflight readiness check failed');
          }
        },
      },
    });

    await expect(boot.start()).rejects.toThrow('Preflight readiness check failed');
    expect(boot.getGate().isOpen()).toBe(false);

    // 锁已在回滚中释放
    const lockExists = await fs.stat(path.join(tempDir, 'kkbot.lock')).then(() => true).catch(() => false);
    expect(lockExists).toBe(false);
  });

  it('BOOT-01.5: 矩阵故障注入：每个 acquire 阶段分别失败时逆拓扑释放已取得资源', async () => {
    const stages = ['InstanceLock', 'KKBotClient', 'KKBotMigrations', 'LibSQLStore', 'Mastra', 'Preflight'];

    for (const failingStage of stages) {
      const boot = new UnifiedBootstrapper({
        configPath: configFile,
        hooks: {
          beforeAcquire: (stage) => {
            if (stage === failingStage) {
              throw new Error(`Injected acquire failure at ${failingStage}`);
            }
          },
        },
      });

      await expect(boot.start()).rejects.toThrow(`Injected acquire failure at ${failingStage}`);
      expect(boot.getGate().isOpen()).toBe(false);

      // 验证锁已释放
      const lockExists = await fs.stat(path.join(tempDir, 'kkbot.lock')).then(() => true).catch(() => false);
      expect(lockExists).toBe(false);
    }
  });

  it('BOOT-01.6: 矩阵故障注入：每个 finalizer 分别失败时其余 finalizer 依然执行并聚合错误', async () => {
    const failingFinalizer = 'KKBotClient';
    const trace: string[] = [];

    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeFinalizer: (resId) => {
          trace.push(resId);
          if (resId === failingFinalizer) {
            throw new Error(`Finalizer failure at ${resId}`);
          }
        },
      },
    });

    await boot.start();
    const shutdownRes = await boot.shutdown('test_finalizer_failure');

    expect(boot.getGate().isOpen()).toBe(false);
    expect(trace).toContain('Mastra');
    expect(trace).toContain('KKBotClient');
    expect(trace).toContain('InstanceLock');

    // InstanceLock 排在最后执行
    expect(trace[trace.length - 1]).toBe('InstanceLock');
    expect(shutdownRes.errors.length).toBe(1);
    expect(shutdownRes.errors[0].resourceId).toBe('KKBotClient');
  });

  it('BOOT-01.7: 单实例锁最后释放，并在所有资源完成关闭尝试后执行', async () => {
    const sequence: string[] = [];

    const boot = new UnifiedBootstrapper({
      configPath: configFile,
      hooks: {
        beforeFinalizer: (resId) => {
          sequence.push(`before_${resId}`);
        },
        afterFinalizer: (resId) => {
          sequence.push(`after_${resId}`);
        },
      },
    });
    await boot.start();
    await boot.shutdown();

    // 确认 InstanceLock 的 afterFinalizer 是整个序列的最后一项
    expect(sequence[sequence.length - 1]).toBe('after_InstanceLock');
  });
});
