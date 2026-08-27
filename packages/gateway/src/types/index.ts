import type {
  FormattedText,
  KK9Driver,
  KK9Message,
  KK9SessionType,
  SendOptions,
  SendResult,
} from '@kkbot/driver';
import type {
  KKBotStore,
  SessionMessage,
  SessionMode,
  ComplianceDeletionCommand,
} from '@kkbot/store';
import type { KKBotAgent, KKBotAgentRunResult, Memory } from '@kkbot/agent';

/**
 * 防抖合并后的聚合消息上下文实体
 */
export interface ConsolidatedMessage {
  /** 会话唯一标识 */
  sessionId: string;
  /** 会话名称 */
  sessionName: string;
  /** 会话类型 (私聊 private 或群聊 group) */
  sessionType: KK9SessionType;
  /** 消息发送者名称 (默认取首条或最新发送者) */
  sender: string;
  /** 发送者 UID (若存在) */
  senderId?: string;
  /** 多条消息合并后的多行文本内容 (以换行符 \n 连接) */
  content: string;
  /** 聚合的消息数量 */
  messageCount: number;
  /** 聚合的所有原始消息列表 (按到达时间升序排列) */
  messages: KK9Message[];
  /** 聚合批次内首条消息接收时间戳 */
  firstReceivedAt: number;
  /** 聚合批次内最后一条消息接收时间戳 */
  lastReceivedAt: number;
  /** 包含的所有 KK9 原生消息 ID 列表 */
  messageIds: string[];
  /** 是否包含 @ 当前机器人 */
  atMe?: boolean;
  /** 是否包含 @ 全体成员 */
  atAll?: boolean;
}

/**
 * 消息分发与回复执行结果
 */
export interface CoordinatorDispatchResult {
  /** 执行动作类型 */
  action: 'message_sent' | 'suppressed' | 'send_failed';
  /** 整体操作是否成功 */
  success: boolean;
  /** 目标会话 ID */
  sessionId: string;
  /** 发送成功的消息 ID（若有） */
  messageId?: string;
  /** 异常信息（若有） */
  error?: string;
  /** 视觉红点是否已被显式清除 */
  redDotCleared: boolean;
}

/**
 * 在途生成会话实体 (In-flight Lock)
 */
export interface InFlightSession {
  /** 会话 ID */
  sessionId: string;
  /** 当前运行的唯一 Run ID */
  runId?: string;
  /** 当前在途处理的原生消息 ID 列表 */
  inputMessageIds?: string[];
  /** 用于 50ms 瞬时切断的中断控制器 */
  abortController: AbortController;
  /** 开始生成时间戳 */
  startedAt: number;
  /** 当前处理的聚合消息快照 */
  message: ConsolidatedMessage;
  /** 关联的异步生成 Promise */
  promise?: Promise<void | CoordinatorDispatchResult>;
}

/**
 * Coordinator 初始化配置选项
 */
export interface CoordinatorConfig {
  /** 短消息防抖合并窗口毫秒数，默认 1500ms */
  debounceMs?: number;
  /** 最长等待时间毫秒数，默认 5000ms */
  maxWaitMs?: number;
  /** 人工接管退避持续时长毫秒数，默认 10 分钟 */
  takeoverDurationMs?: number;
  /** 发送前失败自动重试最大次数，默认 2 次 */
  maxRetries?: number;
  /** 自动回复发送成功后是否清除视觉红点 */
  autoMarkRead?: boolean;
  /** 聚合消息触发的观察回调；不承担 Agent 执行职责 */
  onConsolidatedMessage?: (
    message: ConsolidatedMessage
  ) => Promise<void | CoordinatorDispatchResult> | void;
}

export interface WorkAdmission {
  readonly startupGenerationId: string;
  isOpen(): boolean;
  assertOpen(): void;
}
/**
 * SessionCoordinator 精确故障与崩溃注入钩子 (测试与 Oracle 验证专用)
 */
export interface CoordinatorFaultHooks {
  afterAgentBeforeDeliveryCreate?: (sessionId: string, replyText: string) => Promise<void> | void;
  /** Delivery=generated 创建落库后，但在更新为 sending 前 */
  afterDeliveryGeneratedBeforeSending?: (deliveryId: string) => Promise<void> | void;
  /** 每次进入 sending 状态后、调用 Driver 发送前 (支持按 attempt 注入) */
  afterSendingBeforeDriver?: (deliveryId: string, attempt?: number) => Promise<void> | void;
  /** 每次 Driver 发送调用后、持久化任何发送结果前 (包含成功/失败/超时) */
  afterDriverSendBeforeResultPersist?: (
    deliveryId: string,
    sendResult: SendResult,
    attempt?: number
  ) => Promise<void> | void;
  /** pre-trigger 失败落库为 failed 后，但在发起下一次重试 sending 或退出前 */
  afterFailedPersistBeforeRetry?: (
    deliveryId: string,
    errorCode?: string,
    attempt?: number
  ) => Promise<void> | void;
  /** 重试前准备更新为 sending 状态前 */
  beforeRetrySendingPersist?: (deliveryId: string, nextAttempt: number) => Promise<void> | void;
  /** Delivery 进入 aborted 状态落库后 */
  afterAbortedPersist?: (deliveryId: string) => Promise<void> | void;
  /** Delivery=sent 落库后，但在 Mastra Memory.saveMessages 保存前 */
  afterSentPersistBeforeMemorySave?: (deliveryId: string) => Promise<void> | void;
  /** Mastra Memory 保存成功后，但在 markMemoryCommitted 提交标记落库前 */
  afterMemorySaveBeforeMarkCommitted?: (deliveryId: string) => Promise<void> | void;
  /** markMemoryCommitted 提交标记落库后 */
  afterMarkMemoryCommitted?: (deliveryId: string) => Promise<void> | void;
  /** 人工裁定 sent 落库后，但在 Mastra Memory 补交保存前 */
  afterAdjudicationPersistBeforeMemorySave?: (deliveryId: string) => Promise<void> | void;
}

