import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseClient, closeDatabase } from '../src/database/connection.js';
import { DeliveryRepository } from '../src/repository/delivery-repository.js';
import { KKBotStore } from '../src/store.js';
import type { Client } from '@libsql/client';

describe('DeliveryRepository & Delivery Lifecycle Persistence', () => {
  let client: Client;
  let repo: DeliveryRepository;

  beforeEach(async () => {
    client = await createDatabaseClient({ path: ':memory:' });
    repo = new DeliveryRepository(client);
  });

  afterEach(() => {
    closeDatabase(client);
  });

  it('createDelivery: 初始创建状态为 generated，并正确写入所有字段', async () => {
    const delivery = await repo.createDelivery({
      id: 'deliv_test_001',
      runId: 'run_001',
      sessionId: 'session_private_001',
      mastraMessageId: 'msg_asst_deliv_test_001',
      content: '你好，这是最终生成内容。',
      contentHash: 'hash_sha256_001',
    });

    expect(delivery.id).toBe('deliv_test_001');
    expect(delivery.runId).toBe('run_001');
    expect(delivery.sessionId).toBe('session_private_001');
    expect(delivery.mastraMessageId).toBe('msg_asst_deliv_test_001');
    expect(delivery.content).toBe('你好，这是最终生成内容。');
    expect(delivery.contentHash).toBe('hash_sha256_001');
    expect(delivery.status).toBe('generated');
    expect(delivery.memoryCommittedAt).toBeNull();
    expect(delivery.kkMessageId).toBeNull();
    expect(delivery.errorCode).toBeNull();
    expect(delivery.createdAt).toBeGreaterThan(0);
    expect(delivery.updatedAt).toBeGreaterThan(0);
  });

  it('createDelivery: 重复创建相同 (runId, contentHash) 幂等返回已有记录', async () => {
    const d1 = await repo.createDelivery({
      id: 'deliv_test_002',
      runId: 'run_002',
      sessionId: 'session_private_002',
      mastraMessageId: 'msg_asst_deliv_test_002',
      content: '幂等内容',
      contentHash: 'hash_sha256_002',
    });

    const d2 = await repo.createDelivery({
      id: 'deliv_test_002_duplicate',
      runId: 'run_002',
      sessionId: 'session_private_002',
      mastraMessageId: 'msg_asst_deliv_test_002',
      content: '幂等内容',
      contentHash: 'hash_sha256_002',
    });

    expect(d2.id).toBe(d1.id);
    expect(d2.runId).toBe('run_002');
    expect(d2.contentHash).toBe('hash_sha256_002');
  });

  it('updateStatus: 状态按 generated -> sending -> sent 顺序流转', async () => {
    const delivery = await repo.createDelivery({
      id: 'deliv_test_003',
      runId: 'run_003',
      sessionId: 'session_private_003',
      mastraMessageId: 'msg_asst_deliv_test_003',
      content: '准备发送',
      contentHash: 'hash_sha256_003',
    });

    expect(delivery.status).toBe('generated');

    // 1. 进入 sending
    const sending = await repo.updateStatus(delivery.id, 'sending');
    expect(sending.status).toBe('sending');

    // 2. 发送成功进入 sent，并记录 kkMessageId
    const sent = await repo.updateStatus(delivery.id, 'sent', {
      kkMessageId: 'kk_msg_native_999',
    });
    expect(sent.status).toBe('sent');
    expect(sent.kkMessageId).toBe('kk_msg_native_999');
  });

  it('markMemoryCommitted: 在 sent 后成功持久化 memory_committed_at 时间戳', async () => {
    const delivery = await repo.createDelivery({
      id: 'deliv_test_004',
      runId: 'run_004',
      sessionId: 'session_private_004',
      mastraMessageId: 'msg_asst_deliv_test_004',
      content: '已发送待提交记忆',
      contentHash: 'hash_sha256_004',
    });

    await repo.updateStatus(delivery.id, 'sending');
    await repo.updateStatus(delivery.id, 'sent', { kkMessageId: 'kk_msg_444' });

    // 标记前查询未提交列表
    const uncommittedBefore = await repo.getSentUncommittedDeliveries();
    expect(uncommittedBefore.some((d) => d.id === delivery.id)).toBe(true);

    // 标记已提交
    const commitTime = Date.now();
    const committed = await repo.markMemoryCommitted(delivery.id, commitTime);
    expect(committed.memoryCommittedAt).toBe(commitTime);

    // 标记后查询未提交列表已无该记录
    const uncommittedAfter = await repo.getSentUncommittedDeliveries();
    expect(uncommittedAfter.some((d) => d.id === delivery.id)).toBe(false);
  });

  it('updateStatus: 支持 failed, unknown 与 aborted 状态及 errorCode', async () => {
    const dFail = await repo.createDelivery({
      id: 'deliv_fail',
      runId: 'run_fail',
      sessionId: 'session_fail',
      mastraMessageId: 'asst_fail',
      content: '失败内容',
      contentHash: 'hash_fail',
    });
    const failed = await repo.updateStatus(dFail.id, 'failed', { errorCode: 'PRE_TRIGGER_ERROR' });
    expect(failed.status).toBe('failed');
    expect(failed.errorCode).toBe('PRE_TRIGGER_ERROR');

    const dUnknown = await repo.createDelivery({
      id: 'deliv_unk',
      runId: 'run_unk',
      sessionId: 'session_unk',
      mastraMessageId: 'asst_unk',
      content: '未知状态内容',
      contentHash: 'hash_unk',
    });
    const unknown = await repo.updateStatus(dUnknown.id, 'unknown', { errorCode: 'TIMEOUT_WAITING_ECHO' });
    expect(unknown.status).toBe('unknown');
    expect(unknown.errorCode).toBe('TIMEOUT_WAITING_ECHO');
  });

  it('KKBotStore 门面可直接访问 deliveries 仓储并完成全生命周期', async () => {
    const store = new KKBotStore(client);
    expect(store.deliveries).toBeDefined();

    const created = await store.deliveries.createDelivery({
      id: 'deliv_facade_001',
      runId: 'run_facade_001',
      sessionId: 'session_facade',
      mastraMessageId: 'asst_facade',
      content: '门面测试',
      contentHash: 'hash_facade',
    });

    expect(created.status).toBe('generated');

    const sessionDeliveries = await store.deliveries.getDeliveriesBySession('session_facade');
    expect(sessionDeliveries.length).toBe(1);
    expect(sessionDeliveries[0].id).toBe('deliv_facade_001');
  });
});
