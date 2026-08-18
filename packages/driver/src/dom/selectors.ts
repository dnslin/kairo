import type { SelectorsConfig } from '../types/index.js';

export const DEFAULT_SELECTORS: SelectorsConfig = {
  sessionList: '.chatlist-wrap, .session-list',
  sessionItem: '.chat-item, .session-item',
  sessionTitle: '.chat-item-username, .session-name',
  sessionUnreadBadge: '.unread-badge, .badge, .chat-item-avatar .badge',
  activeSession: '.chat-item.chat-selected, .chat-item.active, .session-item.active',
  messageList: '.chat-content, .chat-message-list, .message-container',
  messageItem: '.record-item, .message-item, .chat-item',
  messageContent: '.pictext-text.js-highlight, .pictext-text, .msg-text, .message-text',
  messageSender: '.rcd-basic-name .username, .username, .sender-name',
  messageTime: '.rcd-time, .message-time, .time',
  messageIsMe: '.rcd-msg-right, .message-right, .is-me',
  inputBox: '.chat-sendArea, .chat-editor [contenteditable="true"], [contenteditable="true"]',
  sendButton: '.sendMsg-btn a.button, .sendMsg-btn, .send-btn',
  virtualScroller: '.vue-recycle-scroller',
};

export function resolveSelectors(custom?: Partial<SelectorsConfig>): SelectorsConfig {
  return {
    ...DEFAULT_SELECTORS,
    ...custom,
  };
}
