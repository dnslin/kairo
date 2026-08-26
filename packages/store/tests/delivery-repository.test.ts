import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseClient, closeDatabase } from '../src/database/connection.js';
import { DeliveryRepository } from '../src/repository/delivery-repository.js';
import { KKBotStore } from '../src/store.js';
import { MessageTombstonedError } from '../src/utils/errors.js';
import type { Client } from '@libsql/client';
import type { Delivery } from '../src/types/index.js';
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
    await repo.updateStatus(dUnknown.id, 'sending');
    const unknown = await repo.updateStatus(dUnknown.id, 'unknown', {
      errorCode: 'TIMEOUT_WAITING_ECHO',
    });
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

  describe('Delivery 状态机允许转换与条件更新 (CAS) 保护', () => {
    it('generated -> sending -> failed -> sending (重试) -> sent 完整合法状态流转', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_flow_01',
        runId: 'run_flow_01',
        sessionId: 'session_flow',
        mastraMessageId: 'asst_flow_01',
        content: '重试流转测试',
        contentHash: 'hash_flow_01',
      });

      // 从 generated 流转至 sending
      const s1 = await repo.updateStatus(d.id, 'sending');
      expect(s1.status).toBe('sending');
      expect(s1.retryCount).toBe(0);

      // 从 sending 流转至 failed (发送前 pre-trigger 失败)
      const f1 = await repo.updateStatus(d.id, 'failed', { errorCode: 'PRE_TRIGGER_FAILED' });
      expect(f1.status).toBe('failed');
      expect(f1.errorCode).toBe('PRE_TRIGGER_FAILED');

      // 从 failed 流转至 sending (发起第 1 次有界自动重试)
      const s2 = await repo.updateStatus(d.id, 'sending', { isRetry: true, maxRetries: 2 });
      expect(s2.status).toBe('sending');
      expect(s2.retryCount).toBe(1);

      // 从 sending 流转至 sent (发送成功终态)
      const sent = await repo.updateStatus(d.id, 'sent', { kkMessageId: 'kk_sent_flow_01' });
      expect(sent.status).toBe('sent');
      expect(sent.kkMessageId).toBe('kk_sent_flow_01');
    });

    it('generated -> aborted、generated -> failed 与 failed -> aborted (重试期间中止) 合法转换', async () => {
      const d1 = await repo.createDelivery({
        id: 'deliv_abort_01',
        runId: 'run_abort_01',
        sessionId: 'session_abort',
        mastraMessageId: 'asst_abort_01',
        content: '中止内容',
        contentHash: 'hash_abort_01',
      });
      const aborted = await repo.updateStatus(d1.id, 'aborted');
      expect(aborted.status).toBe('aborted');

      const d2 = await repo.createDelivery({
        id: 'deliv_prep_fail_01',
        runId: 'run_prep_fail_01',
        sessionId: 'session_prep_fail',
        mastraMessageId: 'asst_prep_fail_01',
        content: '准备失败内容',
        contentHash: 'hash_prep_fail_01',
      });
      const failed = await repo.updateStatus(d2.id, 'failed', { errorCode: 'PREPARATION_FAILED' });
      expect(failed.status).toBe('failed');

      // failed -> aborted (pre-trigger 失败重试期间主动中止)
      const abortedFromFailed = await repo.updateStatus(d2.id, 'aborted', {
        errorCode: 'ABORTED_DURING_RETRY',
      });
      expect(abortedFromFailed.status).toBe('aborted');
      expect(abortedFromFailed.errorCode).toBe('ABORTED_DURING_RETRY');
    });

    it('sending -> unknown (post-trigger) 与 crash recovery scan 场景流转', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_unk_flow_01',
        runId: 'run_unk_flow_01',
        sessionId: 'session_unk_flow',
        mastraMessageId: 'asst_unk_flow_01',
        content: '未知结果内容',
        contentHash: 'hash_unk_flow_01',
      });
      await repo.updateStatus(d.id, 'sending');
      const unknown = await repo.updateStatus(d.id, 'unknown', { errorCode: 'TIMEOUT_WAITING_ACK' });
      expect(unknown.status).toBe('unknown');
      expect(unknown.errorCode).toBe('TIMEOUT_WAITING_ACK');
    });

    it('严禁从终态 (sent / aborted) 再次流转回 sending 或其他状态', async () => {
      const dSent = await repo.createDelivery({
        id: 'deliv_term_sent',
        runId: 'run_term_sent',
        sessionId: 'session_term',
        mastraMessageId: 'asst_term_sent',
        content: '已终态发送内容',
        contentHash: 'hash_term_sent',
      });
      await repo.updateStatus(dSent.id, 'sending');
      await repo.updateStatus(dSent.id, 'sent', { kkMessageId: 'kk_term' });

      // sent -> sending 必须被拒绝
      await expect(repo.updateStatus(dSent.id, 'sending')).rejects.toThrow();
      // sent -> failed 必须被拒绝
      await expect(repo.updateStatus(dSent.id, 'failed')).rejects.toThrow();
      // sent -> unknown 必须被拒绝
      await expect(repo.updateStatus(dSent.id, 'unknown')).rejects.toThrow();
      // sent -> aborted 必须被拒绝
      await expect(repo.updateStatus(dSent.id, 'aborted')).rejects.toThrow();

      const dAborted = await repo.createDelivery({
        id: 'deliv_term_aborted',
        runId: 'run_term_aborted',
        sessionId: 'session_term_2',
        mastraMessageId: 'asst_term_aborted',
        content: '已终态中止内容',
        contentHash: 'hash_term_aborted',
      });
      await repo.updateStatus(dAborted.id, 'aborted');

      // aborted -> sending 必须被拒绝
      await expect(repo.updateStatus(dAborted.id, 'sending')).rejects.toThrow();
      // aborted -> sent 必须被拒绝
      await expect(repo.updateStatus(dAborted.id, 'sent')).rejects.toThrow();
    });
    it('终态 (sent / aborted) 幂等重放时若携带不同交付证据字段则严禁改写并抛出异常', async () => {
      const dSent = await repo.createDelivery({
        id: 'deliv_term_replay_sent',
        runId: 'run_term_replay_sent',
        sessionId: 'session_term_replay',
        mastraMessageId: 'asst_term_replay_sent',
        content: '已终态发送内容',
        contentHash: 'hash_term_replay_sent',
      });
      await repo.updateStatus(dSent.id, 'sending');
      const sent = await repo.updateStatus(dSent.id, 'sent', { kkMessageId: 'kk_orig_msg_id' });
      expect(sent.kkMessageId).toBe('kk_orig_msg_id');

      // 完全一致的幂等重放应该成功返回
      const sameReplay = await repo.updateStatus(dSent.id, 'sent', { kkMessageId: 'kk_orig_msg_id' });
      expect(sameReplay.kkMessageId).toBe('kk_orig_msg_id');

      // 携带不同 kkMessageId 的重放必须被拦截并抛出异常
      await expect(
        repo.updateStatus(dSent.id, 'sent', { kkMessageId: 'kk_tampered_msg_id' })
      ).rejects.toThrow(/已处于终态/);

      const dAborted = await repo.createDelivery({
        id: 'deliv_term_replay_aborted',
        runId: 'run_term_replay_aborted',
        sessionId: 'session_term_replay_2',
        mastraMessageId: 'asst_term_replay_aborted',
        content: '已中止内容',
        contentHash: 'hash_term_replay_aborted',
      });
      await repo.updateStatus(dAborted.id, 'aborted', { errorCode: 'USER_ABORT' });

      // 携带不同 errorCode 的 aborted 重放必须被拦截
      await expect(
        repo.updateStatus(dAborted.id, 'aborted', { errorCode: 'TAMPERED_ABORT' })
      ).rejects.toThrow(/已处于终态/);
    });

    it('严禁未经人工裁定直接将 unknown 自动重试为 sending 或直接改写为 failed', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_unk_no_auto_retry',
        runId: 'run_unk_no_auto_retry',
        sessionId: 'session_unk_nar',
        mastraMessageId: 'asst_unk_nar',
        content: '不可自动重试',
        contentHash: 'hash_unk_nar',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'unknown', { errorCode: 'CDP_DISCONNECTED' });

      // unknown -> sending 自动重试必须被拒绝
      await expect(repo.updateStatus(d.id, 'sending', { isRetry: true })).rejects.toThrow();
      // unknown -> failed 必须被拒绝
      await expect(repo.updateStatus(d.id, 'failed')).rejects.toThrow();
    });

    it('有界自动重试达到 maxRetries 上限后拒绝继续重试', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_max_retries',
        runId: 'run_max_retries',
        sessionId: 'session_mr',
        mastraMessageId: 'asst_mr',
        content: '重试上限测试',
        contentHash: 'hash_mr',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'failed', { errorCode: 'ERR1' });

      // 第 1 次重试 (maxRetries=2)
      const r1 = await repo.updateStatus(d.id, 'sending', { isRetry: true, maxRetries: 2 });
      expect(r1.retryCount).toBe(1);
      await repo.updateStatus(d.id, 'failed', { errorCode: 'ERR2' });

      // 第 2 次重试 (maxRetries=2)
      const r2 = await repo.updateStatus(d.id, 'sending', { isRetry: true, maxRetries: 2 });
      expect(r2.retryCount).toBe(2);
      await repo.updateStatus(d.id, 'failed', { errorCode: 'ERR3' });

      // 第 3 次重试已超过上限，必须拒绝
      await expect(repo.updateStatus(d.id, 'sending', { isRetry: true, maxRetries: 2 })).rejects.toThrow();
    });

    it('相同状态转换重放幂等返回当前实体且不产生副作用', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_idempotent',
        runId: 'run_idempotent',
        sessionId: 'session_idem',
        mastraMessageId: 'asst_idem',
        content: '幂等重放测试',
        contentHash: 'hash_idem',
      });

      const s1 = await repo.updateStatus(d.id, 'sending');
      const s2 = await repo.updateStatus(d.id, 'sending');
      expect(s1.status).toBe('sending');
      expect(s2.status).toBe('sending');
      expect(s2.id).toBe(s1.id);

      const sent1 = await repo.updateStatus(d.id, 'sent', { kkMessageId: 'kk_123' });
      const sent2 = await repo.updateStatus(d.id, 'sent', { kkMessageId: 'kk_123' });
      expect(sent1.status).toBe('sent');
      expect(sent2.status).toBe('sent');
      expect(sent2.kkMessageId).toBe('kk_123');
    });

    it('并发竞争场景下仅有合法的 CAS 状态更新能够生效，终态不可被破坏', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_concurrent_cas',
        runId: 'run_concurrent_cas',
        sessionId: 'session_cc',
        mastraMessageId: 'asst_cc',
        content: '并发竞争测试',
        contentHash: 'hash_cc',
      });
      await repo.updateStatus(d.id, 'sending');

      // 并发尝试更新为 sent 和 failed
      const results = await Promise.allSettled([
        repo.updateStatus(d.id, 'sent', { kkMessageId: 'kk_cc_winner' }),
        repo.updateStatus(d.id, 'failed', { errorCode: 'LATE_FAILURE' }),
      ]);
      expect(results).toHaveLength(2);
      // 至少有一个成功，且终态一致
      const finalRecord = await repo.getDeliveryById(d.id);
      expect(['sent', 'failed']).toContain(finalRecord?.status);
    });
  });

  describe('Delivery 人工裁定 (Manual Adjudication) 与审计持久化', () => {
    it('裁定为 sent: 成功将 unknown 转换为 sent 并记录可审计记录', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_adj_sent',
        runId: 'run_adj_sent',
        sessionId: 'session_adj',
        mastraMessageId: 'asst_adj_sent',
        content: '人工裁定已发送内容',
        contentHash: 'hash_adj_sent',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'unknown', { errorCode: 'TIMEOUT_NO_ECHO' });

      const adjudicated = await repo.adjudicateDelivery(d.id, {
        operator: 'operator_alice',
        decision: 'sent',
        evidenceSummary: '真机抓包与截图确认员工已收到消息',
      });

      expect(adjudicated.status).toBe('sent');

      // 检查审计记录
      const auditRecords = await repo.getAdjudicationsByDeliveryId(d.id);
      expect(auditRecords.length).toBe(1);
      expect(auditRecords[0].operator).toBe('operator_alice');
      expect(auditRecords[0].decision).toBe('sent');
      expect(auditRecords[0].evidenceSummary).toContain('真机抓包与截图确认');
      expect(auditRecords[0].createdAt).toBeGreaterThan(0);
    });

    it('裁定为 not_sent: 保持 unknown 状态不进入 sent，并持久化审计记录', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_adj_notsent',
        runId: 'run_adj_notsent',
        sessionId: 'session_adj_2',
        mastraMessageId: 'asst_adj_notsent',
        content: '人工裁定未发送内容',
        contentHash: 'hash_adj_notsent',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'unknown', { errorCode: 'CDP_TIMEOUT' });

      const adjudicated = await repo.adjudicateDelivery(d.id, {
        operator: 'operator_bob',
        decision: 'not_sent',
        evidenceSummary: '核查 KK 服务端与客户端无此消息',
      });

      // 仍保持 unknown，不进入 sent
      expect(adjudicated.status).toBe('unknown');

      // 检查审计记录
      const auditRecords = await repo.getAdjudicationsByDeliveryId(d.id);
      expect(auditRecords.length).toBe(1);
      expect(auditRecords[0].operator).toBe('operator_bob');
      expect(auditRecords[0].decision).toBe('not_sent');
    });

    it('重复或并发人工裁定保持幂等且不会产生多个终态', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_adj_concur',
        runId: 'run_adj_concur',
        sessionId: 'session_adj_3',
        mastraMessageId: 'asst_adj_concur',
        content: '并发裁定测试',
        contentHash: 'hash_adj_concur',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'unknown', { errorCode: 'TIMEOUT' });

      const [res1, res2] = await Promise.all([
        repo.adjudicateDelivery(d.id, {
          operator: 'operator_1',
          decision: 'sent',
          evidenceSummary: '证据 1',
        }),
        repo.adjudicateDelivery(d.id, {
          operator: 'operator_2',
          decision: 'sent',
          evidenceSummary: '证据 2',
        }),
      ]);

      expect(res1.status).toBe('sent');
      expect(res2.status).toBe('sent');
      const finalD = await repo.getDeliveryById(d.id);
      expect(finalD?.status).toBe('sent');
    });

    it('裁定为 indeterminate (仍不可判定): 保持 unknown 状态，持久化独立审计记录', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_adj_indet',
        runId: 'run_adj_indet',
        sessionId: 'session_adj_indet',
        mastraMessageId: 'asst_adj_indet',
        content: '人工裁定不可判定内容',
        contentHash: 'hash_adj_indet',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'unknown', { errorCode: 'CDP_CRASH' });

      const adjudicated = await repo.adjudicateDelivery(d.id, {
        operator: 'operator_eve',
        decision: 'indeterminate',
        evidenceSummary: '客户端日志损坏，真机暂无法连通，维持不可判定',
      });

      // 仍保持 unknown，不进入 sent
      expect(adjudicated.status).toBe('unknown');

      // 检查审计记录
      const auditRecords = await repo.getAdjudicationsByDeliveryId(d.id);
      expect(auditRecords.length).toBe(1);
      expect(auditRecords[0].operator).toBe('operator_eve');
      expect(auditRecords[0].decision).toBe('indeterminate');
      expect(auditRecords[0].evidenceSummary).toContain('维持不可判定');
    });
  });

  describe('在途与未知 Delivery 恢复扫描查询', () => {
    it('getInFlightSendingDeliveries: 准确查询处于 sending 状态的记录', async () => {
      const d1 = await repo.createDelivery({
        id: 'deliv_inflight_1',
        runId: 'run_if_1',
        sessionId: 'ses_if_1',
        mastraMessageId: 'asst_if_1',
        content: '在途发送 1',
        contentHash: 'hash_if_1',
      });
      await repo.updateStatus(d1.id, 'sending');

      const d2 = await repo.createDelivery({
        id: 'deliv_inflight_2',
        runId: 'run_if_2',
        sessionId: 'ses_if_2',
        mastraMessageId: 'asst_if_2',
        content: '已发送 2',
        contentHash: 'hash_if_2',
      });
      await repo.updateStatus(d2.id, 'sending');
      await repo.updateStatus(d2.id, 'sent', { kkMessageId: 'kk_2' });

      const inFlight = await repo.getInFlightSendingDeliveries();
      expect(inFlight.some((d) => d.id === d1.id)).toBe(true);
      expect(inFlight.some((d) => d.id === d2.id)).toBe(false);
    });

    it('getUnresolvedUnknownDeliveries: 准确查询处于 unknown 状态的未解决记录', async () => {
      const d = await repo.createDelivery({
        id: 'deliv_unk_scan',
        runId: 'run_unk_scan',
        sessionId: 'ses_unk_scan',
        mastraMessageId: 'asst_unk_scan',
        content: '未知未解决 1',
        contentHash: 'hash_unk_scan',
      });
      await repo.updateStatus(d.id, 'sending');
      await repo.updateStatus(d.id, 'unknown', { errorCode: 'NET_TIMEOUT' });

      const unknowns = await repo.getUnresolvedUnknownDeliveries();
      expect(unknowns.some((item) => item.id === d.id)).toBe(true);
    });
  });

  describe('防复活门禁与事务原子回滚保障 (MEMORY-01 / DELIVERY-01)', () => {
    it('当输入消息已被墓碑化时，createDelivery 在事务内抛出 MessageTombstonedError 且整笔事务回滚不留孤立记录', async () => {
      const sessionId = 'ses_tomb_atomic';
      const inputMsgId = 'msg_tomb_target_1';

      // 先在 message_tombstones 写入墓碑
      await client.execute({
        sql: `INSERT INTO message_tombstones (id, session_id, message_id, tombstone_type, created_at)
              VALUES ('tb_atomic_1', ?, ?, 'compliance_deletion', ?)`,
        args: [sessionId, inputMsgId, Date.now()],
      });

      // 尝试创建关联此输入消息的 Delivery
      await expect(
        repo.createDelivery({
          id: 'deliv_atomic_fail',
          runId: 'run_atomic_fail',
          sessionId,
          mastraMessageId: 'asst_atomic_fail',
          content: '不应落库的违规内容',
          contentHash: 'hash_atomic_fail',
          inputMessageIds: [inputMsgId],
        })
      ).rejects.toThrow(/已被墓碑化/);

      // 验证 message_deliveries 中绝对无此记录
      const delivRes = await client.execute({
        sql: 'SELECT * FROM message_deliveries WHERE id = ?',
        args: ['deliv_atomic_fail'],
      });
      expect(delivRes.rows).toHaveLength(0);

      // 验证 delivery_input_messages 中绝对无此映射
      const mapRes = await client.execute({
        sql: 'SELECT * FROM delivery_input_messages WHERE delivery_id = ?',
        args: ['deliv_atomic_fail'],
      });
      expect(mapRes.rows).toHaveLength(0);
    });

    it('并发多会话调用 createDelivery 与 updateStatus: 在写锁与事务保护下全部 100% 成功，精确落库且无死锁', async () => {
      const totalConcurrent = 10;
      const promises: Promise<Delivery>[] = [];

      for (let i = 0; i < totalConcurrent; i++) {
        promises.push(
          repo.createDelivery({
            id: `deliv_pure_conc_${i}`,
            runId: `run_pure_conc_${i}`,
            sessionId: `ses_pure_conc_${i}`,
            mastraMessageId: `asst_pure_conc_${i}`,
            content: `并发回复内容 ${i}`,
            contentHash: `hash_pure_conc_${i}`,
            inputMessageIds: [`msg_pure_conc_input_${i}`],
          })
        );
      }

      const settledResults = await Promise.allSettled(promises);
      // 1. 断言全部 10 笔创建必须 100% 成功 (fulfilled)，严禁发生 SQLITE_BUSY 或死锁报错
      const fulfilledDeliveries = settledResults
        .filter((r): r is PromiseFulfilledResult<Delivery> => r.status === 'fulfilled')
        .map(r => r.value);
      expect(fulfilledDeliveries).toHaveLength(totalConcurrent);

      // 2. 验证每一笔 Delivery 的映射表完整性
      for (let i = 0; i < totalConcurrent; i++) {
        const delivId = `deliv_pure_conc_${i}`;
        const mapRes = await client.execute({
          sql: 'SELECT * FROM delivery_input_messages WHERE delivery_id = ?',
          args: [delivId],
        });
        expect(mapRes.rows).toHaveLength(1);
        const mapRow = mapRes.rows[0];
        expect(mapRow).toBeDefined();
        expect(mapRow?.message_id).toBe(`msg_pure_conc_input_${i}`);
      }
      // 3. 并发更新状态为 sending -> sent
      const updatePromises = fulfilledDeliveries.map(async (d) => {
        const sending = await repo.updateStatus(d.id, 'sending');
        expect(sending.status).toBe('sending');
        const sent = await repo.updateStatus(d.id, 'sent', { kkMessageId: `kk_${d.id}` });
        expect(sent.status).toBe('sent');
        return sent;
      });

      const updateResults = await Promise.allSettled(updatePromises);
      const successfulUpdates = updateResults.filter(r => r.status === 'fulfilled');
      expect(successfulUpdates).toHaveLength(totalConcurrent);
    });

    it('并发竞争场景：createDelivery 与写入 tombstone 竞争时保证原子互斥，成功创建的必有完整映射，被拒绝的必抛出 MessageTombstonedError', async () => {
      const sessionId = 'ses_tomb_concur';
      const inputMsgId = 'msg_tomb_target_concur';

      // 并发执行：10 次针对同一 inputMsgId 的 createDelivery 与 1 次写入 tombstone
      const delivPromises: Promise<Delivery>[] = [];
      for (let i = 0; i < 5; i++) {
        delivPromises.push(
          repo.createDelivery({
            id: `deliv_concur_${i}`,
            runId: `run_concur_${i}`,
            sessionId,
            mastraMessageId: `asst_concur_${i}`,
            content: `并发回复 ${i}`,
            contentHash: `hash_concur_${i}`,
            inputMessageIds: [inputMsgId],
          })
        );
      }
      const tombstonePromise = client.execute({
        sql: `INSERT INTO message_tombstones (id, session_id, message_id, tombstone_type, created_at)
              VALUES ('tb_atomic_concur', ?, ?, 'message_recall', ?)`,
        args: [sessionId, inputMsgId, Date.now()],
      });
      for (let i = 5; i < 10; i++) {
        delivPromises.push(
          repo.createDelivery({
            id: `deliv_concur_${i}`,
            runId: `run_concur_${i}`,
            sessionId,
            mastraMessageId: `asst_concur_${i}`,
            content: `并发回复 ${i}`,
            contentHash: `hash_concur_${i}`,
            inputMessageIds: [inputMsgId],
          })
        );
      }

      const [delivResults] = await Promise.all([
        Promise.allSettled(delivPromises),
        tombstonePromise,
      ]);

      expect(delivResults).toHaveLength(10);

      let fulfilledCount = 0;
      let rejectedCount = 0;

      for (const res of delivResults) {
        if (res.status === 'fulfilled') {
          fulfilledCount++;
          // 验证成功的 Delivery 在数据库中有且仅有 1 条映射
          const mapRes = await client.execute({
            sql: 'SELECT * FROM delivery_input_messages WHERE delivery_id = ?',
            args: [res.value.id],
          });
          expect(mapRes.rows).toHaveLength(1);
        } else {
          rejectedCount++;
          // 验证被拒绝的 Promise 必须是因为墓碑防复活门禁拦截
          expect(res.reason).toBeInstanceOf(MessageTombstonedError);
        }
      }

      // 总数必定为 10
      expect(fulfilledCount + rejectedCount).toBe(10);

      // 数据库中实际落库的 Delivery 数量必须精确等于 fulfilledCount
      const dbDeliveries = await repo.getDeliveriesBySession(sessionId);
      expect(dbDeliveries).toHaveLength(fulfilledCount);
    });
  });
});
