import http from 'node:http';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CdpClient } from '../src/cdp/client.js';
import { CdpError } from '../src/utils/errors.js';
import { setDriverLogSink, type DriverLogEntry } from '../src/utils/logger.js';

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
  it('意外 WebSocket 断线不应在当前进程自动重连', async () => {
    const client = new CdpClient({
      url: `http://127.0.0.1:${port}`,
      pageMatch: 'renderer.html',
      heartbeatIntervalMs: 100_000,
    });
    const statusList: string[] = [];
    const disconnected = Promise.withResolvers<void>();
    client.on('status', status => {
      statusList.push(status);
      if (status === 'disconnected') {
        disconnected.resolve();
      }
    });

    await client.connect();
    const serverSocket = [...wss.clients][0];
    expect(serverSocket).toBeDefined();
    serverSocket?.terminate();
    await disconnected.promise;

    expect(statusList).toContain('disconnected');
    expect(statusList).not.toContain('reconnecting');
    expect(client.getStatus()).toBe('disconnected');
    await client.disconnect();
  });
  it('连接日志只保留状态与启动代次，连接失败仍保留业务错误详情', async () => {
    const entries: DriverLogEntry[] = [];
    setDriverLogSink(entry => entries.push(entry));
    const client = new CdpClient(
      { url: `http://127.0.0.1:${port}`, pageMatch: 'renderer.html' },
      { startupGenerationId: '日志连接代次' }
    );
    try {
      await client.connect();
      await client.disconnect();
      const failedClient = new CdpClient(
        { url: `http://127.0.0.1:${port}`, pageMatch: '测试秘密目标' },
        { startupGenerationId: '日志失败代次' }
      );
      await expect(failedClient.connect()).rejects.toThrow('测试秘密目标');
      expect(entries.filter(entry => entry.event === 'Driver连接状态')).toEqual([
        { level: 'info', event: 'Driver连接状态', status: 'up', runId: '日志连接代次' },
        { level: 'info', event: 'Driver连接状态', status: 'down', runId: '日志连接代次' },
        {
          level: 'error',
          event: 'Driver连接状态',
          status: 'down',
          runId: '日志失败代次',
          errorType: 'driver',
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain('测试秘密目标');
      expect(JSON.stringify(entries)).not.toContain('renderer.html');
      expect(JSON.stringify(entries)).not.toContain('127.0.0.1');
    } finally {
      await client.disconnect();
      setDriverLogSink(undefined);
    }
  });

  it('只转接五条精确Driver渲染诊断，忽略页面正文及附加参数', async () => {
    const entries: DriverLogEntry[] = [];
    const client = new CdpClient(
      { url: `http://127.0.0.1:${port}`, pageMatch: 'renderer.html' },
      { startupGenerationId: '渲染诊断代次' }
    );
    await client.connect();
    setDriverLogSink(entry => entries.push(entry));
    try {
      const connectedSockets = [...wss.clients].filter(socket => socket.readyState === 1);
      const socket = connectedSockets[connectedSockets.length - 1]!;
      const diagnostics = [
        '[KairoDriver] 前序Hook清理异常',
        '[KairoDriver] 事件派发到CDP binding失败',
        '[KairoDriver] 会话摘要更新失败',
        '[KairoDriver] 聊天窗口推送失败',
        '[KairoDriver] Vue滚动列表检查失败',
      ];
      const values = [...diagnostics, 'KK9页面测试秘密', `${diagnostics[0]} 测试秘密后缀`];
      const received = new Promise<void>(resolve => {
        let count = 0;
        client.on('Runtime.consoleAPICalled', () => {
          if (++count === values.length) resolve();
        });
      });
      for (const value of values) {
        socket.send(
          JSON.stringify({
            method: 'Runtime.consoleAPICalled',
            params: {
              type: 'warning',
              args: [
                { type: 'string', value },
                { type: 'object', description: '测试秘密异常正文', objectId: '测试秘密对象' },
              ],
            },
          })
        );
      }
      await received;
      expect(entries).toEqual(
        diagnostics.map((_, index) => ({
          level: index === 1 ? 'error' : 'warn',
          event: 'Driver运行异常',
          errorType: 'driver',
          runId: '渲染诊断代次',
        }))
      );
      expect(JSON.stringify(entries)).not.toContain('测试秘密');
    } finally {
      setDriverLogSink(undefined);
      await client.disconnect();
    }
  });
  it('意外断线输出down但不泄漏WebSocket关闭原因', async () => {
    const entries: DriverLogEntry[] = [];
    const client = new CdpClient(
      { url: `http://127.0.0.1:${port}`, pageMatch: 'renderer.html' },
      { startupGenerationId: '意外断线代次' }
    );
    await client.connect();
    setDriverLogSink(entry => entries.push(entry));
    try {
      const lost = new Promise<void>(resolve => {
        client.once('connection_lost', () => {
          resolve();
        });
      });
      const connectedSockets = [...wss.clients].filter(socket => socket.readyState === 1);
      connectedSockets[connectedSockets.length - 1]!.close(1011, '测试秘密关闭原因');
      await lost;
      expect(client.getStatus()).toBe('disconnected');
      expect(entries).toEqual([
        {
          level: 'warn',
          event: 'Driver连接状态',
          status: 'down',
          errorType: 'driver',
          runId: '意外断线代次',
        },
      ]);
      expect(JSON.stringify(entries)).not.toContain('测试秘密');
    } finally {
      setDriverLogSink(undefined);
      await client.disconnect();
    }
  });
});
