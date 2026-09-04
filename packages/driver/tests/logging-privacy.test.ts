import EventEmitter from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import type { CdpClient } from '../src/cdp/client.js';
import { KK9Driver } from '../src/driver.js';
import type { ConnectionStatus, KK9Message, KK9Session } from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';

const { capturedLogs, createChildLogger } = vi.hoisted(() => {
  const capturedLogs: Array<{ level: string; args: unknown[] }> = [];
  const record = (level: string, args: unknown[]): void => {
    capturedLogs.push({ level, args });
  };
  const logger = {
    debug: (...args: unknown[]) => record('debug', args),
    info: (...args: unknown[]) => record('info', args),
    warn: (...args: unknown[]) => record('warn', args),
    error: (...args: unknown[]) => record('error', args),
  };
  return { capturedLogs, createChildLogger: vi.fn(() => logger) };
});

vi.mock('../src/utils/logger.js', () => ({
  logger: createChildLogger(),
  createChildLogger,
}));

type CapturedLog = (typeof capturedLogs)[number];

class MockCdpClient extends EventEmitter {
  private status: ConnectionStatus = 'connected';
  public evaluateResult: unknown = { ok: true, busFound: true };

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getConnectionIdentity(): null {
    return null;
  }

  public connect(): Promise<void> {
    this.status = 'connected';
    return Promise.resolve();
  }

  public disconnect(): Promise<void> {
    this.status = 'disconnected';
    return Promise.resolve();
  }

  public sendCommand<T = unknown>(_method: string, _params?: Record<string, unknown>): Promise<T> {
    return Promise.resolve({} as T);
  }

  public evaluate<T = unknown>(_script: string): Promise<T> {
    return Promise.resolve(this.evaluateResult as T);
  }

  public triggerBinding(name: string, payload: unknown): void {
    const payloadString = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('Runtime.bindingCalled', { name, payload: payloadString });
  }
}

const pollingSession: KK9Session = {
  id: 'session-polling-213',
  name: '隐私测试会话',
  type: 'private',
  unread: true,
};

function createMessage(content: string, overrides: Partial<KK9Message> = {}): KK9Message {
  return {
    id: 'native-message-213',
    messageId: 'message-213',
    sessionId: 'session-message-213',
    sessionName: '隐私测试会话',
    sessionType: 'private',
    origin: 'external',
    direction: 'inbound',
    sender: '测试成员',
    senderId: 'employee-213',
    content,
    time: '12:00:00',
    isMe: false,
    timestamp: 1_780_000_000_000,
    messageType: 'text',
    raw: {
      content,
      attachmentText: content,
    },
    ...overrides,
  };
}

function getLog(level: string, message: string): CapturedLog | undefined {
  return capturedLogs.find(log => {
    const lastArgument = log.args[log.args.length - 1];
    return log.level === level && lastArgument === message;
  });
}

function getLogFields(log: CapturedLog | undefined): Record<string, unknown> {
  const fields = log?.args[0];
  return fields && typeof fields === 'object' ? (fields as Record<string, unknown>) : {};
}

function serializeCapturedLogs(): string {
  return JSON.stringify(capturedLogs, (_key: string, value: unknown): unknown => {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    return value;
  });
}

async function createConnectedEventBridge(): Promise<{
  bridge: KK9EventBridge;
  cdp: MockCdpClient;
}> {
  const cdp = new MockCdpClient();
  const bridge = new KK9EventBridge(
    {
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
      bindingName: '__kairo_native_bridge',
      maxMessageIds: 100,
      currentUserId: 'bot-213',
    },
    cdp as unknown as CdpClient
  );
  await bridge.connect();
  capturedLogs.length = 0;
  return { bridge, cdp };
}

