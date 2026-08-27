import EventEmitter from 'node:events';
import fs from 'node:fs/promises';
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  CdpConnectionIdentity,
  DriverHealthEvent,
  DriverHealthSnapshot,
  KK9Driver,
  KK9Message,
} from '@kkbot/driver';
import { UnifiedBootstrapper, type AgentFactory } from '../../src/bootstrapper.js';
import { createValidTestYaml } from '../fixtures.js';
import { KKBotAgent, MastraModelFactory, createFakeModel } from '@kkbot/agent';

class FakeDriver extends EventEmitter {
  public readonly connect = vi.fn().mockResolvedValue(undefined);
  public readonly disconnect = vi.fn().mockResolvedValue(undefined);
  public readonly startPolling = vi.fn();
  public readonly scanCompensationWindow = vi.fn().mockResolvedValue([] as KK9Message[]);
  public readonly generationId: string;
  public readonly identity: CdpConnectionIdentity;

  constructor(generationId: string) {
    super();
    this.generationId = generationId;
    this.identity = {
      startupGenerationId: generationId,
      connectionId: `connection-${generationId}`,
      targetId: 'target-test',
      webSocketDebuggerUrl: 'ws://test/devtools/page/target-test',
      connectedAt: Date.now(),
    };
  }

  public getHealthSnapshot(): DriverHealthSnapshot {
    return {
      startupGenerationId: this.generationId,
      cdpStatus: 'connected',
      cdpConnectionIdentity: this.identity,
      eventBridgeAttached: true,
      eventBridgeConnectionIdentity: this.identity,
    };
  }
}
function createTestAgentFactory(): AgentFactory {
  const model = createFakeModel();
  const modelFactory = new MastraModelFactory({
    tiers: {
      FAST: { models: [{ model }] },
      DEEP: { models: [{ model }] },
      VISION: { models: [{ model }] },
    },
  });
  return (_config, { memory, tools }) =>
    new KKBotAgent({
      modelFactory,
      memory,
      tools,
    });
}

describe('BOOT-01 Driver 故障退出合同', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (!tempDir) {
      return;
    }
    const directory = tempDir;
    tempDir = undefined;
    await yieldImmediate();
    try {
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EBUSY') {
        return;
      }
      throw err;
    }
  });

  it('CDP/EventBridge/identity 并发失效只关闭 Gate 和当前代次一次', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-cdp-failure-'));
    const configFile = path.join(tempDir, 'config.yaml');
    await fs.writeFile(
      configFile,
      createValidTestYaml({ dbFilePath: path.join(tempDir, 'kkbot.db') }),
      'utf8'
    );

    let driver: FakeDriver | undefined;
    let factoryCalls = 0;
    const bootstrapper = new UnifiedBootstrapper({
      configPath: configFile,
      driverFactory: (_config, generationId) => {
        factoryCalls += 1;
        driver = new FakeDriver(generationId);
        return driver as unknown as KK9Driver;
      },
      agentFactory: createTestAgentFactory(),
    });

    await bootstrapper.start();
    expect(bootstrapper.getGate().isOpen()).toBe(true);
    expect(factoryCalls).toBe(1);
    expect(driver?.scanCompensationWindow).toHaveBeenCalledOnce();
    expect(driver?.startPolling).toHaveBeenCalledOnce();

    const cause = new Error('CDP connection identity changed');
    const health: DriverHealthEvent = {
      kind: 'connection_identity_mismatch',
      startupGenerationId: bootstrapper.startupGenerationId,
      connectionIdentity: driver?.identity ?? null,
      expectedConnectionIdentity: null,
      observedAt: Date.now(),
      cause,
    };
    driver?.emit('health', health);
    driver?.emit('health', {
      ...health,
      kind: 'cdp_invalidated',
      cause: new Error('CDP closed'),
    });
    driver?.emit('health', {
      ...health,
      kind: 'event_bridge_invalidated',
      cause: new Error('EventBridge closed'),
    });

    expect(bootstrapper.getGate().isOpen()).toBe(false);
    const shutdown = await bootstrapper.waitForShutdown();
    expect(shutdown.triggerReason).toEqual(health);
    expect(driver?.disconnect).toHaveBeenCalledOnce();
    expect(factoryCalls).toBe(1);
    expect(shutdown.executedResources).toContain('Coordinator');
    expect(shutdown.executedResources).toContain('Driver');
  });
});
