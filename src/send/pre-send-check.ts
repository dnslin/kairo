import type { DomLocator } from '../dom/locator.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('pre-send-check');

export interface MessageContext {
  sessionId: string;
  content: string;
  sender: string;
}

export type SendCheckReason = 'session_switched' | 'message_gone' | 'new_messages';

export interface SendCheckResult {
  safe: boolean;
  reason?: SendCheckReason;
  detail?: string;
}

/**
 * 发送前安全校验：确保回复发送到正确的会话且消息上下文未变化
 * @param locator - DOM 定位器
 * @param target - 目标消息上下文
 * @param abortOnNewMessages - 检测到新消息时是否中止发送（默认 true）
 */
export async function preSendCheck(
  locator: DomLocator,
  target: MessageContext,
  abortOnNewMessages = true
): Promise<SendCheckResult> {
  // 1. 检查会话是否切换
  const activeSessionId = await locator.getActiveSessionId();
  if (activeSessionId !== target.sessionId) {
    const detail = `当前会话: ${activeSessionId ?? '未知'}, 目标会话: ${target.sessionId}`;
    log.warn({ activeSessionId, targetSessionId: target.sessionId }, '会话已切换，中止发送');
    return { safe: false, reason: 'session_switched', detail };
  }

  // 2. 检查消息是否仍存在
  const exists = await locator.isMessageInDom(target.content, target.sender);
  if (!exists) {
    log.warn({ content: target.content.slice(0, 20) }, '消息已消失，中止发送');
    return { safe: false, reason: 'message_gone' };
  }

  // 3. 检查是否有新消息（可配置跳过）
  if (abortOnNewMessages) {
    const hasNew = await locator.hasNewMessagesSince(target.content, target.sender);
    if (hasNew) {
      log.warn({ content: target.content.slice(0, 20) }, '检测到新消息，中止发送');
      return { safe: false, reason: 'new_messages' };
    }
  }

  return { safe: true };
}
