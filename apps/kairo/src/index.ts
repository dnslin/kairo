import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client, Pool } from 'pg';
import { KK9Driver, setDriverLogSink } from '@kairo/driver';
import type { CdpConfig, DriverConfig, IKK9Driver } from '@kairo/driver';
import { loadBotConfig } from './config/load.js';
import type { LoadedBotConfig } from './config/load.js';
import { createMastraRuntime } from './mastra/runtime.js';
import type { MastraRuntime } from './mastra/runtime.js';
import { startHealthServer } from './modules/operability/health-server.js';
import type { HealthServer } from './modules/operability/health-server.js';
import type { HealthDependencies } from './modules/operability/health.js';
import {
  createLogger,
  createDriverLogSink,
  MastraOperabilityLogger,
} from './modules/operability/logger.js';
import { AppError, getErrorType } from './modules/operability/errors.js';
import type { AppErrorType } from './modules/operability/errors.js';
import { loadBotCustomization } from './modules/bot-customization/instructions.js';
import type { BotCustomization } from './modules/bot-customization/instructions.js';
import { startDependencyChecks } from './modules/operability/dependency-checks.js';
import type { DependencyChecks } from './modules/operability/dependency-checks.js';
import { PostgresRuntimeBootStore } from './modules/operability/runtime-boot-store.js';
import { knowledgeTools } from './modules/tool-integration/knowledge-tool.js';

const logger = createLogger();
const execFileAsync = promisify(execFile);
const repositoryDirectory = fileURLToPath(new URL('../../../', import.meta.url));

export interface KairoApplication extends MastraRuntime, LoadedBotConfig {
  url: string;
  gitCommit: string;
  bootId: string;
  /** 启动账本失败时保留诊断接口；本代次不能 ready，原始原因仅供程序内诊断。 */
  bootError: AppError | null;
  customization: BotCustomization;
  driver: IKK9Driver;
}

