import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Store } from '../../src/store/index.js';
import type { StoreConfig } from '../../src/config/schema.js';

const TEST_DIR = join(process.cwd(), 'tmp', 'test-store-throttle');

const createConfig = (overrides: Partial<StoreConfig> = {}): StoreConfig => ({
  dbPath: join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`),
  storeMessageContent: true,
  ...overrides,
});

describe('Store — 节流相关方法', () => {
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
    try {
      rmSync(config.dbPath, { force: true });
      rmSync(`${config.dbPath}-wal`, { force: true });
      rmSync(`${config.dbPath}-shm`, { force: true });
    } catch {
      /* 忽略 */
    }
  });

  describe('getThrottleState', () => {
    it('会话不存在时返回默认值', () => {
      const state = store.getThrottleState('non-existent');
      expect(state).toEqual({
        lastReplyAt: 0,
        dailyReplyCount: 0,
        dailyCountResetDate: null,
      });
    });

    it('会话存在时返回实际字段值', () => {
      // 先创建一条消息以触发 session upsert
      store.saveMessage('session-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '测试会话');

      const state = store.getThrottleState('session-1');
      expect(state.lastReplyAt).toBe(0);
      expect(state.dailyReplyCount).toBe(0);
      expect(state.dailyCountResetDate).toBeNull();
    });
  });

  describe('incrementDailyReplyCount', () => {
    it('递增 dailyReplyCount 并更新 lastReplyAt', () => {
      // 先创建会话
      store.saveMessage('session-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '测试会话');

      const before = Date.now();
      store.incrementDailyReplyCount('session-1');
      const after = Date.now();

      const state = store.getThrottleState('session-1');
      expect(state.dailyReplyCount).toBe(1);
      expect(state.lastReplyAt).toBeGreaterThanOrEqual(before);
      expect(state.lastReplyAt).toBeLessThanOrEqual(after);
    });

    it('多次调用递增计数', () => {
      store.saveMessage('session-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '测试会话');

      store.incrementDailyReplyCount('session-1');
      store.incrementDailyReplyCount('session-1');
      store.incrementDailyReplyCount('session-1');

      const state = store.getThrottleState('session-1');
      expect(state.dailyReplyCount).toBe(3);
    });

    it('不同会话计数互不影响', () => {
      store.saveMessage('session-a', { sender: 'A', content: 'hi', isFromSelf: false }, 'A');
      store.saveMessage('session-b', { sender: 'B', content: 'hi', isFromSelf: false }, 'B');

      store.incrementDailyReplyCount('session-a');
      store.incrementDailyReplyCount('session-a');
      store.incrementDailyReplyCount('session-b');

      expect(store.getThrottleState('session-a').dailyReplyCount).toBe(2);
      expect(store.getThrottleState('session-b').dailyReplyCount).toBe(1);
    });
  });

  describe('resetDailyCount', () => {
    it('重置 dailyReplyCount 为 0 并更新 dailyCountResetDate', () => {
      store.saveMessage('session-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '测试会话');

      store.incrementDailyReplyCount('session-1');
      store.incrementDailyReplyCount('session-1');

      const today = '2026-03-02';
      store.resetDailyCount('session-1', today);

      const state = store.getThrottleState('session-1');
      expect(state.dailyReplyCount).toBe(0);
      expect(state.dailyCountResetDate).toBe(today);
    });

    it('重置不影响 lastReplyAt', () => {
      store.saveMessage('session-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '测试会话');

      store.incrementDailyReplyCount('session-1');
      const stateBeforeReset = store.getThrottleState('session-1');

      store.resetDailyCount('session-1', '2026-03-02');
      const stateAfterReset = store.getThrottleState('session-1');

      expect(stateAfterReset.lastReplyAt).toBe(stateBeforeReset.lastReplyAt);
    });
  });

  describe('数据库迁移兼容性', () => {
    it('新建数据库包含 daily_reply_count 和 daily_count_reset_date 字段', () => {
      // 通过成功调用 getThrottleState 验证字段存在
      store.saveMessage('session-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '测试');

      const state = store.getThrottleState('session-1');
      expect(state).toHaveProperty('dailyReplyCount');
      expect(state).toHaveProperty('dailyCountResetDate');
    });
  });

  describe('性能', () => {
    it('节流状态读取 < 10ms', () => {
      store.saveMessage('session-perf', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      }, '性能测试');

      const start = performance.now();
      for (let i = 0; i < 100; i++) {
        store.getThrottleState('session-perf');
      }
      const elapsed = (performance.now() - start) / 100;
      expect(elapsed).toBeLessThan(10);
    });
  });
});
