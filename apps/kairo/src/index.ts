import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { pino } from 'pino';
import { loadBotConfig } from './config/load.js';
import type { LoadedBotConfig } from './config/load.js';
import { createMastraRuntime } from './mastra/runtime.js';
import type { MastraRuntime } from './mastra/runtime.js';
import { startHealthServer } from './modules/operability/health-server.js';
import { loadBotCustomization } from './modules/bot-customization/instructions.js';
import type { BotCustomization } from './modules/bot-customization/instructions.js';

const logger = pino();
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
  const configuration = await loadBotConfig(options.configDirectory);
  const customization = await loadBotCustomization(configuration.config, options.configDirectory);
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryDirectory,
  });
  const gitCommit = stdout.trim();
  const runtime = createMastraRuntime(options.databaseUrl);
  try {
    const health = await startHealthServer(options.port);
    logger.info(
      { event: '配置已加载', gitCommit, configDigest: configuration.configDigest },
      'Bot 配置校验通过'
    );
    let closing: Promise<void> | undefined;
    return {
      ...runtime,
      ...configuration,
      gitCommit,
      customization,
      url: health.url,
      close(): Promise<void> {
        closing ??= (async (): Promise<void> => {
          try {
            await health.close();
          } finally {
            await runtime.close();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    await runtime.close();
    throw error;
  }
}

async function main(): Promise<void> {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 13)) {
    throw new Error(`@kairo/app 需要 Node.js >=22.13.0，当前版本为 ${process.versions.node}`);
  }
  const application = await startKairo();
  console.log(`Kairo 进程内运行时已启动：${application.url}/health/live`);
  const shutdown = (): void => {
    application
      .close()
      .then(() => {
        console.log('Kairo 运行时已关闭');
      })
      .catch(error => {
        console.error('Kairo 关闭失败', error);
        process.exitCode = 1;
      });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error('Kairo 启动失败', error);
    process.exitCode = 1;
  });
}
