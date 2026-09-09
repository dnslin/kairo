import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { lockCurrentContext } from './context-lock.js';
import type {
  ChatContext,
  ContextScope,
  CreateBatchInput,
  MessageBatch,
  MessageKey,
  NoticeKey,
  PrivateChatStore,
  PreparedContext,
  RawMessage,
  RawMessageInput,
} from './types.js';

type RawMessageRow = {
  session_id: string;
  message_id: string;
  direction: RawMessage['direction'];
  observed_at: Date;
  text: string;
  message_type: RawMessage['messageType'];
  attachments: RawMessage['attachments'];
  employee_id: string | null;
  processing_result: string | null;
};

type ContextRow = {
  thread_id: string;
  employee_id: string;
  bot_id: string;
  session_id: string;
  version: number;
  created_at: Date;
  invalidated_at: Date | null;
  idle_since: Date | null;
};

type BatchRow = {
  batch_id: string;
  thread_id: string;
  employee_id: string;
  bot_id: string;
  session_id: string;
  first_observed_at: Date;
  quiet_deadline: Date;
  max_deadline: Date;
  status: MessageBatch['status'];
};

function mapMessage(row: RawMessageRow): RawMessage {
  return {
    sessionId: row.session_id,
    messageId: row.message_id,
    direction: row.direction,
    observedAt: row.observed_at.getTime(),
    text: row.text,
    messageType: row.message_type,
    attachments: row.attachments,
    employeeId: row.employee_id,
    processingResult: row.processing_result,
  };
}

function mapContext(row: ContextRow): ChatContext {
  return {
    threadId: row.thread_id,
    employeeId: row.employee_id,
    botId: row.bot_id,
    sessionId: row.session_id,
    version: row.version,
    createdAt: row.created_at.getTime(),
    invalidatedAt: row.invalidated_at?.getTime() ?? null,
    idleSince: row.idle_since?.getTime() ?? null,
  };
}

function mapBatch(row: BatchRow): MessageBatch {
  return {
    batchId: row.batch_id,
    threadId: row.thread_id,
    employeeId: row.employee_id,
    botId: row.bot_id,
    sessionId: row.session_id,
    firstObservedAt: row.first_observed_at.getTime(),
    quietDeadline: row.quiet_deadline.getTime(),
    maxDeadline: row.max_deadline.getTime(),
    status: row.status,
  };
}

/** 连接池由调用方持有和关闭；运行时不迁移、不记录正文、不清理历史。 */
export class PostgresPrivateChatStore implements PrivateChatStore {
  public constructor(private readonly pool: Pool) {}

  public async insertRawMessage(
    input: RawMessageInput
  ): Promise<{ inserted: boolean; message: RawMessage }> {
    const result = await this.pool.query<RawMessageRow>(
      `INSERT INTO kairo.raw_messages
         (session_id, message_id, direction, observed_at, text, message_type, attachments)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (session_id, message_id) DO NOTHING
       RETURNING *`,
      [
        input.sessionId,
        input.messageId,
        input.direction,
        new Date(input.observedAt),
        input.text,
        input.messageType,
        JSON.stringify(input.attachments),
      ]
    );
    const row = result.rows[0];
    if (row) return { inserted: true, message: mapMessage(row) };
    // 冲突语句会等待并发提交；使用下一条查询的新快照读取胜出者，保留首次观察内容。
    const message = await this.getRawMessage(input);
    if (!message) throw new Error('重复原始消息的已存记录不存在');
    return { inserted: false, message };
  }

  public async getRawMessage(key: MessageKey): Promise<RawMessage | null> {
    const result = await this.pool.query<RawMessageRow>(
      'SELECT * FROM kairo.raw_messages WHERE session_id = $1 AND message_id = $2',
      [key.sessionId, key.messageId]
    );
    return result.rows[0] ? mapMessage(result.rows[0]) : null;
  }

