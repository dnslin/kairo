import type { KK9Message, MessageDirection } from '@kairo/driver';

export interface MessageKey {
  sessionId: string;
  messageId: string;
}

export interface ContextScope {
  employeeId: string;
  botId: string;
  sessionId: string;
}

/** 只保存 Driver 已提供的附件元数据，不读取附件内容。 */
export type AttachmentMetadata = Pick<KK9Message, 'fileInfo' | 'images'>;

export interface RawMessageInput extends MessageKey {
  direction: MessageDirection;
  observedAt: number;
  text: string;
  messageType: KK9Message['messageType'] | null;
  attachments: AttachmentMetadata;
}

export interface RawMessage extends RawMessageInput {
  employeeId: string | null;
  processingResult: string | null;
}

export interface ChatContext extends ContextScope {
  threadId: string;
  version: number;
  createdAt: number;
  invalidatedAt: number | null;
  idleSince: number | null;
}

export type BatchStatus = 'collecting' | 'ready' | 'rejected' | 'discarded';

export interface MessageBatch extends ContextScope {
  batchId: string;
  threadId: string;
  firstObservedAt: number;
  quietDeadline: number;
  maxDeadline: number;
  status: BatchStatus;
}

/** 截止时间由后续聚合器计算；存储不会在重启或读取时重置时间。 */
export interface CreateBatchInput {
  batchId: string;
  threadId: string;
  firstMessage: MessageKey;
  quietDeadline: number;
  maxDeadline: number;
}

export interface NoticeKey {
  botId: string;
  sessionId: string;
  noticeType: string;
}

export interface PreparedContext {
  context: ChatContext;
  invalidatedThreadId: string | null;
  hadUnfinishedWork: boolean;
}

export interface PrivateChatStore {
  insertRawMessage(input: RawMessageInput): Promise<{ inserted: boolean; message: RawMessage }>;
  getRawMessage(key: MessageKey): Promise<RawMessage | null>;
  /** employeeId 必须来自 Driver 员工档案；仅接受与原始私聊会话 UID 匹配的身份。 */
  associateEmployee(key: MessageKey, employeeId: string): Promise<boolean>;
  setProcessingResult(key: MessageKey, result: string): Promise<boolean>;
  getCurrentContext(scope: ContextScope): Promise<ChatContext | null>;
  getContext(threadId: string): Promise<ChatContext | null>;
  /** 已有有效 context 时复用，否则以递增版本创建新的全局唯一 thread。 */
  createContext(scope: ContextScope, createdAt: number): Promise<ChatContext>;
  invalidateContext(scope: ContextScope, version: number, invalidatedAt: number): Promise<boolean>;
  setContextIdleSince(
    scope: ContextScope,
    version: number,
    idleSince: number | null
  ): Promise<boolean>;
  /** 原子选择或切换；clock 在取得 context 锁后采样，idleMs 为 null 时不判定空闲。 */
  prepareContext(
    scope: ContextScope,
    clock: () => number,
    options: { reset: boolean; idleMs: number | null }
  ): Promise<PreparedContext>;
  /** 在有效 context 行锁内同步交付；回调不得等待外部执行。 */
  withContextOutput<T>(
    threadId: string,
    output: (context: ChatContext) => T
  ): Promise<{ value: T } | null>;
  createBatch(input: CreateBatchInput): Promise<MessageBatch>;
  getBatch(batchId: string): Promise<MessageBatch | null>;
  getBatchMessages(batchId: string): Promise<RawMessage[]>;
  /** 追加与静默截止时间更新处于同一事务；最长截止时间不变。 */
  appendBatchMessage(batchId: string, key: MessageKey, quietDeadline: number): Promise<boolean>;
  setBatchStatus(batchId: string, status: Exclude<BatchStatus, 'collecting'>): Promise<boolean>;
  listCollectingBatches(scope: ContextScope): Promise<MessageBatch[]>;
  /** 首次或到达 nextAllowedAt 时原子占用窗口，不负责实际发送提示。 */
  claimNotice(key: NoticeKey, now: number, nextAllowedAt: number): Promise<boolean>;
}
