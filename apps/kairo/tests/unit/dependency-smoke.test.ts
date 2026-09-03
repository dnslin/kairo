import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as driver from '@kairo/driver';

type PackageMetadata = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type Version = readonly [number, number, number];

const require = createRequire(import.meta.url);
const appPackage = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as PackageMetadata;

function readPackageMetadata(packageName: string): PackageMetadata {
  let directory = dirname(require.resolve(packageName));

  while (true) {
    const packageJsonPath = join(directory, 'package.json');

    if (existsSync(packageJsonPath)) {
      const metadata = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as PackageMetadata;
      if (metadata.name === packageName) {
        return metadata;
      }
    }

    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      throw new Error(`无法找到 ${packageName} 的 package.json`);
    }
    directory = parentDirectory;
  }
}

function parseVersion(value: string): Version {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) {
    throw new Error(`无法解析版本号：${value}`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] > right[index] ? 1 : -1;
    }
  }
  return 0;
}

function isVersionInRange(version: string, range: string): boolean {
  const parsedVersion = parseVersion(version);

  return range.split('||').some(part => {
    const normalizedRange = part.trim();

    if (normalizedRange.startsWith('^')) {
      const minimum = parseVersion(normalizedRange.slice(1));
      const maximum: Version =
        minimum[0] > 0
          ? [minimum[0] + 1, 0, 0]
          : minimum[1] > 0
            ? [0, minimum[1] + 1, 0]
            : [0, 0, minimum[2] + 1];
      return compareVersions(parsedVersion, minimum) >= 0 && compareVersions(parsedVersion, maximum) < 0;
    }

    const boundedRange = /^>=([\d.]+)(?:-[^ ]+)?\s+<([\d.]+)(?:-[^ ]+)?$/.exec(normalizedRange);
    if (boundedRange) {
      const minimum = parseVersion(boundedRange[1]);
      const maximum = parseVersion(boundedRange[2]);
      return compareVersions(parsedVersion, minimum) >= 0 && compareVersions(parsedVersion, maximum) < 0;
    }

    throw new Error(`测试未覆盖的 peer 版本范围：${range}`);
  });
}

describe('T03 依赖与 Driver 消费边界', () => {
  it('应用可以直接导入 Driver 且入口解析到 dist 构建产物', () => {
    const driverEntry = require.resolve('@kairo/driver').replaceAll('\\', '/');

    expect(typeof driver.KK9Driver).toBe('function');
    expect(driverEntry).toMatch(/\/packages\/driver\/dist\/index\.js$/);
    expect(driverEntry).not.toContain('/packages/driver/src/');
  });

  it('应用依赖配置精确锁定 T03 版本并直接声明 workspace Driver', () => {
    expect(appPackage.dependencies).toMatchObject({
      '@kairo/driver': 'workspace:*',
      '@mastra/core': '1.63.2',
      '@mastra/memory': '1.28.1',
      '@mastra/pg': '1.22.2',
      mastra: '1.27.2',
      pg: '8.23.0',
      'node-pg-migrate': '9.0.0',
      zod: '4.5.4',
      yaml: '2.9.0',
      pino: '9.14.0',
    });

    expect(appPackage.dependencies?.['@mastra/mcp']).toBeUndefined();
    expect(appPackage.devDependencies?.['@mastra/mcp']).toBeUndefined();
  });

  it('Mastra 相关 peer dependencies 与实际安装版本相容', () => {
    const core = readPackageMetadata('@mastra/core');
    const memory = readPackageMetadata('@mastra/memory');
    const pg = readPackageMetadata('@mastra/pg');
    const mastra = readPackageMetadata('mastra');
    const zod = readPackageMetadata('zod');

    const peerChecks: Array<[string | undefined, string | undefined]> = [
      [core.peerDependencies?.zod, zod.version],
      [memory.peerDependencies?.['@mastra/core'], core.version],
      [pg.peerDependencies?.['@mastra/core'], core.version],
      [mastra.peerDependencies?.['@mastra/core'], core.version],
    ];

    for (const [range, version] of peerChecks) {
      expect(range).toBeDefined();
      expect(version).toBeDefined();
      expect(isVersionInRange(version as string, range as string)).toBe(true);
    }
  });
});
