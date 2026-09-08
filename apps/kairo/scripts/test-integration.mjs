import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
// pnpm 会保留脚本名后的分隔符；只移除首个透传 --，让 Vitest 正确识别文件过滤。
if (args[0] === '--') args.shift();

const result = spawnSync(
  process.execPath,
  [
    fileURLToPath(new URL('../../../node_modules/vitest/vitest.mjs', import.meta.url)),
    'run',
    '--config',
    'vitest.integration.config.ts',
    ...args,
  ],
  { cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit' }
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
