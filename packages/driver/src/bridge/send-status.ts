import { createHash, randomUUID } from 'node:crypto';
import type {
  SendOperationRecord,
  SendOperationStore,
  SendOperationUpdate,
} from '../send-operation.js';
import type { SendFileOptions, SendOptions, SendResult, SendStatus } from '../types/index.js';
import type { CdpClient } from '../cdp/client.js';
import {
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
} from './renderer-script.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-send-status');
export function isCdpUnavailableBeforeSend(cdp: CdpClient): boolean {
  const getStatus = (cdp as Partial<CdpClient>).getStatus;
  return typeof getStatus === 'function' && getStatus.call(cdp) !== 'connected';
}

export interface NativeSendStatusObservation {
  messageId: string;
  sessionId: string;
}

export function createNativeMessageKey(kind: string, operationId?: string): string {
  const normalizedOperationId = operationId?.trim();
  if (normalizedOperationId) {
    const key = `kairo:operation:${encodeURIComponent(normalizedOperationId)}`;
    // 保留已有合法键供历史回查；KK9 的 msgFlag 最多允许 64 个字符。
    if (key.length <= 64) return key;
    // 原生历史查询过滤 %C%；同时避开 SQLite LIKE 可能折叠的小写 c。
    // . 和 ~ 不在 Base64URL 字母表中，替换保持一一对应与完整摘要长度。
    const digest = createHash('sha256')
      .update(normalizedOperationId)
      .digest('base64url')
      .replaceAll('C', '.')
      .replaceAll('c', '~');
    return `k:op:${digest}`;
  }
  return `kairo:${kind}:${randomUUID()}`;
}
export async function resolveActiveSendOptions<T extends SendOptions | SendFileOptions>(
  cdp: CdpClient,
  options: T
): Promise<T | null> {
  if (options.targetSessionId?.trim()) return options;
  if (options.targetSessionId !== undefined && options.targetSessionId !== '') return null;

  try {
    const active = await cdp.evaluate<{
      id?: string | number;
      sesUUID?: string;
    } | null>(`
      (() => {
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const activeSession = editor?.activedSes;
        if (!activeSession) return null;
        return { id: activeSession.id, sesUUID: activeSession.sesUUID };
      })()
    `);
    const targetSessionId =
      active?.sesUUID?.trim() || (active?.id !== undefined ? String(active.id).trim() : '');
    return targetSessionId ? { ...options, targetSessionId } : null;
  } catch {
    return null;
  }
}

