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

  it('AC2: pnpm-workspace.yaml 建立统一 catalog 锁定父规格候选 B，生产工作区通过 catalog: 引用禁止漂移', async () => {
    const workspacePath = path.join(rootDir, 'pnpm-workspace.yaml');
    const wsContent = await fs.readFile(workspacePath, 'utf-8');
    const wsDoc = yaml.parse(wsContent) as { catalog?: Record<string, string> };

    expect(wsDoc.catalog, 'pnpm-workspace.yaml 必须定义 catalog').toBeDefined();
    expect(wsDoc.catalog?.['@mastra/core']).toBe('1.61.0');
    expect(wsDoc.catalog?.['@mastra/libsql']).toBe('1.21.1');
    expect(wsDoc.catalog?.['@mastra/memory']).toBe('1.27.0');
    expect(wsDoc.catalog?.['@mastra/mcp']).toBe('1.17.1');
    expect(wsDoc.catalog?.['@mastra/observability']).toBe('1.17.1');
    expect(wsDoc.catalog?.['zod']).toBe('4.4.3');

    const catalogPackages = ['@mastra/core', '@mastra/libsql', '@mastra/memory', '@mastra/mcp', '@mastra/observability', 'zod'];

    for (const relPath of packagePaths) {
      const fullPath = path.join(rootDir, relPath);
      const content = await fs.readFile(fullPath, 'utf-8');
      const pkg = JSON.parse(content) as PackageJson;
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };

      for (const depName of catalogPackages) {
        if (allDeps[depName]) {
          const declared = allDeps[depName];
          expect(
            declared === 'catalog:' || declared === wsDoc.catalog?.[depName],
            `${relPath} 中的 ${depName} 必须通过 catalog: 引用或与 catalog 版本严格一致，实际为 ${declared}`
          ).toBe(true);
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
