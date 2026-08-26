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
});
