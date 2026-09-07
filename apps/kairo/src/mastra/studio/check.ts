import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { loadStudioConfig } from '../dev-server.js';

loadStudioConfig();
// 锁定 CLI 的子进程直接采用 --env 文件中的 NODE_ENV，而不是父进程值。
const fileEnvironment = parseEnv(readFileSync('../../.env.studio', 'utf8'));
if (fileEnvironment.NODE_ENV !== 'development') {
  throw new Error('.env.studio 必须显式设置 NODE_ENV=development');
}
console.log('Studio 开发配置隔离检查通过');
