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
  private readonly regexCache = new Map<string, RegExp>();

  constructor(private readonly config: PolicyConfig) {
    log.debug('PolicyEngine 已初始化');
    this.precompilePatterns();
  }

  /**
   * 预编译所有通配符模式为正则表达式
   */
  private precompilePatterns(): void {
    const allPatterns = [...this.config.whitelist, ...this.config.blacklist];
    for (const pattern of allPatterns) {
      if (pattern.includes('*')) {
        const wildcardCount = (pattern.match(/\*/g) || []).length;
        if (wildcardCount > 5) {
          log.warn({ pattern }, '通配符数量超过限制(5)，跳过预编译');
          continue;
        }
        const regexPattern = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*?');
        this.regexCache.set(pattern, new RegExp(`^${regexPattern}$`));
      }
    }
  }

  /**
   * 判断会话是否应该被处理
   * @param session 会话信息
   * @returns 处理决策
   */
  shouldProcess(session: SessionInfo): ProcessDecision {
    // 1. 白名单检查（白名单优先）
    if (this.isWhitelisted(session.name)) {
      log.debug({ sessionId: session.id, name: session.name }, '会话在白名单中，允许处理');
      return { allowed: true };
    }

    // 2. 黑名单检查
    if (this.isBlacklisted(session.name)) {
      log.debug({ sessionId: session.id, name: session.name }, '会话在黑名单中');
      return { allowed: false, reason: 'blacklisted' };
    }

    // 3. 工作时间检查
    if (!this.isWithinWorkingHours()) {
      log.debug({ sessionId: session.id }, '当前不在工作时间内');
      return { allowed: false, reason: 'outside_working_hours' };
    }

    // 4. 会话类型检查
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
   * 检查会话是否在白名单中
   */
  private isWhitelisted(sessionName: string): boolean {
    return this.matchesAnyPattern(sessionName, this.config.whitelist);
  }

  /**
   * 检查会话是否在黑名单中
   */
  private isBlacklisted(sessionName: string): boolean {
    return this.matchesAnyPattern(sessionName, this.config.blacklist);
  }

  /**
   * 检查会话名称是否匹配任一模式（支持通配符）
   */
  private matchesAnyPattern(sessionName: string, patterns: string[]): boolean {
    return patterns.some(pattern => this.matchPattern(sessionName, pattern));
  }

  /**
   * 通配符匹配（支持 * 通配符）
   * 例如：*测试* 匹配包含"测试"的任何字符串
   */
  private matchPattern(text: string, pattern: string): boolean {
    if (pattern === text) return true;

    if (pattern.includes('*')) {
      const regex = this.regexCache.get(pattern);
      if (!regex) {
        log.warn({ pattern }, '未预编译的模式，跳过匹配');
        return false;
      }
      return regex.test(text);
    }

    return false;
  }

  /**
   * 检查当前时间是否在工作时间内
   */
  private isWithinWorkingHours(): boolean {
    if (!this.config.workingHours || this.config.workingHours.trim() === '') {
      return true;
    }

    const match = this.config.workingHours.match(/^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/);
    if (!match) {
      log.warn({ workingHours: this.config.workingHours }, '工作时间格式无效，忽略限制');
      return true;
    }

    const [, startHour, startMin, endHour, endMin] = match;
    const sh = parseInt(startHour!, 10);
    const sm = parseInt(startMin!, 10);
    const eh = parseInt(endHour!, 10);
    const em = parseInt(endMin!, 10);

    if (sh > 23 || sm > 59 || eh > 23 || em > 59) {
      log.warn(
        { workingHours: this.config.workingHours },
        '工作时间超出有效范围(0-23:0-59)，忽略限制'
      );
      return true;
    }

    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const startMinutes = sh * 60 + sm;
    const endMinutes = eh * 60 + em;
    return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
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
