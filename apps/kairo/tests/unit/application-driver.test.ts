import { FakeKK9Driver } from '@kairo/driver';
import type { DriverHealthKind, DriverHealthSnapshot } from '@kairo/driver';
import type * as Pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startKairo } from '../../src/index.js';
import type { KairoApplication } from '../../src/index.js';
import * as runtimeModule from '../../src/mastra/runtime.js';
import * as healthModule from '../../src/modules/operability/health-server.js';
import { PostgresRuntimeBootStore } from '../../src/modules/operability/runtime-boot-store.js';
import { ApplicationTestDriver } from '../helpers/application-driver.js';

// 本文件隔离 PostgreSQL 健康查询和启动账本；账本真读写由 T20 集成测试覆盖。
vi.mock('pg', async importOriginal => {
  const actual = await importOriginal<typeof Pg>();
  return {
    ...actual,
    Client: class {
      connect(): Promise<void> {
        return Promise.resolve();
      }
      query(): Promise<{ rows: unknown[] }> {
        return Promise.resolve({ rows: [{ '?column?': 1 }] });
      }
      end(): Promise<void> {
        return Promise.resolve();
      }
    },
  };
});

const databaseUrl = 'postgresql://test:test@127.0.0.1:1/application_driver_unit';
const applications: KairoApplication[] = [];
const createRuntime = runtimeModule.createMastraRuntime;
const startHealth = healthModule.startHealthServer;
beforeEach(() => {
  vi.stubEnv('KAIRO_T12_MODEL_API_KEY', '');
  vi.stubEnv('RAGFLOW_API_KEY', '');
  vi.spyOn(PostgresRuntimeBootStore.prototype, 'startBoot').mockImplementation(input =>
    Promise.resolve({
      inserted: true,
      boot: { ...input, status: 'starting', closedAt: null },
    })
  );
  vi.spyOn(PostgresRuntimeBootStore.prototype, 'markRunning').mockResolvedValue(true);
  vi.spyOn(PostgresRuntimeBootStore.prototype, 'closeBoot').mockResolvedValue(true);
});

