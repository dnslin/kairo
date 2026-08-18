import type { ThrottleConfig } from '../config/schema.js';
import type { ThrottleState } from '../store/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('throttle');

/**
 * 节流状态提供者接口
 * 由 Store 实现，解耦策略层与存储层
 */
export interface ThrottleStateProvider {
  getThrottleState(sessionId: string): ThrottleState;
  resetDailyCount(sessionId: string, todayStr: string): void;
}

/**
 * 节流检查结果
 */
export interface ThrottleResult {
  allowed: boolean;
  reason?: 'min_interval' | 'daily_limit';
  detail?: string;
}

/**
 * 策略引擎错误
 */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * 检查会话节流状态
 *
 * @param sessionId - 会话 ID
 * @param provider - 节流状态提供者（通常是 Store）
 * @param config - 节流配置
 * @returns 节流检查结果
 */
export function checkThrottle(
  sessionId: string,
  provider: ThrottleStateProvider,
  config: ThrottleConfig
): ThrottleResult {
  // 配置校验
  if (config.perSessionMinIntervalSeconds <= 0) {
    throw new PolicyError('perSessionMinIntervalSeconds 必须大于 0');
  }
  if (config.dailyMaxPerSession <= 0) {
    throw new PolicyError('dailyMaxPerSession 必须大于 0');
  }

  const state = provider.getThrottleState(sessionId);

  // 首次消息（从未回复过），直接放行
  if (state.lastReplyAt === 0) {
    return { allowed: true };
  }

  // 最小间隔检查（优先于每日上限）
  const now = Date.now();
  const elapsedMs = now - state.lastReplyAt;
  const minIntervalMs = config.perSessionMinIntervalSeconds * 1000;
  if (elapsedMs < minIntervalMs) {
    const elapsedSec = Math.floor(elapsedMs / 1000);
    log.debug({ sessionId, elapsedSec, minInterval: config.perSessionMinIntervalSeconds }, '节流：距上次回复不足最小间隔');
    return {
      allowed: false,
      reason: 'min_interval',
      detail: `距上次回复仅 ${elapsedSec} 秒`,
    };
  }

  // 跨日计数重置（使用本地时区日期，确保 00:00 按用户本地时间重置）
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let dailyCount = state.dailyReplyCount;
  if (state.dailyCountResetDate !== today) {
    provider.resetDailyCount(sessionId, today);
    dailyCount = 0;
  }

  // 每日上限检查
  if (dailyCount >= config.dailyMaxPerSession) {
    log.debug({ sessionId, dailyCount, max: config.dailyMaxPerSession }, '节流：当日上限已达');
    return {
      allowed: false,
      reason: 'daily_limit',
      detail: `当日已回复 ${dailyCount} 条`,
    };
  }

  return { allowed: true };
}
