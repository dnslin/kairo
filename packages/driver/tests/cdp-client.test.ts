import http from 'node:http';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpClient } from '../src/cdp/client.js';
import { CdpError } from '../src/utils/errors.js';

describe('CdpClient 核心通信与状态机测试 (Mock WS Server)', () => {
  let httpServer: http.Server;
  let wss: WebSocketServer;
  let port: number;
  let serverWsUrl: string;

  beforeAll(async () => {
    // 启动本地 Mock HTTP & WebSocket 服务器
    httpServer = http.createServer((req, res) => {
      if (req.url === '/json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify([
            {
              id: 'target-1',
              title: 'KK9 Main Window',
              type: 'page',
              url: 'file:///app/renderer.html',
              webSocketDebuggerUrl: serverWsUrl,
            },
            {
              id: 'target-2',
              title: 'DevTools',
              type: 'other',
              url: 'devtools://devtools',
            },
          ])
        );
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>(resolve => {
      httpServer.listen(0, '127.0.0.1', () => {
        const addr = httpServer.address();
        if (addr && typeof addr === 'object') {
          port = addr.port;
          serverWsUrl = `ws://127.0.0.1:${port}/devtools/page/target-1`;
        }
        resolve();
      });
    });

    wss = new WebSocketServer({ server: httpServer });

    wss.on('connection', ws => {
      ws.on('message', data => {
        const msg = JSON.parse(
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf-8')
              : (data as Buffer).toString('utf-8')
        );
        if (msg.method === 'Runtime.evaluate') {
          if (msg.params?.expression === 'throw new Error("mock error")') {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: {
                  result: { type: 'undefined' },
                  exceptionDetails: { text: 'Uncaught Error: mock error' },
                },
              })
            );
          } else if (msg.params?.expression === '1') {
            // 心跳
            ws.send(
              JSON.stringify({ id: msg.id, result: { result: { type: 'number', value: 1 } } })
            );
          } else {
            ws.send(
              JSON.stringify({
                id: msg.id,
                result: { result: { type: 'string', value: 'evaluated_ok' } },
              })
            );
          }
        } else if (msg.method === 'Input.dispatchKeyEvent') {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        } else {
          ws.send(JSON.stringify({ id: msg.id, result: {} }));
        }
      });
    });
  });

  afterAll(async () => {
    for (const client of wss.clients) {
      client.terminate();
    }
    wss.close();
    await new Promise<void>(resolve => httpServer.close(() => resolve()));
  });

  it('connect 应成功探测 Target 并建立 WebSocket 连接', async () => {
    const client = new CdpClient({
      url: `http://127.0.0.1:${port}`,
      pageMatch: 'renderer.html',
      heartbeatIntervalMs: 1000,
    });

    const statusList: string[] = [];
    client.on('status', s => statusList.push(s));

    expect(client.getStatus()).toBe('disconnected');
    await client.connect();
    expect(client.getStatus()).toBe('connected');
    expect(client.getUptimeMs()).toBeGreaterThanOrEqual(0);
    expect(statusList).toContain('connecting');
    expect(statusList).toContain('connected');

    await client.disconnect();
    expect(client.getStatus()).toBe('disconnected');
  });

  it('Target 匹配失败时应抛出 CdpError', async () => {
    const client = new CdpClient({
      url: `http://127.0.0.1:${port}`,
      pageMatch: 'non_existent_page.html',
    });

    await expect(client.connect()).rejects.toThrow(CdpError);
    expect(client.getStatus()).toBe('disconnected');
  });

  it('evaluate 应正确返回求值结果', async () => {
    const client = new CdpClient({
      url: `http://127.0.0.1:${port}`,
      pageMatch: 'renderer.html',
    });

    await client.connect();
    const result = await client.evaluate<string>('document.title');
    expect(result).toBe('evaluated_ok');

    await client.disconnect();
  });

  it('evaluate 执行异常时应抛出包含错误详情的 CdpError', async () => {
    const client = new CdpClient({
      url: `http://127.0.0.1:${port}`,
      pageMatch: 'renderer.html',
    });

    await client.connect();
    await expect(client.evaluate('throw new Error("mock error")')).rejects.toThrow(
      'Uncaught Error: mock error'
    );

    await client.disconnect();
  });

  it('dispatchKeyEvent 应正常执行并返回', async () => {
    const client = new CdpClient({
      url: `http://127.0.0.1:${port}`,
      pageMatch: 'renderer.html',
    });

    await client.connect();
    await expect(
      client.dispatchKeyEvent({
        type: 'keyDown',
        key: 'v',
        code: 'KeyV',
      })
    ).resolves.toBeUndefined();

    await client.disconnect();
  });
});
