import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { getHealthSnapshot } from '../../src/modules/operability/health.js';
import type { HealthDependencies } from '../../src/modules/operability/health.js';
import { startHealthServer } from '../../src/modules/operability/health-server.js';
import type { HealthServer } from '../../src/modules/operability/health-server.js';

const healthyDependencies = (): HealthDependencies => ({
  configuration: 'up',
  postgres: 'up',
  mastra: 'up',
  driver: 'up',
  ragflow: 'up',
  model: 'up',
});

const servers: HealthServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
});

describe('T17 健康状态判定', () => {
  it('任一核心依赖未知或不可用时优先判定未就绪，恢复后重新就绪', () => {
    const dependencies = healthyDependencies();
    for (const name of ['configuration', 'postgres', 'mastra', 'driver'] as const) {
      for (const status of ['unknown', 'down'] as const) {
        dependencies[name] = status;
        dependencies.ragflow = 'down';
        expect(getHealthSnapshot(dependencies).status, `${name}:${status}`).toBe('not_ready');
        dependencies[name] = 'up';
        dependencies.ragflow = 'up';
        expect(getHealthSnapshot(dependencies).status).toBe('ready');
      }
    }
  });

  it('核心正常时任一外部依赖未知或不可用仅降级，恢复后重新就绪', () => {
    const dependencies = healthyDependencies();
    for (const name of ['ragflow', 'model'] as const) {
      for (const status of ['unknown', 'down'] as const) {
        dependencies[name] = status;
        expect(getHealthSnapshot(dependencies).status, `${name}:${status}`).toBe('degraded');
        dependencies[name] = 'up';
        expect(getHealthSnapshot(dependencies).status).toBe('ready');
      }
    }
  });
});

describe('T17 回环只读健康服务', () => {
  it('就绪与依赖接口逐次读取异步状态，按当前状态返回状态码', async () => {
    const dependencies = healthyDependencies();
    const server = await startHealthServer({
      port: 0,
      readDependencies: () => Promise.resolve(dependencies),
    });
    servers.push(server);
    for (const [name, value, status, code] of [
      ['postgres', 'down', 'not_ready', 503],
      ['postgres', 'up', 'ready', 200],
      ['model', 'unknown', 'degraded', 200],
      ['model', 'up', 'ready', 200],
    ] as const) {
      dependencies[name] = value;
      const ready = await fetch(`${server.url}/health/ready`);
      expect(ready.status).toBe(code);
      expect(await ready.json()).toEqual({ status, dependencies });
      const detail = await fetch(`${server.url}/health/dependencies`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual({ status, dependencies });
    }
    dependencies.configuration = 'unknown';
    const changedDetail = await fetch(`${server.url}/health/dependencies`);
    expect(changedDetail.status).toBe(200);
    expect(await changedDetail.json()).toEqual({ status: 'not_ready', dependencies });
    dependencies.configuration = 'up';
    const recovered = await fetch(`${server.url}/health/ready`);
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toEqual({ status: 'ready', dependencies });
  });

  it('只输出六个状态，不泄露状态源的连接串、正文或自定义序列化结果', async () => {
    const secret = 'secret-连接串与私聊正文';
    const dependencies = {
      ...healthyDependencies(),
      connectionString: secret,
      content: secret,
      toJSON: () => ({ secret }),
    };
    const server = await startHealthServer({ port: 0, readDependencies: () => dependencies });
    servers.push(server);
    for (const path of ['/health/ready', '/health/dependencies']) {
      const response = await fetch(`${server.url}${path}`);
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(JSON.parse(body)).toEqual({ status: 'ready', dependencies: healthyDependencies() });
    }
  });

  it.each(['同步抛出', '异步拒绝'] as const)(
    '%s依赖异常时返回安全失败，存活接口不读取依赖',
    async mode => {
      const secret = 'secret-数据库密码与异常正文';
      const readDependencies = (): HealthDependencies | Promise<HealthDependencies> => {
        const error = new Error(secret, { cause: new Error(secret) });
        if (mode === '同步抛出') throw error;
        return Promise.reject(error);
      };
      const server = await startHealthServer({ port: 0, readDependencies });
      servers.push(server);
      const live = await fetch(`${server.url}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'alive' });
      for (const path of ['/health/ready', '/health/dependencies']) {
        const response = await fetch(`${server.url}${path}`);
        expect(response.status).toBe(503);
        const body = await response.text();
        expect(body).not.toContain(secret);
        expect(JSON.parse(body)).toMatchObject({ status: 'not_ready' });
        expect(JSON.parse(body)).not.toHaveProperty('dependencies');
      }
      const stillAlive = await fetch(`${server.url}/health/live`);
      expect(stillAlive.status).toBe(200);
      expect(await stillAlive.json()).toEqual({ status: 'alive' });
    }
  );

  it('所有非 GET 健康请求和 Agent、Tool、Workflow 执行路径均不开放', async () => {
    const server = await startHealthServer({
      port: 0,
      readDependencies: () => {
        throw new Error('未知路由不得读取依赖');
      },
    });
    servers.push(server);
    for (const path of ['/health/live', '/health/ready', '/health/dependencies']) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
        const response = await fetch(`${server.url}${path}`, { method });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.text()).toBe('');
      }
    }
    for (const path of [
      '/',
      '/api/agents',
      '/api/agents/test/generate',
      '/api/tools/test/execute',
      '/api/workflows/test/start',
    ]) {
      for (const method of ['GET', 'POST']) {
        const response = await fetch(`${server.url}${path}`, { method });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.text()).toBe('');
      }
    }
  });

  it.each(['0.0.0.0', '::', '::1', '192.168.1.1', 'example.com'])(
    '监听前拒绝非允许地址 %s',
    async host => {
      await expect(
        startHealthServer({ port: 0, host, readDependencies: healthyDependencies })
      ).rejects.toThrow();
    }
  );

  it('localhost 实际监听 IPv4 回环地址，并发和重复关闭释放实际端口', async () => {
    const server = await startHealthServer({
      port: 0,
      host: 'localhost',
      readDependencies: healthyDependencies,
    });
    servers.push(server);
    const address = new URL(server.url);
    expect(address.hostname).toBe('127.0.0.1');
    const live = await fetch(`${server.url}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: 'alive' });
    await Promise.all([server.close(), server.close()]);
    await server.close();
    await expect(fetch(`${server.url}/health/live`)).rejects.toThrow();

    const replacement = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        replacement.once('error', reject);
        replacement.listen(Number(address.port), '127.0.0.1', resolve);
      });
    } finally {
      if (replacement.listening) {
        await new Promise<void>((resolve, reject) => {
          replacement.close(error => (error ? reject(error) : resolve()));
        });
      }
    }
  });
});
