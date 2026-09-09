import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type {
  DispatchStatus,
  DispatchUpdate,
  SendDispatch,
  SendDispatchStore,
  SendIntent,
  SendPurpose,
} from './send-policy.js';

type DatabaseTimestamp = Date | number | string;

type SendDispatchRow = Record<string, unknown> & {
  operation_id: string;
  intent_key: string;
  task_id: string | null;
  purpose: SendPurpose;
  session_id: string;
  content_digest: string;
  status: DispatchStatus;
  send_calls: number;
  query_used: boolean;
  query_due_at: DatabaseTimestamp | null;
  message_id: string | null;
  revision: number;
};

const sendDispatchesTable = '"kairo"."send_dispatches"';

const ensureQuery = `
  INSERT INTO ${sendDispatchesTable} AS existing (
    operation_id,
    intent_key,
    task_id,
    purpose,
    session_id,
    content_digest
  )
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (intent_key) DO UPDATE
  SET intent_key = existing.intent_key
  RETURNING *
`;

const getQuery = `
  SELECT * FROM ${sendDispatchesTable}
  WHERE operation_id = $1
`;

const compareAndSetQuery = `
  UPDATE ${sendDispatchesTable}
  SET
    status = $3,
    send_calls = $4,
    query_used = $5,
    query_due_at = $6,
    message_id = $7,
    revision = revision + 1
  WHERE operation_id = $1
    AND revision = $2
    AND status NOT IN ('delivered', 'failed', 'send_unconfirmed', 'cancelled')
  RETURNING *
`;

function normalizeTimestamp(value: DatabaseTimestamp): number {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error('数据库字段 query_due_at 不是有效时间');
  }
  return timestamp;
}

function mapRow(row: SendDispatchRow): SendDispatch {
  return {
    operationId: row.operation_id,
    intentKey: row.intent_key,
    taskId: row.task_id,
    purpose: row.purpose,
    sessionId: row.session_id,
    contentDigest: row.content_digest,
    status: row.status,
    sendCalls: row.send_calls,
    queryUsed: row.query_used,
    queryDueAt: row.query_due_at === null ? null : normalizeTimestamp(row.query_due_at),
    messageId: row.message_id,
    revision: row.revision,
  };
}

export class PostgresSendDispatchStore implements SendDispatchStore {
  public constructor(private readonly pool: Pick<Pool, 'query'>) {}

  public async ensure(intent: SendIntent): Promise<SendDispatch> {
    const result = await this.pool.query<SendDispatchRow>(ensureQuery, [
      randomUUID(),
      intent.intentKey,
      intent.taskId,
      intent.purpose,
      intent.sessionId,
      intent.contentDigest,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`数据库未返回出站意图 [${intent.intentKey}]`);
    }
    if (
      row.task_id !== intent.taskId ||
      row.purpose !== intent.purpose ||
      row.session_id !== intent.sessionId ||
      row.content_digest !== intent.contentDigest
    ) {
      throw new Error(
        `出站意图 [${intent.intentKey}] 的任务、用途、会话或请求摘要不一致，拒绝复用`
      );
    }
    return mapRow(row);
  }

  public async get(operationId: string): Promise<SendDispatch | null> {
    const result = await this.pool.query<SendDispatchRow>(getQuery, [operationId]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  public async compareAndSet(
    operationId: string,
    revision: number,
    update: DispatchUpdate
  ): Promise<SendDispatch | null> {
    const result = await this.pool.query<SendDispatchRow>(compareAndSetQuery, [
      operationId,
      revision,
      update.status,
      update.sendCalls,
      update.queryUsed,
      update.queryDueAt === null ? null : new Date(update.queryDueAt),
      update.messageId,
    ]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }
}
