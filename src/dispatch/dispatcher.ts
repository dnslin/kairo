import type { OperationMode } from '../config/schema.js';
import type { Store } from '../store/index.js';
import type { Sender } from '../send/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('dispatch');

export interface DispatchDeps {
  store: Store;
  sender: Sender;
}

export interface DispatchInput {
  mode: OperationMode;
  reply: string;
  sessionId: string;
  sessionName: string;
  originalMessage: string;
  originalSender: string;
}

export interface DispatchResult {
  action: 'draft_created' | 'message_sent' | 'send_failed';
  draftId?: number;
  error?: string | undefined;
}

/**
 * 根据运行模式分发回复：草稿模式保存草稿，自动发送模式直接发送
 */
export async function dispatchReply(
  deps: DispatchDeps,
  input: DispatchInput
): Promise<DispatchResult> {
  const { store, sender } = deps;
  const { mode, reply, sessionId, sessionName, originalMessage, originalSender } = input;

  if (mode === 'draft_only') {
    const draftId = store.saveDraft({
      sessionId,
      sessionName,
      originalMessage,
      originalSender,
      draftContent: reply,
    });
    store.logEvent('draft_created', { draftId, sessionId, sessionName });
    store.saveMessage(sessionId, { sender: '自己', content: reply, isFromSelf: true }, sessionName);
    log.info({ draftId, sessionId, sessionName }, '草稿已生成，等待确认');
    return { action: 'draft_created', draftId };
  }

  // auto_send 模式
  const result = await sender.send(reply);
  if (result.success) {
    store.saveMessage(sessionId, { sender: '自己', content: reply, isFromSelf: true }, sessionName);
    store.logEvent('message_sent', { sessionId, sessionName });
    log.info({ sessionId }, '消息已自动发送');
    return { action: 'message_sent' };
  }

  store.logEvent('send_failed', { sessionId, error: result.error });
  log.error({ sessionId, error: result.error }, '自动发送失败');
  return { action: 'send_failed', error: result.error };
}