  public async associateEmployee(key: MessageKey, employeeId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.raw_messages SET employee_id = $3
       WHERE session_id = $1 AND message_id = $2
         AND session_id = '0-' || $3 AND $3 <> ''
         AND (employee_id IS NULL OR employee_id = $3)`,
      [key.sessionId, key.messageId, employeeId]
    );
    return result.rowCount === 1;
  }

  public async setProcessingResult(key: MessageKey, result: string): Promise<boolean> {
    const updated = await this.pool.query(
      `UPDATE kairo.raw_messages SET processing_result = $3
       WHERE session_id = $1 AND message_id = $2`,
      [key.sessionId, key.messageId, result]
    );
    return updated.rowCount === 1;
  }

  public async getCurrentContext(scope: ContextScope): Promise<ChatContext | null> {
    const result = await this.pool.query<ContextRow>(
      `SELECT * FROM kairo.contexts
       WHERE employee_id = $1 AND bot_id = $2 AND session_id = $3
         AND invalidated_at IS NULL`,
      [scope.employeeId, scope.botId, scope.sessionId]
    );
    return result.rows[0] ? mapContext(result.rows[0]) : null;
  }

  public async getContext(threadId: string): Promise<ChatContext | null> {
    const result = await this.pool.query<ContextRow>(
      'SELECT * FROM kairo.contexts WHERE thread_id = $1',
      [threadId]
    );
    return result.rows[0] ? mapContext(result.rows[0]) : null;
  }

  public async createContext(scope: ContextScope, createdAt: number): Promise<ChatContext> {
    return (await this.prepareContext(scope, () => createdAt, { reset: false, idleMs: null }))
      .context;
  }

  public async prepareContext(
    scope: ContextScope,
    clock: () => number,
    options: { reset: boolean; idleMs: number | null }
  ): Promise<PreparedContext> {
    return withTransaction(this.pool, async client => {
      // 首次创建没有可锁行；沿用范围锁分配版本，再锁当前 context。
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        JSON.stringify(['private-chat-context', scope.employeeId, scope.botId, scope.sessionId]),
      ]);
      const parameters = [scope.employeeId, scope.botId, scope.sessionId];
      const current = await client.query<ContextRow>(
        `SELECT * FROM kairo.contexts
         WHERE employee_id = $1 AND bot_id = $2 AND session_id = $3
           AND invalidated_at IS NULL FOR UPDATE`,
        parameters
      );
      const now = clock();
      const old = current.rows[0];
      let hadUnfinishedWork = false;
      if (old) {
        const work = await client.query<{ busy: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM kairo.tasks WHERE thread_id = $1
             AND status IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending'))
           OR EXISTS (SELECT 1 FROM kairo.message_batches b WHERE thread_id = $1
             AND (status = 'collecting' OR (status = 'ready'
               AND NOT EXISTS (SELECT 1 FROM kairo.tasks t WHERE t.batch_id = b.batch_id)))) AS busy`,
          [old.thread_id]
        );
        hadUnfinishedWork = work.rows[0]!.busy;
        const expired =
          options.idleMs !== null &&
          old.idle_since !== null &&
          !hadUnfinishedWork &&
          now - old.idle_since.getTime() > options.idleMs;
        if (!options.reset && !expired) {
          return { context: mapContext(old), invalidatedThreadId: null, hadUnfinishedWork };
        }
        // context 锁阻止新工作；只锁未完成任务，不扫描锁定已结束的历史任务行。
        await client.query(
          `SELECT task_id FROM kairo.tasks WHERE thread_id = $1
           AND status IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending')
           ORDER BY task_id FOR UPDATE`,
          [old.thread_id]
        );
        await client.query(
          `UPDATE kairo.message_batches b SET status = 'discarded'
           WHERE thread_id = $1 AND (status = 'collecting' OR (status = 'ready'
             AND NOT EXISTS (SELECT 1 FROM kairo.tasks t WHERE t.batch_id = b.batch_id)))`,
          [old.thread_id]
        );
        await client.query(
          `UPDATE kairo.user_waits SET closed_at = $2, resolution = 'cancelled'
           WHERE closed_at IS NULL AND task_id IN
             (SELECT task_id FROM kairo.tasks WHERE thread_id = $1)`,
          [old.thread_id, new Date(now)]
        );
        await client.query(
          `UPDATE kairo.tasks SET status = 'cancelled', ended_at = $2, updated_at = $2
           WHERE thread_id = $1 AND status IN
             ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending')`,
          [old.thread_id, new Date(now)]
        );
        await client.query(`UPDATE kairo.contexts SET invalidated_at = $2 WHERE thread_id = $1`, [
          old.thread_id,
          new Date(now),
        ]);
      }
      const created = await client.query<ContextRow>(
        `INSERT INTO kairo.contexts
           (employee_id, bot_id, session_id, thread_id, version, created_at)
         SELECT $1, $2, $3, $4, COALESCE(MAX(version), 0) + 1, $5
         FROM kairo.contexts WHERE employee_id = $1 AND bot_id = $2 AND session_id = $3
         RETURNING *`,
        [...parameters, randomUUID(), new Date(now)]
      );
      const row = created.rows[0];
      if (!row) throw new Error('数据库未返回新建上下文');
      return {
        context: mapContext(row),
        invalidatedThreadId: old?.thread_id ?? null,
        hadUnfinishedWork,
      };
    });
  }

  public async withContextOutput<T>(
    threadId: string,
    output: (context: ChatContext) => T
  ): Promise<{ value: T } | null> {
    return withTransaction(this.pool, async client => {
      const result = await client.query<ContextRow>(
        'SELECT * FROM kairo.contexts WHERE thread_id = $1 AND invalidated_at IS NULL FOR UPDATE',
        [threadId]
      );
      const row = result.rows[0];
      return row ? { value: output(mapContext(row)) } : null;
    });
  }

  public async invalidateContext(
    scope: ContextScope,
    version: number,
    invalidatedAt: number
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.contexts SET invalidated_at = $5
       WHERE employee_id = $1 AND bot_id = $2 AND session_id = $3
         AND version = $4 AND invalidated_at IS NULL`,
      [scope.employeeId, scope.botId, scope.sessionId, version, new Date(invalidatedAt)]
    );
    return result.rowCount === 1;
  }

  public async setContextIdleSince(
    scope: ContextScope,
    version: number,
    idleSince: number | null
  ): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.contexts SET idle_since = $5
       WHERE employee_id = $1 AND bot_id = $2 AND session_id = $3
         AND version = $4 AND invalidated_at IS NULL`,
      [
        scope.employeeId,
        scope.botId,
        scope.sessionId,
        version,
        idleSince === null ? null : new Date(idleSince),
      ]
    );
    return result.rowCount === 1;
  }

  public async createBatch(input: CreateBatchInput): Promise<MessageBatch> {
    return withTransaction(this.pool, async client => {
      if ((await lockCurrentContext(client, input.threadId)) === null) {
        throw new Error('批次需要有效上下文和身份匹配的员工入站消息');
      }
      const result = await client.query<BatchRow>(
        `INSERT INTO kairo.message_batches
           (batch_id, thread_id, employee_id, bot_id, session_id,
            first_observed_at, quiet_deadline, max_deadline, status)
         SELECT $1, c.thread_id, c.employee_id, c.bot_id, c.session_id,
                r.observed_at, $5, $6, 'collecting'
         FROM kairo.contexts c JOIN kairo.raw_messages r
           ON r.session_id = c.session_id AND r.employee_id = c.employee_id
         WHERE c.thread_id = $2 AND c.invalidated_at IS NULL
           AND r.session_id = $3 AND r.message_id = $4 AND r.direction = 'inbound'
         RETURNING *`,
        [
          input.batchId,
          input.threadId,
          input.firstMessage.sessionId,
          input.firstMessage.messageId,
          new Date(input.quietDeadline),
          new Date(input.maxDeadline),
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error('批次需要有效上下文和身份匹配的员工入站消息');
      await client.query(
        `INSERT INTO kairo.batch_messages (batch_id, session_id, message_id, position)
         VALUES ($1, $2, $3, 1)`,
        [input.batchId, input.firstMessage.sessionId, input.firstMessage.messageId]
      );
      return mapBatch(row);
    });
  }

  public async getBatch(batchId: string): Promise<MessageBatch | null> {
    const result = await this.pool.query<BatchRow>(
      'SELECT * FROM kairo.message_batches WHERE batch_id = $1',
      [batchId]
    );
    return result.rows[0] ? mapBatch(result.rows[0]) : null;
  }

  public async getBatchMessages(batchId: string): Promise<RawMessage[]> {
    const result = await this.pool.query<RawMessageRow>(
      `SELECT r.* FROM kairo.batch_messages bm
       JOIN kairo.raw_messages r USING (session_id, message_id)
       WHERE bm.batch_id = $1 ORDER BY bm.position`,
      [batchId]
    );
    return result.rows.map(mapMessage);
  }

  public async appendBatchMessage(
    batchId: string,
    key: MessageKey,
    quietDeadline: number
  ): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const owner = await client.query<{ thread_id: string }>(
        'SELECT thread_id FROM kairo.message_batches WHERE batch_id = $1',
        [batchId]
      );
      if (!owner.rows[0] || (await lockCurrentContext(client, owner.rows[0].thread_id)) === null)
        return false;
      const batch = await client.query<BatchRow>(
        `SELECT * FROM kairo.message_batches
         WHERE batch_id = $1 AND status = 'collecting' FOR UPDATE`,
        [batchId]
      );
      const row = batch.rows[0];
      if (!row) return false;
      const inserted = await client.query(
        `INSERT INTO kairo.batch_messages (batch_id, session_id, message_id, position)
         SELECT $1, r.session_id, r.message_id,
                (SELECT COALESCE(MAX(position), 0) + 1 FROM kairo.batch_messages WHERE batch_id = $1)
         FROM kairo.raw_messages r
         WHERE r.session_id = $2 AND r.message_id = $3
           AND r.session_id = $4 AND r.employee_id = $5 AND r.direction = 'inbound'
         ON CONFLICT (session_id, message_id) DO NOTHING`,
        [batchId, key.sessionId, key.messageId, row.session_id, row.employee_id]
      );
      if (inserted.rowCount !== 1) return false;
      await client.query(
        `UPDATE kairo.message_batches SET quiet_deadline = GREATEST(quiet_deadline, $2)
         WHERE batch_id = $1`,
        [batchId, new Date(quietDeadline)]
      );
      return true;
    });
  }

  public async setBatchStatus(
    batchId: string,
    status: Exclude<MessageBatch['status'], 'collecting'>
  ): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const owner = await client.query<{ thread_id: string }>(
        'SELECT thread_id FROM kairo.message_batches WHERE batch_id = $1',
        [batchId]
      );
      if (!owner.rows[0] || (await lockCurrentContext(client, owner.rows[0].thread_id)) === null)
        return false;
      const result = await client.query(
        `UPDATE kairo.message_batches SET status = $2
         WHERE batch_id = $1 AND status = 'collecting'`,
        [batchId, status]
      );
      return result.rowCount === 1;
    });
  }

  public async listCollectingBatches(scope: ContextScope): Promise<MessageBatch[]> {
    const result = await this.pool.query<BatchRow>(
      `SELECT * FROM kairo.message_batches
       WHERE employee_id = $1 AND bot_id = $2 AND session_id = $3 AND status = 'collecting'
       ORDER BY first_observed_at, batch_id`,
      [scope.employeeId, scope.botId, scope.sessionId]
    );
    return result.rows.map(mapBatch);
  }

  public async claimNotice(key: NoticeKey, now: number, nextAllowedAt: number): Promise<boolean> {
    const result = await this.pool.query(
      `INSERT INTO kairo.notice_limits AS existing
         (bot_id, session_id, notice_type, last_notified_at, next_allowed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (bot_id, session_id, notice_type) DO UPDATE
         SET last_notified_at = EXCLUDED.last_notified_at,
             next_allowed_at = EXCLUDED.next_allowed_at
         WHERE existing.next_allowed_at <= EXCLUDED.last_notified_at
       RETURNING bot_id`,
      [key.botId, key.sessionId, key.noticeType, new Date(now), new Date(nextAllowedAt)]
    );
    return result.rowCount === 1;
  }
}
