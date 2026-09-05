import { randomUUID } from 'node:crypto';
import {
  SendError,
  type SendOperationClaim,
  type SendOperationClaimResult,
  type SendOperationFingerprint,
  type SendOperationMessageType,
  type SendOperationRecord,
  type SendOperationStore,
  type SendOperationUpdate,
} from '@kairo/driver';
import type { Pool } from 'pg';

type DatabaseTimestamp = Date | number | string;

type SendOperationRow = Record<string, unknown> & {
  operation_id: string;
  target_session_id: string;
  message_type: SendOperationMessageType;
  content_digest: string;
  status: 'delivered' | 'failed' | 'unknown';
  message_id: string | null;
  error: string | null;
  is_pre_trigger: boolean | null;
  verify_latency_ms: number | string | null;
  created_at: DatabaseTimestamp;
  updated_at: DatabaseTimestamp;
  claimed?: boolean;
};

const sendOperationsTable = '"kairo"."send_operations"';

const retryableClaimCondition = `
      existing.target_session_id = EXCLUDED.target_session_id
       AND existing.message_type = EXCLUDED.message_type
       AND existing.content_digest = EXCLUDED.content_digest
       AND existing.status = 'failed'
       AND existing.is_pre_trigger = true
`;

const claimQuery = `
  INSERT INTO ${sendOperationsTable} AS existing (
    operation_id,
    target_session_id,
    message_type,
    content_digest,
    native_key,
    status,
    is_pre_trigger,
    claim_token
  )
  VALUES ($1, $2, $3, $4, $5, 'unknown', false, $6)
  ON CONFLICT (operation_id) DO UPDATE
  SET
    operation_id = existing.operation_id,
    status = CASE
      WHEN ${retryableClaimCondition}
      THEN 'unknown'
      ELSE existing.status
    END,
    message_id = CASE
      WHEN ${retryableClaimCondition}
      THEN NULL
      ELSE existing.message_id
    END,
    error = CASE
      WHEN ${retryableClaimCondition}
      THEN NULL
      ELSE existing.error
    END,
    is_pre_trigger = CASE
      WHEN ${retryableClaimCondition}
      THEN NULL
      ELSE existing.is_pre_trigger
    END,
    verify_latency_ms = CASE
      WHEN ${retryableClaimCondition}
      THEN NULL
      ELSE existing.verify_latency_ms
    END,
    claim_token = CASE
      WHEN ${retryableClaimCondition}
      THEN EXCLUDED.claim_token
      ELSE existing.claim_token
    END,
    updated_at = CASE
      WHEN ${retryableClaimCondition}
      THEN CURRENT_TIMESTAMP
      ELSE existing.updated_at
    END
  RETURNING
    operation_id,
    target_session_id,
    message_type,
    content_digest,
    status,
    message_id,
    error,
    is_pre_trigger,
    verify_latency_ms,
    created_at,
    updated_at,
    claim_token = $6 AS claimed
`;

const getQuery = `
  SELECT
    operation_id,
    target_session_id,
    message_type,
    content_digest,
    status,
    message_id,
    error,
    is_pre_trigger,
    verify_latency_ms,
    created_at,
    updated_at
  FROM ${sendOperationsTable}
  WHERE operation_id = $1
`;

const updateQuery = `
  UPDATE ${sendOperationsTable}
  SET
    status = $2,
    message_id = $3,
    error = $4,
    is_pre_trigger = $5,
    verify_latency_ms = $6,
    updated_at = CURRENT_TIMESTAMP
  WHERE operation_id = $1
  RETURNING
    operation_id,
    target_session_id,
    message_type,
    content_digest,
    status,
    message_id,
    error,
    is_pre_trigger,
    verify_latency_ms,
    created_at,
    updated_at
`;

function normalizeOperationId(operationId: string): string {
  const normalized = operationId.trim();
  if (!normalized) {
    throw new SendError('operationId 不能为空');
  }
  return normalized;
}

function normalizeFingerprint(fingerprint: SendOperationFingerprint): SendOperationFingerprint {
  return {
    targetSessionId: fingerprint.targetSessionId.trim(),
    messageType: fingerprint.messageType,
    contentDigest: fingerprint.contentDigest,
  };
}

function fingerprintsEqual(
  left: SendOperationFingerprint,
  right: SendOperationFingerprint
): boolean {
  return (
    left.targetSessionId === right.targetSessionId &&
    left.messageType === right.messageType &&
    left.contentDigest === right.contentDigest
  );
}

function normalizeTimestamp(value: DatabaseTimestamp, field: string): number {
  const timestamp = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    throw new Error(`数据库字段 ${field} 不是有效时间`);
  }
  return timestamp;
}

function mapRow(row: SendOperationRow): SendOperationRecord {
  const operation: SendOperationRecord = {
    operationId: row.operation_id,
    fingerprint: {
      targetSessionId: row.target_session_id,
      messageType: row.message_type,
      contentDigest: row.content_digest,
    },
    status: row.status,
    createdAt: normalizeTimestamp(row.created_at, 'created_at'),
    updatedAt: normalizeTimestamp(row.updated_at, 'updated_at'),
  };

  if (row.message_id !== null) operation.messageId = row.message_id;
  if (row.error !== null) operation.error = row.error;
  if (row.is_pre_trigger !== null) operation.isPreTrigger = row.is_pre_trigger;
  if (row.verify_latency_ms !== null) operation.verifyLatencyMs = Number(row.verify_latency_ms);

  return operation;
}

export class PostgresSendOperationStore implements SendOperationStore {
  public constructor(private readonly pool: Pick<Pool, 'query'>) {}

  public async claim(input: SendOperationClaim): Promise<SendOperationClaimResult> {
    const operationId = normalizeOperationId(input.operationId);
    const fingerprint = normalizeFingerprint(input.fingerprint);
    const claimToken = randomUUID();
    const result = await this.pool.query<SendOperationRow>(claimQuery, [
      operationId,
      fingerprint.targetSessionId,
      fingerprint.messageType,
      fingerprint.contentDigest,
      `kairo:operation:${encodeURIComponent(operationId)}`,
      claimToken,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error(`数据库未返回发送操作 [${operationId}]`);
    }

    const operation = mapRow(row);
    if (!fingerprintsEqual(operation.fingerprint, fingerprint)) {
      throw new SendError(`operationId [${operationId}] 的 fingerprint 不一致，拒绝复用`);
    }

    return {
      claimed: row.claimed === true,
      operation,
    };
  }

  public async get(operationId: string): Promise<SendOperationRecord | null> {
    const normalizedOperationId = operationId.trim();
    if (!normalizedOperationId) return null;

    const result = await this.pool.query<SendOperationRow>(getQuery, [normalizedOperationId]);
    const row = result.rows[0];
    return row ? mapRow(row) : null;
  }

  public async update(
    operationId: string,
    update: SendOperationUpdate
  ): Promise<SendOperationRecord> {
    const normalizedOperationId = normalizeOperationId(operationId);
    const result = await this.pool.query<SendOperationRow>(updateQuery, [
      normalizedOperationId,
      update.status,
      update.messageId ?? null,
      update.error ?? null,
      update.isPreTrigger ?? null,
      update.verifyLatencyMs ?? null,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new SendError(`未找到发送操作 [${normalizedOperationId}]`);
    }
    return mapRow(row);
  }
}
