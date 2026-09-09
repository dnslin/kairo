import { createHash } from 'node:crypto';
import type { SendStatus } from '@kairo/driver';

export const SEND_QUERY_WAIT_MS = 30_000;
export const MAX_SEND_CALLS = 2;

export type SendPurpose = 'queued' | 'progress' | 'final' | `notice:${string}`;

/** 无任务的固定提示使用原始事件键；有上下文时必须传入 threadId。 */
export type SendSubject =
  | { kind: 'task'; taskId: string; inputVersion: number }
  | { kind: 'event'; botId: string; sessionId: string; messageId: string; threadId?: string };

export interface SendRequest {
  subject: SendSubject;
  purpose: SendPurpose;
  text: string;
}

export type DispatchStatus =
  | 'prepared'
  | 'sending'
  | 'retryable'
  | 'unknown'
  | 'querying'
  | 'delivered'
  | 'failed'
  | 'send_unconfirmed'
  | 'cancelled';

export interface SendIntent {
  intentKey: string;
  taskId: string | null;
  purpose: SendPurpose;
  sessionId: string;
  /** 协调请求摘要包含正文及主体版本，不替代 Driver 的消息指纹。 */
  contentDigest: string;
}

export interface SendDispatch extends SendIntent {
  operationId: string;
  status: DispatchStatus;
  sendCalls: number;
  queryUsed: boolean;
  queryDueAt: number | null;
  /** 首次最终判定时刻；未知且尚未最终判定时保持空值。 */
  resultAt: number | null;
  messageId: string | null;
  revision: number;
}

export type DispatchUpdate = Pick<
  SendDispatch,
  'status' | 'sendCalls' | 'queryUsed' | 'queryDueAt' | 'resultAt' | 'messageId'
>;

export interface SendDispatchStore {
  /** 同一 intentKey 原子创建或返回原记录；不同请求摘要明确报错。 */
  ensure(intent: SendIntent): Promise<SendDispatch>;
  get(operationId: string): Promise<SendDispatch | null>;
  /** 仅匹配 revision 的非终态可更新；返回 null 表示被其他调用推进。 */
  compareAndSet(
    operationId: string,
    revision: number,
    update: DispatchUpdate
  ): Promise<SendDispatch | null>;
}

export function isDispatchTerminal(status: DispatchStatus): boolean {
  return ['delivered', 'failed', 'send_unconfirmed', 'cancelled'].includes(status);
}

export function createSendIntent(request: SendRequest, sessionId: string): SendIntent {
  const subject = request.subject;
  const identity =
    subject.kind === 'task'
      ? ['task', subject.taskId]
      : ['event', subject.botId, subject.sessionId, subject.messageId];
  return {
    intentKey: JSON.stringify([...identity, request.purpose]),
    taskId: subject.kind === 'task' ? subject.taskId : null,
    purpose: request.purpose,
    sessionId,
    contentDigest: createHash('sha256')
      .update(
        JSON.stringify([
          identity,
          subject.kind === 'task' ? subject.inputVersion : (subject.threadId ?? null),
          request.text,
          sessionId,
        ])
      )
      .digest('hex'),
  };
}

/** 一次查询与一次重试共享整条 operation 的预算，不按失败分支重置。 */
export function statusAfterObservation(
  status: SendStatus,
  dispatch: Pick<SendDispatch, 'sendCalls' | 'queryUsed'>
): DispatchStatus {
  if (status === 'delivered') return 'delivered';
  if (status === 'failed') return dispatch.sendCalls < MAX_SEND_CALLS ? 'retryable' : 'failed';
  return dispatch.queryUsed ? 'send_unconfirmed' : 'unknown';
}
