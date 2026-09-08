import { createServer } from 'node:http';
import { CdpClient, createChildLogger, setDriverLogSink } from '@kairo/driver';
import { afterEach, describe, expect, it } from 'vitest';
import { createDriverLogSink, createLogger } from '../../src/modules/operability/logger.js';

afterEach(() => setDriverLogSink(undefined));

describe('T17 Driver 与应用日志接入', () => {
  it('实际 CDP 探测失败保留内存诊断，应用输出只有稳定状态和关联 ID', async () => {
    const secret = '禁止进入日志的客户端凭证和标题';
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify([{ type: 'page', title: secret, url: `file:///${secret}` }]));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('无法取得本机测试端口');
    let logs = '';
    setDriverLogSink(
      createDriverLogSink(
        createLogger({
          write: line => {
            logs += line;
          },
        })
      )
    );
    const client = new CdpClient(
      { url: `http://127.0.0.1:${address.port}`, pageMatch: '不存在的目标页面' },
      { startupGenerationId: 'driver-log-generation' }
    );
    try {
      await expect(client.connect()).rejects.toThrow(secret);
      const records = logs
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>);
      expect(records).toContainEqual({
        level: 50,
        time: expect.any(Number),
        event: 'Driver连接状态',
        runId: 'driver-log-generation',
        status: 'down',
        errorType: 'driver',
      });
      expect(logs).not.toContain(secret);
      expect(logs).not.toContain('file:///');
      expect(logs).not.toContain('stack');
    } finally {
      await client.disconnect();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  });

  it('安装前创建的日志也进入应用出口，发送不明不会变为确定失败', () => {
    const earlyLogger = createChildLogger('提前创建的日志');
    let logs = '';
    setDriverLogSink(
      createDriverLogSink(
        createLogger({
          write: line => {
            logs += line;
          },
        })
      )
    );
    earlyLogger.error(
      {
        event: 'Driver发送结果',
        status: 'unknown',
        errorType: 'send_unknown',
        sessionId: '0-employee-log-test',
        messageId: 'message-log-test',
        password: '禁止输出的密码',
        error: new Error('禁止输出的发送正文'),
      },
      '禁止输出的自由消息'
    );
    expect(JSON.parse(logs)).toEqual({
      level: 50,
      time: expect.any(Number),
      event: 'Driver发送结果',
      sessionId: '0-employee-log-test',
      messageId: 'message-log-test',
      status: 'unknown',
      errorType: 'send_unknown',
    });
    expect(logs).not.toContain('禁止输出');
  });
});
