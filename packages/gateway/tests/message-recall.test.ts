import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LibSQLStore } from '@mastra/libsql';
import type { KK9Driver, KK9Message, KK9RecalledEvent, SendResult } from '@kkbot/driver';
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

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
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

describe('MessageRecall 消息撤回与活动上下文移除', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let mockDriver: MockDriver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-recall-test-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });

    libSqlStore = new LibSQLStore({
      id: 'test-recall-storage',
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

  it('防抖期撤回从 Pending Bucket 移除消息，不创建 user Memory', async () => {
    const model = createFakeModel({
      responses: [{ text: '正常回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 150, maxWaitMs: 500 },
    });
    await coordinator.start();

    const sessionId = 'session_recall_debounce';
    const msgId = 'msg_to_recall_1';

    // 发送消息入站并进入防抖队列
    await coordinator.handleInboundMessage({
      id: msgId,
      sessionId,
      sender: '孙七',
      senderId: 'emp_sunqi',
      content: '发错的内容，马上撤回',
      sessionType: 'private',
      isMe: false,
    });

    expect(coordinator.getPendingQueue(sessionId)).toHaveLength(1);

    // 在防抖期内发出撤回事件
    await coordinator.handleRecalled({
      sessionId,
      messageId: msgId,
      sender: '孙七',
    });

    // 等待防抖计时器自然超时
    await new Promise(r => setTimeout(r, 200));

    // 验证 1: Raw Store 保留了原消息且标记为 is_recalled = 1
    const raw = await store.messages.getMessageBySessionAndMessageId(sessionId, msgId);
    expect(raw).toBeDefined();
    expect(raw?.isRecalled).toBe(true);
    expect(raw?.content).toBe('发错的内容，马上撤回');

    // 验证 2: Mastra Memory 中绝不包含该被撤回消息的 user Memory (Thread 尚未创建或为空)
    const thread = await mastraMemory.getThreadById({ threadId: sessionId });
    if (thread) {
      const { messages } = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_sunqi' });
      expect(messages).toHaveLength(0);
    } else {
      expect(thread).toBeNull();
    }

    // 验证 3: 持久撤回墓碑已记录
    expect(await store.tombstones.isTombstoned(sessionId, msgId)).toBe(true);
  });

  it('已提交 user 的 MessageRecall 将正文移出活动上下文，中断正在执行的 Run，保留 Raw Store 原文', async () => {
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

    const sessionId = 'session_recall_committed';
    const msgId = 'msg_committed_recall';

    let recallAbortFired = false;
    coordinator.on('in_flight_aborted', (sid, _elapsed, reason) => {
      if (sid === sessionId && reason === 'message_recalled') {
        recallAbortFired = true;
      }
    });

    // 发出消息启动 Run
    mockDriver.emitMessage({
      id: msgId,
      sessionId,
      sender: '周八',
      senderId: 'emp_zhouba',
      content: '在途已提交将被撤回的问题',
      sessionType: 'private',
      isMe: false,
    });

    await modelStarted;
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);

    // 发出撤回
    await coordinator.handleRecalled({
      sessionId,
      messageId: msgId,
      sender: '周八',
    });

    // 验证: 触发了 message_recalled 中断，在途 Run 结束
    expect(recallAbortFired).toBe(true);
    expect(coordinator.hasInFlightSession(sessionId)).toBe(false);

    // 验证 1: Raw Store 保留原文与 recall 事实
    const raw = await store.messages.getMessageBySessionAndMessageId(sessionId, msgId);
    expect(raw?.content).toBe('在途已提交将被撤回的问题');
    expect(raw?.isRecalled).toBe(true);

    // 验证 2: 活动上下文 (Mastra Memory) 中该消息已被完全移除
    const { messages } = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_zhouba' });
    expect(messages.find(m => m.id === deriveUserMessageId(sessionId, msgId))).toBeUndefined();
  });

  it('GroupSession 撤回仅更新 Raw Store 撤回标记，不触发 Agent/Memory/Delivery', async () => {
    const model = createFakeModel({
      responses: [{ text: '群聊不应回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
    });
    await coordinator.start();

    const sessionId = 'group_session_recall_001';
    const msgId = 'group_msg_001';

    // 1. 群聊消息入站 (自动只写 Raw Store)
    await coordinator.handleInboundMessage({
      id: msgId,
      sessionId,
      sender: '群成员',
      content: '群里的发言',
      sessionType: 'group',
      isMe: false,
    });

    // 2. 群聊消息撤回
    await coordinator.handleRecalled({
      sessionId,
      messageId: msgId,
      sender: '群成员',
    });

    // 验证: Raw Store 标记撤回
    const raw = await store.messages.getMessageBySessionAndMessageId(sessionId, msgId);
    expect(raw?.isRecalled).toBe(true);

    // 验证: Mastra Memory 零写入
    const thread = await mastraMemory.getThreadById({ threadId: sessionId });
    expect(thread).toBeNull();
  });

  it('即使 Store 数据库写入阻塞延迟，PrivateSession 撤回仍同步 0ms 中断 Run，而 GroupSession 绝不误杀 Run', async () => {
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

    const sessionId = 'session_recall_blocked_io';
    const msgId = 'msg_blocked_io_1';

    // 模拟 Store 数据库写入存在 500ms 慢延迟
    let storeBlockedResolve: () => void;
    const storeBlockedPromise = new Promise<void>(r => { storeBlockedResolve = r; });
    const origMark = store.messages.markMessageRecalled.bind(store.messages);
    vi.spyOn(store.messages, 'markMessageRecalled').mockImplementation(async (s, m) => {
      await storeBlockedPromise;
      return origMark(s, m);
    });

    let abortFired = false;
    coordinator.on('in_flight_aborted', (sid, _elapsed, reason) => {
      if (sid === sessionId && reason === 'message_recalled') {
        abortFired = true;
      }
    });

    // 1. 发送消息启动 Run
    await coordinator.handleInboundMessage({
      id: msgId,
      sessionId,
      sender: '员工',
      senderId: 'emp_usr',
      content: '将被撤回的在途问题',
      sessionType: 'private',
      isMe: false,
    });

    await modelStarted;
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);

    // 2. 触发撤回（不等待 handleRecalled Promise 结束，立即同步断言）
    const recallPromise = coordinator.handleRecalled({
      sessionId,
      messageId: msgId,
      sender: '员工',
    });

    // 关键核心断言：即使底层的 Store 写入仍在被阻塞 (storeBlockedPromise 尚未 resolve)，在途 Run 已经同步 0ms 被切断！
    expect(abortFired).toBe(true);
    expect(coordinator.hasInFlightSession(sessionId)).toBe(false);

    // 释放 Store 阻塞并等待清理完成
    storeBlockedResolve!();
    await recallPromise;
  });
});