/**
 * 合规删除授权验证结果
 */
export interface ComplianceAuthorizationResult {
  authorized: boolean;
  policyReference?: string;
  reason?: string;
}

/**
 * 合规删除独立授权验证器函数类型
 */
export type ComplianceDeletionAuthorizer = (
  command: ComplianceDeletionCommand
) => Promise<ComplianceAuthorizationResult> | ComplianceAuthorizationResult;
/**
 * SessionCoordinator 装配选项
 */
export interface SessionCoordinatorOptions {
  /** 底层事件驱动 CDP 驱动器 */
  driver: KK9Driver;
  /** 唯一 Composition Root 的工作准入门 */
  admissionGate?: WorkAdmission;
  /** 统一持久化存储中枢 */
  store: KKBotStore;
  /** Mastra-native Agent 执行入口 */
  agent?: KKBotAgent;
  /** 与 Agent 协同的 Mastra Memory */
  mastraMemory?: Memory;
  /** Mastra Storage（用于 Observational Memory scope reset 等底座操作） */
  mastraStorage?: unknown;
  /** 合规删除独立授权验证器 */
  complianceAuthorizer?: ComplianceDeletionAuthorizer;
  /** 故障与崩溃注入钩子（测试与 Contract 验证专用） */
  hooks?: CoordinatorFaultHooks;
  /** 会话编排器配置项 */
  config?: CoordinatorConfig;
}

/**
 * 会话编排器事件清单
 */
export interface CoordinatorEvents {
  /** GroupSession 群聊消息 Raw Store 幂等持久化完成事件 */
  group_message_saved: (
    sessionId: string,
    savedMessage: SessionMessage,
    originalMessage: KK9Message
  ) => void;
  /** GroupSession 群聊消息 Raw Store 持久化异常事件 */
  group_message_save_failed: (sessionId: string, originalMessage: KK9Message, error: Error) => void;
  /** 消息压入防抖队列事件 */
  message_queued: (sessionId: string, message: KK9Message, queueLength: number) => void;
  /** 消息防抖合并触发事件 */
  consolidated: (message: ConsolidatedMessage) => void;
  /** 撤回即时熔断事件 */
  recall_fused: (sessionId: string, recalledMessageId: string, remainingCount: number) => void;
  /** 人工接管退避触发事件 */
  takeover: (sessionId: string, takeoverUntil: number, message?: KK9Message) => void;
  /** 消息被静默拦截抑制事件 */
  suppressed: (
    sessionId: string,
    reason:
      | 'human_takeover'
      | 'session_disabled'
      | 'empty_queue'
      | 'recalled'
      | 'tombstoned'
      | 'in_flight_aborted'
      | 'unknown_source',
    message?: KK9Message
  ) => void;
  /** 在途请求被中断事件 */
  in_flight_aborted: (sessionId: string, elapsedMs: number, reason: string) => void;
  /** 在途请求打断后消息自动归并重聚事件 */
  in_flight_regrouped: (sessionId: string, totalMessageCount: number) => void;
  /** Agent 开始执行生成事件 */
  agent_started: (sessionId: string, message: ConsolidatedMessage) => void;
  /** Agent 执行完毕事件 */
  agent_completed: (sessionId: string, result: KKBotAgentRunResult) => void;
  /** Agent 被 AbortSignal 中断事件 */
  agent_aborted: (sessionId: string) => void;
  /** Assistant Memory 显式提交失败事件 */
  assistant_memory_save_failed: (sessionId: string, deliveryId: string, error: unknown) => void;
  /** 消息分发完成事件 */
  reply_dispatched: (sessionId: string, result: CoordinatorDispatchResult) => void;
  /** 异常事件 */
  error: (error: Error) => void;
}

/**
 * 防抖待处理桶单条消息项（附带持久化 Promise 追踪）
 */
export interface PendingBucketItem {
  message: KK9Message;
  persistPromise: Promise<boolean>;
}

/**
 * 内部待处理防抖聚合桶
 */
export interface PendingBucket {
  sessionId: string;
  sessionName: string;
  sessionType: KK9SessionType;
  sender: string;
  senderId?: string;
  messages: KK9Message[];
  items?: PendingBucketItem[];
  debounceTimer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
  firstReceivedAt: number;
}
/**
 * 发送回复选项
 */
export interface DispatchReplyOptions extends SendOptions {
  /** 显式指定运行模式（auto: 自动发送，disabled: 禁用） */
  mode?: SessionMode;
  /** 是否在发送成功后显式消除未读红点 */
  markRead?: boolean;
  /** 结构化富文本内容载荷（可选） */
  formattedPayload?: FormattedText;
}
