import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store, StoreError } from '../../src/store/index.js';
import type { StoreConfig } from '../../src/config/schema.js';

const TEST_DIR = join(process.cwd(), 'tmp', 'test-store');

const createConfig = (overrides: Partial<StoreConfig> = {}): StoreConfig => ({
  dbPath: join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`),
  storeMessageContent: true,
  ...overrides,
});

describe('Store', () => {
  let store: Store;
  let config: StoreConfig;

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    config = createConfig();
    store = new Store(config);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
  });

  describe('初始化', () => {
    it('首次运行自动创建数据库和表', () => {
      expect(existsSync(config.dbPath)).toBe(true);
    });

    it('自动创建数据库目录', () => {
      const nestedConfig = createConfig({
        dbPath: join(TEST_DIR, 'nested', 'deep', `auto-${Date.now()}.db`),
      });
      const nestedStore = new Store(nestedConfig);
      expect(existsSync(nestedConfig.dbPath)).toBe(true);
      nestedStore.close();
    });

    it('无效路径抛出 StoreError', () => {
      expect(() => new Store(createConfig({ dbPath: '' }))).toThrow(StoreError);
    });
  });

  describe('isProcessed / markProcessed', () => {
    it('未处理的指纹返回 false', () => {
      expect(store.isProcessed('abc123')).toBe(false);
    });

    it('标记后返回 true', () => {
      store.markProcessed('fp-001');
      expect(store.isProcessed('fp-001')).toBe(true);
    });

    it('重复标记不抛出错误', () => {
      store.markProcessed('fp-dup');
      expect(() => store.markProcessed('fp-dup')).not.toThrow();
      expect(store.isProcessed('fp-dup')).toBe(true);
    });

    it('不同指纹互不影响', () => {
      store.markProcessed('fp-a');
      expect(store.isProcessed('fp-a')).toBe(true);
      expect(store.isProcessed('fp-b')).toBe(false);
    });
  });

  describe('saveMessage / getSessionHistory', () => {
    it('保存并检索会话消息', () => {
      store.saveMessage('ses-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      });

      const history = store.getSessionHistory('ses-1', 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      });
    });

    it('按时间正序返回（最旧在前）', () => {
      store.saveMessage('ses-1', { sender: 'A', content: '第一条', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'B', content: '第二条', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'C', content: '第三条', isFromSelf: false });

      const history = store.getSessionHistory('ses-1', 10);
      expect(history).toHaveLength(3);
      expect(history[0]?.sender).toBe('A');
      expect(history[1]?.sender).toBe('B');
      expect(history[2]?.sender).toBe('C');
    });

    it('限制返回数量（取最新的 n 条）', () => {
      store.saveMessage('ses-1', { sender: 'A', content: '1', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'B', content: '2', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'C', content: '3', isFromSelf: false });

      const history = store.getSessionHistory('ses-1', 2);
      expect(history).toHaveLength(2);
      // 取最新2条 (B, C)，正序排列
      expect(history[0]?.sender).toBe('B');
      expect(history[1]?.sender).toBe('C');
    });

    it('空会话返回空数组', () => {
      const history = store.getSessionHistory('not-exist', 10);
      expect(history).toEqual([]);
    });

    it('自动创建会话记录', () => {
      store.saveMessage(
        'ses-new',
        {
          sender: 'Bot',
          content: '回复',
          isFromSelf: true,
        },
        '测试会话'
      );

      const history = store.getSessionHistory('ses-new', 1);
      expect(history).toHaveLength(1);
      expect(history[0]?.isFromSelf).toBe(true);
    });

    it('不同会话互相隔离', () => {
      store.saveMessage('ses-a', { sender: 'A', content: 'msg-a', isFromSelf: false });
      store.saveMessage('ses-b', { sender: 'B', content: 'msg-b', isFromSelf: false });

      const historyA = store.getSessionHistory('ses-a', 10);
      const historyB = store.getSessionHistory('ses-b', 10);
      expect(historyA).toHaveLength(1);
      expect(historyB).toHaveLength(1);
      expect(historyA[0]?.sender).toBe('A');
      expect(historyB[0]?.sender).toBe('B');
    });
  });

  describe('logEvent / getEvents', () => {
    it('记录并查询事件', () => {
      store.logEvent('message_sent', { sessionId: 'ses-1', text: 'hello' });

      const events = store.getEvents('message_sent');
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('message_sent');
      expect(events[0]?.data).toBe(JSON.stringify({ sessionId: 'ses-1', text: 'hello' }));
    });

    it('无附加数据时 data 为 null', () => {
      store.logEvent('heartbeat');

      const events = store.getEvents('heartbeat');
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toBeNull();
    });

    it('按类型过滤事件', () => {
      store.logEvent('type_a', { x: 1 });
      store.logEvent('type_b', { y: 2 });
      store.logEvent('type_a', { x: 3 });

      const eventsA = store.getEvents('type_a');
      const eventsB = store.getEvents('type_b');
      expect(eventsA).toHaveLength(2);
      expect(eventsB).toHaveLength(1);
    });

    it('不传类型返回所有事件', () => {
      store.logEvent('a');
      store.logEvent('b');
      store.logEvent('c');

      const all = store.getEvents();
      expect(all).toHaveLength(3);
    });

    it('limit 参数限制结果数量', () => {
      for (let i = 0; i < 10; i++) {
        store.logEvent('batch', { i });
      }

      const limited = store.getEvents('batch', 3);
      expect(limited).toHaveLength(3);
    });

    it('事件按时间倒序返回（最新在前）', () => {
      store.logEvent('order', { seq: 1 });
      store.logEvent('order', { seq: 2 });
      store.logEvent('order', { seq: 3 });

      const events = store.getEvents('order');
      // 最新在前
      expect(JSON.parse(events[0]?.data ?? '{}')).toMatchObject({ seq: 3 });
      expect(JSON.parse(events[2]?.data ?? '{}')).toMatchObject({ seq: 1 });
    });
  });

  describe('安全验收 - storeMessageContent', () => {
    it('storeMessageContent=false 时消息内容不存储', () => {
      const secureConfig = createConfig({ storeMessageContent: false });
      const secureStore = new Store(secureConfig);

      secureStore.saveMessage('ses-secret', {
        sender: 'Alice',
        content: '这是敏感消息',
        isFromSelf: false,
      });

      const history = secureStore.getSessionHistory('ses-secret', 10);
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toBe('[已隐藏]');
      secureStore.close();
    });

    it('storeMessageContent=true 时正常存储消息内容', () => {
      store.saveMessage('ses-open', {
        sender: 'Bob',
        content: '普通消息',
        isFromSelf: false,
      });

      const history = store.getSessionHistory('ses-open', 10);
      expect(history[0]?.content).toBe('普通消息');
    });
  });

  describe('性能验收', () => {
    it('单次查询 < 50ms', () => {
      // 先插入一些数据
      for (let i = 0; i < 100; i++) {
        store.markProcessed(`perf-fp-${String(i)}`);
      }
      for (let i = 0; i < 100; i++) {
        store.saveMessage('perf-ses', {
          sender: `user-${String(i)}`,
          content: `消息内容 ${String(i)}`,
          isFromSelf: i % 2 === 0,
        });
      }

      // 测试查询性能
      const start1 = performance.now();
      store.isProcessed('perf-fp-50');
      const duration1 = performance.now() - start1;
      expect(duration1).toBeLessThan(50);

      const start2 = performance.now();
      store.getSessionHistory('perf-ses', 20);
      const duration2 = performance.now() - start2;
      expect(duration2).toBeLessThan(50);

      const start3 = performance.now();
      store.getEvents(undefined, 50);
      const duration3 = performance.now() - start3;
      expect(duration3).toBeLessThan(50);
    });
  });

  describe('close', () => {
    it('关闭后操作抛出错误', () => {
      store.close();
      expect(() => store.isProcessed('test')).toThrow();
    });
  });
});