export async function startKairo(
  options: {
    databaseUrl?: string;
    port?: number;
    configDirectory?: string;
    cdp?: CdpConfig;
    driverFactory?: (config: DriverConfig) => IKK9Driver;
  } = {}
): Promise<KairoApplication> {
  // 底层日志也经过应用现有白名单，不输出连接地址或原始异常。
  setDriverLogSink(createDriverLogSink(logger));
  let stage: AppErrorType = 'configuration';
  let runtime: MastraRuntime | undefined;
  let driver: IKK9Driver | undefined;
  let health: HealthServer | undefined;
  let external: DependencyChecks | undefined;
  let closing: Promise<void> | undefined;
  let driverInvalidated = false;
  const bootId = randomUUID();
  const bootStartedAt = Date.now();
  let bootPool: Pool | undefined;
  let bootStore: PostgresRuntimeBootStore | undefined;
  let bootRecorded = false;
  let bootReady = false;
  let bootError: AppError | null = null;
  let startupFailed = false;
  const failBoot = (error: unknown): void => {
    bootReady = false;
    bootError = new AppError('storage', { cause: error });
    logger.error({ event: '运行失败', runId: bootId, errorType: 'storage', status: 'not_ready' });
  };
  const close = (): Promise<void> => {
    closing ??= (async (): Promise<void> => {
      driverInvalidated = true;
      const failures: AppError[] = [];
      // 逐一回收属于本应用的资源；某一步失败不能跳过后续步骤。
      for (const [resource, errorType] of [
        [external?.close.bind(external), 'internal'],
        [health?.close.bind(health), 'configuration'],
        [driver?.disconnect.bind(driver), 'driver'],
        [runtime?.close.bind(runtime), 'storage'],
        [
          async (): Promise<void> => {
            if (!bootRecorded || !bootStore) return;
            const closed = await bootStore.closeBoot(bootId, {
              status: startupFailed || bootError || failures.length > 0 ? 'failed' : 'closed',
              closedAt: Date.now(),
            });
            if (!closed) throw new AppError('storage');
          },
          'storage',
        ],
        [bootPool?.end.bind(bootPool), 'storage'],
      ] as const) {
        if (!resource) continue;
        try {
          await resource();
        } catch (error) {
          const failure = new AppError(getErrorType(error, errorType), { cause: error });
          failures.push(failure);
          logger.error({ event: '应用关闭失败', errorType: failure.type });
        }
      }
      if (failures.length === 1) throw failures[0]!;
      if (failures.length > 1) throw new AggregateError(failures, '应用资源关闭失败');
      logger.info({ event: '应用已关闭', status: 'closed' });
    })();
    return closing;
  };
  try {
    const configuration = await loadBotConfig(options.configDirectory, Object.keys(knowledgeTools));
    const customization = await loadBotCustomization(configuration.config, options.configDirectory);
    const cdp = options.cdp ?? {
      url: process.env.CDP_URL ?? 'http://127.0.0.1:9222',
      pageMatch: process.env.PAGE_MATCH ?? 'renderer.html',
    };
    const cdpUrl = new URL(cdp.url);
    if (
      !['http:', 'https:'].includes(cdpUrl.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(cdpUrl.hostname)
    ) {
      throw new AppError('configuration');
    }
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryDirectory,
    });
    const gitCommit = stdout.trim();
    logger.info({ event: '配置已加载', gitCommit, configDigest: configuration.configDigest });
    stage = 'storage';
    const initialized = createMastraRuntime(options.databaseUrl);
    runtime = initialized;
    initialized.mastra.setLogger({ logger: new MastraOperabilityLogger(logger) });
    // 启动账本必须有界失败；独立小池同时允许在 Mastra 关闭后保存最终关闭结果。
    bootPool = new Pool({
      ...initialized.storage.pool.options,
      password: initialized.storage.pool.options.password,
      max: 1,
      connectionTimeoutMillis: 2000,
      query_timeout: 2000,
      statement_timeout: 2000,
    });
    bootPool.on('error', failBoot);
    bootStore = new PostgresRuntimeBootStore(bootPool);
    try {
      await bootStore.startBoot({
        bootId,
        gitCommit,
        configDigest: configuration.configDigest,
        startedAt: bootStartedAt,
      });
      bootRecorded = true;
    } catch (error) {
      failBoot(error);
    }
    stage = 'driver';
    const activeDriver = options.driverFactory
      ? options.driverFactory({ cdp })
      : new KK9Driver({ cdp });
    driver = activeDriver;
    const generationId = activeDriver.getStartupGenerationId();
    let driverConnecting = true;
    const invalidateDriver = (): void => {
      if (driverInvalidated) return;
      driverInvalidated = true;
      logger.error({
        event: 'Driver运行异常',
        status: 'down',
        errorType: 'driver',
        runId: generationId,
      });
    };
    // 必须在 connect 前订阅，覆盖连接期间同步发出的 error 和关键失效事实。
    activeDriver.on('health', invalidateDriver);
    activeDriver.on('error', invalidateDriver);
    const readDriverStatus = (): HealthDependencies['driver'] => {
      if (driverInvalidated || closing) return 'down';
      if (driverConnecting) return 'unknown';
      try {
        const snapshot = activeDriver.getHealthSnapshot();
        const cdpIdentity = snapshot.cdpConnectionIdentity;
        const bridgeIdentity = snapshot.eventBridgeConnectionIdentity;
        if (
          snapshot.cdpStatus === 'connected' &&
          snapshot.eventBridgeAttached &&
          snapshot.startupGenerationId === generationId &&
          cdpIdentity !== null &&
          bridgeIdentity !== null &&
          cdpIdentity.startupGenerationId === generationId &&
          bridgeIdentity.startupGenerationId === generationId &&
          cdpIdentity.connectionId === bridgeIdentity.connectionId
        ) {
          return 'up';
        }
      } catch {
        // 无法取得自身健康事实也不能冒充可用；后续伪恢复不会解锁本实例。
      }
      invalidateDriver();
      return 'down';
    };
    stage = 'configuration';
    health = await startHealthServer({
      port: options.port,
      async readDependencies(): Promise<HealthDependencies> {
        const pool = initialized.storage.pool;
        const dependencies: HealthDependencies = {
          configuration: 'up',
          postgres: 'unknown',
          mastra:
            !closing && initialized.mastra.getStorage()?.id === initialized.storage.id
              ? 'up'
              : 'down',
          driver: readDriverStatus(),
          ...(external?.read() ?? { model: 'unknown', ragflow: 'unknown' }),
        };
        if (closing || pool.ending || pool.ended || !bootReady || bootError) {
          dependencies.postgres = 'down';
          return dependencies;
        }
        // 复用实际存储的连接配置，但不占用业务池或改变其超时。短连接只做只读探测。
        const client = new Client({
          ...pool.options,
          // pg-pool 将 password 设为不可枚举，展开配置不会带上它。
          password: pool.options.password,
          connectionTimeoutMillis: 2000,
          query_timeout: 2000,
          statement_timeout: 2000,
        });
        const startedAt = performance.now();
        try {
          await client.connect();
          await client.query('SELECT 1');
          dependencies.postgres = 'up';
        } catch (error) {
          dependencies.postgres = 'down';
          logger.warn({
            event: '依赖检查失败',
            status: 'down',
            errorType: getErrorType(error, 'storage'),
            durationMs: performance.now() - startedAt,
          });
        } finally {
          await client.end();
        }
        if (bootError) dependencies.postgres = 'down';
        return dependencies;
      },
    });
    external = startDependencyChecks(configuration.config, logger);
    stage = 'driver';
    try {
      await activeDriver.connect();
    } catch {
      // 初次连接失败仍提供存活与依赖诊断；不换替身、不重试失效实例。
      invalidateDriver();
    } finally {
      driverConnecting = false;
    }
    if (bootRecorded && !bootError) {
      try {
        bootReady = await bootStore.markRunning(bootId);
        if (!bootReady) throw new AppError('storage');
      } catch (error) {
        failBoot(error);
      }
    }
    logger.info({ event: '应用已启动', status: 'started' });
    return {
      ...initialized,
      ...configuration,
      gitCommit,
      bootId,
      get bootError(): AppError | null {
        return bootError;
      },
      customization,
      driver: activeDriver,
      url: health.url,
      close,
    };
  } catch (error) {
    startupFailed = true;
    try {
      if (health || driver || runtime) await close();
    } catch (closeError) {
      // 启动主因与关闭错误都保留给程序内调用方，日志仍只记录稳定分类。
      throw new AppError(getErrorType(error, stage), {
        cause: new AggregateError([error, closeError], '应用初始化与资源回收失败', {
          cause: error,
        }),
      });
    }
    // 原始异常仅供程序内诊断；CLI 只记录稳定分类，不序列化 message、stack 或 cause。
    throw new AppError(getErrorType(error, stage), { cause: error });
  }
}

async function main(): Promise<void> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new AppError('configuration');
  }
  const application = await startKairo();
  const shutdown = (): void => {
    application.close().catch(error => {
      logger.error({ event: '应用关闭失败', errorType: getErrorType(error) });
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    logger.error({ event: '应用启动失败', errorType: getErrorType(error) });
    process.exitCode = 1;
  });
}
