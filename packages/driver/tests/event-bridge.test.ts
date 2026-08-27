import EventEmitter from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import type { CdpClient } from '../src/cdp/client.js';
import type {
  CdpConnectionIdentity,
  ConnectionStatus,
  KK9Message,
  KK9RecalledEvent,
} from '../src/types/index.js';

class MockCdpClient extends EventEmitter {
  private status: ConnectionStatus = 'disconnected';
  public evaluateResult: unknown = { ok: true, busFound: true };
  public sendCommandMock = vi.fn().mockImplementation((method: string) => {
    if (method === 'Runtime.enable') return Promise.resolve({});
    if (method === 'Runtime.addBinding') return Promise.resolve({});
    return Promise.resolve({});
  });
  public evaluateMock = vi.fn().mockImplementation(() => Promise.resolve(this.evaluateResult));

  public connectionIdentity: CdpConnectionIdentity | null = null;
  public getStatus(): ConnectionStatus {
    return this.status;
  }
  public getConnectionIdentity(): CdpConnectionIdentity | null {
    return this.connectionIdentity;
  }

  public async connect(): Promise<void> {
    this.status = 'connecting';
    this.emit('status', 'connecting');
    this.status = 'connected';
    this.emit('status', 'connected');
    await Promise.resolve();
  }

  public async disconnect(): Promise<void> {
    this.status = 'disconnected';
    this.emit('status', 'disconnected');
    await Promise.resolve();
  }

  public async sendCommand<T = unknown>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<T> {
    if (params !== undefined) {
      return this.sendCommandMock(method, params) as Promise<T>;
    }
    return this.sendCommandMock(method) as Promise<T>;
  }

  public async evaluate<T = unknown>(script: string): Promise<T> {
    return this.evaluateMock(script) as Promise<T>;
  }

  public triggerBinding(name: string, payload: unknown): void {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    this.emit('Runtime.bindingCalled', { name, payload: payloadStr });
  }

  public triggerHeartbeat(uptimeMs: number): void {
    this.emit('heartbeat', uptimeMs);
  }

  public triggerError(err: Error): void {
    this.emit('error', err);
  }

  public async simulateReconnect(): Promise<void> {
    this.status = 'disconnected';
    this.emit('status', 'disconnected');
    this.status = 'connected';
    this.emit('status', 'connected');
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
  }
}

