import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  closeDatabase,
  createDatabase,
  KKBotStore,
  MediaStorage,
  MessageRepository,
  Store,
  type MessageRawPayload,
  type SaveMessageInput,
} from '../src/index.js';

describe('MessageRepository 与会话消息持久化、原生 ID 撤回与多模态转存测试 (TDD Red -> Green)', () => {
  let db: Database.Database;
  let repo: MessageRepository;
  let tempDir: string;
  let mediaStorage: MediaStorage;

  beforeEach(() => {
    // 为每个测试用例分配完全隔离的内存数据库
    db = createDatabase({ path: ':memory:' });
    repo = new MessageRepository(db);

    // 为多模态转存创建隔离的临时测试目录
    tempDir = join(
      tmpdir(),
      `kkbot-test-media-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    );
    mkdirSync(tempDir, { recursive: true });
    mediaStorage = new MediaStorage({ baseDir: tempDir });
  });

  afterEach(() => {
    closeDatabase(db);
    if (existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  describe('1. 数据库 DDL 表结构与索引初始化', () => {
    it('应正确创建 session_messages 表并包含所有必需字段', () => {
      const tableInfo = db
        .prepare<
          [],
          {
            cid: number;
            name: string;
            type: string;
            notnull: number;
            dflt_value: string | null;
            pk: number;
          }
        >('PRAGMA table_info(session_messages)')
        .all();

      const columnNames = tableInfo.map(c => c.name);
      expect(columnNames).toContain('id');
      expect(columnNames).toContain('session_id');
      expect(columnNames).toContain('message_id');
      expect(columnNames).toContain('sender');
      expect(columnNames).toContain('sender_id');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('message_type');
      expect(columnNames).toContain('raw_payload');
      expect(columnNames).toContain('reply_target_id');
      expect(columnNames).toContain('is_from_self');
      expect(columnNames).toContain('is_recalled');
      expect(columnNames).toContain('created_at');

      // 验证主键定义
      const idCol = tableInfo.find(c => c.name === 'id');
      expect(idCol?.pk).toBe(1);
    });

    it('应正确建立 session_messages 的核心索引', () => {
      const indices = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='session_messages' ORDER BY name"
        )
        .all()
        .map(i => i.name);

      expect(indices).toContain('idx_session_messages_session_id');
      expect(indices).toContain('idx_session_messages_message_id');
      expect(indices).toContain('idx_session_messages_session_message_id');
      expect(indices).toContain('idx_session_messages_session_created');
      expect(indices).toContain('idx_session_messages_session_recalled');
    });
  });

  describe('2. saveMessage: 消息持久化与单/批量写入', () => {
    it('应成功保存单条纯文本消息并返回完整的 SessionMessage 实体', () => {
      const input: SaveMessageInput = {
        sessionId: 'session-001',
        messageId: 'native-msg-1001',
        sender: '张三',
        senderId: 'emp-001',
        content: '你好，这是第一条测试消息',
        messageType: 'text',
        isFromSelf: false,
        createdAt: 1700000000000,
      };

      const saved = repo.saveMessage(input);

      expect(saved.id).toBeGreaterThan(0);
      expect(saved.sessionId).toBe('session-001');
      expect(saved.messageId).toBe('native-msg-1001');
      expect(saved.sender).toBe('张三');
      expect(saved.senderId).toBe('emp-001');
      expect(saved.content).toBe('你好，这是第一条测试消息');
      expect(saved.messageType).toBe('text');
      expect(saved.rawPayload).toBeNull();
      expect(saved.replyTargetId).toBeNull();
      expect(saved.isFromSelf).toBe(false);
      expect(saved.isRecalled).toBe(false);
      expect(saved.createdAt).toBe(1700000000000);
    });

    it('应支持默认缺省值（createdAt 自动赋值为当前时间戳、messageType 默认为 text）', () => {
      const nowBefore = Date.now();
      const saved = repo.saveMessage({
        sessionId: 'session-002',
        sender: '李四',
        content: '缺省参数测试',
      });
      const nowAfter = Date.now();

      expect(saved.id).toBeGreaterThan(0);
      expect(saved.messageId).toBeNull();
      expect(saved.senderId).toBeNull();
      expect(saved.messageType).toBe('text');
      expect(saved.isFromSelf).toBe(false);
      expect(saved.isRecalled).toBe(false);
      expect(saved.createdAt).toBeGreaterThanOrEqual(nowBefore);
      expect(saved.createdAt).toBeLessThanOrEqual(nowAfter);
    });

    it('应支持通过 saveMessages 单事务原子批量保存多条消息', () => {
      const inputs: SaveMessageInput[] = [
        {
          sessionId: 'session-batch',
          messageId: 'm-1',
          sender: 'A',
          content: 'Msg 1',
          createdAt: 1000,
        },
        {
          sessionId: 'session-batch',
          messageId: 'm-2',
          sender: 'B',
          content: 'Msg 2',
          createdAt: 2000,
        },
        {
          sessionId: 'session-batch',
          messageId: 'm-3',
          sender: 'A',
          content: 'Msg 3',
          createdAt: 3000,
        },
      ];

      const savedList = repo.saveMessages(inputs);
      expect(savedList).toHaveLength(3);
      expect(savedList[0].id).toBeLessThan(savedList[1].id);
      expect(savedList[1].id).toBeLessThan(savedList[2].id);
      expect(savedList.map(s => s.messageId)).toEqual(['m-1', 'm-2', 'm-3']);
    });
  });

  describe('3. markMessageRecalled: 原生 ID 100% 精确撤回', () => {
    it('应基于原生 messageId 精准标记撤回状态 (is_recalled = 1)', () => {
      repo.saveMessage({
        sessionId: 'session-recall',
        messageId: 'native-recall-target',
        sender: '王五',
        content: '这是一条即将被撤回的消息',
      });

      repo.saveMessage({
        sessionId: 'session-recall',
        messageId: 'native-recall-other',
        sender: '赵六',
        content: '这是一条正常消息',
      });

      // 撤回目标消息
      const success = repo.markMessageRecalled('session-recall', 'native-recall-target');
      expect(success).toBe(true);

      // 验证目标消息已被标记为撤回
      const target = repo.getMessageByNativeId('session-recall', 'native-recall-target');
      expect(target).not.toBeNull();
      expect(target?.isRecalled).toBe(true);

      // 验证其他消息未受影响
      const other = repo.getMessageByNativeId('session-recall', 'native-recall-other');
      expect(other).not.toBeNull();
      expect(other?.isRecalled).toBe(false);
    });

    it('对不存在的原生 messageId 撤回应返回 false', () => {
      const success = repo.markMessageRecalled('session-recall', 'non-existent-id');
      expect(success).toBe(false);
    });

    it('跨会话应严格隔离，即使原生 messageId 相同也不会误撤回其他会话的消息', () => {
      repo.saveMessage({
        sessionId: 'session-A',
        messageId: 'duplicate-native-id',
        sender: 'A1',
        content: '会话A的消息',
      });

      repo.saveMessage({
        sessionId: 'session-B',
        messageId: 'duplicate-native-id',
        sender: 'B1',
        content: '会话B的消息',
      });

      // 仅撤回会话 A 中的消息
      const success = repo.markMessageRecalled('session-A', 'duplicate-native-id');
      expect(success).toBe(true);

      const msgA = repo.getMessageByNativeId('session-A', 'duplicate-native-id');
      const msgB = repo.getMessageByNativeId('session-B', 'duplicate-native-id');

      expect(msgA?.isRecalled).toBe(true);
      expect(msgB?.isRecalled).toBe(false);
    });

    it('应支持按数据库自增 ID 撤回 (markMessageRecalledById)', () => {
      const saved = repo.saveMessage({
        sessionId: 'session-by-id',
        sender: '孙七',
        content: '按自增ID撤回测试',
      });

      const success = repo.markMessageRecalledById(saved.id);
      expect(success).toBe(true);

      const fetched = repo.getMessageById(saved.id);
      expect(fetched?.isRecalled).toBe(true);
    });
  });

  describe('4. getSessionHistory: 历史上下文查询与自动过滤撤回消息', () => {
    beforeEach(() => {
      // 预先写入一系列会话消息，包含正常消息与撤回消息
      repo.saveMessages([
        { sessionId: 's-hist', messageId: 'm-1', sender: 'U1', content: '消息 1', createdAt: 1000 },
        {
          sessionId: 's-hist',
          messageId: 'm-2',
          sender: 'U2',
          content: '消息 2 (将被撤回)',
          createdAt: 2000,
        },
        { sessionId: 's-hist', messageId: 'm-3', sender: 'U1', content: '消息 3', createdAt: 3000 },
        {
          sessionId: 's-hist',
          messageId: 'm-4',
          sender: 'U2',
          content: '消息 4 (将被撤回)',
          createdAt: 4000,
        },
        { sessionId: 's-hist', messageId: 'm-5', sender: 'U1', content: '消息 5', createdAt: 5000 },
      ]);

      repo.markMessageRecalled('s-hist', 'm-2');
      repo.markMessageRecalled('s-hist', 'm-4');
    });

    it('默认 getSessionHistory 应在 SQL 层面完全过滤已撤回的消息', () => {
      const history = repo.getSessionHistory('s-hist');

      expect(history).toHaveLength(3);
      expect(history.map(m => m.messageId)).toEqual(['m-1', 'm-3', 'm-5']);
      expect(history.map(m => m.content)).toEqual(['消息 1', '消息 3', '消息 5']);
      expect(history.every(m => !m.isRecalled)).toBe(true);
    });

    it('传入 limit 时应返回最新的 N 条有效消息且保持时序正序排列', () => {
      const latest2 = repo.getSessionHistory('s-hist', 2);

      expect(latest2).toHaveLength(2);
      expect(latest2.map(m => m.messageId)).toEqual(['m-3', 'm-5']);
      expect(latest2[0].createdAt).toBeLessThan(latest2[1].createdAt);
    });

    it('当指定 includeRecalled: true 时应能查到包含已撤回消息的完整审计历史', () => {
      const fullHistory = repo.getSessionHistory('s-hist', { includeRecalled: true });

      expect(fullHistory).toHaveLength(5);
      expect(fullHistory.map(m => m.messageId)).toEqual(['m-1', 'm-2', 'm-3', 'm-4', 'm-5']);
      expect(fullHistory.filter(m => m.isRecalled)).toHaveLength(2);
    });

    it('应支持基于 beforeId 或 beforeTimestamp 进行向上滚动分页', () => {
      const page = repo.getSessionHistory('s-hist', { beforeTimestamp: 5000, limit: 10 });
      expect(page.map(m => m.messageId)).toEqual(['m-1', 'm-3']);
    });
  });

  describe('5. 多模态载荷 (raw_payload) 序列化与结构化读写', () => {
    it('应正确持久化并反序列化图片、文件、@ 提及与引用回复的多模态载荷', () => {
      const payload: MessageRawPayload = {
        images: [
          {
            relativePath: 'images/2026-08/sample-photo.png',
            width: 1920,
            height: 1080,
            size: 204800,
            mimeType: 'image/png',
          },
        ],
        fileInfo: {
          name: '2026年技术架构白皮书.pdf',
          size: '15.4MB',
          relativePath: 'files/2026-08/arch-whitepaper.pdf',
          extension: '.pdf',
        },
        mentions: {
          isAtMe: true,
          isAtAll: false,
          mentionedUsers: ['10086', '10087'],
        },
        replyTo: {
          id: 'native-ref-999',
          sender: '主管领导',
          content: '请尽快提交本周技术方案',
        },
      };

      const saved = repo.saveMessage({
        sessionId: 'session-multimodal',
        messageId: 'native-multi-01',
        sender: '系统研发',
        senderId: 'emp-tech-01',
        content: '[图片] [文件] @张三 @李四 请查阅',
        messageType: 'rich-text',
        rawPayload: payload,
        replyTargetId: 'native-ref-999',
      });

      expect(saved.id).toBeGreaterThan(0);
      expect(saved.rawPayload).toEqual(payload);
      expect(saved.rawPayload?.images?.[0].relativePath).toBe('images/2026-08/sample-photo.png');
      expect(saved.rawPayload?.fileInfo?.name).toBe('2026年技术架构白皮书.pdf');
      expect(saved.rawPayload?.mentions?.isAtMe).toBe(true);
      expect(saved.replyTargetId).toBe('native-ref-999');

      // 从数据库重新读取验证
      const fetched = repo.getMessageById(saved.id);
      expect(fetched?.rawPayload).toEqual(payload);
      expect(fetched?.replyTargetId).toBe('native-ref-999');
    });

    it('当传入字符串形式的 rawPayload 时也应安全解析', () => {
      const jsonStr = JSON.stringify({ customKey: 'customValue', number: 42 });
      const saved = repo.saveMessage({
        sessionId: 'session-json-str',
        sender: 'Tester',
        content: 'JSON string payload',
        rawPayload: jsonStr,
      });

      expect(saved.rawPayload).toEqual({ customKey: 'customValue', number: 42 });
    });
  });

  describe('6. MediaStorage: 本地多模态受控转存管理器', () => {
    it('应成功从 Buffer 保存媒体文件并生成相对路径与 SHA-256 哈希', async () => {
      const buffer = Buffer.from('KKBot Multimodal Image Binary Simulation Content');
      const result = await mediaStorage.saveMediaBuffer(buffer, 'test-image.png', {
        subDir: 'images',
      });

      expect(result.originalName).toBe('test-image.png');
      expect(result.extension).toBe('.png');
      expect(result.size).toBe(buffer.length);
      expect(result.sha256).toHaveLength(64);
      expect(result.relativePath.startsWith('images/')).toBe(true);
      expect(existsSync(result.absolutePath)).toBe(true);
      expect(mediaStorage.mediaExists(result.relativePath)).toBe(true);
    });

    it('应成功从源文件路径异步转存到受控目录', async () => {
      const sourceFile = join(tempDir, 'source-doc.pdf');
      writeFileSync(sourceFile, 'Dummy PDF binary content for testing transfer');

      const result = await mediaStorage.saveMediaFile(sourceFile, { subDir: 'files' });

      expect(result.originalName).toBe('source-doc.pdf');
      expect(result.extension).toBe('.pdf');
      expect(result.relativePath.startsWith('files/')).toBe(true);
      expect(existsSync(result.absolutePath)).toBe(true);
    });

    it('应防范路径遍历攻击，确保只能访问 baseDir 内的受控路径', () => {
      expect(() => {
        mediaStorage.getMediaAbsolutePath('../../../etc/passwd');
      }).toThrow();

      expect(() => {
        mediaStorage.getMediaAbsolutePath('..\\..\\windows\\system32\\cmd.exe');
      }).toThrow();
    });

    it('应支持安全删除受控媒体文件', async () => {
      const buffer = Buffer.from('To be deleted');
      const result = await mediaStorage.saveMediaBuffer(buffer, 'delete-me.txt');

      expect(mediaStorage.mediaExists(result.relativePath)).toBe(true);
      const deleted = await mediaStorage.deleteMedia(result.relativePath);
      expect(deleted).toBe(true);
      expect(mediaStorage.mediaExists(result.relativePath)).toBe(false);
    });
    it('当转存不存在的源文件时应抛出异常', async () => {
      await expect(
        mediaStorage.saveMediaFile(join(tempDir, 'non-existent-source.jpg'))
      ).rejects.toThrow();
    });

    it('当文件大小超出限制时应拒绝写入并抛出异常', async () => {
      const smallStorage = new MediaStorage({ baseDir: tempDir, maxFileSize: 10 });
      const bigBuffer = Buffer.from('This buffer is definitely longer than 10 bytes');
      await expect(smallStorage.saveMediaBuffer(bigBuffer, 'large-file.bin')).rejects.toThrow();
    });

    it('对于不存在的文件调用 deleteMedia 应返回 false', async () => {
      const deleted = await mediaStorage.deleteMedia('images/2026-08/not-found.png');
      expect(deleted).toBe(false);
    });
  });

  describe('7. Store 统一门面类集成测试', () => {
    it('应能通过 Store 门面统一访问 messages、org 与 media 仓储并完成全链路调用', async () => {
      const store = new Store({ path: ':memory:', media: { baseDir: tempDir } });
      expect(store).toBeInstanceOf(KKBotStore);
      expect(store.messages).toBeInstanceOf(MessageRepository);
      expect(store.media).toBeInstanceOf(MediaStorage);

      // 1. 转存媒体
      const mediaResult = await store.media.saveMediaBuffer(
        Buffer.from('Hello Store Media'),
        'store-img.jpg'
      );

      // 2. 持久化带有媒体相对路径的消息
      const msg = store.messages.saveMessage({
        sessionId: 'session-store-facade',
        messageId: 'store-native-1',
        sender: 'Bot',
        content: '这是门面类发送的图片',
        messageType: 'image',
        rawPayload: {
          images: [{ relativePath: mediaResult.relativePath, size: mediaResult.size }],
        },
      });

      expect(msg.id).toBeGreaterThan(0);
      expect(msg.rawPayload?.images?.[0].relativePath).toBe(mediaResult.relativePath);

      // 3. 原生 ID 精确撤回
      const recalled = store.messages.markMessageRecalled('session-store-facade', 'store-native-1');
      expect(recalled).toBe(true);

      // 4. 获取历史过滤
      const history = store.messages.getSessionHistory('session-store-facade');
      expect(history).toHaveLength(0);

      store.close();
    });
  });

  describe('8. 复合条件检索、统计与会话清理', () => {
    beforeEach(() => {
      repo.saveMessages([
        {
          sessionId: 's-search',
          messageId: 'm-search-1',
          sender: '张三',
          senderId: 'user-001',
          content: '请协助处理生产环境告警问题',
          messageType: 'text',
          isFromSelf: false,
          createdAt: 10000,
        },
        {
          sessionId: 's-search',
          messageId: 'm-search-2',
          sender: '李四',
          senderId: 'user-002',
          content: '收到，正在排查数据库慢查询日志',
          messageType: 'text',
          isFromSelf: false,
          createdAt: 20000,
        },
        {
          sessionId: 's-search',
          messageId: 'm-search-3',
          sender: '机器人',
          senderId: 'bot-001',
          content: '检测到告警已恢复',
          messageType: 'system',
          isFromSelf: true,
          createdAt: 30000,
        },
      ]);
    });

    it('getMessages 应支持按关键词进行全文模糊检索', () => {
      const results = repo.getMessages({ keyword: '告警' });
      expect(results).toHaveLength(2);
      expect(results.map(r => r.messageId)).toEqual(['m-search-3', 'm-search-1']);
    });

    it('getMessages 应支持按发送人、消息类型与时间区间组合过滤', () => {
      const results = repo.getMessages({
        sender: '张三',
        messageType: 'text',
        startTime: 5000,
        endTime: 15000,
      });
      expect(results).toHaveLength(1);
      expect(results[0].messageId).toBe('m-search-1');
    });

    it('countSessionMessages 与 getLatestMessage 应准确返回统计与最新记录', () => {
      expect(repo.countSessionMessages('s-search')).toBe(3);
      const latest = repo.getLatestMessage('s-search');
      expect(latest?.messageId).toBe('m-search-3');
      expect(latest?.content).toBe('检测到告警已恢复');
    });

    it('deleteSessionMessages 应完全清理指定会话的历史记录', () => {
      const deletedCount = repo.deleteSessionMessages('s-search');
      expect(deletedCount).toBe(3);
      expect(repo.countSessionMessages('s-search')).toBe(0);
      expect(repo.getSessionHistory('s-search')).toHaveLength(0);
    });
  });
});
