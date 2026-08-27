import type { Client } from '@libsql/client';
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
function parseSessionMode(rawMode: string): SessionMode {
  if (rawMode === 'auto' || rawMode === 'disabled') {
    return rawMode;
  }
  throw new Error(`会话 mode 无效: ${rawMode}`);
}

/**
 * 将数据库原始行转换为领域强类型会话实体
 */
function mapRowToSession(row: SessionRow): SessionRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    type: row.type as SessionType,
    employeeId: row.employee_id ? String(row.employee_id) : null,
    mode: parseSessionMode(row.mode),
    humanTakeoverUntil: Number(row.human_takeover_until),
    lastMessageAt: Number(row.last_message_at),
    lastReplyAt: Number(row.last_reply_at),
    dailyReplyCount: Number(row.daily_reply_count),
    dailyCountResetDate: row.daily_count_reset_date ? String(row.daily_count_reset_date) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 会话状态持久化仓储类
 * 负责会话元数据存储、人工退避时间戳管理与对话轮次判定
 * 严格遵循纯数据访问层原则：零 Driver 依赖、零长运行定时器
 */
export class SessionRepository {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 插入新会话或更新已有会话元数据（支持部分字段增量更新）
   * @param input 会话数据输入
   */
  public async upsertSession(input: UpsertSessionInput): Promise<void> {
    const now = Date.now();
    const existing = await this.getSession(input.id);

    if (!existing) {
      try {
        await this.client.execute({
          sql: `INSERT INTO sessions (
            id, name, type, employee_id, mode,
            human_takeover_until, last_message_at, last_reply_at,
            daily_reply_count, daily_count_reset_date,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = CASE WHEN excluded.name != '' THEN excluded.name ELSE sessions.name END,
            type = excluded.type,
            updated_at = excluded.updated_at`,
          args: [
            input.id,
            input.name ?? '',
            input.type ?? 'private',
            input.employeeId ?? null,
            input.mode ?? 'auto',
            input.humanTakeoverUntil ?? 0,
            input.lastMessageAt ?? 0,
            input.lastReplyAt ?? 0,
            input.dailyReplyCount ?? 0,
            input.dailyCountResetDate ?? null,
            input.createdAt ?? now,
            input.updatedAt ?? now,
          ],
        });
        log.debug({ sessionId: input.id }, '新增会话记录');
        return;
      } catch (err) {
        log.debug({ err, sessionId: input.id }, '并发新增会话竞争，转为更新');
      }
    }
    // 会话已存在，仅动态更新已提供的字段
    const sets: string[] = [];
    const args: Array<string | number | null> = [];

    if (input.name !== undefined) {
      sets.push('name = ?');
      args.push(input.name);
    }
    if (input.type !== undefined) {
      sets.push('type = ?');
      args.push(input.type);
    }
    if ('employeeId' in input) {
      sets.push('employee_id = ?');
      args.push(input.employeeId ?? null);
    }
    if (input.mode !== undefined) {
      sets.push('mode = ?');
      args.push(input.mode);
    }
    if (input.humanTakeoverUntil !== undefined) {
      sets.push('human_takeover_until = ?');
      args.push(input.humanTakeoverUntil);
    }
    if (input.lastMessageAt !== undefined) {
      sets.push('last_message_at = ?');
      args.push(input.lastMessageAt);
    }
    if (input.lastReplyAt !== undefined) {
      sets.push('last_reply_at = ?');
      args.push(input.lastReplyAt);
    }
    if (input.dailyReplyCount !== undefined) {
      sets.push('daily_reply_count = ?');
      args.push(input.dailyReplyCount);
    }
    if ('dailyCountResetDate' in input) {
      sets.push('daily_count_reset_date = ?');
      args.push(input.dailyCountResetDate ?? null);
    }
    if (input.createdAt !== undefined) {
      sets.push('created_at = ?');
      args.push(input.createdAt);
    }

    // 始终更新 updated_at
    sets.push('updated_at = ?');
    args.push(input.updatedAt ?? now);

    args.push(input.id);

    const sql = `UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`;
    await this.client.execute({ sql, args });
    log.debug({ sessionId: input.id }, '更新会话记录');
  }

  /**
   * 根据会话唯一标识 (sesUUID) 获取会话完整记录
   * @param id 会话 ID
   * @returns 会话实体或 null
   */
  public async getSession(id: string): Promise<SessionRecord | null> {
    const res = await this.client.execute({
      sql: `SELECT
              id, name, type, employee_id, mode,
              human_takeover_until, last_message_at, last_reply_at,
              daily_reply_count, daily_count_reset_date,
              created_at, updated_at
            FROM sessions
            WHERE id = ?`,
      args: [id],
    });

    if (res.rows.length === 0) {
      return null;
    }
    return mapRowToSession(res.rows[0] as unknown as SessionRow);
  }