afterEach(async () => {
  await Promise.allSettled(applications.splice(0).map(application => application.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('正式应用拥有的 Driver', () => {
  it('连接完成前 live 已可达，启动期探测不会将随后成功的 Driver 锁定 down', async () => {
    let completeConnection!: () => void;
    const connectionGate = new Promise<void>(resolve => {
      completeConnection = resolve;
    });
    let announceListening!: (url: string) => void;
    const listening = new Promise<string>(resolve => {
      announceListening = resolve;
    });
    vi.spyOn(healthModule, 'startHealthServer').mockImplementation(async options => {
      const health = await startHealth(options);
      announceListening(health.url);
      return health;
    });
    const driver = new ApplicationTestDriver();
    const connect = driver.connect.bind(driver);
    vi.spyOn(driver, 'connect').mockImplementation(async () => {
      await connectionGate;
      await connect();
    });
    const starting = startKairo({ databaseUrl, port: 0, driverFactory: () => driver });
    let application: KairoApplication;
    try {
      const url = await listening;
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      const ready = await fetch(`${url}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toMatchObject({ dependencies: { driver: 'unknown' } });
    } finally {
      completeConnection();
      application = await starting;
      applications.push(application);
    }
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(200);
  });

  it('启动连接返回的同一实例，核心依赖正常时 degraded 200，普通发送失败不使连接失效', async () => {
    const driver = new ApplicationTestDriver();
    const application = await startKairo({ databaseUrl, port: 0, driverFactory: () => driver });
    applications.push(application);
    expect(application.driver).toBe(driver);
    expect(driver.getStatus()).toBe('connected');
    driver.setSendBehavior({ mode: 'pre_trigger_failure', error: '测试发送被拒绝' });
    const sent = await application.driver.sendText('仅用于测试的消息');
    expect(sent.status).toBe('failed');
    const ready = await fetch(`${application.url}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({
      status: 'degraded',
      dependencies: {
        configuration: 'up',
        postgres: 'up',
        mastra: 'up',
        driver: 'up',
        ragflow: 'unknown',
        model: 'unknown',
      },
    });
  });

  it.each<DriverHealthKind>([
    'cdp_invalidated',
    'event_bridge_invalidated',
    'connection_identity_mismatch',
  ])('%s 事件将本实例锁定 down，即使后续快照仍声称正常', async kind => {
    const driver = new ApplicationTestDriver();
    const application = await startKairo({ databaseUrl, port: 0, driverFactory: () => driver });
    applications.push(application);
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(200);
    driver.emit('health', {
      kind,
      startupGenerationId: driver.getStartupGenerationId(),
      connectionIdentity: driver.getHealthSnapshot().cdpConnectionIdentity,
      observedAt: Date.now(),
      cause: new Error('不可写入输出的连接诊断'),
    });
    expect(driver.getHealthSnapshot().cdpStatus).toBe('connected');
    const ready = await fetch(`${application.url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ dependencies: { driver: 'down' } });
    expect((await fetch(`${application.url}/health/live`)).status).toBe(200);
  });

  it.each([
    [
      'CDP 断开',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.cdpStatus = 'disconnected';
      },
    ],
    [
      'Bridge 脱离',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.eventBridgeAttached = false;
      },
    ],
    [
      '缺少 CDP 身份',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.cdpConnectionIdentity = null;
      },
    ],
    [
      '缺少 Bridge 身份',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.eventBridgeConnectionIdentity = null;
      },
    ],
    [
      '快照代次错误',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.startupGenerationId = '其他代次';
      },
    ],
    [
      'CDP 代次错误',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.cdpConnectionIdentity = {
          ...snapshot.cdpConnectionIdentity!,
          startupGenerationId: '其他代次',
        };
      },
    ],
    [
      'Bridge 代次错误',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.eventBridgeConnectionIdentity = {
          ...snapshot.eventBridgeConnectionIdentity!,
          startupGenerationId: '其他代次',
        };
      },
    ],
    [
      '连接身份不一致',
      (snapshot: DriverHealthSnapshot) => {
        snapshot.eventBridgeConnectionIdentity = {
          ...snapshot.eventBridgeConnectionIdentity!,
          connectionId: '其他连接',
        };
      },
    ],
  ])('%s 不得冒充健康，快照伪恢复也不能恢复就绪', async (_name, invalidate) => {
    const driver = new ApplicationTestDriver();
    const application = await startKairo({ databaseUrl, port: 0, driverFactory: () => driver });
    applications.push(application);
    const snapshot = driver.getHealthSnapshot();
    const probe = vi.spyOn(driver, 'getHealthSnapshot').mockReturnValue(snapshot);
    invalidate(snapshot);
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(503);
    probe.mockRestore();
    expect((await fetch(`${application.url}/health/ready`)).status).toBe(503);
  });

  it('SDK 默认 Fake 的空连接身份不能作为应用 Driver up 的证据', async () => {
    const application = await startKairo({
      databaseUrl,
      port: 0,
      driverFactory: () => new FakeKK9Driver(),
    });
    applications.push(application);
    const ready = await fetch(`${application.url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toMatchObject({ dependencies: { driver: 'down' } });
  });

  it.each(['连接拒绝', '连接期间 error', '启动后 error'] as const)(
    '%s 保留 live 并接住错误事件',
    async scenario => {
      const driver = new ApplicationTestDriver();
      const failure = new Error('不能输出的连接凭证');
      if (scenario !== '启动后 error') {
        vi.spyOn(driver, 'connect').mockImplementation(() => {
          if (scenario === '连接期间 error') driver.emit('error', failure);
          return Promise.reject(failure);
        });
      }
      const application = await startKairo({ databaseUrl, port: 0, driverFactory: () => driver });
      applications.push(application);
      if (scenario === '启动后 error') driver.emit('error', failure);
      const ready = await fetch(`${application.url}/health/ready`);
      expect(ready.status).toBe(503);
      const body = await ready.text();
      expect(JSON.parse(body)).toMatchObject({ dependencies: { driver: 'down' } });
      expect(body).not.toContain(failure.message);
      expect((await fetch(`${application.url}/health/live`)).status).toBe(200);
      await application.close();
      expect(driver.getStatus()).toBe('disconnected');
    }
  );

  it.each([
    'https://example.com:9222',
    'ws://127.0.0.1:9222',
    'http://127.0.0.2:9222',
    '不能解析的地址',
  ])('拒绝非允许的 CDP 地址 %s，且不初始化运行时或 Driver', async url => {
    const runtime = vi.spyOn(runtimeModule, 'createMastraRuntime');
    const driverFactory = vi.fn(() => new ApplicationTestDriver());
    await expect(
      startKairo({ databaseUrl, port: 0, cdp: { url, pageMatch: 'renderer.html' }, driverFactory })
    ).rejects.toMatchObject({ type: 'configuration' });
    expect(runtime).not.toHaveBeenCalled();
    expect(driverFactory).not.toHaveBeenCalled();
  });

  it('使用既有 CDP 环境值，显式配置优先，不提供禁用 Driver 的路径', async () => {
    vi.stubEnv('CDP_URL', 'https://localhost:9223');
    vi.stubEnv('PAGE_MATCH', '测试渲染页');
    const factory = vi.fn(() => new ApplicationTestDriver());
    applications.push(await startKairo({ databaseUrl, port: 0, driverFactory: factory }));
    expect(factory.mock.calls[0]).toEqual([
      { cdp: { url: 'https://localhost:9223', pageMatch: '测试渲染页' } },
    ]);
    const cdp = { url: 'http://[::1]:9224', pageMatch: '显式页面', timeoutMs: 20 };
    applications.push(await startKairo({ databaseUrl, port: 0, cdp, driverFactory: factory }));
    expect(factory.mock.calls[1]).toEqual([{ cdp }]);
  });

  it('关闭逐一释放健康监听、Driver、Mastra，多个错误仍保留且并发调用共享 Promise', async () => {
    const order: string[] = [];
    const healthFailure = new Error('健康监听关闭错误');
    const driverFailure = new Error('Driver 关闭错误');
    const storageFailure = new Error('存储关闭错误');
    vi.spyOn(healthModule, 'startHealthServer').mockImplementation(async options => {
      const health = await startHealth(options);
      const close = health.close;
      health.close = async () => {
        await close();
        order.push('health');
        throw healthFailure;
      };
      return health;
    });
    const driver = new ApplicationTestDriver();
    const disconnect = driver.disconnect.bind(driver);
    vi.spyOn(driver, 'disconnect').mockImplementation(async () => {
      await disconnect();
      order.push('driver');
      throw driverFailure;
    });
    const application = await startKairo({ databaseUrl, port: 0, driverFactory: () => driver });
    applications.push(application);
    const shutdown = application.mastra.shutdown.bind(application.mastra);
    vi.spyOn(application.mastra, 'shutdown').mockImplementation(async () => {
      await shutdown();
      order.push('mastra');
      throw storageFailure;
    });
    const closing = application.close();
    expect(application.close()).toBe(closing);
    await expect(closing).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ cause: healthFailure }),
        expect.objectContaining({ cause: driverFailure }),
        expect.objectContaining({ cause: storageFailure }),
      ],
    });
    expect(application.close()).toBe(closing);
    expect(order).toEqual(['health', 'driver', 'mastra']);
    expect(driver.getStatus()).toBe('disconnected');
    expect(application.storage.pool.ended).toBe(true);
    await expect(fetch(`${application.url}/health/live`)).rejects.toThrow();
  });

  it('监听初始化失败时不连接 Driver，并回收已创建资源', async () => {
    const failure = new Error('测试监听失败');
    const runtime = createRuntime(databaseUrl);
    vi.spyOn(runtimeModule, 'createMastraRuntime').mockReturnValue(runtime);
    vi.spyOn(healthModule, 'startHealthServer').mockRejectedValue(failure);
    const driver = new ApplicationTestDriver();
    const connect = vi.spyOn(driver, 'connect');
    await expect(
      startKairo({ databaseUrl, port: 0, driverFactory: () => driver })
    ).rejects.toMatchObject({ type: 'configuration', cause: failure });
    expect(connect).not.toHaveBeenCalled();
    expect(driver.getStatus()).toBe('disconnected');
    expect(runtime.storage.pool.ended).toBe(true);
  });

  it('Driver 工厂抛出异常时释放已创建的 Mastra，并保留原 cause', async () => {
    const failure = new Error('测试 Driver 创建失败');
    const runtime = createRuntime(databaseUrl);
    vi.spyOn(runtimeModule, 'createMastraRuntime').mockReturnValue(runtime);
    await expect(
      startKairo({
        databaseUrl,
        port: 0,
        driverFactory: () => {
          throw failure;
        },
      })
    ).rejects.toMatchObject({ type: 'driver', cause: failure });
    expect(runtime.storage.pool.ended).toBe(true);
  });
});
