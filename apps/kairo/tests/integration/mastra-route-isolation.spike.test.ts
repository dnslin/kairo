import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { PostgresStore } from '@mastra/pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startKairo } from '../../src/index.js';
import type { KairoApplication } from '../../src/index.js';
import { createStudioMastra } from '../../src/mastra/dev-server.js';
import { createPostgresPool } from '../../src/db/pool.js';
import { migrateDatabase } from '../../src/db/migrate.js';

const databaseUrl = process.env.KAIRO_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 KAIRO_TEST_DATABASE_URL，不能执行 T13 集成测试');

const applications: KairoApplication[] = [];
afterEach(async () => {
  await Promise.all(applications.splice(0).map(application => application.close()));
  vi.unstubAllEnvs();
});

describe('T13 生产路由隔离', () => {
  it('生产环境即使带 Studio 变量也只开放本机只读健康接口', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('MASTRA_STUDIO', 'true');
    vi.stubEnv('KAIRO_STUDIO_DATABASE_URL', databaseUrl);
    const application = await startKairo({ databaseUrl, port: 0 });
    applications.push(application);
    expect(new URL(application.url).hostname).toBe('127.0.0.1');
    const live = await fetch(`${application.url}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'alive' });
    const ready = await fetch(`${application.url}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.json()).toEqual({
      status: 'not_ready',
      dependencies: {
        configuration: 'up',
        postgres: 'up',
        mastra: 'up',
        driver: 'unknown',
        ragflow: 'unknown',
        model: 'unknown',
      },
    });
    const dependencies = await fetch(`${application.url}/health/dependencies`);
    expect(dependencies.status).toBe(200);
    expect(await dependencies.json()).toMatchObject({
      dependencies: { postgres: 'up', driver: 'unknown' },
    });
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/api/agents'],
      ['POST', '/api/agents/test/generate'],
      ['POST', '/api/tools/test/execute'],
      ['POST', '/api/workflows/test/start'],
    ] as const) {
      const response = await fetch(`${application.url}${path}`, { method });
      expect(response.status, path).toBe(404);
    }
    expect((await fetch(`${application.url}/health/live`, { method: 'POST' })).status).toBe(404);
    const result = await application.storage.db.query('SELECT current_database() AS name');
    expect(result.rows[0].name).toBe(decodeURIComponent(new URL(databaseUrl).pathname.slice(1)));
  });

  it('关闭释放实际端口和数据库连接，重复关闭不会重新执行', async () => {
    const application = await startKairo({ databaseUrl, port: 0 });
    applications.push(application);
    await application.storage.db.query('SELECT 1');
    await Promise.all([application.close(), application.close()]);
    await expect(fetch(`${application.url}/health/live`)).rejects.toThrow();
    await expect(application.storage.db.query('SELECT 1')).rejects.toThrow();
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(Number(new URL(application.url).port), '127.0.0.1', resolve);
    });
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  });
});

describe('T13 Studio 数据隔离', () => {
  it('开发写入只进入独立数据库，正式 thread 不可读取', async () => {
    const admin = createPostgresPool(databaseUrl);
    const suffix = randomUUID().replaceAll('-', '');
    const productionName = `kairo_t13_prod_${suffix}`;
    const developmentName = `kairo_t13_dev_${suffix}`;
    const created: string[] = [];
    const urlFor = (name: string) => {
      const url = new URL(databaseUrl);
      url.pathname = `/${name}`;
      return url.toString();
    };
    try {
      for (const name of [productionName, developmentName]) {
        await admin.query(`CREATE DATABASE "${name}"`);
        created.push(name);
        await migrateDatabase({ databaseUrl: urlFor(name) });
      }
      const production = await startKairo({ databaseUrl: urlFor(productionName), port: 0 });
      try {
        const developmentUrl = new URL(urlFor(developmentName));
        developmentUrl.pathname = '/outer_alias_not_used';
        developmentUrl.searchParams.set('connectionString', urlFor(developmentName));
        const studio = await createStudioMastra({
          NODE_ENV: 'development',
          DATABASE_URL: urlFor(productionName),
          KAIRO_PRODUCTION_DATASET_ID: 't13-production-dataset',
          KAIRO_PRODUCTION_EMPLOYEE_IDS: 'production-employee',
          KAIRO_STUDIO_DATABASE_URL: developmentUrl.toString(),
          KAIRO_STUDIO_DATASET_ID: 't13-test-dataset',
          KAIRO_STUDIO_EMPLOYEE_ID: 'test-employee',
        });
        try {
          const storage = studio.getStorage();
          if (!(storage instanceof PostgresStore)) throw new Error('Studio PostgreSQL 存储不可用');
          const target = await storage.pool.query<{ name: string }>(
            'SELECT current_database() AS name'
          );
          expect(target.rows[0]?.name).toBe(developmentName);
          const productionMemory = await production.storage.getStore('memory');
          const developmentMemory = await studio.getStorage()?.getStore('memory');
          if (!productionMemory || !developmentMemory) throw new Error('Mastra Memory 存储不可用');
          const now = new Date();
          await productionMemory.saveThread({
            thread: {
              id: 'production-thread',
              resourceId: 'production-employee',
              title: '正式对话',
              createdAt: now,
              updatedAt: now,
            },
          });
          await developmentMemory.saveThread({
            thread: {
              id: 'development-thread',
              resourceId: 'test-employee',
              title: '开发对话',
              createdAt: now,
              updatedAt: now,
            },
          });
          expect(
            await developmentMemory.getThreadById({ threadId: 'production-thread' })
          ).toBeNull();
          expect(
            await productionMemory.getThreadById({ threadId: 'development-thread' })
          ).toBeNull();
          expect(
            await developmentMemory.getThreadById({ threadId: 'development-thread' })
          ).toMatchObject({ resourceId: 'test-employee' });
          expect(
            await productionMemory.getThreadById({ threadId: 'production-thread' })
          ).toMatchObject({ resourceId: 'production-employee' });
        } finally {
          await studio.shutdown();
        }
      } finally {
        await production.close();
      }
    } finally {
      for (const name of created.reverse()) await admin.query(`DROP DATABASE "${name}"`);
      await admin.end();
    }
  }, 30_000);
});