describe('KK9EventBridge 原生事件直连桥与同构事件流测试', () => {
  const defaultConfig = {
    cdp: {
      url: 'http://127.0.0.1:9222',
      pageMatch: 'renderer.html',
    },
    bindingName: '__kkbot_native_bridge',
    maxMessageIds: 100,
    currentUserId: '10086',
  };

  it('初始化与连接生命周期：正确注入 binding 与 in-browser hook', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);

    expect(bridge.getStatus()).toBe('disconnected');
    expect(bridge.isAttached()).toBe(false);

    const statusEvents: ConnectionStatus[] = [];
    bridge.on('status', s => statusEvents.push(s));

    await bridge.connect();

    expect(bridge.getStatus()).toBe('connected');
    expect(bridge.isAttached()).toBe(true);
    expect(statusEvents).toEqual(['connecting', 'connected']);

    expect(mockCdp.sendCommandMock).toHaveBeenCalledWith('Runtime.enable');
    expect(mockCdp.sendCommandMock).toHaveBeenCalledWith('Runtime.addBinding', {
      name: '__kkbot_native_bridge',
    });
    expect(mockCdp.evaluateMock).toHaveBeenCalled();

    // 再次调用 connect 保持幂等
    await bridge.connect();
    expect(bridge.getStatus()).toBe('connected');

    await bridge.disconnect();
    expect(bridge.getStatus()).toBe('disconnected');
    expect(bridge.isAttached()).toBe(false);
  });

  it('注入结果缺少原生 bus 时拒绝 attached 并报告结构化失效', async () => {
    const mockCdp = new MockCdpClient();
    mockCdp.evaluateResult = { ok: true, busFound: false, sessionsHooked: 0 };
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    const healthEvents: Array<{ kind: string }> = [];
    bridge.on('health', event => healthEvents.push(event));

    await expect(bridge.connect()).rejects.toThrow('EventBridge 注入失败');
    expect(bridge.isAttached()).toBe(false);
    expect(healthEvents.some(event => event.kind === 'event_bridge_invalidated')).toBe(true);
  });

  it('非空 CDP identity 注入后保留 identity 并接收同代首条 binding', async () => {
    const mockCdp = new MockCdpClient();
    const identity: CdpConnectionIdentity = {
      startupGenerationId: 'gen-event-identity-01',
      connectionId: 'connection-event-identity-01',
      targetId: 'target-event-identity-01',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target',
      connectedAt: 1_700_000_000_000,
    };
    mockCdp.connectionIdentity = identity;
    const bridge = new KK9EventBridge(
      { ...defaultConfig, startupGenerationId: identity.startupGenerationId },
      mockCdp as unknown as CdpClient
    );
    await bridge.connect();

    expect(bridge.getConnectionIdentity()).toEqual(identity);
    const received: KK9Message[] = [];
    bridge.on('message', message => received.push(message));
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      generationId: identity.startupGenerationId,
      connectionId: identity.connectionId,
      type: 'receive-message',
      data: {
        id: 'identity-message-01',
        sessionId: 'identity-session-01',
        sender: '员工',
        content: '同代消息',
      },
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe('identity-message-01');
  });
  it('receive-message 事件：解析标准消息并派发 message 事件', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();

    const receivedMessages: KK9Message[] = [];
    bridge.on('message', msg => receivedMessages.push(msg));

    // 模拟来自渲染进程 $bus 的 receive-message 事件
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        session: {
          id: '1-29467',
          name: '技术讨论组',
          type: 1,
        },
        message: {
          id: 'msg-001',
          sender: '李四',
          senderId: '1002',
          content: '大家好，原生事件桥已就绪！',
          sendTime: '10:30:00',
        },
      },
    });

    expect(receivedMessages).toHaveLength(1);
    const msg = receivedMessages[0]!;
    expect(msg.id).toBe('msg-001');
    expect(msg.sessionId).toBe('1-29467');
    expect(msg.sessionName).toBe('技术讨论组');
    expect(msg.sessionType).toBe('group');
    expect(msg.sender).toBe('李四');
    expect(msg.senderId).toBe('1002');
    expect(msg.content).toBe('大家好，原生事件桥已就绪！');
    expect(msg.isMe).toBe(false);
  });

  it('session-msg 批量增量消息：展开派发多条消息', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();

    const receivedMessages: KK9Message[] = [];
    bridge.on('message', msg => receivedMessages.push(msg));

    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'session-msg',
      data: {
        sesUUID: 'ses-uuid-999',
        messages: [
          {
            id: 'msg-batch-1',
            sessionId: '0-3585',
            sessionName: '张三',
            sender: '张三',
            senderId: '1003',
            content: '第一条消息',
            sendTime: '10:31:01',
          },
          {
            id: 'msg-batch-2',
            sessionId: '0-3585',
            sessionName: '张三',
            sender: '张三',
            senderId: '1003',
            content: '第二条消息',
            sendTime: '10:31:02',
          },
        ],
      },
    });

    expect(receivedMessages).toHaveLength(2);
    expect(receivedMessages[0]!.id).toBe('msg-batch-1');
    expect(receivedMessages[0]!.content).toBe('第一条消息');
    expect(receivedMessages[1]!.id).toBe('msg-batch-2');
    expect(receivedMessages[1]!.content).toBe('第二条消息');
  });

  it('自身消息只有显式 operator/bot 事实时才分类来源并派发', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(
      { ...defaultConfig, currentUserId: '10086' },
      mockCdp as unknown as CdpClient
    );
    await bridge.connect();

    const receivedMessages: KK9Message[] = [];
    bridge.on('message', msg => receivedMessages.push(msg));

    // 1. isMe: true (operator 操作员)
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-self-1',
        sessionId: 'session-self-1',
        origin: 'operator',
        sender: '我',
        content: '这是我自己发出的消息',
        isMe: true,
      },
    });

    // 2. senderId 匹配 currentUserId (operator 操作员)
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-self-2',
        sessionId: 'session-self-2',
        origin: 'operator',
        senderId: '10086',
        sender: '机器人自己',
        content: '通过 UID 识别的自身消息',
      },
    });

    // 3. 正常他人消息 (external 外部成员)
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-other-1',
        sessionId: 'session-other-1',
        senderId: '99999',
        sender: '王五',
        content: '这是一条他人发出的消息',
      },
    });

    expect(receivedMessages).toHaveLength(3);
    expect(receivedMessages[0]!.id).toBe('msg-self-1');
    expect(receivedMessages[0]!.origin).toBe('operator');
    expect(receivedMessages[1]!.id).toBe('msg-self-2');
    expect(receivedMessages[1]!.origin).toBe('operator');
    expect(receivedMessages[2]!.id).toBe('msg-other-1');
    expect(receivedMessages[2]!.origin).toBe('external');
  });

  it('按 sessionId 隔离 native messageId，同会话重复只派发一次', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();

    const receivedMessages: KK9Message[] = [];
    bridge.on('message', msg => receivedMessages.push(msg));

    const msgPayload = {
      type: 'receive-message',
      data: {
        id: 'msg-dup-1',
        sessionId: '0-100',
        sender: '赵六',
        content: '内容一致的消息',
        sendTime: '11:00:00',
      },
    };

    mockCdp.triggerBinding('__kkbot_native_bridge', msgPayload);
    mockCdp.triggerBinding('__kkbot_native_bridge', msgPayload);
    mockCdp.triggerBinding('__kkbot_native_bridge', msgPayload);
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-dup-1',
        sessionId: '0-101',
        sender: '赵六',
        content: '另一会话中的同一 native ID',
        sendTime: '11:00:00',
      },
    });

    expect(receivedMessages).toHaveLength(2);
  });

  it('@ 提及检测：精准派发专用的 at 事件', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(
      { ...defaultConfig, currentUserId: '10086' },
      mockCdp as unknown as CdpClient
    );
    await bridge.connect();

    const atEvents: KK9Message[] = [];
    const normalMessages: KK9Message[] = [];

    bridge.on('at', msg => atEvents.push(msg));
    bridge.on('message', msg => normalMessages.push(msg));

    // 1. @ 我 (atMemberIDList 包含 10086)
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-at-1',
        sessionId: 'session-at-1',
        sender: '钱七',
        content: '@机器人 你好',
        atMemberIDList: ['10086'],
      },
    });

    // 2. @ 全体 (atAll: true)
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-at-2',
        sessionId: 'session-at-2',
        sender: '孙八',
        content: '@全体成员 下午开会',
        atAll: true,
      },
    });

    // 3. 普通消息 (不触发 at)
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        id: 'msg-normal-1',
        sessionId: 'session-normal-1',
        sender: '周九',
        content: '普通闲聊',
      },
    });

    expect(normalMessages).toHaveLength(3);
    expect(atEvents).toHaveLength(2);
    expect(atEvents[0]!.id).toBe('msg-at-1');
    expect(atEvents[0]!.atMe).toBe(true);
    expect(atEvents[1]!.id).toBe('msg-at-2');
    expect(atEvents[1]!.atAll).toBe(true);
  });

  it('CancelMessage 原生撤回事件捕获与派发', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();

    const recalledEvents: KK9RecalledEvent[] = [];
    bridge.on('recalled', evt => recalledEvents.push(evt));

    // 1. type === 'recalled' 直达
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'recalled',
      data: {
        msgID: 'msg-to-recall-1',
        sessionId: '0-3585',
        sender: '张三',
      },
    });

    // 2. receive-message 中携带 CancelMessage 事件
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        event: 'CancelMessage',
        msgID: 'msg-to-recall-2',
        sessionID: '1-29467',
        senderName: '管理员',
      },
    });

    // 3. receive-message.message 数组中嵌套 Event 撤回消息（KK9 生产真实载荷格式）
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'receive-message',
      data: {
        session: { id: '0-7783', sesUUID: '0-7783', name: '王五' },
        message: [
          {
            id: 'msg-to-recall-3',
            contentType: 6,
            content: JSON.stringify({
              event: 'CancelMessage',
              msgID: 'msg-to-recall-3',
              byAdmin: 0,
            }),
            sessionID: '0-7783',
            sender: '王五',
          },
        ],
      },
    });

    // 4. 重复撤回事件（去重）
    mockCdp.triggerBinding('__kkbot_native_bridge', {
      type: 'recalled',
      data: {
        messageId: 'msg-to-recall-1',
        sessionId: '0-3585',
        sender: '张三',
      },
    });

    expect(recalledEvents).toHaveLength(3);
    expect(recalledEvents[0]!.messageId).toBe('msg-to-recall-1');
    expect(recalledEvents[0]!.sessionId).toBe('0-3585');
    expect(recalledEvents[0]!.sender).toBe('张三');

    expect(recalledEvents[1]!.messageId).toBe('msg-to-recall-2');
    expect(recalledEvents[1]!.sessionId).toBe('1-29467');
    expect(recalledEvents[1]!.sender).toBe('管理员');

    expect(recalledEvents[2]!.messageId).toBe('msg-to-recall-3');
    expect(recalledEvents[2]!.sessionId).toBe('0-7783');
    expect(recalledEvents[2]!.sender).toBe('王五');
  });

  it('连接重新建立时不应在当前进程自动 reattach', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();

    const initialEvaluateCount = mockCdp.evaluateMock.mock.calls.length;

    await mockCdp.simulateReconnect();

    expect(mockCdp.evaluateMock.mock.calls.length).toBe(initialEvaluateCount);
    expect(bridge.isAttached()).toBe(false);
  });

  it('同一代同一连接重复 reattach 不重复注入 Hook', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();
    const initialEvaluateCount = mockCdp.evaluateMock.mock.calls.length;

    await expect(bridge.reattach()).resolves.toBe(true);

    expect(mockCdp.evaluateMock.mock.calls.length).toBe(initialEvaluateCount);
  });
  it('心跳转发与畸变数据容错', async () => {
    const mockCdp = new MockCdpClient();
    const bridge = new KK9EventBridge(defaultConfig, mockCdp as unknown as CdpClient);
    await bridge.connect();

    let capturedUptime = 0;
    bridge.on('heartbeat', uptime => {
      capturedUptime = uptime;
    });

    mockCdp.triggerHeartbeat(12345);
    expect(capturedUptime).toBe(12345);

    // 传入非 JSON 畸变字符串不应崩溃
    expect(() => {
      mockCdp.triggerBinding('__kkbot_native_bridge', 'INVALID_JSON_STRING');
    }).not.toThrow();

    // 传入非对应 bindingName 不应处理
    expect(() => {
      mockCdp.triggerBinding('other_binding', { type: 'test' });
    }).not.toThrow();
  });
});
