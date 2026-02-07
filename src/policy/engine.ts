import type { PolicyConfig, SessionType } from '../config/schema.js';
import type { SessionInfo } from '../dom/locator.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('policy');

/**
 * 策略决策结果
 */
export interface ProcessDecision {
  /** 是否允许处理 */
  allowed: boolean;
  /** 拒绝原因 (仅当 allowed=false 时) */
  reason?: string;
}

/**
 * 策略引擎
 * 负责判断会话是否应该被处理
 */
export class PolicyEngine {
  constructor(private readonly config: PolicyConfig) {
    log.debug('PolicyEngine 已初始化');
  }

  /**
   * 判断会话是否应该被处理
   * @param session 会话信息
   * @returns 处理决策
   */
  shouldProcess(session: SessionInfo): ProcessDecision {
    // 会话类型检查
    const typeResult = this.checkSessionType(session.type);
    if (!typeResult.allowed) {
      log.debug(
        { sessionId: session.id, type: session.type, reason: typeResult.reason },
        '会话被拒绝'
      );
      return typeResult;
    }

    log.debug({ sessionId: session.id, type: session.type }, '会话允许处理');
    return { allowed: true };
  }

  /**
   * 检查会话类型是否在允许列表中
   */
  private checkSessionType(type: SessionType): ProcessDecision {
    // 空数组表示允许所有类型
    if (this.config.sessionTypes.length === 0) {
      return { allowed: true };
    }

    if (this.config.sessionTypes.includes(type)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `会话类型 ${type} 不在允许列表中`,
    };
  }
}
