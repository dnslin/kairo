#!/usr/bin/env node
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { UnifiedBootstrapper } from './bootstrapper.js';
import { ConfigValidationError } from './errors.js';

export interface CliIO {
  log: (message: string) => void;
  error: (message: string) => void;
}

const defaultIO: CliIO = {
  log: (msg: string) => console.log(msg),
  error: (msg: string) => console.error(msg),
};
/**
 * 查找默认配置文件路径
 */
async function resolveDefaultConfigPath(): Promise<string> {
  const candidates = [
    './config.yaml',
    './config/kkbot.yaml',
    './config.example.yaml',
    '../../config.yaml',
    '../../config/kkbot.yaml',
    '../../config.example.yaml',
  ];
  for (const cand of candidates) {
    try {
      await fs.access(path.resolve(cand));
      return cand;
    } catch {
      // 尝试下一个候选
    }
  }
  return './config.yaml';
}

/**
 * 解析命令行参数
 */
function parseArgs(args: string[]): {
  command: string;
  configPath: string | null;
  devMode: boolean;
} {
  let command = 'start';
  let configPath: string | null = null;
  let devMode = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (
      arg === 'doctor' ||
      arg === 'start' ||
      arg === 'knowledge:ingest' ||
      arg === 'knowledge:rebuild'
    ) {
      command = arg;
    } else if (arg === '--config' || arg === '-c') {
      if (i + 1 < args.length) {
        configPath = args[i + 1] ?? null;
        i++;
      }
    } else if (arg === '--dev') {
      devMode = true;
    }
  }

  return { command, configPath, devMode };
}

/**
 * 运行 CLI 主逻辑
 */
export async function runCli(
  args: string[] = process.argv.slice(2),
  io: CliIO = defaultIO
): Promise<number> {
  const { command, configPath: rawConfigPath, devMode } = parseArgs(args);
  const resolvedConfigPath = rawConfigPath ?? (await resolveDefaultConfigPath());

  io.log(
    `[KKBot] 正在加载配置文件: ${resolvedConfigPath} (命令: ${command}${devMode ? ', 开发模式' : ''})`
  );

  const bootstrapper = new UnifiedBootstrapper({ configPath: resolvedConfigPath });

  try {
    const config = await bootstrapper.staticValidate();

    if (command === 'doctor') {
      io.log('[KKBot] ✅ 配置静态校验通过！');
      io.log(`[KKBot] - 数据库存储: ${config.storage.url}`);
      io.log(`[KKBot] - CDP 服务地址: ${config.kk.cdp.url}`);
      io.log(`[KKBot] - Agent ID: ${config.agent.id}`);
      io.log(
        `[KKBot] - 时区与限额: ${config.limits.timezone} (每日限额: ${config.limits.globalDailyTokens} tokens)`
      );
      return 0;
    }

    if (command === 'knowledge:ingest' || command === 'knowledge:rebuild') {
      io.log(`[KKBot] 知识库命令 '${command}' 准备就绪（由后续 Knowledge 专用任务实施执行）。`);
      return 0;
    }

    io.log('[KKBot] 运行基线与静态配置验证完成。');
    return 0;
  } catch (err) {
    if (err instanceof ConfigValidationError) {
      io.error(`\n❌ [KKBot] 配置文件校验失败，共发现 ${err.errors.length} 处错误：\n`);
      for (const [idx, item] of err.errors.entries()) {
        io.error(`[${idx + 1}] 字段路径: ${item.path}`);
        io.error(`    失败原因: ${item.reason}`);
        io.error(`    修复建议: ${item.hint}\n`);
      }
      return 1;
    }

    const message = err instanceof Error ? err.message : String(err);
    io.error(`[KKBot] 启动失败: ${message}`);
    return 1;
  }
}

// 直接运行主入口：仅当当前文件确为命令行直接执行的目标脚本时运行
if (process.argv[1]) {
  try {
    const currentFilePath = fileURLToPath(import.meta.url);
    const invokedPath = path.resolve(process.argv[1]);
    if (invokedPath === currentFilePath) {
      void runCli().then(code => {
        if (code !== 0) {
          process.exit(code);
        }
      });
    }
  } catch {
    // 忽略解析异常
  }
}