describe('Issue #213 日志隐私回归测试', () => {
  beforeEach(() => {
    capturedLogs.length = 0;
    vi.clearAllMocks();
  });

  it('轮询消息日志不包含消息正文', async () => {
    const sensitiveContent = '轮询正文隐私标记-213-A';
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });
    const internals = getDriverTestInternals(driver);
    const message = createMessage(sensitiveContent, {
      id: 'polling-message-213',
      messageId: 'polling-native-message-213',
      sessionId: pollingSession.id,
      messageType: 'file',
    });
    internals.bridgeMessageOps.getRecentMessagesResult = vi
      .fn()
      .mockResolvedValue({ kind: 'ok', value: [message] });

    await internals.collectAndEmitMessages(pollingSession, 1);

    const log = getLog('debug', '捕获新消息并触发事件');
    expect(log).toBeDefined();
    expect(serializeCapturedLogs()).not.toContain(sensitiveContent);
  });

  it('EventBridge 消息日志不包含文本正文', async () => {
    const sensitiveContent = 'EventBridge 富文本隐私标记-213-B';
    const { bridge, cdp } = await createConnectedEventBridge();
    const received: KK9Message[] = [];
    bridge.on('message', message => received.push(message));

    cdp.triggerBinding('__kairo_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'event-message-213',
        messageId: 'event-native-message-213',
        sessionId: 'event-session-213',
        sender: '测试成员',
        content: sensitiveContent,
        messageType: sensitiveContent,
        richText: { html: `<p>${sensitiveContent}</p>` },
        isMe: false,
      },
    });

    const log = getLog('debug', '原生事件桥接收到新消息');
    expect(received).toHaveLength(1);
    expect(received[0]?.content).toBe(sensitiveContent);
    expect(log).toBeDefined();
    expect(serializeCapturedLogs()).not.toContain(sensitiveContent);
  });

  it('非法 payload 日志不包含 raw payload 正文', async () => {
    const sensitiveContent = '非法载荷正文隐私标记-213-C';
    const rawPayload = `{"type":"receive-message","data":{"content":"${sensitiveContent}"`;
    const { cdp } = await createConnectedEventBridge();

    cdp.triggerBinding('__kairo_native_bridge', rawPayload);

    const log = getLog('warn', '收到非 JSON 格式的原生事件载荷');
    expect(log).toBeDefined();
    expect(serializeCapturedLogs()).not.toContain(sensitiveContent);
    expect(serializeCapturedLogs()).not.toContain(rawPayload);
  });

  it('debug 日志不包含消息正文', async () => {
    const sensitiveContent = 'debug 正文隐私标记-213-D';
    const { cdp } = await createConnectedEventBridge();

    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });
    const driverInternals = getDriverTestInternals(driver);
    driverInternals.bridgeMessageOps.getRecentMessagesResult = vi.fn().mockResolvedValue({
      kind: 'ok',
      value: [createMessage(sensitiveContent, { id: 'debug-polling-message-213' })],
    });
    await driverInternals.collectAndEmitMessages(pollingSession, 1);

    cdp.triggerBinding('__kairo_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'debug-event-message-213',
        sessionId: 'debug-event-session-213',
        sender: '测试成员',
        content: sensitiveContent,
        isMe: false,
      },
    });

    const debugLogs = capturedLogs.filter(log => log.level === 'debug');
    expect(debugLogs.length).toBeGreaterThanOrEqual(2);
    expect(serializeCapturedLogs()).not.toContain(sensitiveContent);
  });

  it('日志保留已有消息标识方向和状态', async () => {
    const { cdp } = await createConnectedEventBridge();
    const message = createMessage('仅用于验证结构化字段', {
      id: 'structured-message-213',
      messageId: 'structured-native-message-213',
      sessionId: 'structured-session-213',
    });

    cdp.triggerBinding('__kairo_native_bridge', {
      type: 'receive-message',
      data: {
        id: message.id,
        messageId: message.messageId,
        sessionId: message.sessionId,
        sender: message.sender,
        senderId: message.senderId,
        content: message.content,
        messageType: message.messageType,
        isMe: false,
      },
    });

    const log = getLog('debug', '原生事件桥接收到新消息');
    expect(getLogFields(log)).toMatchObject({
      id: message.messageId,
      messageId: message.messageId,
      sessionId: message.sessionId,
      sender: message.sender,
      direction: 'inbound',
      origin: 'external',
      status: 'received',
    });
  });

  it('日志保留错误类型并仅输出安全摘要', async () => {
    const sensitiveContent = '解析异常正文隐私标记-213-E';
    const rawPayload = `非 JSON 载荷-${sensitiveContent}`;
    const { cdp } = await createConnectedEventBridge();
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      throw new Error(`解析失败：${sensitiveContent}`);
    });

    try {
      cdp.triggerBinding('__kairo_native_bridge', rawPayload);
    } finally {
      parseSpy.mockRestore();
    }

    const log = getLog('warn', '收到非 JSON 格式的原生事件载荷');
    const fields = getLogFields(log);
    expect(fields).toMatchObject({ errorType: 'Error' });
    expect(fields).not.toHaveProperty('payload');
    expect(fields).not.toHaveProperty('err');
    expect(serializeCapturedLogs()).not.toContain(sensitiveContent);
    expect(serializeCapturedLogs()).not.toContain(rawPayload);
  });

  it('正常消息事件行为不因日志修改而改变', async () => {
    const sensitiveContent = '正常事件正文隐私标记-213-F';
    const { bridge, cdp } = await createConnectedEventBridge();
    const received: KK9Message[] = [];
    const mentioned: KK9Message[] = [];
    bridge.on('message', message => received.push(message));
    bridge.on('at', message => mentioned.push(message));

    cdp.triggerBinding('__kairo_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'normal-message-213',
        sessionId: 'normal-session-213',
        sender: '测试成员',
        content: sensitiveContent,
        isMe: false,
        atMe: true,
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: 'normal-message-213',
      sessionId: 'normal-session-213',
      content: sensitiveContent,
      direction: 'inbound',
    });
    expect(mentioned).toHaveLength(1);
    expect(mentioned[0]?.content).toBe(sensitiveContent);
    expect(serializeCapturedLogs()).not.toContain(sensitiveContent);
  });
});
