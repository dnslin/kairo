import { createServer } from 'node:net';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { startKairo } from '../../src/index.js';
import type { KairoApplication } from '../../src/index.js';

describe('T17 正式入口的真实健康路径', () => {
  it('数据库握手挂起时健康请求有界失败，live 不受影响且未接入依赖保持未知', async () => {
    const sockets = new Set<Socket>();
    const database = createServer(socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>(resolve => database.listen(0, '127.0.0.1', resolve));
    const address = database.address();
    if (!address || typeof address === 'string') throw new Error('无法取得测试数据库端口');
    let application: KairoApplication | undefined;
    try {
      application = await startKairo({
        databaseUrl: `postgresql://probe:不能泄露的测试密码@127.0.0.1:${address.port}/t17_probe`,
        port: 0,
      });
      const pending = fetch(`${application.url}/health/ready`, {
        signal: AbortSignal.timeout(5000),
      });
      const live = await fetch(`${application.url}/health/live`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: 'alive' });
      const ready = await pending;
      expect(ready.status).toBe(503);
      const body = await ready.text();
      expect(JSON.parse(body)).toEqual({
        status: 'not_ready',
        dependencies: {
          configuration: 'up',
          postgres: 'down',
          mastra: 'up',
          driver: 'unknown',
          ragflow: 'unknown',
          model: 'unknown',
        },
      });
      expect(body).not.toContain('不能泄露');
      expect(body).not.toContain('postgresql://');
    } finally {
      await application?.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        database.close(error => (error ? reject(error) : resolve()))
      );
    }
  }, 15000);
});
