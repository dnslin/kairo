/**
 * @kkbot/driver 强类型定义
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type KK9SessionType = 'private' | 'group';

export interface KK9Session {
  id: string;
  name: string;
  type: KK9SessionType;
  unread: boolean;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageTime?: string;
  active?: boolean;
}

export interface KK9Message {
  /** 基于 SHA-256 计算的唯一消息指纹 */
  id: string;
  sessionId: string;
  sessionName: string;
  sessionType: KK9SessionType;
  sender: string;
  content: string;
  time: string;
  isMe: boolean;
  timestamp: number;
  raw?: Record<string, unknown>;
}

export interface SelectorsConfig {
  sessionList: string;
  sessionItem: string;
  sessionTitle: string;
  sessionUnreadBadge: string;
  activeSession: string;
  messageList: string;
  messageItem: string;
  messageContent: string;
  messageSender: string;
  messageTime: string;
  messageIsMe: string;
  inputBox: string;
  sendButton: string;
  virtualScroller?: string;
}

export interface CdpConfig {
  url: string;
  pageMatch: string;
  timeoutMs?: number;
  heartbeatIntervalMs?: number;
  maxReconnectRetries?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
}

export interface PollingConfig {
  intervalMs: number;
  switchDelayMs: number;
  maxSessionsPerCycle: number;
  maxMessagesPerSession: number;
}

export interface DriverConfig {
  cdp: CdpConfig;
  selectors?: Partial<SelectorsConfig>;
  polling?: Partial<PollingConfig>;
}

export interface SendResult {
  success: boolean;
  error?: string;
  verifyLatencyMs?: number;
}

export interface PreSendCheckResult {
  canSend: boolean;
  reason?: 'session_switched' | 'message_gone' | 'new_incoming_messages' | 'input_not_empty' | 'unknown';
  details?: string;
}

export interface DriverEvents {
  status: (status: ConnectionStatus) => void;
  message: (message: KK9Message) => void;
  error: (error: Error) => void;
  heartbeat: (uptimeMs: number) => void;
}
