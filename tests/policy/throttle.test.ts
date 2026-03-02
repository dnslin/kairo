import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ThrottleConfig } from '../../src/config/schema.js';

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: (): Record<string, (...args: unknown[]) => void> => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { checkThrottle } from '../../src/policy/throttle.js';
import type { ThrottleStateProvider } from '../../src/policy/throttle.js';

const createConfig = (overrides: Partial<ThrottleConfig> = {}): ThrottleConfig => ({
  perSessionMinIntervalSeconds: 60,
  dailyMaxPerSession: 50,
  ...overrides,
});

/** 获取本地时区 YYYY-MM-DD 字符串 */
function localDateStr(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function createMockProvider(overrides: {
  lastReplyAt?: number;
  dailyReplyCount?: number;
  dailyCountResetDate?: string | null;
} = {}): ThrottleStateProvider {
  return {
    getThrottleState: vi.fn().mockReturnValue({
      lastReplyAt: overrides.lastReplyAt ?? 0,
      dailyReplyCount: overrides.dailyReplyCount ?? 0,
      dailyCountResetDate: overrides.dailyCountResetDate ?? null,
    }),
    resetDailyCount: vi.fn(),
  };
}

describe('checkThrottle', () => {
  let config: ThrottleConfig;
  let provider: ThrottleStateProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    config = createConfig();
    provider = createMockProvider();
  });

  // ── 首次消息 ──────────────────────────────────────────────────

  describe('首次消息（无历史记录）', () => {
    it('lastReplyAt=0 时允许处理', () => {
      provider = createMockProvider({ lastReplyAt: 0, dailyReplyCount: 0 });
      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(true);
    });

    it('会话不存在时允许处理', () => {
      provider = createMockProvider();
      const result = checkThrottle('non-existent', provider, config);
      expect(result.allowed).toBe(true);
    });
  });

  // ── 最小间隔检查 ──────────────────────────────────────────────

  describe('最小间隔检查 (perSessionMinIntervalSeconds)', () => {
    it('距上次回复不足最小间隔时拒绝', () => {
      const now = Date.now();
      // 上次回复在 10 秒前，最小间隔 60 秒
      provider = createMockProvider({ lastReplyAt: now - 10_000 });
      config = createConfig({ perSessionMinIntervalSeconds: 60 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('min_interval');
      expect(result.detail).toBeDefined();
    });

    it('距上次回复超过最小间隔时允许', () => {
      const now = Date.now();
      // 上次回复在 120 秒前，最小间隔 60 秒
      provider = createMockProvider({ lastReplyAt: now - 120_000 });
      config = createConfig({ perSessionMinIntervalSeconds: 60 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(true);
    });

    it('距上次回复恰好等于最小间隔时允许', () => {
      const now = Date.now();
      provider = createMockProvider({ lastReplyAt: now - 60_000 });
      config = createConfig({ perSessionMinIntervalSeconds: 60 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(true);
    });
  });

  // ── 每日上限检查 ──────────────────────────────────────────────

  describe('每日上限检查 (dailyMaxPerSession)', () => {
    it('当日回复数达到上限时拒绝', () => {
      const now = Date.now();
      const today = localDateStr();
      provider = createMockProvider({
        lastReplyAt: now - 120_000,
        dailyReplyCount: 50,
        dailyCountResetDate: today,
      });
      config = createConfig({ dailyMaxPerSession: 50 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('daily_limit');
      expect(result.detail).toBeDefined();
    });

    it('当日回复数超过上限时拒绝', () => {
      const now = Date.now();
      const today = localDateStr();
      provider = createMockProvider({
        lastReplyAt: now - 120_000,
        dailyReplyCount: 100,
        dailyCountResetDate: today,
      });
      config = createConfig({ dailyMaxPerSession: 50 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('daily_limit');
    });

    it('当日回复数未达上限时允许', () => {
      const now = Date.now();
      const today = localDateStr();
      provider = createMockProvider({
        lastReplyAt: now - 120_000,
        dailyReplyCount: 49,
        dailyCountResetDate: today,
      });
      config = createConfig({ dailyMaxPerSession: 50 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(true);
    });
  });

  // ── 跨日计数重置 ──────────────────────────────────────────────

  describe('跨日计数重置', () => {
    it('日期变化时调用 resetDailyCount 并允许处理', () => {
      const now = Date.now();
      // dailyCountResetDate 是昨天
      const yesterday = localDateStr(new Date(Date.now() - 86400_000));
      provider = createMockProvider({
        lastReplyAt: now - 120_000,
        dailyReplyCount: 50,
        dailyCountResetDate: yesterday,
      });
      config = createConfig({ dailyMaxPerSession: 50 });

      const result = checkThrottle('session-1', provider, config);
      expect(provider.resetDailyCount).toHaveBeenCalled();
      // 重置后计数变为 0，应该允许
      expect(result.allowed).toBe(true);
    });

    it('dailyCountResetDate 为 null 时视为需要重置', () => {
      const now = Date.now();
      provider = createMockProvider({
        lastReplyAt: now - 120_000,
        dailyReplyCount: 50,
        dailyCountResetDate: null,
      });
      config = createConfig({ dailyMaxPerSession: 50 });

      const result = checkThrottle('session-1', provider, config);
      expect(provider.resetDailyCount).toHaveBeenCalled();
      expect(result.allowed).toBe(true);
    });
  });

  // ── 优先级：最小间隔优先于每日上限 ────────────────────────────

  describe('优先级', () => {
    it('最小间隔检查优先于每日上限检查', () => {
      const now = Date.now();
      const today = localDateStr();
      // 距上次回复仅 10 秒且已达每日上限
      provider = createMockProvider({
        lastReplyAt: now - 10_000,
        dailyReplyCount: 50,
        dailyCountResetDate: today,
      });
      config = createConfig({ perSessionMinIntervalSeconds: 60, dailyMaxPerSession: 50 });

      const result = checkThrottle('session-1', provider, config);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('min_interval');
    });
  });

  // ── 配置校验 ──────────────────────────────────────────────────

  describe('配置校验', () => {
    it('perSessionMinIntervalSeconds <= 0 时抛错', () => {
      config = createConfig({ perSessionMinIntervalSeconds: 0 });
      expect(() => checkThrottle('session-1', provider, config)).toThrow();
    });

    it('perSessionMinIntervalSeconds 为负数时抛错', () => {
      config = createConfig({ perSessionMinIntervalSeconds: -1 });
      expect(() => checkThrottle('session-1', provider, config)).toThrow();
    });

    it('dailyMaxPerSession <= 0 时抛错', () => {
      config = createConfig({ dailyMaxPerSession: 0 });
      expect(() => checkThrottle('session-1', provider, config)).toThrow();
    });

    it('dailyMaxPerSession 为负数时抛错', () => {
      config = createConfig({ dailyMaxPerSession: -1 });
      expect(() => checkThrottle('session-1', provider, config)).toThrow();
    });
  });
});
