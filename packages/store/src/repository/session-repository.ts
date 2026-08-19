import type Database from 'better-sqlite3';
import type {
  SessionMode,
  SessionRecord,
  SessionType,
  UpsertSessionInput,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('session-repo');

/**
 * 会话表 SQLite 原始数据行结构
 */
interface SessionRow {
  id: string;
  name: string;
  type: string;
  employee_id: string | null;
  mode: string;
  human_takeover_until: number;
  last_message_at: number;
  last_reply_at: number;
  daily_reply_count: number;
  daily_count_reset_date: string | null;
  created_at: number;
  updated_at: number;
}

/**
 * 将数据库原始行转换为领域强类型会话实体
 */
function mapRowToSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    name: row.name,
    type: row.type as SessionType,
    employeeId: row.employee_id,
    mode: row.mode as SessionMode,
    humanTakeoverUntil: row.human_takeover_until,
    lastMessageAt: row.last_message_at,
    lastReplyAt: row.last_reply_at,
    dailyReplyCount: row.daily_reply_count,
    dailyCountResetDate: row.daily_count_reset_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * 会话状态持久化仓储类
 * 负责会话元数据存储、人工退避时间戳管理与对话轮次判定
 * 严格遵循纯数据访问层原则：零 Driver 依赖、零长运行定时器
 */
export class SessionRepository {
  private readonly db: Database.Database;

  // 预编译 SQL 语句
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly getTakeoverUntilStmt: Database.Statement;
  private readonly getActivityTimesStmt: Database.Statement;
  private readonly setTakeoverStmt: Database.Statement;
  private readonly touchMsgStmt: Database.Statement;
  private readonly touchReplyStmt: Database.Statement;

  /** 动态更新预编译语句缓存池，避免重复解析与编译 SQL */
  private readonly dynamicUpdateStmtCache = new Map<string, Database.Statement>();
  constructor(db: Database.Database) {
    this.db = db;

    this.insertStmt = this.db.prepare(`
      INSERT INTO sessions (
        id, name, type, employee_id, mode,
        human_takeover_until, last_message_at, last_reply_at,
        daily_reply_count, daily_count_reset_date,
        created_at, updated_at
      ) VALUES (
        @id, @name, @type, @employee_id, @mode,
        @human_takeover_until, @last_message_at, @last_reply_at,
        @daily_reply_count, @daily_count_reset_date,
        @created_at, @updated_at
      )
    `);

    this.getByIdStmt = this.db.prepare(`
      SELECT
        id, name, type, employee_id, mode,
        human_takeover_until, last_message_at, last_reply_at,
        daily_reply_count, daily_count_reset_date,
        created_at, updated_at
      FROM sessions
      WHERE id = ?
    `);

    this.getTakeoverUntilStmt = this.db.prepare(`
      SELECT human_takeover_until
      FROM sessions
      WHERE id = ?
    `);

    this.getActivityTimesStmt = this.db.prepare(`
      SELECT last_message_at, last_reply_at
      FROM sessions
      WHERE id = ?
    `);

    this.setTakeoverStmt = this.db.prepare(`
      UPDATE sessions
      SET human_takeover_until = @human_takeover_until,
          updated_at = @updated_at
      WHERE id = @id
    `);

    this.touchMsgStmt = this.db.prepare(`
      UPDATE sessions
      SET last_message_at = @last_message_at,
          updated_at = @updated_at
      WHERE id = @id
    `);

    this.touchReplyStmt = this.db.prepare(`
      UPDATE sessions
      SET last_reply_at = @last_reply_at,
          updated_at = @updated_at
      WHERE id = @id
    `);
  }

  /**
   * 插入新会话或更新已有会话元数据（支持部分字段增量更新）
   * @param input 会话数据输入
   */
  upsertSession(input: UpsertSessionInput): void {
    const now = Date.now();
    const existing = this.getSession(input.id);

    if (!existing) {
      // 会话尚不存在，执行全量插入并应用默认值
      this.insertStmt.run({
        id: input.id,
        name: input.name ?? '',
        type: input.type ?? 'private',
        employee_id: input.employeeId ?? null,
        mode: input.mode ?? 'auto',
        human_takeover_until: input.humanTakeoverUntil ?? 0,
        last_message_at: input.lastMessageAt ?? 0,
        last_reply_at: input.lastReplyAt ?? 0,
        daily_reply_count: input.dailyReplyCount ?? 0,
        daily_count_reset_date: input.dailyCountResetDate ?? null,
        created_at: input.createdAt ?? now,
        updated_at: input.updatedAt ?? now,
      });
      log.debug({ sessionId: input.id }, '新增会话记录');
      return;
    }

    // 会话已存在，仅动态更新已提供的字段
    const sets: string[] = [];
    const params: Record<string, unknown> = { id: input.id };

    if (input.name !== undefined) {
      sets.push('name = @name');
      params.name = input.name;
    }
    if (input.type !== undefined) {
      sets.push('type = @type');
      params.type = input.type;
    }
    if ('employeeId' in input) {
      sets.push('employee_id = @employee_id');
      params.employee_id = input.employeeId ?? null;
    }
    if (input.mode !== undefined) {
      sets.push('mode = @mode');
      params.mode = input.mode;
    }
    if (input.humanTakeoverUntil !== undefined) {
      sets.push('human_takeover_until = @human_takeover_until');
      params.human_takeover_until = input.humanTakeoverUntil;
    }
    if (input.lastMessageAt !== undefined) {
      sets.push('last_message_at = @last_message_at');
      params.last_message_at = input.lastMessageAt;
    }
    if (input.lastReplyAt !== undefined) {
      sets.push('last_reply_at = @last_reply_at');
      params.last_reply_at = input.lastReplyAt;
    }
    if (input.dailyReplyCount !== undefined) {
      sets.push('daily_reply_count = @daily_reply_count');
      params.daily_reply_count = input.dailyReplyCount;
    }
    if ('dailyCountResetDate' in input) {
      sets.push('daily_count_reset_date = @daily_count_reset_date');
      params.daily_count_reset_date = input.dailyCountResetDate ?? null;
    }
    if (input.createdAt !== undefined) {
      sets.push('created_at = @created_at');
      params.created_at = input.createdAt;
    }

    // 始终更新 updated_at
    sets.push('updated_at = @updated_at');
    params.updated_at = input.updatedAt ?? now;

    const cacheKey = sets.slice().sort().join('|');
    let stmt = this.dynamicUpdateStmtCache.get(cacheKey);
    if (!stmt) {
      const sql = `UPDATE sessions SET ${sets.join(', ')} WHERE id = @id`;
      stmt = this.db.prepare(sql);
      this.dynamicUpdateStmtCache.set(cacheKey, stmt);
    }
    stmt.run(params);
    log.debug({ sessionId: input.id, updatedFields: Object.keys(params) }, '更新会话记录');
  }

  /**
   * 根据会话唯一标识 (sesUUID) 获取会话完整记录
   * @param id 会话 ID
   * @returns 会话实体或 null
   */
  getSession(id: string): SessionRecord | null {
    const row = this.getByIdStmt.get(id) as SessionRow | undefined;
    if (!row) {
      return null;
    }
    return mapRowToSession(row);
  }

  /**
   * 设置人工接管退避截止时间戳
   * @param sessionId 会话 ID
   * @param timestamp 毫秒时间戳（0 代表解除接管，未来时间戳代表人工接管中）
   */
  setTakeoverUntil(sessionId: string, timestamp: number): void {
    const now = Date.now();
    this.setTakeoverStmt.run({
      id: sessionId,
      human_takeover_until: timestamp,
      updated_at: now,
    });
    log.debug({ sessionId, timestamp }, '更新人工接管截止时间戳');
  }

  /**
   * 更新会话最后消息时间戳并刷新 updatedAt
   * @param sessionId 会话 ID
   * @param now 可选指定时间戳，默认 Date.now()
   */
  touchMessageTime(sessionId: string, now?: number): void {
    const timestamp = now ?? Date.now();
    this.touchMsgStmt.run({
      id: sessionId,
      last_message_at: timestamp,
      updated_at: timestamp,
    });
    log.debug({ sessionId, timestamp }, '更新会话最后消息时间戳');
  }

  /**
   * 更新会话最后回复时间戳并刷新 updatedAt
   * @param sessionId 会话 ID
   * @param now 可选指定时间戳，默认 Date.now()
   */
  touchReplyTime(sessionId: string, now?: number): void {
    const timestamp = now ?? Date.now();
    this.touchReplyStmt.run({
      id: sessionId,
      last_reply_at: timestamp,
      updated_at: timestamp,
    });
    log.debug({ sessionId, timestamp }, '更新会话最后回复时间戳');
  }

  /**
   * 判定会话当前是否处于人工接管/退避状态
   * @param sessionId 会话 ID
   * @param now 可选指定当前时间戳，默认 Date.now()
   * @returns true: 正在接管中; false: 未接管或已过期/会话不存在
   */
  isTakeoverActive(sessionId: string, now?: number): boolean {
    const row = this.getTakeoverUntilStmt.get(sessionId) as
      | { human_takeover_until: number }
      | undefined;
    if (!row) {
      return false;
    }
    const currentTime = now ?? Date.now();
    return row.human_takeover_until > currentTime;
  }

  /**
   * 判定会话是否进入新一轮对话（轮次切断判定）
   * 判定规则：
   * 1. 会话不存在或从未有消息与回复 -> true (新轮次)
   * 2. 距离最后一次活动 (Math.max(lastMessageAt, lastReplyAt)) 超过 timeoutHours (默认 2 小时) -> true (新轮次)
   * 3. 在超时时间内 -> false (同一轮次延续)
   * 4. 出现时钟回拨或未来时间戳 -> false (未超时)
   *
   * @param sessionId 会话 ID
   * @param timeoutHours 闲置超时小时数，默认 2 小时
   * @param now 可选指定当前时间戳，默认 Date.now()
   * @returns true: 新轮次; false: 同一轮次
   */
  isNewTurn(sessionId: string, timeoutHours = 2, now?: number): boolean {
    const row = this.getActivityTimesStmt.get(sessionId) as
      | { last_message_at: number; last_reply_at: number }
      | undefined;

    if (!row) {
      return true;
    }

    const { last_message_at: lastMsg, last_reply_at: lastReply } = row;
    if (lastMsg === 0 && lastReply === 0) {
      return true;
    }

    const lastActivityAt = Math.max(lastMsg, lastReply);
    const currentTime = now ?? Date.now();

    // 异常防御：未来时间戳不视为超时
    if (currentTime < lastActivityAt) {
      return false;
    }

    const timeoutMs = timeoutHours * 3600 * 1000;
    return currentTime - lastActivityAt >= timeoutMs;
  }
}
