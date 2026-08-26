import type { Client, InValue } from '@libsql/client';
import type {
  GetSessionHistoryOptions,
  MessageProcessingState,
  MessageRawPayload,
  MessageType,
  QueryMessagesOptions,
  SaveMessageInput,
  SessionMessage,
  SessionMessageOrigin,
  TombstoneType,
} from '../types/index.js';
import { DatabaseError, TransactionError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('message-repo');

/**
 * session_messages 表 SQLite 行结构
 */
interface MessageRow {
  id: number;
  session_id: string;
  message_id: string | null;
  sender: string;
  sender_id: string | null;
  content: string;
  message_type: string;
  origin: string | null;
  raw_payload: string | null;
  reply_target_id: string | null;
  is_from_self: number;
  is_recalled: number;
  created_at: number;
  processing_state?: string | null;
  processing_run_id?: string | null;
}

/**
 * 序列化多模态与扩展载荷
 */
function serializePayload(payload?: MessageRawPayload | string | null): string | null {
  if (!payload) {
    return null;
  }
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload);
  } catch (err) {
    log.warn({ err }, '序列化消息 raw_payload 发生异常，降级为空');
    return null;
  }
}

/**
 * 反序列化数据库存储的 JSON 载荷
 */
function deserializePayload(rawPayload: string | null): MessageRawPayload | null {
  if (!rawPayload) {
    return null;
  }
  try {
    return JSON.parse(rawPayload) as MessageRawPayload;
  } catch {
    return {
      type: 'text',
      data: { text: rawPayload },
    };
  }
}

/**
 * 将数据库 MessageRow 映射为领域实体 SessionMessage
 */
function mapRowToMessage(row: MessageRow): SessionMessage {
  const origin = (row.origin ||
    (Number(row.is_from_self) === 1 ? 'operator' : 'external')) as SessionMessageOrigin;
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    messageId: row.message_id ? String(row.message_id) : null,
    sender: String(row.sender),
    senderId: row.sender_id ? String(row.sender_id) : null,
    content: String(row.content),
    messageType: (row.message_type || 'text') as MessageType,
    origin,
    rawPayload: deserializePayload(row.raw_payload ? String(row.raw_payload) : null),
    replyTargetId: row.reply_target_id ? String(row.reply_target_id) : null,
    isFromSelf: Number(row.is_from_self) === 1,
    isRecalled: Number(row.is_recalled) === 1,
    createdAt: Number(row.created_at),
    processingState: (row.processing_state || 'pending') as MessageProcessingState,
    processingRunId: row.processing_run_id ? String(row.processing_run_id) : null,
  };
}

/**
 * 解析已存在记录或命中墓碑的拦截结果（去重共享助手）
 */
async function resolveExistingOrTombstonedMessage(
  executor: { execute: (stmt: { sql: string; args: InValue[] }) => Promise<{ rows: unknown[] }> },
  input: SaveMessageInput,
  messageId: string,
  meta: {
    senderId: string | null;
    messageType: MessageType;
    origin: SessionMessageOrigin;
    replyTargetId: string | null;
    createdAt: number;
  }
): Promise<SessionMessage | null> {
  // 1. 检查数据库中是否已存在既有真实记录
  const existingRes = await executor.execute({
    sql: `SELECT * FROM session_messages WHERE session_id = ? AND message_id = ? LIMIT 1`,
    args: [input.sessionId, messageId],
  });
  if (existingRes.rows.length > 0 && existingRes.rows[0]) {
    const existingMsg = mapRowToMessage(existingRes.rows[0] as unknown as MessageRow);
    const tombRes = await executor.execute({
      sql: `SELECT tombstone_type FROM message_tombstones WHERE session_id = ? AND message_id = ? LIMIT 1`,
      args: [input.sessionId, messageId],
    });
    const isTomb = tombRes.rows.length > 0;
    const tombType =
      isTomb && tombRes.rows[0]
        ? ((tombRes.rows[0] as unknown as { tombstone_type: string })
            .tombstone_type as TombstoneType)
        : undefined;
    return {
      ...existingMsg,
      isNewlyInserted: false,
      isTombstoned: isTomb,
      tombstoneType: tombType,
    };
  }

  // 2. 若无既有记录，说明被持久墓碑原子拒绝写入，返回墓碑擦除结果（绝不回传原始明文）
  const tombRes = await executor.execute({
    sql: `SELECT tombstone_type, operator, reason FROM message_tombstones WHERE session_id = ? AND message_id = ? LIMIT 1`,
    args: [input.sessionId, messageId],
  });
  if (tombRes.rows.length > 0 && tombRes.rows[0]) {
    const tombType = (tombRes.rows[0] as unknown as { tombstone_type: string })
      .tombstone_type as TombstoneType;
    return {
      id: 0,
      sessionId: input.sessionId,
      messageId,
      sender: input.sender,
      senderId: meta.senderId,
      content: '[COMPLIANCE_DELETED]',
      messageType: meta.messageType,
      origin: meta.origin,
      rawPayload: null,
      replyTargetId: meta.replyTargetId,
      isFromSelf: Boolean(input.isFromSelf),
      isRecalled: true,
      createdAt: meta.createdAt,
      processingState: 'raw_only',
      processingRunId: null,
      isNewlyInserted: false,
      isTombstoned: true,
      tombstoneType: tombType,
    };
  }

  return null;
}

