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

export interface SenderConfig {
  verifyTimeoutMs: number;
  logMasking: boolean;
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
