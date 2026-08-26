import { randomUUID } from 'node:crypto';
import type { Client, InValue } from '@libsql/client';
import type {
  ComplianceDeletionRecord,
  MessageTombstone,
  RecordComplianceDeletionInput,
  RecordTombstoneInput,
  TombstoneType,
} from '../types/index.js';
import { DatabaseError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('tombstone-repo');

interface TombstoneRow {
  id: string;
  session_id: string;
  message_id: string;
  tombstone_type: string;
  operator: string | null;
  reason: string | null;
  created_at: number;
}

interface ComplianceDeletionRow {
  id: string;
  command_id: string;
  target_type: string;
  target_id: string;
  session_id: string | null;
  scope: string;
  reason: string;
  operator: string;
  status: string;
  erased_messages_count: number;
  erased_deliveries_count: number;
  created_at: number;
  completed_at: number | null;
  error: string | null;
}

function mapRowToTombstone(row: TombstoneRow): MessageTombstone {
  return {
    id: row.id,
    sessionId: row.session_id,
    messageId: row.message_id,
    tombstoneType: row.tombstone_type as TombstoneType,
    operator: row.operator,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapRowToComplianceDeletion(row: ComplianceDeletionRow): ComplianceDeletionRecord {
  return {
    id: row.id,
    commandId: row.command_id,
    targetType: row.target_type as ComplianceDeletionRecord['targetType'],
    targetId: row.target_id,
    sessionId: row.session_id,
    scope: row.scope,
    reason: row.reason,
    operator: row.operator,
    status: row.status as 'completed' | 'failed',
    erasedMessagesCount: row.erased_messages_count,
    erasedDeliveriesCount: row.erased_deliveries_count,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    error: row.error,
  };
}

/**
 * 墓碑与合规删除仓储类
 * 负责消息持久墓碑记录、防复活检测与合规删除审计
 */
export class TombstoneRepository {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 记录消息墓碑（支持撤回与合规删除类型）
   * 合规删除墓碑优先覆盖普通撤回墓碑
   */
  public async recordTombstone(input: RecordTombstoneInput): Promise<MessageTombstone> {
    const id = input.id || `tomb_${randomUUID()}`;
    const now = input.createdAt || Date.now();

    const sql = `
      INSERT INTO message_tombstones (
        id, session_id, message_id, tombstone_type, operator, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, message_id) DO UPDATE SET
        tombstone_type = CASE
          WHEN excluded.tombstone_type = 'compliance_deletion' THEN 'compliance_deletion'
          ELSE message_tombstones.tombstone_type
        END,
        operator = COALESCE(excluded.operator, message_tombstones.operator),
        reason = COALESCE(excluded.reason, message_tombstones.reason)
    `;

    const args: InValue[] = [
      id,
      input.sessionId,
      input.messageId,
      input.type,
      input.operator ?? null,
      input.reason ?? null,
      now,
    ];

    try {
      await this.client.execute({ sql, args });
      const tombstone = await this.getTombstone(input.sessionId, input.messageId);
      if (!tombstone) {
        throw new Error(`记录墓碑后未能查询到记录: [${input.sessionId}:${input.messageId}]`);
      }
      log.debug(
        { sessionId: input.sessionId, messageId: input.messageId, type: input.type },
        '成功持久化消息墓碑'
      );
      return tombstone;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, sessionId: input.sessionId, messageId: input.messageId }, '持久化消息墓碑异常');
      throw new DatabaseError(`持久化消息墓碑失败: ${cause.message}`, cause);
    }
  }

  /**
   * 检查指定消息是否已被墓碑化 (tombstoned)
   */
  public async isTombstoned(sessionId: string, messageId: string): Promise<boolean> {
    const sql = 'SELECT 1 FROM message_tombstones WHERE session_id = ? AND message_id = ? LIMIT 1';
    try {
      const rs = await this.client.execute({ sql, args: [sessionId, messageId] });
      return rs.rows.length > 0;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, sessionId, messageId }, '查询消息墓碑状态异常');
      throw new DatabaseError(`查询消息墓碑状态失败: ${cause.message}`, cause);
    }
  }

  /**
   * 获取指定消息的墓碑实体
   */
  public async getTombstone(sessionId: string, messageId: string): Promise<MessageTombstone | null> {
    const sql = 'SELECT * FROM message_tombstones WHERE session_id = ? AND message_id = ? LIMIT 1';
    try {
      const rs = await this.client.execute({ sql, args: [sessionId, messageId] });
      if (rs.rows.length === 0) {
        return null;
      }
      return mapRowToTombstone(rs.rows[0] as unknown as TombstoneRow);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, sessionId, messageId }, '获取消息墓碑实体异常');
      throw new DatabaseError(`获取消息墓碑实体失败: ${cause.message}`, cause);
    }
  }

  /**
   * 获取会话内所有墓碑实体
   */
  public async getTombstonesBySession(sessionId: string): Promise<MessageTombstone[]> {
    const sql = 'SELECT * FROM message_tombstones WHERE session_id = ? ORDER BY created_at ASC';
    try {
      const rs = await this.client.execute({ sql, args: [sessionId] });
      return rs.rows.map(r => mapRowToTombstone(r as unknown as TombstoneRow));
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, sessionId }, '查询会话消息墓碑列表异常');
      throw new DatabaseError(`查询会话消息墓碑列表失败: ${cause.message}`, cause);
    }
  }

  /**
   * 获取会话内所有已被墓碑化的 messageId 集合
   */
  public async getTombstoneSet(sessionId: string): Promise<Set<string>> {
    const sql = 'SELECT message_id FROM message_tombstones WHERE session_id = ?';
    try {
      const rs = await this.client.execute({ sql, args: [sessionId] });
      const set = new Set<string>();
      for (const row of rs.rows) {
        if (row.message_id && typeof row.message_id === 'string') {
          set.add(row.message_id);
        }
      }
      return set;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, sessionId }, '查询会话墓碑 ID 集合异常');
      throw new DatabaseError(`查询会话墓碑 ID 集合失败: ${cause.message}`, cause);
    }
  }

  /**
   * 记录合规删除审计记录
   */
  public async recordComplianceDeletion(
    input: RecordComplianceDeletionInput
  ): Promise<ComplianceDeletionRecord> {
    const id = input.id || `cdel_${randomUUID()}`;
    const now = input.createdAt || Date.now();

    const sql = `
      INSERT INTO compliance_deletions (
        id, command_id, target_type, target_id, session_id, scope, reason,
        operator, status, erased_messages_count, erased_deliveries_count,
        created_at, completed_at, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (command_id) DO UPDATE SET
        status = excluded.status,
        erased_messages_count = excluded.erased_messages_count,
        erased_deliveries_count = excluded.erased_deliveries_count,
        completed_at = excluded.completed_at,
        error = excluded.error
    `;

    const args: InValue[] = [
      id,
      input.commandId,
      input.targetType,
      input.targetId,
      input.sessionId ?? null,
      input.scope,
      input.reason,
      input.operator,
      input.status,
      input.erasedMessagesCount ?? 0,
      input.erasedDeliveriesCount ?? 0,
      now,
      input.completedAt ?? (input.status === 'completed' ? Date.now() : null),
      input.error ?? null,
    ];

    try {
      await this.client.execute({ sql, args });
      const record = await this.getComplianceDeletion(input.commandId);
      if (!record) {
        throw new Error(`记录合规删除后未能查询到记录: commandId=[${input.commandId}]`);
      }
      log.info(
        { commandId: input.commandId, targetType: input.targetType, targetId: input.targetId, status: input.status },
        '成功持久化合规删除审计记录'
      );
      return record;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, commandId: input.commandId }, '持久化合规删除审计记录异常');
      throw new DatabaseError(`持久化合规删除审计记录失败: ${cause.message}`, cause);
    }
  }

  /**
   * 按 commandId 获取合规删除审计记录
   */
  public async getComplianceDeletion(commandId: string): Promise<ComplianceDeletionRecord | null> {
    const sql = 'SELECT * FROM compliance_deletions WHERE command_id = ? LIMIT 1';
    try {
      const rs = await this.client.execute({ sql, args: [commandId] });
      if (rs.rows.length === 0) {
        return null;
      }
      return mapRowToComplianceDeletion(rs.rows[0] as unknown as ComplianceDeletionRow);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err: cause, commandId }, '获取合规删除审计记录异常');
      throw new DatabaseError(`获取合规删除审计记录失败: ${cause.message}`, cause);
    }
  }
}
