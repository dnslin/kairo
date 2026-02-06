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
  messageList: string;
  messageNode: string;
  messageSender: string;
  messageTime: string;
  messageContent: string;
  inputBox: string;
  sendButton: string;
  sessionList: string;
  sessionItem: string;
  sessionName: string;
  unreadBadge: string;
  groupIndicator: string;
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
}
