import { createHash } from 'node:crypto';
import type { SendStatus } from './types/index.js';
import { SendError } from './utils/errors.js';

export type { SendStatus } from './types/index.js';

export type SendOperationMessageType =
  | 'text'
  | 'rich-text'
  | 'reply'
  | 'image'
  | 'file'
  | 'url-card'
  | 'biz-message'
  | 'app-message'
  | 'chat-record'
  | 'voice';

export interface SendOperationFingerprint {
  targetSessionId: string;
  messageType: SendOperationMessageType;
  contentDigest: string;
}

export interface SendOperationRecord {
  operationId: string;
  fingerprint: SendOperationFingerprint;
  status: SendStatus;
  messageId?: string;
  error?: string;
  isPreTrigger?: boolean;
  verifyLatencyMs?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SendOperationClaim {
  operationId: string;
  fingerprint: SendOperationFingerprint;
}

export interface SendOperationClaimResult {
  claimed: boolean;
  operation: SendOperationRecord;
}

export interface SendOperationUpdate {
  status: SendStatus;
  messageId?: string;
  error?: string;
  isPreTrigger?: boolean;
  verifyLatencyMs?: number;
}

export interface SendOperationStore {
  /** 原子声明发送意图；相同未知/已送达操作不得再次声明。 */
  claim(input: SendOperationClaim): Promise<SendOperationClaimResult>;
  /** 只读查询发送操作。 */
  get(operationId: string): Promise<SendOperationRecord | null>;
  /** 写入已观察到的发送状态。 */
  update(operationId: string, update: SendOperationUpdate): Promise<SendOperationRecord>;
}

export interface SendOperationFingerprintInput {
  targetSessionId?: string;
  messageType: SendOperationMessageType;
  content: unknown;
}

function normalizeOperationId(operationId: string): string {
  const normalized = operationId.trim();
  if (!normalized) {
    throw new SendError('operationId 不能为空');
  }
  return normalized;
}

function serializeContent(content: unknown): string {
  if (typeof content === 'string') return content;

  try {
    const serialized = JSON.stringify(content);
    if (serialized === undefined) {
      throw new Error('内容不可序列化');
    }
    return serialized;
  } catch (error) {
    const cause = error instanceof Error ? error : new Error(String(error));
    throw new SendError(`无法生成发送内容摘要: ${cause.message}`, cause);
  }
}

function cloneFingerprint(fingerprint: SendOperationFingerprint): SendOperationFingerprint {
  return { ...fingerprint };
}

function cloneOperation(operation: SendOperationRecord): SendOperationRecord {
  return { ...operation, fingerprint: cloneFingerprint(operation.fingerprint) };
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

export function createSendOperationFingerprint(
  input: SendOperationFingerprintInput
): SendOperationFingerprint {
  const contentDigest = createHash('sha256')
    .update(serializeContent(input.content), 'utf8')
    .digest('hex');

  return {
    targetSessionId: input.targetSessionId?.trim() ?? '',
    messageType: input.messageType,
    contentDigest,
  };
}

function runAsync<T>(operation: () => T): Promise<T> {
  return Promise.resolve().then(operation);
}

export class InMemorySendOperationStore implements SendOperationStore {
  private readonly operations = new Map<string, SendOperationRecord>();

  public claim(input: SendOperationClaim): Promise<SendOperationClaimResult> {
    return runAsync(() => this.claimNow(input));
  }

  private claimNow(input: SendOperationClaim): SendOperationClaimResult {
    const operationId = normalizeOperationId(input.operationId);
    const existing = this.operations.get(operationId);

    if (!existing) {
      const now = Date.now();
      const operation: SendOperationRecord = {
        operationId,
        fingerprint: cloneFingerprint(input.fingerprint),
        status: 'unknown',
        createdAt: now,
        updatedAt: now,
      };
      this.operations.set(operationId, operation);
      return { claimed: true, operation: cloneOperation(operation) };
    }

    if (!fingerprintsEqual(existing.fingerprint, input.fingerprint)) {
      throw new SendError(`operationId [${operationId}] 的 fingerprint 不一致，拒绝复用`);
    }

    if (existing.status === 'failed' && existing.isPreTrigger === true) {
      const operation: SendOperationRecord = {
        ...existing,
        status: 'unknown',
        messageId: undefined,
        error: undefined,
        isPreTrigger: undefined,
        verifyLatencyMs: undefined,
        updatedAt: Date.now(),
      };
      this.operations.set(operationId, operation);
      return { claimed: true, operation: cloneOperation(operation) };
    }

    return { claimed: false, operation: cloneOperation(existing) };
  }

  public get(operationId: string): Promise<SendOperationRecord | null> {
    return runAsync(() => this.getNow(operationId));
  }

  private getNow(operationId: string): SendOperationRecord | null {
    const normalizedOperationId = operationId.trim();
    if (!normalizedOperationId) return null;
    const operation = this.operations.get(normalizedOperationId);
    return operation ? cloneOperation(operation) : null;
  }

  public update(operationId: string, update: SendOperationUpdate): Promise<SendOperationRecord> {
    return runAsync(() => this.updateNow(operationId, update));
  }

  private updateNow(operationId: string, update: SendOperationUpdate): SendOperationRecord {
    const normalizedOperationId = normalizeOperationId(operationId);
    const existing = this.operations.get(normalizedOperationId);
    if (!existing) {
      throw new SendError(`未找到发送操作 [${normalizedOperationId}]`);
    }

    const updated: SendOperationRecord = {
      operationId: existing.operationId,
      fingerprint: cloneFingerprint(existing.fingerprint),
      status: update.status,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };
    if (update.messageId !== undefined) updated.messageId = update.messageId;
    if (update.error !== undefined) updated.error = update.error;
    if (update.isPreTrigger !== undefined) updated.isPreTrigger = update.isPreTrigger;
    if (update.verifyLatencyMs !== undefined) updated.verifyLatencyMs = update.verifyLatencyMs;

    this.operations.set(normalizedOperationId, updated);
    return cloneOperation(updated);
  }
}
