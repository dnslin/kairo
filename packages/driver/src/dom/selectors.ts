import type { SelectorsConfig } from '../types/index.js';

export const DEFAULT_SELECTORS: SelectorsConfig = {
  sessionList: '.session-list',
  sessionItem: '.session-item',
  sessionTitle: '.session-name',
  sessionUnreadBadge: '.unread-badge',
  activeSession: '.session-item.active, .session-item.selected',
  messageList: '.chat-message-list, .message-container',
  messageItem: '.message-item, .chat-item',
  messageContent: '.message-text, .content',
  messageSender: '.sender-name, .nickname',
  messageTime: '.message-time, .time',
  messageIsMe: '.message-right, .is-me',
  inputBox: '#message-input, .input-editor, .chat-input',
  sendButton: '.send-btn, .btn-send',
  virtualScroller: '.vue-recycle-scroller',
};

export function resolveSelectors(custom?: Partial<SelectorsConfig>): SelectorsConfig {
  return {
    ...DEFAULT_SELECTORS,
    ...custom,
  };
}
