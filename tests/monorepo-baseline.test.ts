import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

interface PackageJson {
  name?: string;
  engines?: {
    node?: string;
  };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

describe('运行基线与工作区配置验证', () => {
  const packagePaths = [
    'package.json',
    'packages/agent/package.json',
    'packages/driver/package.json',
    'packages/gateway/package.json',
    'packages/store/package.json',
    'packages/knowledge/package.json',
    'apps/kkbot/package.json',
  ];

  it('AC1: 根运行时及所有工作区声明统一为 Node.js >=22.13.0', async () => {
    for (const relPath of packagePaths) {
      const fullPath = path.join(rootDir, relPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const pkg = JSON.parse(content) as PackageJson;

      expect(pkg.engines?.node, `${relPath} 的 engines.node 必须配置为 >=22.13.0 或 >=22.13`).toMatch(/>=\s*22\.13/);
    }
  });

  it('AC2: Mastra、Zod 和 MCP 依赖使用父规格锁定的精确候选 B 版本，禁止带 ^ 或 ~ 漂移', async () => {
    const lockedVersions: Record<string, string> = {
      '@mastra/core': '1.61.0',
      '@mastra/libsql': '1.21.1',
      '@mastra/memory': '1.27.0',
      '@mastra/observability': '1.17.1',
      '@mastra/mcp': '1.17.1',
      'zod': '4.4.3',
      '@modelcontextprotocol/sdk': '1.30.0',
    };

    for (const relPath of packagePaths) {
      const fullPath = path.join(rootDir, relPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const pkg = JSON.parse(content) as PackageJson;
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

      for (const [depName, expectedVersion] of Object.entries(lockedVersions)) {
        if (allDeps[depName]) {
          const declared = allDeps[depName];
          expect(
            declared,
            `${relPath} 中的 ${depName} 必须为精确版本 ${expectedVersion}，实际为 ${declared}`
          ).toBe(expectedVersion);
        }
      }
    }
  });

  it('AC4: pnpm-workspace.yaml 正式包含应用模块和 Knowledge 模块', async () => {
    const workspacePath = path.join(rootDir, 'pnpm-workspace.yaml');
    const content = await fs.readFile(workspacePath, 'utf-8');
    const doc = yaml.parse(content) as { packages?: string[] };

    expect(doc.packages).toBeDefined();
    expect(doc.packages).toContain('packages/*');
    expect(doc.packages).toContain('apps/*');

    // 检查 packages/knowledge 和 apps/kkbot 物理目录存在
    const knowledgeStat = await fs.stat(path.join(rootDir, 'packages/knowledge'));
    expect(knowledgeStat.isDirectory()).toBe(true);

    const appStat = await fs.stat(path.join(rootDir, 'apps/kkbot'));
    expect(appStat.isDirectory()).toBe(true);
  });
});
