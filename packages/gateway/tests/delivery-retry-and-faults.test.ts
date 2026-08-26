import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import { LibSQLStore } from '@mastra/libsql';
import {
  KKBotAgent,
  MastraModelFactory,
  createFakeModel,
  Memory,
  deriveAssistantMessageId,
  ensureMastraThread,
} from '@kkbot/agent';
import { FakeKK9Driver, type KK9Driver } from '@kkbot/driver';
import { SessionCoordinator } from '../src/coordinator.js';

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    'content' in content &&
    typeof content.content === 'string'
  ) {
    return content.content;
  }
  return '';
}

describe('Delivery 自动重试、Post-trigger Unknown、Aborted 与崩溃强杀点测试 (TDD Red -> Green)', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let fakeDriver: FakeKK9Driver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-faults-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-faults-store', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();
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

  it('pre-trigger 失败触发有界自动重试，复用同一 deliveryId，成功后仅提交 1 次 Memory', async () => {
    // 模拟 Driver 行为：第 1 次 pre_trigger_failure，第 2 次 success
    fakeDriver.setSendBehavior({
      mode: 'sequence',
      behaviors: [
        { mode: 'pre_trigger_failure', error: '会话切换瞬时失败' },
        { mode: 'success', messageId: 'kk_msg_retry_success' },
      ],
    });

    const fakeModel = createFakeModel({
      responses: [{ text: '重试成功回复内容', finishReason: 'stop' }],
    });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150, maxRetries: 2 },
    });
    await coordinator.start();

    const sessionId = 'session_retry_01';
    await coordinator.handleInboundMessage({
      id: 'msg_r_1',
      messageId: 'msg_r_1',
      sessionId,
      sessionName: '用户',
      sessionType: 'private',
      sender: '用户',
      senderId: 'emp_retry_01',
      content: '测试自动重试',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证底层发送调用了 2 次
    expect(fakeDriver.recordedCalls.length).toBe(2);

    // 验证数据库中仅存在 1 个 Delivery 实体，且最终状态为 sent，retryCount 为 1
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].retryCount).toBe(1);
    expect(deliveries[0].kkMessageId).toBe('kk_msg_retry_success');
    expect(deliveries[0].memoryCommittedAt).toBeGreaterThan(0);

    // 验证 Mastra Memory 中仅存在 1 条 assistant 消息
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_retry_01' });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(1);
    expect(extractMessageText(asstMsgs[0].content)).toBe('重试成功回复内容');
  });

  it('pre-trigger 连续失败达到 maxRetries 上限后停止重试，终态为 failed 且不提交 Memory', async () => {
    // 模拟持续 pre-trigger 失败
    fakeDriver.setSendBehavior({
      mode: 'pre_trigger_failure',
      error: '持续前置锁失败',
    });

    const fakeModel = createFakeModel({
      responses: [{ text: '重试耗尽回复', finishReason: 'stop' }],
    });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150, maxRetries: 2 },
    });
    await coordinator.start();

    const sessionId = 'session_retry_exhausted';
    await coordinator.handleInboundMessage({
      id: 'msg_re_1',
      messageId: 'msg_re_1',
      sessionId,
      sessionName: '用户',
      sessionType: 'private',
      sender: '用户',
      senderId: 'emp_re_01',
      content: '测试重试耗尽',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证底层调用了 1 + 2 = 3 次 (首次 + 2 次重试)
    expect(fakeDriver.recordedCalls.length).toBe(3);

    // 验证最终 Delivery 状态为 failed
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('failed');
    expect(deliveries[0].retryCount).toBe(2);
    expect(deliveries[0].memoryCommittedAt).toBeNull();

    // 验证 Memory 中无任何 assistant 消息
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_re_01' });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(0);
  });

  it('post-trigger timeout / disconnect 严禁自动重试，直接进入 unknown 并坚决不提交 Memory', async () => {
    fakeDriver.setSendBehavior({
      mode: 'post_trigger_timeout',
      error: 'CDP timeout waiting message echo',
    });

    const fakeModel = createFakeModel({
      responses: [{ text: '超时未知结果回复', finishReason: 'stop' }],
    });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150, maxRetries: 3 },
    });
    await coordinator.start();

    const sessionId = 'session_post_timeout';
    await coordinator.handleInboundMessage({
      id: 'msg_pt_1',
      messageId: 'msg_pt_1',
      sessionId,
      sessionName: '用户',
      sessionType: 'private',
      sender: '用户',
      senderId: 'emp_pt_01',
      content: '测试超时不重发',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证底层精确仅调用了 1 次 (绝不自动重试)
    expect(fakeDriver.recordedCalls.length).toBe(1);

    // 验证 Delivery 为 unknown
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('unknown');
    expect(deliveries[0].errorCode).toContain('CDP timeout');
    expect(deliveries[0].memoryCommittedAt).toBeNull();

    // 验证 Memory 绝无写入
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_pt_01' });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(0);
  });

  it('强杀点 1: Delivery=sent 持久化后、Memory 保存前强杀，重启恢复后仅补交 Memory 不二次发送', async () => {
    const sessionId = 'session_crash_sent_uncomm';
    const deliveryId = 'deliv_crash_01';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_crash_01' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_crash_01');

    // 预置已发送但未提交 Memory 的 Delivery
    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_crash_01',
      sessionId,
      mastraMessageId,
      content: '强杀窗口内容',
      contentHash: 'hash_crash_01',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'sent', { kkMessageId: 'kk_crash_01' });

    const uncommittedBefore = await store.deliveries.getSentUncommittedDeliveries();
    expect(uncommittedBefore.length).toBe(1);

    // 重启后启动 Coordinator (自动在 start 阶段执行恢复扫描)
    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 验证 Driver 绝对 0 次调用
    expect(fakeDriver.recordedCalls.length).toBe(0);

    // 验证 Memory 已被启动恢复扫描自动补交
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_crash_01' });
    const asstMsg = recalled.messages.find((m) => m.id === mastraMessageId);
    expect(asstMsg).toBeDefined();
    expect(extractMessageText(asstMsg?.content)).toBe('强杀窗口内容');

    // 验证 memory_committed_at 已标记
    const updated = await store.deliveries.getDeliveryById(deliveryId);
    expect(updated?.memoryCommittedAt).toBeGreaterThan(0);
  });

  it('强杀点 2: Delivery=sending 提交后、Driver 发送前强杀，重启恢复后安全收敛为 unknown', async () => {
    const sessionId = 'session_crash_sending';
    const deliveryId = 'deliv_crash_sending_01';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_crash_02' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_crash_02');

    // 模拟 Delivery 为 sending 时进程死亡
    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_crash_02',
      sessionId,
      mastraMessageId,
      content: '在途死亡内容',
      contentHash: 'hash_crash_02',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');

    const inFlightBefore = await store.deliveries.getInFlightSendingDeliveries();
    expect(inFlightBefore.length).toBe(1);

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 验证 Delivery 已被启动恢复扫描安全流转至 unknown，不假设未发送，不自动补发
    const updated = await store.deliveries.getDeliveryById(deliveryId);
    expect(updated?.status).toBe('unknown');
    expect(updated?.errorCode).toContain('RECOVERY_IN_FLIGHT_SENDING_INTERRUPTED');

    // 验证 Driver 0 次调用，Memory 0 写入
    expect(fakeDriver.recordedCalls.length).toBe(0);
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_crash_02' });
    expect(recalled.messages.some((m) => m.id === mastraMessageId)).toBe(false);
  });

  it('pre-trigger 阶段检测到主动中止 (如人工接管或信号打断)，Delivery 进入 aborted，不调用 Driver，不提交 Memory，恢复扫描不重发', async () => {
    const sessionId = 'session_abort_pre_trigger';
    const senderId = 'emp_abort_01';

    await store.sessions.upsertSession({ id: sessionId, employeeId: senderId });

    // 在模型生成期间动态激活人工接管，模拟在不可逆发送边界前触发主动中止
    const fakeModel = createFakeModel({
      responses: [{ text: '将被中止的回复内容', finishReason: 'stop' }],
    });
    const origDoGenerate = fakeModel.doGenerate.bind(fakeModel);
    fakeModel.doGenerate = async (opts) => {
      await store.sessions.setTakeoverUntil(sessionId, Date.now() + 600000);
      return origDoGenerate(opts);
    };

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    await coordinator.handleInboundMessage({
      id: 'msg_ab_1',
      messageId: 'msg_ab_1',
      sessionId,
      sessionName: '用户',
      sessionType: 'private',
      sender: '用户',
      senderId,
      content: '测试主动中止',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证底层 Driver 绝对 0 次发送
    expect(fakeDriver.recordedCalls.length).toBe(0);

    // 验证 Delivery 终态为 aborted
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('aborted');
    expect(deliveries[0].memoryCommittedAt).toBeNull();

    // 验证 Memory 绝对无 assistant 消息
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: senderId });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(0);

    // 验证恢复扫描跳过 aborted，不尝试重发或提交 Memory
    const report = await coordinator.runDeliveryRecoveryScan();
    expect(report.inFlightSendingRecovered).toBe(0);
    expect(report.sentUncommittedCommitted).toBe(0);
    const afterScan = await store.deliveries.getDeliveryById(deliveries[0].id);
    expect(afterScan?.status).toBe('aborted');
  });

  it('发送动作发出后若发生中止或断线，因边界无法确认，必须收敛为 unknown 而不是 aborted', async () => {
    // 模拟 Driver 发送动作已触发，但随后断线
    fakeDriver.setSendBehavior({
      mode: 'post_trigger_disconnect',
      error: '发送动作已触发后断线',
    });

    const fakeModel = createFakeModel({
      responses: [{ text: '触发后断线回复', finishReason: 'stop' }],
    });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_post_abort_unk';
    await coordinator.handleInboundMessage({
      id: 'msg_pau_1',
      messageId: 'msg_pau_1',
      sessionId,
      sessionName: '用户',
      sessionType: 'private',
      sender: '用户',
      senderId: 'emp_pau_01',
      content: '测试触发后不能判定为 aborted',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证 Delivery 必须进入 unknown，绝不能误判为 aborted
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('unknown');
    expect(deliveries[0].status).not.toBe('aborted');
    expect(deliveries[0].memoryCommittedAt).toBeNull();
  });
});
