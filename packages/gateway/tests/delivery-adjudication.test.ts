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
  if (content && typeof content === 'object' && 'content' in content && typeof content.content === 'string') {
    return content.content;
  }
  return '';
}
describe('Delivery Manual Adjudication 人工裁定与 Memory 补交测试 (TDD Red -> Green)', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let fakeDriver: FakeKK9Driver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-adj-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-adj-store', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

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
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();
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

  it('unknown 经人工裁定为 sent: 先持久化为 sent，再补交 assistant Memory 并打标', async () => {
    const sessionId = 'session_adj_01';
    const deliveryId = 'deliv_adj_01';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_adj_01' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_adj_01');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_adj_01',
      sessionId,
      mastraMessageId,
      content: '裁定已发送内容',
      contentHash: 'hash_adj_01',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'unknown', { errorCode: 'NET_TIMEOUT' });

    // 裁定前 Memory 无记录
    const recallBefore = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_adj_01' });
    expect(recallBefore.messages.some((m) => m.id === mastraMessageId)).toBe(false);

    // 执行人工裁定 (sent)
    const result = await coordinator.adjudicateDelivery({
      deliveryId,
      operator: 'op_charlie',
      decision: 'sent',
      evidenceSummary: '核对 KK 消息日志，确认消息于 10:00 已送达',
    });

    expect(result.success).toBe(true);
    expect(result.delivery.status).toBe('sent');
    expect(result.memoryCommitted).toBe(true);

    // 验证数据库状态与提交标记
    const updated = await store.deliveries.getDeliveryById(deliveryId);
    expect(updated?.status).toBe('sent');
    expect(updated?.memoryCommittedAt).toBeGreaterThan(0);

    // 验证审计记录
    const audits = await store.deliveries.getAdjudicationsByDeliveryId(deliveryId);
    expect(audits.length).toBe(1);
    expect(audits[0].operator).toBe('op_charlie');
    expect(audits[0].decision).toBe('sent');
    expect(audits[0].evidenceSummary).toContain('已送达');

    // 验证 Mastra Memory 已成功补交
    const recallAfter = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_adj_01' });
    const asstMsg = recallAfter.messages.find((m) => m.id === mastraMessageId);
    expect(asstMsg).toBeDefined();
    expect(extractMessageText(asstMsg?.content)).toBe('裁定已发送内容');

    // 验证未调用底层 Driver 发送
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('unknown 经人工裁定为 not_sent: 保持 unknown 状态，绝不提交 assistant Memory，不自动补发', async () => {
    const sessionId = 'session_adj_02';
    const deliveryId = 'deliv_adj_02';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_adj_02' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_adj_02');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_adj_02',
      sessionId,
      mastraMessageId,
      content: '裁定未发送内容',
      contentHash: 'hash_adj_02',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'unknown', { errorCode: 'CDP_DISCONNECTED' });

    // 执行人工裁定 (not_sent)
    const result = await coordinator.adjudicateDelivery({
      deliveryId,
      operator: 'op_david',
      decision: 'not_sent',
      evidenceSummary: '经核查客户端无此消息，未送达',
    });

    expect(result.success).toBe(true);
    expect(result.delivery.status).toBe('unknown');
    expect(result.memoryCommitted).toBe(false);

    // 验证数据库状态仍为 unknown 且 memory_committed_at 为 NULL
    const updated = await store.deliveries.getDeliveryById(deliveryId);
    expect(updated?.status).toBe('unknown');
    expect(updated?.memoryCommittedAt).toBeNull();

    // 验证审计记录
    const audits = await store.deliveries.getAdjudicationsByDeliveryId(deliveryId);
    expect(audits.length).toBe(1);
    expect(audits[0].operator).toBe('op_david');
    expect(audits[0].decision).toBe('not_sent');

    // 验证 Mastra Memory 绝无写入
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_adj_02' });
    expect(recalled.messages.some((m) => m.id === mastraMessageId)).toBe(false);

    // 验证未调用底层 Driver 发送
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('重复或并发人工裁定保持幂等且不会重复提交 Memory', async () => {
    const sessionId = 'session_adj_03';
    const deliveryId = 'deliv_adj_03';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_adj_03' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_adj_03');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_adj_03',
      sessionId,
      mastraMessageId,
      content: '重复裁定测试',
      contentHash: 'hash_adj_03',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'unknown', { errorCode: 'TIMEOUT' });

    // 首次裁定为 sent
    const res1 = await coordinator.adjudicateDelivery({
      deliveryId,
      operator: 'op_1',
      decision: 'sent',
      evidenceSummary: '证据 1',
    });
    expect(res1.memoryCommitted).toBe(true);

    // 再次裁定为 sent (重复)
    const res2 = await coordinator.adjudicateDelivery({
      deliveryId,
      operator: 'op_2',
      decision: 'sent',
      evidenceSummary: '证据 2',
    });
    expect(res2.delivery.status).toBe('sent');

    // 验证 Memory 依然仅有 1 条该 assistant 消息
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_adj_03' });
    const matches = recalled.messages.filter((m) => m.id === mastraMessageId);
    expect(matches.length).toBe(1);
  });

  it('unknown 经人工裁定为 indeterminate (仍不可判定): 保持 unknown 状态，绝不提交 Memory，不自动补发', async () => {
    const sessionId = 'session_adj_04';
    const deliveryId = 'deliv_adj_04';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_adj_04' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_adj_04');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_adj_04',
      sessionId,
      mastraMessageId,
      content: '裁定仍不可判定内容',
      contentHash: 'hash_adj_04',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'unknown', { errorCode: 'CDP_CRASH_UNCONFIRMED' });

    // 执行人工裁定 (indeterminate)
    const result = await coordinator.adjudicateDelivery({
      deliveryId,
      operator: 'op_eve',
      decision: 'indeterminate',
      evidenceSummary: '真机网络与数据库日志不完整，无法确认是否送达，保持门禁',
    });

    expect(result.success).toBe(true);
    expect(result.delivery.status).toBe('unknown');
    expect(result.memoryCommitted).toBe(false);

    // 验证数据库状态仍为 unknown 且 memory_committed_at 为 NULL
    const updated = await store.deliveries.getDeliveryById(deliveryId);
    expect(updated?.status).toBe('unknown');
    expect(updated?.memoryCommittedAt).toBeNull();

    // 验证审计记录
    const audits = await store.deliveries.getAdjudicationsByDeliveryId(deliveryId);
    expect(audits.length).toBe(1);
    expect(audits[0].operator).toBe('op_eve');
    expect(audits[0].decision).toBe('indeterminate');
    expect(audits[0].evidenceSummary).toContain('保持门禁');

    // 验证 Mastra Memory 绝无写入
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_adj_04' });
    expect(recalled.messages.some((m) => m.id === mastraMessageId)).toBe(false);

    // 验证未调用底层 Driver 发送
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });
});
