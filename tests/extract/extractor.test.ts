import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  MessageExtractor,
  ExtractorError,
  normalizeText,
  generateFingerprint,
} from '../../src/extract/index.js';
import type { DomLocator } from '../../src/dom/index.js';

const createMockLocator = () => ({
  getMessages: vi.fn(),
  getCurrentSession: vi.fn(),
});

describe('normalizeText', () => {
  it('去除首尾空白', () => {
    expect(normalizeText('  hello world  ')).toBe('hello world');
  });

  it('保留中间空白', () => {
    expect(normalizeText('hello   world')).toBe('hello   world');
  });

  it('处理空字符串', () => {
    expect(normalizeText('')).toBe('');
  });

  it('处理纯空白字符串', () => {
    expect(normalizeText('   \t\n   ')).toBe('');
  });

  it('处理换行符和制表符', () => {
    expect(normalizeText('\n  hello\t  ')).toBe('hello');
  });
});

describe('generateFingerprint', () => {
  it('相同输入产生相同指纹 (一致性)', () => {
    const fp1 = generateFingerprint('session1', 'Alice', '10:00', 'Hello');
    const fp2 = generateFingerprint('session1', 'Alice', '10:00', 'Hello');
    expect(fp1).toBe(fp2);
  });

  it('不同输入产生不同指纹 (唯一性)', () => {
    const fp1 = generateFingerprint('session1', 'Alice', '10:00', 'Hello');
    const fp2 = generateFingerprint('session1', 'Alice', '10:01', 'Hello');
    const fp3 = generateFingerprint('session1', 'Bob', '10:00', 'Hello');
    const fp4 = generateFingerprint('session2', 'Alice', '10:00', 'Hello');
    const fp5 = generateFingerprint('session1', 'Alice', '10:00', 'Hi');

    const fingerprints = [fp1, fp2, fp3, fp4, fp5];
    const uniqueFingerprints = new Set(fingerprints);
    expect(uniqueFingerprints.size).toBe(fingerprints.length);
  });

  it('指纹是64字符小写十六进制 (SHA-256格式)', () => {
    const fp = generateFingerprint('session1', 'Alice', '10:00', 'Hello');
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it('指纹长度正确', () => {
    const fp = generateFingerprint('session1', 'Alice', '10:00', 'Hello');
    expect(fp.length).toBe(64);
    expect(fp).not.toBe('');
  });
});

describe('MessageExtractor', () => {
  let mockLocator: ReturnType<typeof createMockLocator>;
  let extractor: MessageExtractor;

  beforeEach(() => {
    mockLocator = createMockLocator();
    extractor = new MessageExtractor(mockLocator as unknown as DomLocator);
  });

  describe('getRecentMessages', () => {
    it('返回最近 n 条消息（过滤自消息）', async () => {
      mockLocator.getCurrentSession.mockResolvedValue({
        id: 'session-123',
        name: 'Test Session',
        type: 'private',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: true,
      });

      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: 'Alice', content: '  Hello  ', time: '10:00', isMe: false },
        { id: 'msg-2', sender: 'Bob', content: 'Hi there', time: '10:01', isMe: false },
      ]);

      const messages = await extractor.getRecentMessages(2);

      expect(messages).toHaveLength(2);
      expect(messages[0].sessionId).toBe('session-123');
      expect(messages[0].sender).toBe('Alice');
      expect(messages[0].content).toBe('Hello');
      expect(messages[0].time).toBe('10:00');
      expect(messages[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(messages[0].isMe).toBe(false);
    });

    it('过滤掉 isMe === true 的自消息', async () => {
      mockLocator.getCurrentSession.mockResolvedValue({
        id: 'session-123',
        name: 'Test Session',
        type: 'private',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: true,
      });

      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: 'Alice', content: 'Hello', time: '10:00', isMe: false },
        { id: 'msg-2', sender: '自己', content: '你好', time: '10:01', isMe: true },
        { id: 'msg-3', sender: 'Bob', content: 'Hi', time: '10:02', isMe: false },
      ]);

      const messages = await extractor.getRecentMessages(3);

      expect(messages).toHaveLength(2);
      expect(messages[0].sender).toBe('Alice');
      expect(messages[1].sender).toBe('Bob');
    });

    it('全部消息都是自消息时返回空数组', async () => {
      mockLocator.getCurrentSession.mockResolvedValue({
        id: 'session-123',
        name: 'Test',
        type: 'private',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: true,
      });

      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: '自己', content: '你好', time: '10:00', isMe: true },
        { id: 'msg-2', sender: '自己', content: '再见', time: '10:01', isMe: true },
      ]);

      const messages = await extractor.getRecentMessages(2);
      expect(messages).toHaveLength(0);
    });

    it('无会话时抛出 ExtractorError', async () => {
      mockLocator.getCurrentSession.mockResolvedValue(null);

      await expect(extractor.getRecentMessages(5)).rejects.toThrow(ExtractorError);
      await expect(extractor.getRecentMessages(5)).rejects.toThrow('无当前会话');
    });

    it('n=0 返回空数组', async () => {
      mockLocator.getCurrentSession.mockResolvedValue({
        id: 'session-123',
        name: 'Test',
        type: 'private',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: true,
      });
      mockLocator.getMessages.mockResolvedValue([]);

      const messages = await extractor.getRecentMessages(0);
      expect(messages).toEqual([]);
    });

    it('n<0 抛出 ExtractorError', async () => {
      await expect(extractor.getRecentMessages(-1)).rejects.toThrow(ExtractorError);
      await expect(extractor.getRecentMessages(-1)).rejects.toThrow('消息数量不能为负数');
    });

    it('消息数少于 n 时返回所有消息', async () => {
      mockLocator.getCurrentSession.mockResolvedValue({
        id: 'session-123',
        name: 'Test',
        type: 'private',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: true,
      });
      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: 'Alice', content: 'Hello', time: '10:00', isMe: false },
      ]);

      const messages = await extractor.getRecentMessages(10);
      expect(messages).toHaveLength(1);
    });

    it('每条消息包含完整字段', async () => {
      mockLocator.getCurrentSession.mockResolvedValue({
        id: 'ses-abc',
        name: 'Test',
        type: 'group',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: true,
      });
      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: '张三', content: '你好', time: '下午3:00', isMe: false },
      ]);

      const [msg] = await extractor.getRecentMessages(1);

      expect(msg).toHaveProperty('sessionId', 'ses-abc');
      expect(msg).toHaveProperty('sender', '张三');
      expect(msg).toHaveProperty('content', '你好');
      expect(msg).toHaveProperty('time', '下午3:00');
      expect(msg).toHaveProperty('fingerprint');
      expect(msg.fingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(msg).toHaveProperty('isMe', false);
    });
  });
});
