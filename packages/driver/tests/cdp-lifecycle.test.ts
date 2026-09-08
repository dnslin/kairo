import http from 'node:http';
import type { Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { CdpClient } from '../src/cdp/client.js';

// 本地TCP集成需验证ws原生握手计时，不能用假时钟；截止时间只让回归失败时也进入finally释放服务器。
async function withinDeadline<T>(promise: PromiseLike<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('本地生命周期等待超时')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function createHangingHandshake() {
  const sockets = new Set<Socket>();
  let announceUpgrade!: () => void;
  const upgraded = new Promise<void>(resolve => {
    announceUpgrade = resolve;
  });
  let announceClose!: () => void;
  const socketClosed = new Promise<void>(resolve => {
    announceClose = resolve;
  });
  let port = 0;
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json', Connection: 'close' });
    response.end(
      JSON.stringify([
        {
          id: '本地握手目标',
          type: 'page',
          title: '离线握手',
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
    // 接受TCP但永远不完成WebSocket握手，不连接任何真实KK9。
    // HTTP upgrade 的socket允许半关闭；收到客户端真实FIN后才结束服务端写端。
    socket.on('end', () => {
      socket.end();
    });
    socket.on('close', announceClose);
    socket.resume();
    announceUpgrade();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地服务器缺少端口');
  port = address.port;
  return {
    url: `http://127.0.0.1:${port}`,
    upgraded,
    socketClosed,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    },
  };
}

describe('CDP 握手资源生命周期', () => {
  it('复用timeoutMs终止挂起握手并释放真实TCP连接', async () => {
    const server = await createHangingHandshake();
    const client = new CdpClient({ url: server.url, pageMatch: 'renderer.html', timeoutMs: 100 });
    try {
      await withinDeadline(expect(client.connect()).rejects.toThrow('CDP 连接失败'));
      await withinDeadline(server.socketClosed);
      expect(client.getStatus()).toBe('disconnected');
      expect(client.getConnectionIdentity()).toBeNull();
    } finally {
      await client.disconnect();
      await server.close();
    }
  });

  it('主动关闭正在握手的实例会终止连接并结算connect，而不是遗留等待', async () => {
    const server = await createHangingHandshake();
    const client = new CdpClient({
      url: server.url,
      pageMatch: 'renderer.html',
      timeoutMs: 60_000,
    });
    const errors: Error[] = [];
    client.on('error', error => errors.push(error));
    const connecting = client.connect();
    const rejection = expect(connecting).rejects.toThrow('CDP 连接失败');
    try {
      await withinDeadline(server.upgraded);
      await withinDeadline(Promise.all([client.disconnect(), client.disconnect()]));
      await withinDeadline(rejection);
      await withinDeadline(server.socketClosed);
      expect(client.getStatus()).toBe('disconnected');
      expect(client.getConnectionIdentity()).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await client.disconnect();
      await server.close();
    }
  });
});
