export interface CdpConfig {
  url: string;
  reconnect: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
  };
}

export interface PageConfig {
  match: string;
}

export interface SelectorsConfig {
  sessionList: string;
  sessionScroller: string;
  sessionItem: string;
  sessionItemSelected: string;
  sessionName: string;
  sessionTime: string;
  sessionPreview: string;
  sessionUnread: string;
  groupAvatar: string;
  discussAvatar: string;
  privateAvatar: string;
  messageContainer: string;
  messageItem: string;
  messageContent: string;
  messageSender: string;
  messageTime: string;
  messageLeft: string;
  messageRight: string;
  editorArea: string;
  inputBox: string;
  sendButton: string;
}

export interface WatcherConfig {
  intervalMs: number;
  maxMessages: number;
  switchDelayMs: number;       // 会话切换延迟(毫秒)，默认 500
  maxSessionsPerCycle: number; // 每轮最大处理会话数，默认 10
}

export interface ThrottleConfig {
  perSessionMinIntervalSeconds: number;
  dailyMaxPerSession: number;
}

export type SessionType = 'private' | 'group';

export interface PolicyConfig {
  whitelist: string[];
  blacklist: string[];
  sessionTypes: SessionType[];
  workingHours: string;
  throttle: ThrottleConfig;
}

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeout: number;
  maxTokens: number;
  contextMessages: number;
  systemPrompt: string;
  /** 触发摘要生成的消息间隔数（0 = 禁用） */
  summaryIntervalMessages: number;
  /** 摘要生成的系统提示词 */
  summaryPrompt: string;
}

export interface ValidationConfig {
  sensitiveWords: string[];
  maxReplyLength: number;
}

export type OperationMode = 'draft_only' | 'auto_send';

export interface OpsConfig {
  port: number;
  host: string;
}

export interface LoggingConfig {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  pretty: boolean;
}

export interface StoreConfig {
  dbPath: string;
  storeMessageContent: boolean;
}

export interface SendCheckConfig {
  /** 发送前检测到新消息时是否中止发送，默认 true */
  abortOnNewMessages: boolean;
}

export interface SenderConfig {
  verifyTimeoutMs: number;
  logMasking: boolean;
  sendCheck?: SendCheckConfig;
}

export interface AppConfig {
  cdp: CdpConfig;
  page: PageConfig;
  selectors: SelectorsConfig;
  watcher: WatcherConfig;
  policy: PolicyConfig;
  llm: LlmConfig;
  validation: ValidationConfig;
  mode: OperationMode;
  ops: OpsConfig;
  logging: LoggingConfig;
  sender: SenderConfig;
  store: StoreConfig;
}