  /**
   * 获取所有会话列表
   */
  public async getAllSessions(): Promise<SessionRecord[]> {
    const res = await this.client.execute(`
      SELECT
        id, name, type, employee_id, mode,
        human_takeover_until, last_message_at, last_reply_at,
        daily_reply_count, daily_count_reset_date,
        created_at, updated_at
      FROM sessions
      ORDER BY last_message_at DESC, updated_at DESC
    `);

    return (res.rows as unknown as SessionRow[]).map(mapRowToSession);
  }

  /**
   * 设置会话工作模式
   */
  public async setSessionMode(sessionId: string, mode: SessionMode): Promise<void> {
    const now = Date.now();
    await this.client.execute({
      sql: `UPDATE sessions SET mode = ?, updated_at = ? WHERE id = ?`,
      args: [mode, now, sessionId],
    });
  }

  /**
   * 设置人工接管退避截止时间戳
   * @param sessionId 会话 ID
   * @param timestamp 毫秒时间戳（0 代表解除接管，未来时间戳代表人工接管中）
   */
  public async setTakeoverUntil(sessionId: string, timestamp: number): Promise<void> {
    const now = Date.now();
    await this.client.execute({
      sql: `UPDATE sessions
            SET human_takeover_until = ?,
                updated_at = ?
            WHERE id = ?`,
      args: [timestamp, now, sessionId],
    });
    log.debug({ sessionId, timestamp }, '更新人工接管截止时间戳');
  }

  /**
   * 手动解除人工接管退避状态
   * @param sessionId 会话 ID
   */
  public async clearTakeover(sessionId: string): Promise<void> {
    await this.setTakeoverUntil(sessionId, 0);
  }

  /**
   * 更新会话最后消息时间戳并刷新 updatedAt
   * @param sessionId 会话 ID
   * @param now 可选指定时间戳，默认 Date.now()
   */
  public async touchMessageTime(sessionId: string, now?: number): Promise<void> {
    const timestamp = now ?? Date.now();
    await this.client.execute({
      sql: `UPDATE sessions
            SET last_message_at = ?,
                updated_at = ?
            WHERE id = ?`,
      args: [timestamp, timestamp, sessionId],
    });
    log.debug({ sessionId, timestamp }, '更新会话最后消息时间戳');
  }

  /**
   * 更新会话最后回复时间戳并刷新 updatedAt
   * @param sessionId 会话 ID
   * @param now 可选指定时间戳，默认 Date.now()
   */
  public async touchReplyTime(sessionId: string, now?: number): Promise<void> {
    const timestamp = now ?? Date.now();
    await this.client.execute({
      sql: `UPDATE sessions
            SET last_reply_at = ?,
                updated_at = ?
            WHERE id = ?`,
      args: [timestamp, timestamp, sessionId],
    });
    log.debug({ sessionId, timestamp }, '更新会话最后回复时间戳');
  }

  /**
   * 判定会话当前是否处于人工接管/退避状态
   * @param sessionId 会话 ID
   * @param now 可选指定当前时间戳，默认 Date.now()
   * @returns true: 正在接管中; false: 未接管或已过期/会话不存在
   */
  public async isTakeoverActive(sessionId: string, now?: number): Promise<boolean> {
    const res = await this.client.execute({
      sql: `SELECT human_takeover_until FROM sessions WHERE id = ?`,
      args: [sessionId],
    });

    if (res.rows.length === 0) {
      return false;
    }

    const row = res.rows[0] as unknown as { human_takeover_until: number };
    const currentTime = now ?? Date.now();
    return Number(row.human_takeover_until) > currentTime;
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
  public async isNewTurn(sessionId: string, timeoutHours = 2, now?: number): Promise<boolean> {
    const res = await this.client.execute({
      sql: `SELECT last_message_at, last_reply_at FROM sessions WHERE id = ?`,
      args: [sessionId],
    });

    if (res.rows.length === 0) {
      return true;
    }

    const row = res.rows[0] as unknown as { last_message_at: number; last_reply_at: number };
    const lastMsg = Number(row.last_message_at);
    const lastReply = Number(row.last_reply_at);

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

  /**
   * 删除指定会话记录
   */
  public async deleteSession(id: string): Promise<boolean> {
    const res = await this.client.execute({
      sql: `DELETE FROM sessions WHERE id = ?`,
      args: [id],
    });
    return res.rowsAffected > 0;
  }

  /**
   * 清空所有会话
   */
  public async clearAllSessions(): Promise<number> {
    const res = await this.client.execute('DELETE FROM sessions');
    return res.rowsAffected;
  }
}
