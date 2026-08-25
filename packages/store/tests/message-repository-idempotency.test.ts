import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Client } from '@libsql/client';
import {
  createDatabaseClient,
  closeDatabase,
  MessageRepository,
  type SaveMessageInput,
} from '../src/index.js';

describe('MessageRepository 数据库级唯一约束与并发幂等写入测试 (TDD Red -> Green)', () => {
  let client: Client;
  let repo: MessageRepository;

  beforeEach(async () => {
    // 采用真实临时内存 LibSQL 实例
    client = await createDatabaseClient({ path: ':memory:' });
    repo = new MessageRepository(client);
  });

  afterEach(() => {
    if (client) {
      closeDatabase(client);
    }
  });

  describe('1. 数据库级唯一约束与 origin 存储', () => {
    it('数据库表应成功持久化 messageId 与 origin 来源字段', async () => {
      const input: SaveMessageInput = {
        sessionId: 'group_test_001',
        messageId: 'msg_native_001',
        sender: '张三',
        senderId: 'user_001',
        content: '第一条测试群消息',
        messageType: 'text',
        origin: 'external',
      };

      const saved = await repo.saveMessage(input);
      expect(saved.id).toBeGreaterThan(0);
      expect(saved.sessionId).toBe('group_test_001');
      expect(saved.messageId).toBe('msg_native_001');
      expect(saved.origin).toBe('external');
      expect(saved.content).toBe('第一条测试群消息');

      const queried = await repo.getMessageBySessionAndMessageId(
        'group_test_001',
        'msg_native_001'
      );
      expect(queried).not.toBeNull();
      expect(queried?.id).toBe(saved.id);
      expect(queried?.origin).toBe('external');
      expect(queried?.messageId).toBe('msg_native_001');
    });
  });

  describe('2. 串行重放幂等测试 (Serial Replay Idempotency)', () => {
    it('相同 (session_id, message_id) 连续串行写入 5 次，数据库只形成一条事实记录', async () => {
      const input: SaveMessageInput = {
        sessionId: 'group_idempotent_serial',
        messageId: 'msg_serial_unique_100',
        sender: '李四',
        senderId: 'user_002',
        content: '串行重放测试消息',
        messageType: 'text',
        origin: 'external',
        createdAt: 1787640000000,
      };

      // 连续写入 5 次
      const r1 = await repo.saveMessage(input);
      const r2 = await repo.saveMessage(input);
      const r3 = await repo.saveMessage(input);
      const r4 = await repo.saveMessage(input);
      const r5 = await repo.saveMessage(input);

      // 验证每次返回的实体 id 相同
      expect(r1.id).toBe(r2.id);
      expect(r2.id).toBe(r3.id);
      expect(r3.id).toBe(r4.id);
      expect(r4.id).toBe(r5.id);

      // 验证数据库真实记录总数精确为 1
      const countRes = await client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = ? AND message_id = ?',
        args: [input.sessionId, input.messageId],
      });
      const count = Number(countRes.rows[0].cnt);
      expect(count).toBe(1);
    });
  });

  describe('3. 并发重放幂等测试 (Concurrent Replay Idempotency)', () => {
    it('相同 (session_id, message_id) 使用 Promise.all 并发写入 20 次，数据库必须保持精确 1 条事实', async () => {
      const input: SaveMessageInput = {
        sessionId: 'group_idempotent_concurrent',
        messageId: 'msg_concurrent_race_200',
        sender: '王五',
        senderId: 'user_003',
        content: '高并发写入竞争测试消息',
        messageType: 'text',
        origin: 'operator',
        createdAt: 1787640001000,
      };

      const concurrency = 20;
      const tasks = Array.from({ length: concurrency }, () => repo.saveMessage(input));
      const results = await Promise.all(tasks);

      expect(results).toHaveLength(concurrency);
      const firstId = results[0].id;
      for (const res of results) {
        expect(res.id).toBe(firstId);
        expect(res.messageId).toBe(input.messageId);
        expect(res.sessionId).toBe(input.sessionId);
      }

      const countRes = await client.execute({
        sql: 'SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = ? AND message_id = ?',
        args: [input.sessionId, input.messageId],
      });
      expect(Number(countRes.rows[0].cnt)).toBe(1);
    });
  });

  describe('4. 跨会话隔离与多消息共存测试', () => {
    it('两个不同 sessionId 拥有相同 messageId 时，必须分别保存为两条独立记录', async () => {
      const msgId = 'msg_shared_uuid_999';

      const msgA = await repo.saveMessage({
        sessionId: 'session_A',
        messageId: msgId,
        sender: '员工A',
        content: '会话A内容',
        origin: 'external',
      });

      const msgB = await repo.saveMessage({
        sessionId: 'session_B',
        messageId: msgId,
        sender: '员工B',
        content: '会话B内容',
        origin: 'external',
      });

      expect(msgA.id).not.toBe(msgB.id);
      expect(msgA.sessionId).toBe('session_A');
      expect(msgB.sessionId).toBe('session_B');
      expect(msgA.messageId).toBe(msgId);
      expect(msgB.messageId).toBe(msgId);

      const totalCount = await repo.countMessages();
      expect(totalCount).toBe(2);
    });

    it('同一 sessionId 的不同 messageId 分别正常保存', async () => {
      const sid = 'session_same';

      const m1 = await repo.saveMessage({
        sessionId: sid,
        messageId: 'msg_1',
        sender: '员工',
        content: '消息1',
      });

      const m2 = await repo.saveMessage({
        sessionId: sid,
        messageId: 'msg_2',
        sender: '员工',
        content: '消息2',
      });

      expect(m1.id).not.toBe(m2.id);
      const history = await repo.getSessionHistory(sid);
      expect(history).toHaveLength(2);
    });
  });

  describe('5. 非唯一约束底层错误保留测试', () => {
    it('当发生非唯一约束错误 (如连接已关闭) 时，必须向上抛出且保留错误原因', async () => {
      closeDatabase(client);

      const input: SaveMessageInput = {
        sessionId: 'group_err',
        messageId: 'msg_err_1',
        sender: '张三',
        content: '失败消息',
      };

      await expect(repo.saveMessage(input)).rejects.toThrow();
    });
  });
});
