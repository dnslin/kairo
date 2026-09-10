import http from 'node:http';
import type { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { KK9Driver } from '@kairo/driver';
import { expect, it } from 'vitest';
import { createDriverSupervisor } from '../../src/modules/im-transport/driver-supervisor.js';
import { deferredSignal } from '../helpers/collector-runtime.js';

it('监督器关闭主动取消真实CDP挂起握手，不等待六十秒超时', async () => {
  const sockets = new Set<Socket>();
  const upgraded = deferredSignal();
  const ended = deferredSignal();
  let port = 0;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(
      JSON.stringify([
        {
          id: '本地挂起连接',
          type: 'page',
          title: 'renderer.html',
          url: 'file:///renderer.html',
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/local`,
        },
      ])
    );
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('upgrade', (_request, socket) => {
    socket.on('end', () => socket.end());
    socket.on('close', () => ended.resolve());
    socket.resume();
    upgraded.resolve();
  });
  const listening = deferredSignal();
  server.listen(0, '127.0.0.1', () => listening.resolve());
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地服务器没有端口');
  port = address.port;
  const supervisor = createDriverSupervisor({
    logger: { error(): void {} },
    createDriver: () =>
      new KK9Driver({
        cdp: { url: `http://127.0.0.1:${port}`, pageMatch: 'renderer.html', timeoutMs: 60000 },
      }),
  });
  const connecting = supervisor.connect().catch(error => error as unknown);
  try {
    await upgraded.promise;
    const closing = supervisor.close();
    const result = await Promise.race([
      Promise.all([closing, ended.promise]).then(() => '已回收'),
      delay(1000).then(() => '仍等待握手'),
    ]);
    expect(result).toBe('已回收');
    expect(supervisor.current).toBeNull();
  } finally {
    for (const socket of sockets) socket.destroy();
    await connecting;
    await supervisor.close();
    const closed = deferredSignal();
    server.close(() => closed.resolve());
    await closed.promise;
  }
}, 5000);
