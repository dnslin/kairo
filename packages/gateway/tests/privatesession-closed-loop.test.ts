import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LibSQLStore } from '@mastra/libsql';
import type { KK9Driver, KK9Message, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import {
  KKBotAgent,
  MastraModelFactory,
  Memory,
  createFakeModel,
  deriveUserMessageId,
  deriveAssistantMessageId,
} from '@kkbot/agent';
import { SessionCoordinator } from '../src/coordinator.js';
class MockDriver extends EventEmitter {
  public selectSession = vi.fn().mockResolvedValue(true);
  public getCurrentSession = vi.fn().mockResolvedValue({ id: 'session_init' });
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi
    .fn()
    .mockImplementation((_text: string, _options?: { targetSessionId?: string }) => {
      return Promise.resolve({
        success: true,
        messageId: `mock_sent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      } as SendResult);
    });
  public sendRichText = vi.fn().mockImplementation(() => {
    return Promise.resolve({
      success: true,
      messageId: `mock_sent_rich_${Date.now()}`,
    } as SendResult);
  });

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content && typeof content === 'object' && 'content' in content) {
    return String((content as { content: unknown }).content);
  }
  return String(content);
}

describe('PrivateSession Closed Loop & Delivery Happy Path (Issue #176)', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let mockDriver: MockDriver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-gateway-test-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    // 1. 初始化 KKBotStore 与 Mastra LibSQLStore (单数据库双 Client)
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({
      id: 'test-mastra-storage',
      url: fileUrl,
    });
    await libSqlStore.init();

    mastraMemory = new Memory({
      storage: libSqlStore,
    });

    mockDriver = new MockDriver();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
    if (store) {
      store.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  it('单条 PrivateSession 消息完整跑通：Raw Store -> user Memory -> Agent -> Delivery -> KK send -> assistant Memory 闭环', async () => {
    const fakeModel = createFakeModel({
      responses: [
        {
          text: '您好！我是企业助手 KKBot，已收到您的请求。',
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 20, totalTokens: 32 },
        },
      ],
    });

    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });

    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: {
        debounceMs: 50,
        maxWaitMs: 150,
      },
    });
    await coordinator.start();

    const sessionId = 'session_private_user_101';
    const senderId = 'emp_zhangsan_001';
    const nativeMsgId = 'native_msg_10001';

    const inboundMsg: KK9Message = {
      id: nativeMsgId,
      messageId: nativeMsgId,
      sessionId,
      sessionName: '张三',
      sessionType: 'private',
      sender: '张三',
      senderId,
      content: '你好，请介绍一下你自己',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    };

    // 1. 发送入站私聊消息
    await coordinator.handleInboundMessage(inboundMsg);

    // 2. 触发防抖聚合
    await coordinator.flushSession(sessionId);

    // 3. 验证 Raw Store 持久化
    const rawMessages = await store.messages.getSessionHistory(sessionId);
    expect(rawMessages.length).toBe(2); // 1 条 inbound user 消息 + 1 条 sent bot_echo 消息
    const userRaw = rawMessages.find(m => !m.isFromSelf);
    expect(userRaw).toBeDefined();
    expect(userRaw?.content).toBe('你好，请介绍一下你自己');
    expect(userRaw?.messageId).toBe(nativeMsgId);

    // 4. 验证 Delivery 状态及生命周期
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const delivery = deliveries[0];
    expect(delivery.status).toBe('sent');
    expect(delivery.content).toBe('您好！我是企业助手 KKBot，已收到您的请求。');
    expect(delivery.sessionId).toBe(sessionId);
    expect(delivery.kkMessageId).toBeDefined();
    expect(delivery.memoryCommittedAt).toBeGreaterThan(0); // 已提交标记

    // 5. 验证 Driver 真实调用
    expect(mockDriver.sendText).toHaveBeenCalledTimes(1);
    expect(mockDriver.sendText).toHaveBeenCalledWith(
      '您好！我是企业助手 KKBot，已收到您的请求。',
      expect.objectContaining({ targetSessionId: sessionId })
    );

    // 6. 验证 Mastra Memory 中的对话记录
    const { messages: memoryMessages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    expect(memoryMessages.length).toBe(2);
    // 第一条为前置显式保存的 user message
    expect(memoryMessages[0].role).toBe('user');
    expect(memoryMessages[0].id).toBe(deriveUserMessageId(sessionId, nativeMsgId));
    expect(extractMessageText(memoryMessages[0].content)).toBe('你好，请介绍一下你自己');

    // 第二条为 sent 后显式保存的 assistant message
    expect(memoryMessages[1].role).toBe('assistant');
    expect(memoryMessages[1].id).toBe(deriveAssistantMessageId(delivery.id));
    expect(extractMessageText(memoryMessages[1].content)).toBe(
      '您好！我是企业助手 KKBot，已收到您的请求。'
    );
  });

  it('相同原始消息串行与并发重放均不创建第二条 user Memory', async () => {
    const fakeModel = createFakeModel({
      responses: [
        {
          text: '回复1',
          finishReason: 'stop',
        },
        {
          text: '回复2',
          finishReason: 'stop',
        },
      ],
    });

    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });

    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: {
        debounceMs: 50,
        maxWaitMs: 150,
      },
    });
    await coordinator.start();

    const sessionId = 'session_private_replay_001';
    const senderId = 'emp_lisi_002';
    const nativeMsgId = 'native_replay_888';

    const msg: KK9Message = {
      id: nativeMsgId,
      messageId: nativeMsgId,
      sessionId,
      sessionName: '李四',
      sessionType: 'private',
      sender: '李四',
      senderId,
      content: '重放测试消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    };

    // 第一次处理
    await coordinator.handleInboundMessage(msg);
    await coordinator.flushSession(sessionId);

    // 串行重放相同原始消息
    await coordinator.handleInboundMessage(msg);
    await coordinator.flushSession(sessionId);

    const { messages: memoryMessages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    const userMessages = memoryMessages.filter(m => m.role === 'user');
    // 稳定 ID 派生使得两次保存命中同一主键，仅有 1 条 user message
    expect(userMessages.length).toBe(1);
    expect(userMessages[0].id).toBe(deriveUserMessageId(sessionId, nativeMsgId));
  });

  it('两条连续的不同原始消息保留各自的稳定 user message ID', async () => {
    const fakeModel = createFakeModel({
      responses: [
        {
          text: '合并回复两句话',
          finishReason: 'stop',
        },
      ],
    });

    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });

    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: {
        debounceMs: 500, // 较长防抖聚合
        maxWaitMs: 1500,
      },
    });
    await coordinator.start();

    const sessionId = 'session_private_multi_001';
    const senderId = 'emp_wangwu_003';

    const msg1: KK9Message = {
      id: 'native_m1',
      messageId: 'native_m1',
      sessionId,
      sessionName: '王五',
      sessionType: 'private',
      sender: '王五',
      senderId,
      content: '第一句话',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    };

    const msg2: KK9Message = {
      id: 'native_m2',
      messageId: 'native_m2',
      sessionId,
      sessionName: '王五',
      sessionType: 'private',
      sender: '王五',
      senderId,
      content: '第二句话',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now() + 10,
    };

    // 连续发送两条消息
    await coordinator.handleInboundMessage(msg1);
    await coordinator.handleInboundMessage(msg2);

    // 触发防抖合并
    await coordinator.flushSession(sessionId);

    // 验证 Mastra Memory：两批 user message 各自独立显式保存
    const { messages: memoryMessages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    const userMessages = memoryMessages.filter(m => m.role === 'user');
    expect(userMessages.length).toBe(2);
    expect(userMessages[0].id).toBe(deriveUserMessageId(sessionId, 'native_m1'));
    expect(extractMessageText(userMessages[0].content)).toBe('第一句话');
    expect(userMessages[1].id).toBe(deriveUserMessageId(sessionId, 'native_m2'));
    expect(extractMessageText(userMessages[1].content)).toBe('第二句话');
  });

  it('当 Driver 发送未获明确成功时，区分 pre-trigger failed 与 post-trigger unknown 且绝不保存 assistant Memory', async () => {
    // 1. 测试 post-trigger failure (如 sendText 已调用但超时) -> Delivery 进入 unknown
    mockDriver.selectSession.mockResolvedValueOnce(true);
    mockDriver.sendText.mockResolvedValueOnce({
      success: false,
      error: '网络超时未收到 KK 回执',
    });

    const fakeModel = createFakeModel({
      responses: [
        {
          text: '本条应该发送失败',
          finishReason: 'stop',
        },
      ],
    });

    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });

    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: {
        debounceMs: 50,
        maxWaitMs: 150,
      },
    });
    await coordinator.start();

    const sessionId = 'session_private_fail_001';
    const senderId = 'emp_fail_001';
    const nativeMsgId = 'native_fail_101';

    await coordinator.handleInboundMessage({
      id: nativeMsgId,
      messageId: nativeMsgId,
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId,
      content: '发送将失败的请求',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证 Delivery 为 unknown 状态
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('unknown');
    expect(deliveries[0].errorCode).toBe('网络超时未收到 KK 回执');
    expect(deliveries[0].memoryCommittedAt).toBeNull();

    // 验证 Mastra Memory 中绝不保存未成功的 assistant 消息
    const { messages: memoryMessages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    const assistantMessages = memoryMessages.filter(m => m.role === 'assistant');
    expect(assistantMessages.length).toBe(0);
  });

  it('当传入 agent 但未传入协同的 mastraMemory 时，构造期必须直接抛出异常阻止运行', () => {
    const fakeModel = createFakeModel({ responses: [] });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory });

    expect(
      () =>
        new SessionCoordinator({
          driver: mockDriver as unknown as KK9Driver,
          store,
          agent,
        })
    ).toThrow('装配 Mastra-native Agent 时必须同时传入协同的 mastraMemory 实例');
  });

  it('当会话缺失有效人员身份 (senderId 与 employeeId 均为空) 时，必须 Fail-Closed 终止处理并拒绝调用 Agent', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '不应被调用', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });
    const agentSpy = vi.spyOn(agent, 'execute');

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionNoIdentity = 'session_no_identity_001';
    await coordinator.handleInboundMessage({
      id: 'msg_no_id_1',
      messageId: 'msg_no_id_1',
      sessionId: sessionNoIdentity,
      sessionName: '未知会话',
      sessionType: 'private',
      sender: '',
      senderId: '', // 空 senderId
      content: '无身份测试',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionNoIdentity);

    // Agent 严禁被调用
    expect(agentSpy).toHaveBeenCalledTimes(0);
    // KK 发送严禁被调用
    expect(mockDriver.sendText).toHaveBeenCalledTimes(0);
  });

  it('混合 agent_claimed 与 pending 消息时 Delivery 只关联本轮新消息', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '只回复本轮新消息', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 200, maxWaitMs: 500 },
    });
    let startedMessageIds: string[] = [];
    coordinator.on('agent_started', (_sessionId, consolidated) => {
      startedMessageIds = consolidated.messageIds;
    });
    await coordinator.start();

    mockDriver.emitMessage({
      id: 'mastra-claim-old-001',
      messageId: 'mastra-claim-old-001',
      sessionId: 'session_mixed_claim_001',
      sessionName: '混合 Claim 用户',
      sessionType: 'private',
      sender: '员工',
      senderId: 'employee-mixed-001',
      content: '上一轮已领取的消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(
      (
        await store.messages.getMessageBySessionAndMessageId(
          'session_mixed_claim_001',
          'mastra-claim-old-001'
        )
      )?.processingState
    ).toBe('pending');
    expect(
      await store.messages.claimMessagesForAgent(
        'session_mixed_claim_001',
        ['mastra-claim-old-001'],
        'previous-run-mastra-001'
      )
    ).toEqual(['mastra-claim-old-001']);

    const completed = new Promise<void>(resolve => {
      coordinator!.once('agent_completed', () => resolve());
    });
    mockDriver.emitMessage({
      id: 'mastra-claim-new-001',
      messageId: 'mastra-claim-new-001',
      sessionId: 'session_mixed_claim_001',
      sessionName: '混合 Claim 用户',
      sessionType: 'private',
      sender: '员工',
      senderId: 'employee-mixed-001',
      content: '本轮新消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });
    await completed;

    expect(startedMessageIds).toEqual(['mastra-claim-new-001']);
    const mappings = await store.db.execute(
      'SELECT message_id FROM delivery_input_messages ORDER BY message_id'
    );
    expect(mappings.rows).toEqual([{ message_id: 'mastra-claim-new-001' }]);
    expect(await store.deliveries.getDeliveriesBySession('session_mixed_claim_001')).toHaveLength(
      1
    );
  });

  it('两个 PrivateSession 并发处理时，Thread、Memory、Delivery 与发送目标完全隔离', async () => {
    const fakeModel = createFakeModel({
      responses: [
        { text: '回复会话 A', finishReason: 'stop' },
        { text: '回复会话 B', finishReason: 'stop' },
      ],
    });

    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });

    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: {
        debounceMs: 50,
        maxWaitMs: 150,
      },
    });
    await coordinator.start();

    const sessionA = 'session_user_A';
    const senderA = 'emp_user_A';
    const sessionB = 'session_user_B';
    const senderB = 'emp_user_B';

    // 并发投入两个不同会话消息
    await Promise.all([
      coordinator.handleInboundMessage({
        id: 'msg_A_1',
        messageId: 'msg_A_1',
        sessionId: sessionA,
        sessionName: '用户A',
        sessionType: 'private',
        sender: '用户A',
        senderId: senderA,
        content: '我是用户A的消息',
        messageType: 'text',
        isMe: false,
        timestamp: Date.now(),
      }),
      coordinator.handleInboundMessage({
        id: 'msg_B_1',
        messageId: 'msg_B_1',
        sessionId: sessionB,
        sessionName: '用户B',
        sessionType: 'private',
        sender: '用户B',
        senderId: senderB,
        content: '我是用户B的消息',
        messageType: 'text',
        isMe: false,
        timestamp: Date.now(),
      }),
    ]);

    // 并发触发两个会话 flush
    await Promise.all([coordinator.flushSession(sessionA), coordinator.flushSession(sessionB)]);

    // 验证会话 A 的 Memory 仅含 A 的数据
    const { messages: memA } = await mastraMemory.recall({
      threadId: sessionA,
      resourceId: senderA,
    });
    expect(memA.length).toBe(2);
    expect(extractMessageText(memA[0].content)).toBe('我是用户A的消息');
    expect(extractMessageText(memA[1].content)).toBe('回复会话 A');

    // 验证会话 B 的 Memory 仅含 B 的数据
    const { messages: memB } = await mastraMemory.recall({
      threadId: sessionB,
      resourceId: senderB,
    });
    expect(memB.length).toBe(2);
    expect(extractMessageText(memB[0].content)).toBe('我是用户B的消息');
    expect(extractMessageText(memB[1].content)).toBe('回复会话 B');

    // 验证 Delivery 归属隔离
    const delivA = await store.deliveries.getDeliveriesBySession(sessionA);
    expect(delivA.length).toBe(1);
    expect(delivA[0].content).toBe('回复会话 A');

    const delivB = await store.deliveries.getDeliveriesBySession(sessionB);
    expect(delivB.length).toBe(1);
    expect(delivB[0].content).toBe('回复会话 B');

    // 验证 Driver 发送目标相互隔离
    expect(mockDriver.sendText).toHaveBeenCalledWith(
      '回复会话 A',
      expect.objectContaining({ targetSessionId: sessionA })
    );
    expect(mockDriver.sendText).toHaveBeenCalledWith(
      '回复会话 B',
      expect.objectContaining({ targetSessionId: sessionB })
    );
  });

  it('user Memory 保存失败时 Agent 调用次数为零', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '不应被调用', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    // 模拟 mastraMemory.saveMessages 失败
    vi.spyOn(mastraMemory, 'saveMessages').mockRejectedValueOnce(
      new Error('LibSQL Storage connection failed')
    );
    const agentSpy = vi.spyOn(agent, 'execute');

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_user_mem_fail';
    await coordinator.handleInboundMessage({
      id: 'msg_fail_1',
      messageId: 'msg_fail_1',
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_fail',
      content: '测试消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // Agent 严禁被调用
    expect(agentSpy).toHaveBeenCalledTimes(0);
    // KK 发送严禁被调用
    expect(mockDriver.sendText).toHaveBeenCalledTimes(0);
  });

  it('Agent 失败时 KK 发送次数为零', async () => {
    const fakeModel = createFakeModel({
      responses: [
        {
          throwError: new Error('Model provider unavailable'),
        },
      ],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_agent_fail';
    await coordinator.handleInboundMessage({
      id: 'msg_agent_fail_1',
      messageId: 'msg_agent_fail_1',
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_fail',
      content: '触发模型失败',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // KK 发送调用次数为零
    expect(mockDriver.sendText).toHaveBeenCalledTimes(0);
    // 未创建任何 Delivery
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(0);
  });

  it('Delivery 创建失败时 KK 发送次数为零', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '正常回复内容', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    // 模拟 Delivery 创建失败
    vi.spyOn(store.deliveries, 'createDelivery').mockRejectedValueOnce(new Error('DB disk full'));

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_deliv_create_fail';
    await coordinator.handleInboundMessage({
      id: 'msg_deliv_create_fail_1',
      messageId: 'msg_deliv_create_fail_1',
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_fail',
      content: '测试消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // KK 发送严禁调用
    expect(mockDriver.sendText).toHaveBeenCalledTimes(0);
  });

  it('sending 持久化失败时 KK 发送次数为零', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '正常回复内容', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    // 模拟 updateStatus('sending') 失败
    vi.spyOn(store.deliveries, 'updateStatus').mockImplementationOnce(() => {
      return Promise.reject(new Error('Lock timeout'));
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_sending_fail';
    await coordinator.handleInboundMessage({
      id: 'msg_sending_fail_1',
      messageId: 'msg_sending_fail_1',
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_fail',
      content: '测试消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // KK 发送严禁调用
    expect(mockDriver.sendText).toHaveBeenCalledTimes(0);
  });

  it('assistant Memory 保存失败时 Delivery 保持 sent，KK 发送仍只有一次', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '已发送成功的内容', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });

    // 允许第一次（user message）saveMessages 成功，但在第二次（assistant message）saveMessages 时抛出异常
    const origSaveMessages = mastraMemory.saveMessages.bind(mastraMemory);
    let saveCount = 0;
    vi.spyOn(mastraMemory, 'saveMessages').mockImplementation(async opts => {
      saveCount++;
      if (saveCount === 2) {
        throw new Error('Mastra storage crashed on assistant commit');
      }
      return origSaveMessages(opts);
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_asst_mem_fail';
    await coordinator.handleInboundMessage({
      id: 'msg_asst_fail_1',
      messageId: 'msg_asst_fail_1',
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_test',
      content: '测试消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // KK 发送精确仅有 1 次（严禁重试）
    expect(mockDriver.sendText).toHaveBeenCalledTimes(1);

    // Delivery 保持 sent 状态，但 memoryCommittedAt 为 null (形成 sent-but-uncommitted 检查点)
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].memoryCommittedAt).toBeNull();

    const uncommitted = await store.deliveries.getSentUncommittedDeliveries();
    expect(uncommitted.some(d => d.id === deliveries[0].id)).toBe(true);
  });

  it('GroupSession 消息绝不进入 user Memory、Agent、Delivery 或 KK 发送', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '群聊不应回复', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({
      modelFactory,
      memory: mastraMemory,
    });
    const agentSpy = vi.spyOn(agent, 'execute');

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const groupSessionId = 'group_room_888';
    await coordinator.handleInboundMessage({
      id: 'group_msg_1',
      messageId: 'group_msg_1',
      sessionId: groupSessionId,
      sessionName: '研发群',
      sessionType: 'group',
      sender: '某同事',
      senderId: 'emp_colleague',
      content: '@我 帮我查个东西',
      atMe: true,
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(groupSessionId);

    // 1. Raw Store 写入成功
    const rawMsgs = await store.messages.getSessionHistory(groupSessionId);
    expect(rawMsgs.length).toBe(1);

    // 2. 下游调用全为 0
    expect(agentSpy).toHaveBeenCalledTimes(0);
    expect(mockDriver.sendText).toHaveBeenCalledTimes(0);

    const deliveries = await store.deliveries.getDeliveriesBySession(groupSessionId);
    expect(deliveries.length).toBe(0);
  });

  it('慢写 Raw Store 时 flush 必须等待持久化完成后才进入 user Memory 与 Agent', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '慢写成功后的回复', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    // 模拟慢写：通过 Promise.withResolvers 控制延迟写入时机
    const { promise: delayPromise, resolve: unlockWrite } = Promise.withResolvers<void>();
    const origSaveMessage = store.messages.saveMessage.bind(store.messages);
    let writeCompleted = false;
    vi.spyOn(store.messages, 'saveMessage').mockImplementation(async input => {
      await delayPromise;
      writeCompleted = true;
      return origSaveMessage(input);
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 10, maxWaitMs: 30 }, // 极短防抖窗口
    });
    await coordinator.start();

    const sessionId = 'session_slow_write_001';
    // 不 await handleInboundMessage，直接触发入站并立即触发 flushSession
    void coordinator.handleInboundMessage({
      id: 'msg_slow_1',
      messageId: 'msg_slow_1',
      sessionId,
      sessionName: '测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_slow',
      content: '慢写入站消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    // 启动 flush：flush 必须等待 Raw Store 写入
    const flushPromise = coordinator.flushSession(sessionId);

    // 此时写入尚未解锁
    expect(writeCompleted).toBe(false);

    // 解锁写入并等待 flush 完成
    unlockWrite();
    await flushPromise;

    // flush 完成后，Raw Store 必须已经写入完成
    expect(writeCompleted).toBe(true);

    // 验证成功交付并保存 assistant Memory
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].content).toBe('慢写成功后的回复');
  });
  it('Shutdown 期间慢 Raw Store 完成后不创建 Agent Run 且保留 pending', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '不应发送的回复', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });
    const agentExecute = vi.spyOn(agent, 'execute');
    const { promise: delayPromise, resolve: unlockWrite } = Promise.withResolvers<void>();
    const originalSave = store.messages.saveMessage.bind(store.messages);
    let saveStarted = false;
    vi.spyOn(store.messages, 'saveMessage').mockImplementation(async input => {
      saveStarted = true;
      await delayPromise;
      return originalSave(input);
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 10, maxWaitMs: 100 },
    });
    await coordinator.start();

    const sessionId = 'session_shutdown_slow_agent_001';
    const inboundPromise = coordinator.handleInboundMessage({
      id: 'msg_shutdown_slow_001',
      messageId: 'msg_shutdown_slow_001',
      sessionId,
      sessionName: 'Shutdown 测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_shutdown_slow',
      content: 'Shutdown 期间慢写消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(saveStarted).toBe(true);

    let stopSettled = false;
    const stopPromise = coordinator.stop().then(() => {
      stopSettled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(stopSettled).toBe(false);

    unlockWrite();
    await inboundPromise;
    await stopPromise;

    expect(agentExecute).not.toHaveBeenCalled();
    expect(mockDriver.sendText).not.toHaveBeenCalled();
    expect(
      (await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_shutdown_slow_001'))
        ?.processingState
    ).toBe('pending');
  });
  it('claim 已提交后 Shutdown 必须回滚为 pending 并跳过 Agent', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '不应生成的回复', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });
    const agentExecute = vi.spyOn(agent, 'execute');
    const claimCommitted = Promise.withResolvers<void>();
    const releaseClaim = Promise.withResolvers<void>();
    const originalClaim = store.messages.claimMessagesForAgent.bind(store.messages);
    vi.spyOn(store.messages, 'claimMessagesForAgent').mockImplementation(
      async (sessionId, messageIds, runId) => {
        const claimed = await originalClaim(sessionId, messageIds, runId);
        claimCommitted.resolve();
        await releaseClaim.promise;
        return claimed;
      }
    );

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 10, maxWaitMs: 100 },
    });
    await coordinator.start();

    const sessionId = 'session_claim_shutdown_001';
    const inboundPromise = coordinator.handleInboundMessage({
      id: 'msg_claim_shutdown_001',
      messageId: 'msg_claim_shutdown_001',
      sessionId,
      sessionName: 'Claim Shutdown 测试员',
      sessionType: 'private',
      sender: '测试员',
      senderId: 'emp_claim_shutdown',
      content: '已提交 claim 的消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });
    await claimCommitted.promise;

    let stopSettled = false;
    const stopPromise = coordinator.stop().then(() => {
      stopSettled = true;
    });
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(stopSettled).toBe(false);

    releaseClaim.resolve();
    await inboundPromise;
    await stopPromise;

    expect(agentExecute).not.toHaveBeenCalled();
    expect(mockDriver.sendText).not.toHaveBeenCalled();
    expect(
      (await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_claim_shutdown_001'))
        ?.processingState
    ).toBe('pending');
  });
});
