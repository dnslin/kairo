import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { loadBotConfig } from './config/load.js';
import type { LoadedBotConfig } from './config/load.js';
import { createMastraRuntime } from './mastra/runtime.js';
import type { MastraRuntime } from './mastra/runtime.js';
import { startHealthServer } from './modules/operability/health-server.js';
import type { HealthDependencies } from './modules/operability/health.js';
import { createLogger, MastraOperabilityLogger } from './modules/operability/logger.js';
import { AppError, getErrorType } from './modules/operability/errors.js';
import type { AppErrorType } from './modules/operability/errors.js';
import { loadBotCustomization } from './modules/bot-customization/instructions.js';
import type { BotCustomization } from './modules/bot-customization/instructions.js';

const logger = createLogger();
const execFileAsync = promisify(execFile);
const repositoryDirectory = fileURLToPath(new URL('../../../', import.meta.url));

export interface KairoApplication extends MastraRuntime, LoadedBotConfig {
  url: string;
  gitCommit: string;
  customization: BotCustomization;
}

export async function startKairo(
  options: { databaseUrl?: string; port?: number; configDirectory?: string } = {}
): Promise<KairoApplication> {
  let stage: AppErrorType = 'configuration';
  let runtime: MastraRuntime | undefined;
  try {
    const configuration = await loadBotConfig(options.configDirectory);
    const customization = await loadBotCustomization(configuration.config, options.configDirectory);
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: repositoryDirectory,
    });
    const gitCommit = stdout.trim();
    logger.info({ event: '配置已加载', gitCommit, configDigest: configuration.configDigest });
    stage = 'storage';
    const initialized = createMastraRuntime(options.databaseUrl);
    runtime = initialized;
    initialized.mastra.setLogger({ logger: new MastraOperabilityLogger(logger) });
    let closing: Promise<void> | undefined;
    stage = 'configuration';
    const health = await startHealthServer({
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
          // 尚未装配这些依赖；配置中出现地址或模型名不代表服务可用。
          driver: 'unknown',
          ragflow: 'unknown',
          model: 'unknown',
        };
        if (closing || pool.ending || pool.ended) {
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
        return dependencies;
      },
    });
    logger.info({ event: '应用已启动', status: 'not_ready' });
    return {
      ...initialized,
      ...configuration,
      gitCommit,
      customization,
      url: health.url,
      close(): Promise<void> {
        closing ??= (async (): Promise<void> => {
          try {
            await health.close();
          } finally {
            await initialized.close();
          }
          logger.info({ event: '应用已关闭', status: 'closed' });
        })();
        return closing;
      },
    };
  } catch (error) {
    if (runtime) {
      try {
        await runtime.close();
      } catch (closeError) {
        logger.error({ event: '应用关闭失败', errorType: getErrorType(closeError, 'storage') });
      }
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
