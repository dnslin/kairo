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
} from '@kkbot/agent';
import { SessionCoordinator } from '../src/coordinator.js';

class MockDriver extends EventEmitter {
  public selectSession = vi.fn().mockResolvedValue(true);
  public getCurrentSession = vi.fn().mockResolvedValue({ id: 'session_init' });
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi.fn().mockImplementation((_text: string, _options?: { targetSessionId?: string }) => {
    return Promise.resolve({
      success: true,
      messageId: `mock_sent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      isPreTrigger: false,
    } as SendResult);
  });

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }
}

type ModelParam = Parameters<MastraModelFactory['createModel']>[0];

function createTestAgent(fakeModel: ModelParam, memory: Memory): KKBotAgent {
  const modelFactory = new MastraModelFactory({
    tiers: {
      FAST: { models: [{ model: fakeModel }] },
      DEEP: { models: [{ model: fakeModel }] },
      VISION: { models: [{ model: fakeModel }] },
    },
  });
  return new KKBotAgent({
    modelFactory,
    memory,
  });
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

describe('HumanTakeover 人工操作员接管与 Bot 回显隔离', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let mockDriver: MockDriver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-takeover-test-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });

    libSqlStore = new LibSQLStore({
      id: 'test-takeover-storage',
      url: fileUrl,
    });
    await libSqlStore.init();

    mastraMemory = new Memory({
      storage: libSqlStore,
    });

    mockDriver = new MockDriver();
  });

  afterEach(async () => {
    if (coordinator && coordinator.isRunningCoordinator) {
      await coordinator.stop();
    }
    store.close();
    await libSqlStore.close();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  it('Operator 消息写入 Store 和 Mastra Thread，触发 HumanTakeover 并清空 Pending 自动回复', async () => {
    const model = createFakeModel({
      responses: [{ text: '自动回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 100, maxWaitMs: 400 },
    });
    await coordinator.start();

    const sessionId = 'session_takeover_001';

    // 1. 用户先发送了一条消息，处于防抖排队中
    await coordinator.handleInboundMessage({
      id: 'msg_user_t1',
      sessionId,
      sender: '员工小王',
      senderId: 'emp_wang',
      content: '人工客服在吗？',
      sessionType: 'private',
      isMe: false,
    });

    expect(coordinator.getPendingQueue(sessionId)).toHaveLength(1);

    // 2. 操作员在客户端发送消息 (origin: 'operator') 介入
    await coordinator.handleInboundMessage({
      id: 'msg_op_1',
      sessionId,
      sender: '客服专员',
      senderId: 'emp_operator',
      content: '您好，我是人工客服，正在为您处理',
      sessionType: 'private',
      origin: 'operator',
      isMe: true,
    });
    // 验证: 防抖队列已立即被清空
    expect(coordinator.getPendingQueue(sessionId)).toHaveLength(0);

    // 验证: 会话处于人工退避期
    expect(await coordinator.isTakeoverActive(sessionId)).toBe(true);

    // 验证: Raw Store 记录了 operator 消息事实
    const rawOp = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_op_1');
    expect(rawOp?.origin).toBe('operator');
    expect(rawOp?.isFromSelf).toBe(true);

    // 验证: Mastra Thread 中以自身稳定 ID 写入了 operator 历史 (归属于会话员工 resourceId)
    const { messages } = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_wang' });
    const opMsg = messages.find(m => m.id === deriveUserMessageId(sessionId, 'msg_op_1'));
    expect(opMsg).toBeDefined();
    expect(extractMessageText(opMsg?.content)).toBe('您好，我是人工客服，正在为您处理');
    expect(mockDriver.sendText).not.toHaveBeenCalled();
  });

  it('Bot 回显不被识别为 Operator，不触发 HumanTakeover，不重复入库', async () => {
    const model = createFakeModel({
      responses: [{ text: '机器人正常回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 50, maxWaitMs: 200 },
    });
    await coordinator.start();

    const sessionId = 'session_bot_echo_001';

    // 模拟收到 bot_echo 消息（客户端回显）
    await coordinator.handleInboundMessage({
      id: 'msg_echo_01',
      sessionId,
      sender: '自己',
      content: '之前发出的回显',
      sessionType: 'private',
      origin: 'bot_echo',
      isMe: true,
    });
    // 验证: 不触发人工退避
    expect(await coordinator.isTakeoverActive(sessionId)).toBe(false);

    // 验证: 不会作为新消息产生 pending 队列
    expect(coordinator.getPendingQueue(sessionId)).toHaveLength(0);
  });

  it('HumanTakeover 中断正在运行的自动 Run，并将处于 generated 的 Delivery 设为 aborted', async () => {
    const { promise: modelStarted, resolve: resolveModelStarted } = Promise.withResolvers<void>();
    const model = createFakeModel({
      onGenerate: async (_count, callOptions) => {
        resolveModelStarted();
        const { promise: abortWait, resolve: resolveAborted } = Promise.withResolvers<void>();
        callOptions?.abortSignal?.addEventListener('abort', () => {
          resolveAborted();
        });
        await abortWait;
      },
      responses: [{ text: '不应完成的回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 20, maxWaitMs: 100 },
    });
    await coordinator.start();

    const sessionId = 'session_takeover_run_abort';
    let takeoverAbortFired = false;
    coordinator.on('in_flight_aborted', (sid, _elapsed, reason) => {
      if (sid === sessionId && reason === 'human_takeover') {
        takeoverAbortFired = true;
      }
    });

    // 发送用户消息启动 Run
    mockDriver.emitMessage({
      id: 'msg_u_before_op',
      sessionId,
      sender: '员工',
      senderId: 'emp_usr',
      content: '请帮我写代码',
      sessionType: 'private',
      isMe: false,
    });

    await modelStarted;
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);

    // 操作员发送消息接管
    await coordinator.handleInboundMessage({
      id: 'msg_op_takeover',
      sessionId,
      sender: '客服专员',
      senderId: 'emp_op',
      content: '人工接管中',
      sessionType: 'private',
      origin: 'operator',
      isMe: true,
    });
    expect(takeoverAbortFired).toBe(true);
    expect(coordinator.hasInFlightSession(sessionId)).toBe(false);
  });

  it('已墓碑化的 operator 消息重放时被静默抑制，不中断在途 Run，不触发接管退避且不写入 Mastra Memory', async () => {
    const { promise: modelRunningPromise, resolve: resolveModelRunning } = Promise.withResolvers<void>();
    const { promise: allowModelFinish, resolve: resolveModelFinish } = Promise.withResolvers<void>();

    const model = createFakeModel({
      onGenerate: async () => {
        resolveModelRunning();
        await allowModelFinish;
      },
      responses: [{ text: '正常回复正常请求', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 20, maxWaitMs: 100 },
    });
    const sessionId = 'session_operator_tombstone_active_run';
    const tombstonedOpMsgId = 'msg_op_tomb_active_01';

    // 1. 预先将该 operator 消息持久化合规删除墓碑（在启动前写入，测试跨重启预热与 0ms 栅栏拦截）
    await store.tombstones.recordTombstone({
      sessionId,
      messageId: tombstonedOpMsgId,
      type: 'compliance_deletion',
      operator: 'dpo',
      reason: '合规删除',
    });

    await coordinator.start();
    let takeoverFired = false;
    let inFlightAbortedFired = false;
    coordinator.on('takeover', () => {
      takeoverFired = true;
    });
    coordinator.on('in_flight_aborted', () => {
      inFlightAbortedFired = true;
    });

    // 2. 正常用户发送消息启动在途 Run
    mockDriver.emitMessage({
      id: 'msg_user_active_01',
      sessionId,
      sender: '正常员工',
      senderId: 'emp_user_active',
      content: '请帮我查询天气',
      sessionType: 'private',
      isMe: false,
    });

    // 等待模型开始执行（进入在途状态）
    await modelRunningPromise;
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);

    // 3. 在 Run 执行期间重放已墓碑化的 operator 消息
    await coordinator.handleInboundMessage({
      id: tombstonedOpMsgId,
      sessionId,
      sender: '客服专员',
      senderId: 'emp_op_001',
      content: '已删除的敏感客服发言',
      sessionType: 'private',
      origin: 'operator',
      isMe: true,
    });

    // 关键核心验证 1: 墓碑门禁拦截，绝不中止正在运行的在途 Run
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);
    expect(inFlightAbortedFired).toBe(false);

    // 关键核心验证 2: 绝不触发接管退避事件与人工退避状态
    expect(takeoverFired).toBe(false);
    expect(await coordinator.isTakeoverActive(sessionId)).toBe(false);

    // 4. 允许原在途模型执行完毕并完成正常交付
    resolveModelFinish();
    await new Promise(r => setTimeout(r, 200));

    // 关键核心验证 3: 原始合法 Run 顺利交付，Mastra Thread 中包含合法回复，绝无敏感 operator 内容
    const recall = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_user_active' });
    const messageTexts = recall.messages.map(m => extractMessageText(m.content));
    expect(messageTexts).toContain('正常回复正常请求');
    expect(messageTexts.some(t => t.includes('已删除的敏感客服发言'))).toBe(false);
  });

  it('即使 Store 数据库写入存在阻塞延迟，Operator 介入仍同步 0ms 瞬时切断在途 Run', async () => {
    const { promise: modelStarted, resolve: resolveModelStarted } = Promise.withResolvers<void>();
    const model = createFakeModel({
      onGenerate: async (_count, callOptions) => {
        resolveModelStarted();
        const { promise: abortWait, resolve: resolveAborted } = Promise.withResolvers<void>();
        callOptions?.abortSignal?.addEventListener('abort', () => {
          resolveAborted();
        });
        await abortWait;
      },
      responses: [{ text: '不应完成的回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 20, maxWaitMs: 100 },
    });
    await coordinator.start();

    const sessionId = 'session_takeover_blocked_store';

    // 模拟 Store 消息持久化存在慢延迟阻塞
    let storeBlockedResolve: () => void;
    const storeBlockedPromise = new Promise<void>(r => { storeBlockedResolve = r; });
    const origSave = store.messages.saveMessage.bind(store.messages);
    vi.spyOn(store.messages, 'saveMessage').mockImplementation(async (input) => {
      if (input.origin === 'operator') {
        await storeBlockedPromise;
      }
      return origSave(input);
    });

    let takeoverAbortFired = false;
    coordinator.on('in_flight_aborted', (sid, _elapsed, reason) => {
      if (sid === sessionId && reason === 'human_takeover') {
        takeoverAbortFired = true;
      }
    });

    // 1. 发送用户消息启动 Run
    mockDriver.emitMessage({
      id: 'msg_user_before_slow_op',
      sessionId,
      sender: '员工',
      senderId: 'emp_usr',
      content: '请帮我写代码',
      sessionType: 'private',
      isMe: false,
    });

    await modelStarted;
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);

    // 2. Operator 发送消息（不等待 handleInboundMessage 完成，立即同步断言）
    const opMsgPromise = coordinator.handleInboundMessage({
      id: 'msg_op_slow_takeover',
      sessionId,
      sender: '客服专员',
      senderId: 'emp_op',
      content: '人工接管中',
      sessionType: 'private',
      origin: 'operator',
      isMe: true,
    });

    // 关键核心断言：即使底层的 Store 写入仍在被阻塞 (storeBlockedPromise 尚未 resolve)，在途 Run 已经同步 0ms 被切断！
    expect(takeoverAbortFired).toBe(true);
    expect(coordinator.hasInFlightSession(sessionId)).toBe(false);

    // 释放 Store 阻塞并等待处理完成
    storeBlockedResolve!();
    await opMsgPromise;
  });
});
