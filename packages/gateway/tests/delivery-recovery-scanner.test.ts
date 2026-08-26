import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import { LibSQLStore } from '@mastra/libsql';
import {
  Memory,
  deriveAssistantMessageId,
  createMastraTextMessage,
  ensureMastraThread,
} from '@kkbot/agent';
import { DeliveryRecoveryScanner } from '../src/recovery/delivery-recovery-scanner.js';
import { FakeKK9Driver } from '@kkbot/driver';


function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content && typeof content === 'object' && 'content' in content && typeof content.content === 'string') {
    return content.content;
  }
  return '';
}
describe('DeliveryRecoveryScanner 交付恢复扫描器测试 (TDD Red -> Green)', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let fakeDriver: FakeKK9Driver;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-recovery-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-store', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();
  });

  afterEach(async () => {
    if (store) {
      store.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  it('sent-but-uncommitted 恢复只补交 Memory，绝不调用 Driver 发送', async () => {
    const sessionId = 'session_rec_01';
    const runId = 'run_rec_01';
    const deliveryId = 'deliv_rec_01';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    // 预置会话与员工档案及 Mastra Thread (模拟 user 前置提交已创建 Thread)
    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_rec_01' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_rec_01');

    // 预置已发送但未提交 Memory 的 Delivery
    await store.deliveries.createDelivery({
      id: deliveryId,
      runId,
      sessionId,
      mastraMessageId,
      content: '需要补交记忆的回复',
      contentHash: 'hash_rec_01',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'sent', { kkMessageId: 'kk_rec_01' });

    // 检查初始未提交列表
    const uncommittedBefore = await store.deliveries.getSentUncommittedDeliveries();
    expect(uncommittedBefore.length).toBe(1);
    expect(uncommittedBefore[0].id).toBe(deliveryId);

    // 执行恢复扫描
    const scanner = new DeliveryRecoveryScanner({
      store,
      mastraMemory,
    });
    const report = await scanner.runRecoveryScan();

    expect(report.sentUncommittedCommitted).toBe(1);
    expect(report.errors.length).toBe(0);

    // 验证 Delivery 的 memory_committed_at 已被标记
    const updatedDeliv = await store.deliveries.getDeliveryById(deliveryId);
    expect(updatedDeliv?.status).toBe('sent');
    expect(updatedDeliv?.memoryCommittedAt).toBeGreaterThan(0);

    // 验证 Mastra Memory 中存在该条消息且 resourceId 正确
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_rec_01' });
    const asstMsg = recalled.messages.find((m) => m.id === mastraMessageId);
    expect(asstMsg).toBeDefined();
    expect(extractMessageText(asstMsg?.content)).toBe('需要补交记忆的回复');
    // 验证 Driver 发送方法绝对 0 调用
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('Memory 保存成功但标记提交前崩溃重启，恢复扫描重放后仍只有一条逻辑 assistant 消息', async () => {
    const sessionId = 'session_rec_02';
    const deliveryId = 'deliv_rec_02';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_rec_02' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_rec_02');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_rec_02',
      sessionId,
      mastraMessageId,
      content: '崩溃窗口重放消息',
      contentHash: 'hash_rec_02',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'sent', { kkMessageId: 'kk_rec_02' });

    // 模拟在 memoryCommittedAt 持久化前已由 Memory 保存过（强杀窗口）
    await mastraMemory.saveMessages({
      messages: [
        createMastraTextMessage({
          id: mastraMessageId,
          role: 'assistant',
          content: '崩溃窗口重放消息',
          threadId: sessionId,
          resourceId: 'emp_rec_02',
        }),
      ],
    });

    const scanner = new DeliveryRecoveryScanner({ store, mastraMemory });
    const report = await scanner.runRecoveryScan();
    expect(report.sentUncommittedCommitted).toBe(1);

    // 验证重放后 Memory 依然只有 1 条该 ID 的消息
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_rec_02' });
    const matched = recalled.messages.filter((m) => m.id === mastraMessageId);
    expect(matched.length).toBe(1);
  });

  it('在途 sending 状态在崩溃重启后安全转换为 unknown，不假设未发送，不自动补发', async () => {
    const sessionId = 'session_rec_03';
    const deliveryId = 'deliv_rec_03';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_rec_03' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_rec_03');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_rec_03',
      sessionId,
      mastraMessageId,
      content: '在途强杀消息',
      contentHash: 'hash_rec_03',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');

    const scanner = new DeliveryRecoveryScanner({ store, mastraMemory });
    const report = await scanner.runRecoveryScan();

    expect(report.inFlightSendingRecovered).toBe(1);

    // 验证 Delivery 必须安全流转至 unknown
    const updated = await store.deliveries.getDeliveryById(deliveryId);
    expect(updated?.status).toBe('unknown');
    expect(updated?.errorCode).toContain('RECOVERY_IN_FLIGHT_SENDING_INTERRUPTED');
    expect(updated?.memoryCommittedAt).toBeNull();

    // 验证 Mastra Memory 绝对无写入
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_rec_03' });
    expect(recalled.messages.some((m) => m.id === mastraMessageId)).toBe(false);
  });

  it('处于 unknown 状态的 Delivery 在恢复扫描中保持 unknown，不提交 Memory，不自动发送', async () => {
    const sessionId = 'session_rec_04';
    const deliveryId = 'deliv_rec_04';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_rec_04' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_rec_04');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_rec_04',
      sessionId,
      mastraMessageId,
      content: '既有未知结果',
      contentHash: 'hash_rec_04',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'unknown', { errorCode: 'NET_TIMEOUT' });

    const scanner = new DeliveryRecoveryScanner({ store, mastraMemory });
    const report = await scanner.runRecoveryScan();

    expect(report.unknownSkipped).toBe(1);

    const d = await store.deliveries.getDeliveryById(deliveryId);
    expect(d?.status).toBe('unknown');
    expect(d?.memoryCommittedAt).toBeNull();
  });

  it('两个恢复扫描器并发执行时，具有 CAS 保护与稳定 ID 幂等性，只产生一次有效提交', async () => {
    const sessionId = 'session_rec_concur';
    const deliveryId = 'deliv_rec_concur';
    const mastraMessageId = deriveAssistantMessageId(deliveryId);

    await store.sessions.upsertSession({ id: sessionId, employeeId: 'emp_rec_concur' });
    await ensureMastraThread(mastraMemory, sessionId, 'emp_rec_concur');

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_rec_concur',
      sessionId,
      mastraMessageId,
      content: '并发恢复消息',
      contentHash: 'hash_rec_concur',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'sent', { kkMessageId: 'kk_rec_concur' });

    const scanner1 = new DeliveryRecoveryScanner({ store, mastraMemory });
    const scanner2 = new DeliveryRecoveryScanner({ store, mastraMemory });

    const [rep1, rep2] = await Promise.all([
      scanner1.runRecoveryScan(),
      scanner2.runRecoveryScan(),
    ]);

    expect(rep1.sentUncommittedCommitted + rep2.sentUncommittedCommitted).toBe(1);
    expect(rep1.errors.length).toBe(0);
    expect(rep2.errors.length).toBe(0);
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_rec_concur' });
    const matches = recalled.messages.filter((m) => m.id === mastraMessageId);
    expect(matches.length).toBe(1);
  });

  it('多会话隔离：不同 PrivateSession 的恢复记录与 threadId / resourceId 互不串线', async () => {
    const s1 = 'session_rec_multi_1';
    const s2 = 'session_rec_multi_2';

    await store.sessions.upsertSession({ id: s1, employeeId: 'emp_user_1' });
    await store.sessions.upsertSession({ id: s2, employeeId: 'emp_user_2' });
    await ensureMastraThread(mastraMemory, s1, 'emp_user_1');
    await ensureMastraThread(mastraMemory, s2, 'emp_user_2');

    const d1 = 'deliv_m1';
    const d2 = 'deliv_m2';

    await store.deliveries.createDelivery({
      id: d1,
      runId: 'run_m1',
      sessionId: s1,
      mastraMessageId: deriveAssistantMessageId(d1),
      content: '内容 1',
      contentHash: 'hash_m1',
    });
    await store.deliveries.updateStatus(d1, 'sending');
    await store.deliveries.updateStatus(d1, 'sent', { kkMessageId: 'kk_m1' });

    await store.deliveries.createDelivery({
      id: d2,
      runId: 'run_m2',
      sessionId: s2,
      mastraMessageId: deriveAssistantMessageId(d2),
      content: '内容 2',
      contentHash: 'hash_m2',
    });
    await store.deliveries.updateStatus(d2, 'sending');
    await store.deliveries.updateStatus(d2, 'sent', { kkMessageId: 'kk_m2' });

    const scanner = new DeliveryRecoveryScanner({ store, mastraMemory });
    await scanner.runRecoveryScan();

    const recall1 = await mastraMemory.recall({ threadId: s1, resourceId: 'emp_user_1' });
    const recall2 = await mastraMemory.recall({ threadId: s2, resourceId: 'emp_user_2' });

    expect(recall1.messages.some((m) => m.id === deriveAssistantMessageId(d1))).toBe(true);
    expect(recall1.messages.some((m) => m.id === deriveAssistantMessageId(d2))).toBe(false);

    expect(recall2.messages.some((m) => m.id === deriveAssistantMessageId(d2))).toBe(true);
    expect(recall2.messages.some((m) => m.id === deriveAssistantMessageId(d1))).toBe(false);
  });
  it('generated 恢复遇到异常时记录到 report.errors 且不吞错', async () => {
    const deliveryId = 'deliv_gen_fail';
    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_gen_fail',
      sessionId: 'session_gen_fail',
      mastraMessageId: deriveAssistantMessageId(deliveryId),
      content: '生成失败测试内容',
      contentHash: 'hash_gen_fail',
    });

    // 模拟 updateStatus 抛出数据库异常
    const origUpdate = store.deliveries.updateStatus.bind(store.deliveries);
    store.deliveries.updateStatus = async (id, st, opt) => {
      if (id === deliveryId && st === 'aborted') {
        throw new Error('模拟底层数据库死锁或写入失败');
      }
      return origUpdate(id, st, opt);
    };

    try {
      const scanner = new DeliveryRecoveryScanner({ store, mastraMemory });
      const report = await scanner.runRecoveryScan();
      expect(report.errors.length).toBeGreaterThanOrEqual(1);
      expect(report.errors.some((e) => e.deliveryId === deliveryId && e.error.includes('模拟底层数据库死锁'))).toBe(true);
    } finally {
      store.deliveries.updateStatus = origUpdate;
    }
  });
  it('SessionCoordinator 启动时若恢复扫描发现错误，严格阻止系统启动 (Fail-Closed)', async () => {
    const { SessionCoordinator } = await import('../src/coordinator.js');
    const fakeDriver = {
      on: () => {},
      emit: () => {},
      removeListener: () => {},
    };

    const deliveryId = 'deliv_fail_closed_start';
    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: 'run_fail_closed_start',
      sessionId: 'session_fail_closed_start',
      mastraMessageId: deriveAssistantMessageId(deliveryId),
      content: '阻断启动测试内容',
      contentHash: 'hash_fail_closed_start',
    });

    const origUpdate = store.deliveries.updateStatus.bind(store.deliveries);
    store.deliveries.updateStatus = async (id, st, opt) => {
      if (id === deliveryId && st === 'aborted') {
        throw new Error('模拟 generated 恢复写入死锁');
      }
      return origUpdate(id, st, opt);
    };

    try {
      const coordinator = new SessionCoordinator({
        driver: fakeDriver as any,
        store,
        mastraMemory,
      });

      await expect(coordinator.start()).rejects.toThrow(/阻止系统启动 \(Fail-Closed\)/);
    } finally {
      store.deliveries.updateStatus = origUpdate;
    }
  });
});