export function sendOperationRecordToResult(operation: SendOperationRecord): SendResult {
  return {
    success: operation.status === 'delivered',
    operationId: operation.operationId,
    status: operation.status,
    ...(operation.messageId !== undefined ? { messageId: operation.messageId } : {}),
    ...(operation.error !== undefined ? { error: operation.error } : {}),
    isPreTrigger: operation.status === 'failed' && operation.isPreTrigger === true,
    ...(operation.verifyLatencyMs !== undefined
      ? { verifyLatencyMs: operation.verifyLatencyMs }
      : {}),
  };
}
export function sendResultToOperationUpdate(result: SendResult): SendOperationUpdate {
  const hasMessageId = typeof result.messageId === 'string' && result.messageId.trim().length > 0;
  const status: SendStatus =
    (result.status === 'delivered' || result.success) && hasMessageId
      ? 'delivered'
      : result.isPreTrigger === true
        ? 'failed'
        : 'unknown';
  return {
    status,
    ...(status === 'delivered' && result.messageId !== undefined
      ? { messageId: result.messageId }
      : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
    isPreTrigger: status === 'failed',
    ...(result.verifyLatencyMs !== undefined ? { verifyLatencyMs: result.verifyLatencyMs } : {}),
  };
}

function unknownResult(operation: SendOperationRecord, error?: string): SendResult {
  const reason = error ?? operation.error;
  return {
    success: false,
    operationId: operation.operationId,
    status: 'unknown',
    ...(reason !== undefined ? { error: reason } : {}),
    isPreTrigger: false,
  };
}

function isValidNativeMessageId(messageId: string): boolean {
  const normalized = messageId.trim();
  const numericId = Number(normalized);
  return normalized.length > 0 && Number.isFinite(numericId) && numericId > 0;
}

export class BridgeSendStatus {
  constructor(
    private readonly cdp: CdpClient,
    private readonly store: SendOperationStore
  ) {}

  private async readNativeMessage(
    targetSessionId: string,
    nativeKey: string
  ): Promise<NativeSendStatusObservation | null> {
    const encoded = encodeRendererPayload({ target: targetSessionId, nativeKey });
    try {
      return await this.cdp.evaluate<NativeSendStatusObservation | null>(
        `
          (async () => {
            const electron = window.require ? window.require('electron') : null;
            const ipc = window.ipcRenderer || electron?.ipcRenderer;
            const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
            ${RENDERER_SESSION_RESOLVER_SCRIPT}
            ${RENDERER_IPC_HELPERS_SCRIPT}
            const data = JSON.parse(decodeURIComponent(${encoded}));
            const targetSession = resolveRendererSession(editor?.sortedSessions, data.target);
            if (!targetSession) return null;
            const targetSessionIds = [targetSession.id, targetSession.sesUUID, data.target]
              .filter(value => value !== undefined && value !== null && String(value).trim() !== '')
              .map(value => String(value));

            const response = await callKairoIpc('getMessages', {
              sessionID: targetSession.id,
              count: 100,
              endIdx: targetSession.maxMessageIndex ?? 2147483647,
              sendTime: 0
            });
            if (response?.code !== 0 || !Array.isArray(response.data)) return null;

            const found = response.data.find(message => {
              if (!message || message.msgFlag !== data.nativeKey || Number(message.id) <= 0) {
                return false;
              }
              const rawSessionId = message.sessionId ?? message.sessionID ?? message.sesUUID;
              return rawSessionId === undefined ||
                rawSessionId === null ||
                String(rawSessionId).trim() === '' ||
                targetSessionIds.includes(String(rawSessionId));
            });
            if (!found) return null;
            return { messageId: String(found.id), sessionId: String(data.target) };
          })()
        `,
        15000
      );
    } catch (err) {
      log.warn({ err: String(err) }, 'Bridge 查询发送操作原生历史异常');
      return null;
    }
  }

  public async getSendStatus(operationId: string): Promise<SendResult> {
    const normalizedOperationId = operationId.trim();
    const operation = await this.store.get(normalizedOperationId);
    if (!operation) {
      return {
        success: false,
        operationId: normalizedOperationId,
        status: 'unknown',
        isPreTrigger: false,
      };
    }
    return this.resolve(operation);
  }

  public async resolve(operation: SendOperationRecord): Promise<SendResult> {
    if (operation.status === 'failed' && operation.isPreTrigger === true) {
      return sendOperationRecordToResult(operation);
    }

    const targetSessionId = operation.fingerprint.targetSessionId.trim();
    if (!targetSessionId) {
      return unknownResult(operation, '发送操作缺少可查询的目标会话');
    }

    const nativeKey = createNativeMessageKey(
      operation.fingerprint.messageType,
      operation.operationId
    );
    const observation = await this.readNativeMessage(targetSessionId, nativeKey);
    if (
      !observation ||
      !isValidNativeMessageId(observation.messageId) ||
      observation.sessionId.trim() !== targetSessionId
    ) {
      return unknownResult(operation);
    }

    return {
      success: true,
      operationId: operation.operationId,
      status: 'delivered',
      messageId: observation.messageId,
      isPreTrigger: false,
      ...(operation.verifyLatencyMs !== undefined
        ? { verifyLatencyMs: operation.verifyLatencyMs }
        : {}),
    };
  }
}
