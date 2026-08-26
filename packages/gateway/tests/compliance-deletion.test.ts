import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { LibSQLStore } from '@mastra/libsql';
import type { KK9Driver, KK9Message, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore, type ComplianceDeletionCommand } from '@kkbot/store';
import {
  KKBotAgent,
  MastraModelFactory,
  Memory,
  createFakeModel,
  deriveUserMessageId,
  deriveAssistantMessageId,
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

describe('ComplianceDeletion 正式合规删除与防复活机制', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let mockDriver: MockDriver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-compliance-test-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });

    libSqlStore = new LibSQLStore({
      id: 'test-compliance-storage',
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

  it('未授权的合规删除命令必须被门禁拦截拒绝 (Fail-Closed)，不破坏任何数据', async () => {
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      mastraMemory,
      mastraStorage: libSqlStore,
      complianceAuthorizer: command => {
        if (command.operator !== 'dpo_authorized_officer') {
          return { authorized: false, reason: '操作员无合规删除授权' };
        }
        return { authorized: true, policyReference: 'GDPR-ARTICLE-17' };
      },
    });
    await coordinator.start();

    const sessionId = 'session_unauth_01';
    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_unauth_1',
      sender: '员工',
      content: '保留的重要数据',
    });

    const unauthorizedCmd: ComplianceDeletionCommand = {
      commandId: 'cmd_unauth_001',
      targetType: 'message',
      targetId: 'msg_unauth_1',
      sessionId,
      reason: '未授权删除',
      operator: 'unauthorized_hacker',
    };

    await expect(coordinator.executeComplianceDeletion(unauthorizedCmd)).rejects.toThrow('合规删除命令授权拒绝: 操作员无合规删除授权');

    // 验证数据未被破坏
    const raw = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_unauth_1');
    expect(raw?.content).toBe('保留的重要数据');
  });

  it('单条消息 ComplianceDeletion 擦除 Raw Store, Memory 与 Delivery 正文，保留真实 Delivery 状态与审计记录', async () => {
    const model = createFakeModel({
      responses: [{ text: '生成的已发送回复包含敏感分析', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 20, maxWaitMs: 100 },
      complianceAuthorizer: () => ({ authorized: true, policyReference: 'GDPR-ARTICLE-17' }),
    });
    await coordinator.start();

    const sessionId = 'session_comp_msg_001';
    const userMsgId = 'msg_user_privacy_01';

    // 1. 发送消息并跑通闭环
    await coordinator.handleInboundMessage({
      id: userMsgId,
      sessionId,
      sender: '员工李',
      senderId: 'emp_li',
      content: '包含机密手机号 13800000000 的数据',
      sessionType: 'private',
      isMe: false,
    });

    await new Promise(r => setTimeout(r, 200));

    // 检查初始状态：Raw Store, Memory 与 Delivery 均有明文
    const initialRaw = await store.messages.getMessageBySessionAndMessageId(sessionId, userMsgId);
    expect(initialRaw?.content).toBe('包含机密手机号 13800000000 的数据');

    const initialMem = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_li' });
    expect(initialMem.messages).toHaveLength(2);

    const initialDeliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(initialDeliveries[0].status).toBe('sent');
    expect(initialDeliveries[0].content).toBe('生成的已发送回复包含敏感分析');

    // 2. 执行合规删除命令
    const command: ComplianceDeletionCommand = {
      commandId: 'cmd_comp_msg_dpo_01',
      targetType: 'message',
      targetId: userMsgId,
      sessionId,
      scope: { rawStore: true, explicitMemory: true, deliveries: true },
      reason: '员工离职要求清除所有个人隐私数据',
      operator: 'dpo_authorized_officer',
    };

    const record = await coordinator.executeComplianceDeletion(command);
    expect(record.status).toBe('completed');
    expect(record.erasedMessagesCount).toBe(1);
    expect(record.erasedDeliveriesCount).toBe(1);

    // 验证 1: Raw Store 正文被彻底擦除为 [COMPLIANCE_DELETED]
    const erasedRaw = await store.messages.getMessageBySessionAndMessageId(sessionId, userMsgId);
    expect(erasedRaw?.content).toBe('[COMPLIANCE_DELETED]');
    expect(erasedRaw?.rawPayload).toBeNull();

    // 验证 2: 显式 Memory 中 user message 已被彻底移除
    const afterMem = await mastraMemory.recall({ threadId: sessionId, resourceId: 'emp_li' });
    expect(afterMem.messages.find(m => m.id === deriveUserMessageId(sessionId, userMsgId))).toBeUndefined();

    // 验证 3: 关联 Delivery 正文被精准擦除，但 sent 状态严格保留
    const afterDeliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(afterDeliveries[0].content).toBe('[COMPLIANCE_DELETED]');
    expect(afterDeliveries[0].contentHash).toBe('');
    expect(afterDeliveries[0].status).toBe('sent');

    // 验证 4: 持久合规删除墓碑已建立
    const tomb = await store.tombstones.getTombstone(sessionId, userMsgId);
    expect(tomb?.tombstoneType).toBe('compliance_deletion');

    // 验证 5: 重复执行同一命令保持幂等
    const recordReplay = await coordinator.executeComplianceDeletion(command);
    expect(recordReplay.id).toBe(record.id);
    expect(recordReplay.status).toBe('completed');
  });

  it('会话级 ComplianceDeletion 擦除整会话所有消息与 Delivery 正文，并清空 Thread 与 OM Scope', async () => {
    const sessionId = 'session_compliance_all_002';

    // 写入消息
    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_s_1',
      sender: '王五',
      senderId: 'emp_wang5',
      content: '会话敏感消息1',
    });
    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_s_2',
      sender: '王五',
      senderId: 'emp_wang5',
      content: '会话敏感消息2',
    });

    // 写入 Delivery
    await store.deliveries.createDelivery({
      id: 'deliv_s_1',
      runId: 'run_s_1',
      sessionId,
      mastraMessageId: deriveAssistantMessageId('deliv_s_1'),
      content: '敏感交付回复1',
      contentHash: 'hash_s_1',
      status: 'sent',
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      mastraMemory,
      mastraStorage: libSqlStore,
      complianceAuthorizer: () => ({ authorized: true, policyReference: 'POLICY-DATA-RETENTION' }),
    });

    const command: ComplianceDeletionCommand = {
      commandId: 'cmd_comp_session_full_001',
      targetType: 'session',
      targetId: sessionId,
      scope: { rawStore: true, deliveries: true, explicitMemory: true },
      reason: '项目结束数据销毁',
      operator: 'compliance_officer',
    };

    const record = await coordinator.executeComplianceDeletion(command);
    expect(record.status).toBe('completed');
    expect(record.erasedMessagesCount).toBe(2);
    expect(record.erasedDeliveriesCount).toBe(1);

    // 验证 Delivery 正文被擦除但 sent 事实保留
    const deliv = await store.deliveries.getDeliveryById('deliv_s_1');
    expect(deliv?.content).toBe('[COMPLIANCE_DELETED]');
    expect(deliv?.status).toBe('sent');

    // 验证所有消息正文被擦除
    const m1 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_s_1');
    expect(m1?.content).toBe('[COMPLIANCE_DELETED]');
    const m2 = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_s_2');
    expect(m2?.content).toBe('[COMPLIANCE_DELETED]');
  });

  it('被合规删除的消息在重放时被静默抑制，绝不复活', async () => {
    const model = createFakeModel({
      responses: [{ text: '不应被调用', finishReason: 'stop' }],
    });
    const agent = createTestAgent(model, mastraMemory);

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      mastraStorage: libSqlStore,
      config: { debounceMs: 50, maxWaitMs: 200 },
      complianceAuthorizer: () => ({ authorized: true }),
    });
    await coordinator.start();

    const sessionId = 'session_antiresurrect_comp_01';
    const tombstonedMsgId = 'msg_dead_comp_001';

    // 1. 预先建立持久合规删除墓碑
    await store.tombstones.recordTombstone({
      sessionId,
      messageId: tombstonedMsgId,
      type: 'compliance_deletion',
      reason: '已合规销毁',
      operator: 'dpo',
    });

    let suppressedFired = false;
    coordinator.on('suppressed', (sid, reason) => {
      if (sid === sessionId && reason === 'tombstoned') {
        suppressedFired = true;
      }
    });

    // 2. 模拟网络重放该已删除消息
    await coordinator.handleInboundMessage({
      id: tombstonedMsgId,
      sessionId,
      sender: '员工',
      senderId: 'emp_dead_comp',
      content: '试图复活的敏感正文',
      sessionType: 'private',
      isMe: false,
    });

    // 验证 1: 触发了 tombstoned 静默抑制事件
    expect(suppressedFired).toBe(true);

    // 验证 2: 绝不创建/提交 user Memory (Thread 绝不存在)
    const thread = await mastraMemory.getThreadById({ threadId: sessionId });
    expect(thread).toBeNull();

    // 验证 3: 绝不调用 Driver 发送
    expect(mockDriver.sendText).not.toHaveBeenCalled();

    // 验证 4: Raw Store 中无明文
    const raw = await store.messages.getMessageBySessionAndMessageId(sessionId, tombstonedMsgId);
    expect(raw).toBeNull();
  });

  it('非法的 JSON scope 参数必须 Fail-Closed 抛出异常且记录 failed 审计，绝不默认擦除数据', async () => {
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      mastraMemory,
      mastraStorage: libSqlStore,
      complianceAuthorizer: () => ({ authorized: true }),
    });
    await coordinator.start();

    const sessionId = 'session_malformed_scope_01';
    await store.messages.saveMessage({
      sessionId,
      messageId: 'msg_malformed_1',
      sender: '员工',
      content: '受保护的重要业务数据',
    });

    const invalidCmd: ComplianceDeletionCommand = {
      commandId: 'cmd_malformed_scope_001',
      targetType: 'message',
      targetId: 'msg_malformed_1',
      sessionId,
      scope: '{ invalid json format :::',
      reason: '错误格式命令',
      operator: 'admin',
    };

    await expect(coordinator.executeComplianceDeletion(invalidCmd)).rejects.toThrow(
      /合规删除 scope 参数不是合法的 JSON/
    );

    // 验证数据未被错误擦除
    const rawMsg = await store.messages.getMessageBySessionAndMessageId(sessionId, 'msg_malformed_1');
    expect(rawMsg?.content).toBe('受保护的重要业务数据');

    // 验证审计记录为 failed
    const auditRecord = await store.tombstones.getComplianceDeletion('cmd_malformed_scope_001');
    expect(auditRecord?.status).toBe('failed');
  });

  it('Session 删除时若 Memory deleteThread 失败，必须抛出带 cause 的异常且审计记录为 failed', async () => {
    const failingMemory = new Memory({
      storage: libSqlStore,
    });
    (failingMemory as unknown as { deleteThread: () => Promise<void> }).deleteThread = vi
      .fn()
      .mockRejectedValue(new Error('Mastra Storage 驱动硬件故障'));

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      mastraMemory: failingMemory,
      mastraStorage: libSqlStore,
      complianceAuthorizer: () => ({ authorized: true }),
    });
    await coordinator.start();

    const sessionId = 'session_delete_thread_fail_01';
    const failCmd: ComplianceDeletionCommand = {
      commandId: 'cmd_thread_fail_001',
      targetType: 'session',
      targetId: sessionId,
      reason: '销毁数据',
      operator: 'compliance_officer',
    };

    await expect(coordinator.executeComplianceDeletion(failCmd)).rejects.toThrow(
      /Mastra Thread 删除失败/
    );

    // 验证审计状态记录为 failed，严禁虚标 completed
    const auditRecord = await store.tombstones.getComplianceDeletion('cmd_thread_fail_001');
    expect(auditRecord?.status).toBe('failed');
    expect(auditRecord?.error).toContain('Mastra Thread 删除失败');
  });
});
