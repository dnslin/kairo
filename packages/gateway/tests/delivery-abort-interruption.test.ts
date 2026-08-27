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

describe('Delivery Abort & New Message Interruption', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let mockDriver: MockDriver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-abort-test-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });

    libSqlStore = new LibSQLStore({
      id: 'test-abort-storage',
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

  it('防抖期新消息使用各自稳定 ID 保存至 Raw Store，不提前创建重复 user Memory', async () => {
    const model = createFakeModel({
      responses: [{ text: '智能回复内容', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 100, maxWaitMs: 500 },
    });
    await coordinator.start();

    const sessionId = 'session_debounce_001';

    // 发送第一条短消息
    mockDriver.emitMessage({
      id: 'msg_deb_1',
      sessionId,
      sender: '张三',
      senderId: 'emp_zhangsan',
      content: '你好，',
      sessionType: 'private',
      isMe: false,
    });

    // 40ms 后发送第二条短消息（在 100ms 防抖期内）
    await new Promise(r => setTimeout(r, 40));
    mockDriver.emitMessage({
      id: 'msg_deb_2',
      sessionId,
      sender: '张三',
      senderId: 'emp_zhangsan',
      content: '请问考勤怎么算？',
      sessionType: 'private',
      isMe: false,
    });

    // 等待防抖聚合并执行完毕
    await new Promise(r => setTimeout(r, 300));

    // 验证 1: Raw Store 均有各自的稳定记录
    const raw1 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_deb_1');
    const raw2 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_deb_2');
    expect(raw1).toBeDefined();
    expect(raw2).toBeDefined();
    expect(raw1?.content).toBe('你好，');
    expect(raw2?.content).toBe('请问考勤怎么算？');
    const { messages } = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_zhangsan' });
    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].id).toBe(deriveUserMessageId(sessionId, 'msg_deb_1'));
    expect(userMsgs[1].id).toBe(deriveUserMessageId(sessionId, 'msg_deb_2'));
  });

  it('Run 期间新消息 0ms 中断当前只读 Run，已提交 user 事实保留，新一轮只提交新 user', async () => {
    const { promise: model1Started, resolve: resolveModel1Started } = Promise.withResolvers<void>();
    const { promise: waitAbortPromise, resolve: resolveAborted } = Promise.withResolvers<void>();

    const model = createFakeModel({
      onGenerate: (callCount, callOptions) => {
        if (callCount === 1) {
          resolveModel1Started();
          const signal = callOptions?.abortSignal;
          signal?.addEventListener('abort', () => {
            resolveAborted();
          });
        }
      },
      responses: [
        { text: '慢速第一轮回复', finishReason: 'stop' },
        { text: '最终第二轮回复', finishReason: 'stop' },
      ],
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

    const sessionId = 'session_in_flight_abort_001';
    let abortEventFired = false;
    coordinator.on('in_flight_aborted', (sid, _elapsed, reason) => {
      if (sid === sessionId && reason === 'new_inbound_message') {
        abortEventFired = true;
      }
    });

    // 1. 发出第一条消息，触发第一轮 Run
    mockDriver.emitMessage({
      id: 'msg_round1',
      sessionId,
      sender: '李四',
      senderId: 'emp_lisi',
      content: '第一轮问题',
      sessionType: 'private',
      isMe: false,
    });

    // 等待第一轮 Run 正式进入 Model 执行
    await model1Started;
    expect(coordinator.hasInFlightSession(sessionId)).toBe(true);

    // 2. Agent Run 执行中到达新消息 -> 0ms 中断当前只读 Run
    mockDriver.emitMessage({
      id: 'msg_round2',
      sessionId,
      sender: '李四',
      senderId: 'emp_lisi',
      content: '等等，我改主意了，问第二轮问题',
      sessionType: 'private',
      isMe: false,
    });
    // 等待在途请求被 AbortController.abort() 中断
    await waitAbortPromise;
    expect(abortEventFired).toBe(true);
    // 等待第二轮生成与交付完成
    await new Promise(r => setTimeout(r, 200));

    // 验证：已提交 user 事实与新 user 事实均在 Mastra Thread 中
    const { messages } = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_lisi' });
    const userMsgs = messages.filter(m => m.role === 'user');
    expect(userMsgs).toHaveLength(2);
    expect(userMsgs[0].id).toBe(deriveUserMessageId(sessionId, 'msg_round1'));
    expect(userMsgs[1].id).toBe(deriveUserMessageId(sessionId, 'msg_round2'));

    // 验证: 只有最终成功发送的 assistant 消息进入 Memory
    const asstMsgs = messages.filter(m => m.role === 'assistant');
    expect(asstMsgs).toHaveLength(1);
  });

  it('两个不同 PrivateSession 的中断互不影响，会话完全隔离', async () => {
    const { promise: aStarted, resolve: resolveAStarted } = Promise.withResolvers<void>();
    const model = createFakeModel({
      onGenerate: (callCount, _callOptions) => {
        if (callCount === 1) {
          resolveAStarted();
        }
      },
      responses: [
        { text: '会话A完成', finishReason: 'stop' },
        { text: '会话B快速完成', finishReason: 'stop' },
        { text: '会话A打断后完成', finishReason: 'stop' },
      ],
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

    const sessionA = 'session_iso_A';
    const sessionB = 'session_iso_B';
    // 启动会话 A 慢速 Run
    mockDriver.emitMessage({
      id: 'msg_iso_A_1',
      sessionId: sessionA,
      sender: '员工A',
      senderId: 'emp_A',
      content: '会话A慢速请求',
      sessionType: 'private',
      isMe: false,
    });
    await aStarted;
    // 启动会话 B 快速 Run
    mockDriver.emitMessage({
      id: 'msg_B_1',
      sessionId: sessionB,
      sender: '员工B',
      senderId: 'emp_B',
      content: '会话B正常请求',
      sessionType: 'private',
      isMe: false,
    });

    // 等待进入 Run 状态
    await new Promise(r => setTimeout(r, 70));

    // 会话 A 收到新消息中断
    mockDriver.emitMessage({
      id: 'msg_A_2',
      sessionId: sessionA,
      sender: '员工A',
      senderId: 'emp_A',
      content: '会话A新消息打断',
      sessionType: 'private',
      isMe: false,
    });

    // 等待全部会话完成
    await new Promise(r => setTimeout(r, 450));

    // 验证: 会话 B 成功完成，Memory 包含 user 与 assistant
    const recallB = await mastraMemory.recall({ threadId: sessionB, resourceId: 'emp_B' });
    expect(recallB.messages.filter(m => m.role === 'user')).toHaveLength(1);
    expect(recallB.messages.filter(m => m.role === 'assistant')).toHaveLength(1);

    // 验证: 会话 A 包含 2 条 user 记录
    const recallA = await mastraMemory.recall({ threadId: sessionA, resourceId: 'emp_A' });
    expect(recallA.messages.filter(m => m.role === 'user')).toHaveLength(2);
  });

  it('generated 阶段中断使 Delivery 进入 aborted，不提交 assistant Memory', async () => {
    const model = createFakeModel({
      responses: [{ text: '生成好的回复', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    let capturedDeliveryId = '';
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 50, maxWaitMs: 200 },
      hooks: {
        afterDeliveryGeneratedBeforeSending: (delivId) => {
          capturedDeliveryId = delivId;
          const inFlight = coordinator.getInFlightSession('session_abort_gen');
          inFlight?.abortController.abort();
          return Promise.resolve();
        },
      },
    });
    await coordinator.start();

    const sessionId = 'session_abort_gen';
    mockDriver.emitMessage({
      id: 'msg_gen_1',
      sessionId,
      sender: '赵六',
      senderId: 'emp_zhaoliu',
      content: '测试生成后中断',
      sessionType: 'private',
      isMe: false,
    });

    await new Promise(r => setTimeout(r, 300));

    expect(capturedDeliveryId).toBeTruthy();
    const deliv = await store.deliveries.getDeliveryById(capturedDeliveryId);
    expect(deliv?.status).toBe('aborted');
    const { messages } = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_zhaoliu' });
    expect(messages.filter(m => m.role === 'assistant')).toHaveLength(0);
  });
});