/**
 * 消息仓储类
 * 负责会话消息持久化、原生 ID 100% 精确撤回、多模态载荷读写与历史上下文过滤
 */
export class MessageRepository {
  private readonly client: Client;
  private messageWriteQueue: Promise<void> = Promise.resolve();

  constructor(client: Client) {
    this.client = client;
  }
  private async withMessageWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const previousWrite = this.messageWriteQueue;
    let releaseWrite!: () => void;
    this.messageWriteQueue = new Promise<void>(resolve => {
      releaseWrite = resolve;
    });
    await previousWrite;
    try {
      return await operation();
    } finally {
      releaseWrite();
    }
  }

  /**
   * 保存单条会话消息
   * @param input 消息输入参数
   */
  public async saveMessage(input: SaveMessageInput): Promise<SessionMessage> {
    return this.withMessageWriteLock(async () => {
      const rawPayloadStr = serializePayload(input.rawPayload);
      const createdAt = input.createdAt ?? Date.now();
      const messageType = input.messageType || 'text';
      const origin = input.origin || (input.isFromSelf ? 'operator' : 'external');
      const isFromSelf = input.isFromSelf ? 1 : 0;
      const isRecalled = input.isRecalled ? 1 : 0;
      const messageId = input.messageId ?? null;
      const senderId = input.senderId ?? null;
      const replyTargetId = input.replyTargetId ?? null;
      const processingState = input.processingState ?? 'pending';

      try {
        // 原子插入：若 messageId 已存在于 message_tombstones，则 WHERE NOT EXISTS 阻止正文写入；ON CONFLICT 防止重复
        const info = await this.client.execute({
          sql: `INSERT INTO session_messages (
          session_id, message_id, sender, sender_id, content,
          message_type, origin, raw_payload, reply_target_id, is_from_self,
          is_recalled, created_at, processing_state, processing_run_id
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM message_tombstones
          WHERE session_id = ? AND message_id IS NOT NULL AND message_id = ?
        )
        ON CONFLICT (session_id, message_id) DO NOTHING`,
          args: [
            input.sessionId,
            messageId,
            input.sender,
            senderId,
            input.content,
            messageType,
            origin,
            rawPayloadStr,
            replyTargetId,
            isFromSelf,
            isRecalled,
            createdAt,
            processingState,
            null,
            input.sessionId,
            messageId ?? '',
          ],
        });

        const isNewlyInserted = info.rowsAffected > 0;
        if (!isNewlyInserted && messageId) {
          const tombOrExisting = await resolveExistingOrTombstonedMessage(
            this.client,
            input,
            messageId,
            {
              senderId,
              messageType,
              origin,
              replyTargetId,
              createdAt,
            }
          );
          if (tombOrExisting) {
            return tombOrExisting;
          }
        }

        const insertedId = Number(info.lastInsertRowid);

        return {
          id: insertedId,
          sessionId: input.sessionId,
          messageId,
          sender: input.sender,
          senderId,
          content: input.content,
          messageType,
          origin,
          rawPayload: deserializePayload(rawPayloadStr),
          replyTargetId,
          isFromSelf: Boolean(input.isFromSelf),
          isRecalled: Boolean(input.isRecalled),
          createdAt,
          processingState,
          processingRunId: null,
          isNewlyInserted,
          isTombstoned: false,
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        throw new DatabaseError(`持久化会话消息失败: ${err.message}`, err);
      }
    });
  }

  /**
   * 单事务原子批量保存多条消息
   * @param inputs 消息输入列表
   */
  public async saveMessages(inputs: SaveMessageInput[]): Promise<SessionMessage[]> {
    if (inputs.length === 0) {
      return [];
    }

    return this.withMessageWriteLock(async () => {
      const tx = await this.client.transaction('write');

      try {
        const results: SessionMessage[] = [];

        for (const input of inputs) {
          const rawPayloadStr = serializePayload(input.rawPayload);
          const createdAt = input.createdAt ?? Date.now();
          const messageType = input.messageType || 'text';
          const origin = input.origin || (input.isFromSelf ? 'operator' : 'external');
          const isFromSelf = input.isFromSelf ? 1 : 0;
          const isRecalled = input.isRecalled ? 1 : 0;
          const messageId = input.messageId ?? null;
          const senderId = input.senderId ?? null;
          const replyTargetId = input.replyTargetId ?? null;
          const processingState = input.processingState ?? 'pending';

          const info = await tx.execute({
            sql: `INSERT INTO session_messages (
            session_id, message_id, sender, sender_id, content,
            message_type, origin, raw_payload, reply_target_id, is_from_self,
            is_recalled, created_at, processing_state, processing_run_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM message_tombstones
            WHERE session_id = ? AND message_id IS NOT NULL AND message_id = ?
          )
          ON CONFLICT (session_id, message_id) DO NOTHING`,
            args: [
              input.sessionId,
              messageId,
              input.sender,
              senderId,
              input.content,
              messageType,
              origin,
              rawPayloadStr,
              replyTargetId,
              isFromSelf,
              isRecalled,
              createdAt,
              processingState,
              null,
              input.sessionId,
              messageId ?? '',
            ],
          });

          if (info.rowsAffected === 0 && messageId) {
            const tombOrExisting = await resolveExistingOrTombstonedMessage(tx, input, messageId, {
              senderId,
              messageType,
              origin,
              replyTargetId,
              createdAt,
            });
            if (tombOrExisting) {
              results.push(tombOrExisting);
              continue;
            }
          }

          const finalId = Number(info.lastInsertRowid);
          results.push({
            id: finalId,
            sessionId: input.sessionId,
            messageId,
            sender: input.sender,
            senderId,
            content: input.content,
            messageType,
            origin,
            rawPayload: deserializePayload(rawPayloadStr),
            replyTargetId,
            isFromSelf: Boolean(input.isFromSelf),
            isRecalled: Boolean(input.isRecalled),
            createdAt,
            processingState,
            processingRunId: null,
            isNewlyInserted: info.rowsAffected > 0,
          });
        }

        await tx.commit();
        return results;
      } catch (error) {
        await tx.rollback();
        const err = error instanceof Error ? error : new Error(String(error));
        throw new TransactionError(`批量保存会话消息失败: ${err.message}`, err);
      }
    });
  }

  /**
   * @param sessionId 会话 ID（确保跨会话隔离）
   * @param nativeMessageId 客户端原生消息 ID
   * @returns 是否成功匹配并更新记录
   */
  public async markMessageRecalled(sessionId: string, nativeMessageId: string): Promise<boolean> {
    if (!sessionId || !nativeMessageId) {
      return false;
    }

    const result = await this.client.execute({
      sql: `UPDATE session_messages
            SET is_recalled = 1
            WHERE session_id = ? AND message_id = ?`,
      args: [sessionId, nativeMessageId],
    });

    const affected = result.rowsAffected > 0;
    if (affected) {
      log.debug({ sessionId, nativeMessageId }, '已精准标记原生消息为撤回状态 (is_recalled = 1)');
    } else {
      log.debug({ sessionId, nativeMessageId }, '未找到匹配的原生消息或该消息已撤回');
    }
    return affected;
  }

  /**
   * 基于数据库自增 ID 标记消息为已撤回
   * @param id 消息自增 ID
   */
  public async markMessageRecalledById(id: number): Promise<boolean> {
    const result = await this.client.execute({
      sql: `UPDATE session_messages
            SET is_recalled = 1
            WHERE id = ?`,
      args: [id],
    });
    return result.rowsAffected > 0;
  }

  /**
   * 获取会话历史消息，默认在 SQL 层面严格过滤已撤回消息 (is_recalled = 0)
   *
   * @param sessionId 会话 ID
   * @param optionsOrLimit 返回条数限制或查询选项
   */
  public async getSessionHistory(
    sessionId: string,
    optionsOrLimit?: number | GetSessionHistoryOptions
  ): Promise<SessionMessage[]> {
    const options: GetSessionHistoryOptions =
      typeof optionsOrLimit === 'number'
        ? { limit: optionsOrLimit, includeRecalled: false }
        : optionsOrLimit || {};

    const includeRecalled = options.includeRecalled ?? false;
    const limit = options.limit;
    const order = options.order ?? 'asc';

    const conditions: string[] = ['session_id = ?'];
    const params: Array<string | number> = [sessionId];

    if (!includeRecalled) {
      conditions.push('is_recalled = 0');
    }

    if (options.beforeId !== undefined) {
      conditions.push('id < ?');
      params.push(options.beforeId);
    }

    if (options.beforeTimestamp !== undefined) {
      conditions.push('created_at < ?');
      params.push(options.beforeTimestamp);
    }

    if (options.afterId !== undefined) {
      conditions.push('id > ?');
      params.push(options.afterId);
    }

    if (options.afterTimestamp !== undefined) {
      conditions.push('created_at > ?');
      params.push(options.afterTimestamp);
    }

    const whereClause = conditions.join(' AND ');

    let rows: MessageRow[];

    if (limit && limit > 0) {
      // 当指定 limit 时，若要求时序正序返回，应先倒序获取最近的 limit 条，再按时序正序返回
      if (order === 'asc') {
        const sql = `
          SELECT * FROM (
            SELECT * FROM session_messages
            WHERE ${whereClause}
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          ) sub
          ORDER BY created_at ASC, id ASC
        `;
        params.push(limit);
        const res = await this.client.execute({ sql, args: params });
        rows = res.rows as unknown as MessageRow[];
      } else {
        const sql = `
          SELECT * FROM session_messages
          WHERE ${whereClause}
          ORDER BY created_at DESC, id DESC
          LIMIT ?
        `;
        params.push(limit);
        const res = await this.client.execute({ sql, args: params });
        rows = res.rows as unknown as MessageRow[];
      }
    } else {
      const sortOrder = order === 'desc' ? 'DESC' : 'ASC';
      const sql = `
        SELECT * FROM session_messages
        WHERE ${whereClause}
        ORDER BY created_at ${sortOrder}, id ${sortOrder}
      `;
      const res = await this.client.execute({ sql, args: params });
      rows = res.rows as unknown as MessageRow[];
    }

    return rows.map(mapRowToMessage);
  }

  /**
   * 根据原生消息 ID 查询单条消息记录
   */
  public async getMessageByNativeId(
    sessionId: string,
    nativeMessageId: string
  ): Promise<SessionMessage | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM session_messages WHERE session_id = ? AND message_id = ? ORDER BY id DESC LIMIT 1`,
      args: [sessionId, nativeMessageId],
    });

    if (res.rows.length === 0) {
      return null;
    }
    return mapRowToMessage(res.rows[0] as unknown as MessageRow);
  }

  /**
   * 根据数据库自增主键 ID 查询单条消息记录
   */
  public async getMessageById(id: number): Promise<SessionMessage | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM session_messages WHERE id = ?`,
      args: [id],
    });

    if (res.rows.length === 0) {
      return null;
    }
    return mapRowToMessage(res.rows[0] as unknown as MessageRow);
  }

  /**
   * 多维度消息动态复合查询
   */
  public async getMessages(options: QueryMessagesOptions = {}): Promise<SessionMessage[]> {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }

    if (options.sender) {
      conditions.push('sender = ?');
      params.push(options.sender);
    }

    if (options.senderId) {
      conditions.push('sender_id = ?');
      params.push(options.senderId);
    }

    if (options.messageType) {
      conditions.push('message_type = ?');
      params.push(options.messageType);
    }

    if (options.keyword) {
      conditions.push('content LIKE ?');
      params.push(`%${options.keyword}%`);
    }

    if (options.isFromSelf !== undefined) {
      conditions.push('is_from_self = ?');
      params.push(options.isFromSelf ? 1 : 0);
    }

    if (!options.includeRecalled) {
      conditions.push('is_recalled = 0');
    }

    if (options.startTime !== undefined) {
      conditions.push('created_at >= ?');
      params.push(options.startTime);
    }

    if (options.endTime !== undefined) {
      conditions.push('created_at <= ?');
      params.push(options.endTime);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sortOrder = options.order === 'asc' ? 'ASC' : 'DESC';
    const limit = options.limit ?? 50;
    const offset = options.offset ?? 0;

    const sql = `
      SELECT * FROM session_messages
      ${whereClause}
      ORDER BY created_at ${sortOrder}, id ${sortOrder}
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);
    const res = await this.client.execute({ sql, args: params });
    const rows = res.rows as unknown as MessageRow[];
    return rows.map(mapRowToMessage);
  }

  /**
   * 获取指定会话的消息总数
   */
  public async countSessionMessages(sessionId: string, includeRecalled = false): Promise<number> {
    const sql = includeRecalled
      ? 'SELECT COUNT(*) as total FROM session_messages WHERE session_id = ?'
      : 'SELECT COUNT(*) as total FROM session_messages WHERE session_id = ? AND is_recalled = 0';

    const res = await this.client.execute({ sql, args: [sessionId] });
    const row = res.rows[0] as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /**
   * 获取指定会话最新的一条消息
   */
  public async getLatestMessage(
    sessionId: string,
    includeRecalled = false
  ): Promise<SessionMessage | null> {
    const sql = includeRecalled
      ? 'SELECT * FROM session_messages WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
      : 'SELECT * FROM session_messages WHERE session_id = ? AND is_recalled = 0 ORDER BY created_at DESC, id DESC LIMIT 1';

    const res = await this.client.execute({ sql, args: [sessionId] });
    if (res.rows.length === 0) {
      return null;
    }
    return mapRowToMessage(res.rows[0] as unknown as MessageRow);
  }

  /**
   * 删除指定会话的所有历史消息
   */
  public async deleteSessionMessages(sessionId: string): Promise<number> {
    const res = await this.client.execute({
      sql: `DELETE FROM session_messages WHERE session_id = ?`,
      args: [sessionId],
    });
    return res.rowsAffected;
  }

  /**
   * 按 (session_id, message_id) 精确查询单条消息
   */
  public async getMessageBySessionAndMessageId(
    sessionId: string,
    messageId: string
  ): Promise<SessionMessage | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM session_messages WHERE session_id = ? AND message_id = ? LIMIT 1`,
      args: [sessionId, messageId],
    });
    if (res.rows.length === 0) {
      return null;
    }
    return mapRowToMessage(res.rows[0] as unknown as MessageRow);
  }
  /** 原子领取本轮仍 pending 的 Agent 输入子集，允许旧 claim 作为重聚上下文。 */
  public async claimMessagesForAgent(
    sessionId: string,
    messageIds: readonly string[],
    runId: string
  ): Promise<string[]> {
    const uniqueMessageIds = Array.from(new Set(messageIds.filter(Boolean)));
    if (uniqueMessageIds.length === 0) {
      return [];
    }

    return this.withMessageWriteLock(async () => {
      const claimedMessageIds: string[] = [];
      const tx = await this.client.transaction('write');
      try {
        for (const messageId of uniqueMessageIds) {
          const result = await tx.execute({
            sql: `UPDATE session_messages
                  SET processing_state = 'agent_claimed', processing_run_id = ?
                  WHERE session_id = ? AND message_id = ? AND processing_state = 'pending'`,
            args: [runId, sessionId, messageId],
          });
          if (result.rowsAffected === 1) {
            claimedMessageIds.push(messageId);
          }
        }
        await tx.commit();
        return claimedMessageIds;
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new TransactionError(`领取 Agent 输入消息失败: ${cause.message}`, cause);
      }
    });
  }
  /** Shutdown 或快照不一致时，按本次 run 精确释放 Agent claim，恢复补偿 pending。 */
  public async releaseAgentClaims(
    sessionId: string,
    messageIds: readonly string[],
    runId: string
  ): Promise<void> {
    const uniqueMessageIds = Array.from(new Set(messageIds.filter(Boolean)));
    if (uniqueMessageIds.length === 0) {
      return;
    }

    return this.withMessageWriteLock(async () => {
      const tx = await this.client.transaction('write');
      try {
        for (const messageId of uniqueMessageIds) {
          await tx.execute({
            sql: `UPDATE session_messages
                  SET processing_state = 'pending', processing_run_id = NULL
                  WHERE session_id = ? AND message_id = ?
                    AND processing_state = 'agent_claimed' AND processing_run_id = ?`,
            args: [sessionId, messageId, runId],
          });
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new TransactionError(`释放 Agent claim 失败: ${cause.message}`, cause);
      }
    });
  }

  /** 将已完成 Raw-only/抑制路径的消息标记为不再进入 Agent。 */
  public async markMessagesRawOnly(
    sessionId: string,
    messageIds: readonly string[]
  ): Promise<void> {
    const uniqueMessageIds = Array.from(new Set(messageIds.filter(Boolean)));
    if (uniqueMessageIds.length === 0) {
      return;
    }
    return this.withMessageWriteLock(async () => {
      const tx = await this.client.transaction('write');
      try {
        for (const messageId of uniqueMessageIds) {
          await tx.execute({
            sql: `UPDATE session_messages
                SET processing_state = 'raw_only'
                WHERE session_id = ? AND message_id = ? AND processing_state = 'pending'`,
            args: [sessionId, messageId],
          });
        }
        await tx.commit();
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        const cause = error instanceof Error ? error : new Error(String(error));
        throw new TransactionError(`标记 Raw-only 消息失败: ${cause.message}`, cause);
      }
    });
  }

  /**
   * 统计满足条件的消息数量
   */
  public async countMessages(options?: {
    sessionId?: string;
    includeRecalled?: boolean;
  }): Promise<number> {
    const conditions: string[] = [];
    const params: InValue[] = [];

    if (options?.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (!options?.includeRecalled) {
      conditions.push('is_recalled = 0');
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as total FROM session_messages ${whereClause}`;

    const res = await this.client.execute({ sql, args: params });
    const row = res.rows[0] as unknown as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  /**
   * 擦除单条消息的正文与多模态载荷（合规删除）
   */
  public async eraseMessageContent(sessionId: string, messageId: string): Promise<number> {
    const res = await this.client.execute({
      sql: `UPDATE session_messages
            SET content = '[COMPLIANCE_DELETED]', raw_payload = NULL, is_recalled = 1
            WHERE session_id = ? AND message_id = ?`,
      args: [sessionId, messageId],
    });
    return res.rowsAffected;
  }

  /**
   * 擦除会话内所有消息的正文与多模态载荷（合规删除）
   */
  public async eraseSessionMessagesContent(sessionId: string): Promise<number> {
    const res = await this.client.execute({
      sql: `UPDATE session_messages
            SET content = '[COMPLIANCE_DELETED]', raw_payload = NULL, is_recalled = 1
            WHERE session_id = ?`,
      args: [sessionId],
    });
    return res.rowsAffected;
  }

  /**
   * 擦除指定员工发出的所有消息正文与多模态载荷（合规删除）
   */
  public async eraseEmployeeMessagesContent(employeeId: string): Promise<number> {
    const res = await this.client.execute({
      sql: `UPDATE session_messages
            SET content = '[COMPLIANCE_DELETED]', raw_payload = NULL, is_recalled = 1
            WHERE sender_id = ?`,
      args: [employeeId],
    });
    return res.rowsAffected;
  }
}
