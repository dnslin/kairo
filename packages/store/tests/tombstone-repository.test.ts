import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createKKBotStore, type KKBotStore } from '../src/index.js';

describe('TombstoneRepository & Compliance Deletion in KKBotStore', () => {
  let store: KKBotStore;

  beforeEach(async () => {
    store = await createKKBotStore({
      url: 'file::memory:',
    });
  });

  afterEach(() => {
    store.close();
  });

  it('records recall tombstone and checks isTombstoned and getTombstoneSet', async () => {
    const sessionId = 'session_tomb_01';
    const messageId = 'msg_native_001';

    expect(await store.tombstones.isTombstoned(sessionId, messageId)).toBe(false);

    const tombstone = await store.tombstones.recordTombstone({
      sessionId,
      messageId,
      type: 'recall',
      reason: '用户主动撤回',
      operator: 'employee_1',
    });

    expect(tombstone.sessionId).toBe(sessionId);
    expect(tombstone.messageId).toBe(messageId);
    expect(tombstone.tombstoneType).toBe('recall');
    expect(tombstone.reason).toBe('用户主动撤回');

    expect(await store.tombstones.isTombstoned(sessionId, messageId)).toBe(true);

    const set = await store.tombstones.getTombstoneSet(sessionId);
    expect(set.has(messageId)).toBe(true);
    expect(set.size).toBe(1);

    const list = await store.tombstones.getTombstonesBySession(sessionId);
    expect(list).toHaveLength(1);
    expect(list[0].messageId).toBe(messageId);
  });

  it('compliance_deletion tombstone overrides recall tombstone', async () => {
    const sessionId = 'session_tomb_02';
    const messageId = 'msg_native_002';

    // 1. 先记录普通撤回墓碑
    await store.tombstones.recordTombstone({
      sessionId,
      messageId,
      type: 'recall',
    });

    let record = await store.tombstones.getTombstone(sessionId, messageId);
    expect(record?.tombstoneType).toBe('recall');

    // 2. 升级为正式合规删除墓碑
    await store.tombstones.recordTombstone({
      sessionId,
      messageId,
      type: 'compliance_deletion',
      reason: 'GDPR 合规删除',
      operator: 'compliance_officer_1',
    });

    record = await store.tombstones.getTombstone(sessionId, messageId);
    expect(record?.tombstoneType).toBe('compliance_deletion');
    expect(record?.reason).toBe('GDPR 合规删除');
    expect(record?.operator).toBe('compliance_officer_1');
  });

  it('saveMessage prevents resurrection when tombstoned with compliance_deletion', async () => {
    const sessionId = 'session_tomb_03';
    const messageId = 'msg_native_003';

    // 预先建立合规删除墓碑
    await store.tombstones.recordTombstone({
      sessionId,
      messageId,
      type: 'compliance_deletion',
      reason: '合规删除',
    });

    // 尝试重放写入该 messageId 的消息
    const saved = await store.messages.saveMessage({
      sessionId,
      messageId,
      sender: '员工A',
      content: '机密商业数据',
      rawPayload: { confidential: true },
      isFromSelf: false,
    });

    // 验证正文被原子拒绝写入，返回值标记为 [COMPLIANCE_DELETED]，载荷为 null，标记为 isRecalled 且 isNewlyInserted 为 false
    expect(saved.content).toBe('[COMPLIANCE_DELETED]');
    expect(saved.rawPayload).toBeNull();
    expect(saved.isRecalled).toBe(true);
    expect(saved.isNewlyInserted).toBe(false);

    // 验证底层 session_messages 数据表确实零写入（绝不残留明文或脏记录）
    const query = await store.messages.getMessageBySessionAndMessageId(sessionId, messageId);
    expect(query).toBeNull();
    expect(await store.tombstones.isTombstoned(sessionId, messageId)).toBe(true);
  });

  it('erases message content for message, session, and employee', async () => {
    const sessionId = 'session_erase_01';
    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_e1',
      sender: '员工A',
      senderId: 'emp_001',
      content: '敏感信息1',
      rawPayload: { file: 'secret.pdf' },
    });

    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_e2',
      sender: '员工A',
      senderId: 'emp_001',
      content: '敏感信息2',
      rawPayload: { file: 'secret2.pdf' },
    });

    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_e3',
      sender: '员工B',
      senderId: 'emp_002',
      content: '员工B普通信息',
    });

    // 1. 擦除单条消息
    const erased1 = await store.messages.eraseMessageContent(sessionId, 'msg_e1');
    expect(erased1).toBe(1);
    const m1 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_e1');
    expect(m1?.content).toBe('[COMPLIANCE_DELETED]');
    expect(m1?.rawPayload).toBeNull();
    expect(m1?.isRecalled).toBe(true);

    // 2. 按员工擦除
    const erasedEmp = await store.messages.eraseEmployeeMessagesContent('emp_001');
    expect(erasedEmp).toBeGreaterThanOrEqual(1);
    const m2 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_e2');
    expect(m2?.content).toBe('[COMPLIANCE_DELETED]');
    expect(m2?.rawPayload).toBeNull();

    // 员工B消息仍保留
    const m3 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_e3');
    expect(m3?.content).toBe('员工B普通信息');

    // 3. 擦除整个会话
    await store.messages.eraseSessionMessagesContent(sessionId);
    const m3After = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_e3');
    expect(m3After?.content).toBe('[COMPLIANCE_DELETED]');
  });

  it('erases delivery content while keeping status and audit fields', async () => {
    const deliveryId = 'deliv_erase_01';
    const runId = 'run_erase_01';
    const sessionId = 'session_erase_deliv';

    await store.deliveries.createDelivery({
      id: deliveryId,
      runId,
      sessionId,
      mastraMessageId: 'msg_asst_01',
      content: '已发送的回复正文包含敏感信息',
      contentHash: 'hash123',
      status: 'sent',
      kkMessageId: 'kk_sent_01',
    });

    const erased = await store.deliveries.eraseDeliveryContent(deliveryId);
    expect(erased).toBe(true);

    const d = await store.deliveries.getDeliveryById(deliveryId);
    expect(d).toBeDefined();
    expect(d?.content).toBe('[COMPLIANCE_DELETED]');
    expect(d?.contentHash).toBe('');
    expect(d?.status).toBe('sent'); // 真实交付事实严格保留！
    expect(d?.kkMessageId).toBe('kk_sent_01');
  });

  it('records compliance deletion audit record idempotently', async () => {
    const commandId = 'cmd_cdel_001';

    const record1 = await store.tombstones.recordComplianceDeletion({
      commandId,
      targetType: 'message',
      targetId: 'msg_target_01',
      sessionId: 'session_cdel_01',
      scope: JSON.stringify({ messageId: 'msg_target_01' }),
      reason: '合规要求',
      operator: 'admin',
      status: 'completed',
      erasedMessagesCount: 1,
      erasedDeliveriesCount: 1,
    });

    expect(record1.commandId).toBe(commandId);
    expect(record1.status).toBe('completed');
    expect(record1.erasedMessagesCount).toBe(1);

    // 重放同一 commandId
    const record2 = await store.tombstones.recordComplianceDeletion({
      commandId,
      targetType: 'message',
      targetId: 'msg_target_01',
      sessionId: 'session_cdel_01',
      scope: JSON.stringify({ messageId: 'msg_target_01' }),
      reason: '合规要求',
      operator: 'admin',
      status: 'completed',
      erasedMessagesCount: 1,
      erasedDeliveriesCount: 1,
    });

    expect(record2.id).toBe(record1.id);
    expect(record2.commandId).toBe(commandId);
  });

  it('saveMessages batch insertion atomically respects message_tombstones', async () => {
    const sessionId = 'session_batch_tomb';
    const msg1 = 'msg_b1';
    const msg2 = 'msg_b2';

    // 预先建立 msg1 的合规删除墓碑
    await store.tombstones.recordTombstone({
      sessionId,
      messageId: msg1,
      type: 'compliance_deletion',
      reason: '合规删除',
    });

    // 批量保存包含 msg1 和 msg2
    const batchRes = await store.messages.saveMessages([
      {
        sessionId,
        messageId: msg1,
        sender: '员工A',
        content: '机密消息1',
      },
      {
        sessionId,
        messageId: msg2,
        sender: '员工A',
        content: '正常消息2',
      },
    ]);

    expect(batchRes).toHaveLength(2);
    // msg1 被墓碑原子拒绝，返回 [COMPLIANCE_DELETED]
    expect(batchRes[0].messageId).toBe(msg1);
    expect(batchRes[0].content).toBe('[COMPLIANCE_DELETED]');
    expect(batchRes[0].isNewlyInserted).toBe(false);

    // msg2 正常落库
    expect(batchRes[1].messageId).toBe(msg2);
    expect(batchRes[1].content).toBe('正常消息2');
    expect(batchRes[1].isNewlyInserted).toBe(true);

    // 确认数据库真实状态
    const q1 = await store.messages.getMessageBySessionAndMessageId(sessionId, msg1);
    expect(q1).toBeNull();
    const q2 = await store.messages.getMessageBySessionAndMessageId(sessionId, msg2);
    expect(q2?.content).toBe('正常消息2');
  });

  it('concurrent saveMessage and compliance deletion sequence guarantees zero plaintext in DB', async () => {
    const sessionId = 'session_concurrent_tomb';
    const messageId = 'msg_conc_01';

    // 模拟合规删除完整序列 (建立墓碑 + 擦除既有正文)
    const runComplianceSequence = async () => {
      await store.tombstones.recordTombstone({
        sessionId,
        messageId,
        type: 'compliance_deletion',
        reason: '并发合规删除',
        operator: 'officer_1',
      });
      await store.messages.eraseMessageContent(sessionId, messageId);
    };

    // 并发执行：一边尝试写入消息，一边执行合规删除序列
    await Promise.all([
      runComplianceSequence(),
      store.messages.saveMessage({
        sessionId,
        messageId,
        sender: '员工C',
        content: '并发机密内容',
      }),
    ]);

    // 无论谁先到达：墓碑必须生效
    const tomb = await store.tombstones.getTombstone(sessionId, messageId);
    expect(tomb?.tombstoneType).toBe('compliance_deletion');

    // 核心断言：合规删除序列完成后，数据库绝对无明文残留
    const dbRecord = await store.messages.getMessageBySessionAndMessageId(sessionId, messageId);
    if (dbRecord) {
      expect(dbRecord.content).toBe('[COMPLIANCE_DELETED]');
      expect(dbRecord.rawPayload).toBeNull();
      expect(dbRecord.isTombstoned).toBe(true);
    } else {
      // 若 tombstone 先到达，则 session_messages 中完全为 null（零写入）
      expect(dbRecord).toBeNull();
    }

    // 后续任何再次 saveMessage 重放必须被原子拒绝，返回 isTombstoned=true 与 [COMPLIANCE_DELETED]
    const replay = await store.messages.saveMessage({
      sessionId,
      messageId,
      sender: '员工C',
      content: '并发机密内容重放',
    });
    expect(replay.content).toBe('[COMPLIANCE_DELETED]');
    expect(replay.isTombstoned).toBe(true);
    expect(replay.isNewlyInserted).toBe(false);
  });
});
