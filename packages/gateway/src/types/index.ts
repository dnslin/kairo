import type { KK9Message, KK9SessionType, SendOptions } from '@kkbot/driver';
import type { SessionMode } from '@kkbot/store';

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
  /** 包含的所有消息指纹 ID 列表 */
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
  action: 'message_sent' | 'draft_created' | 'suppressed' | 'send_failed';
  /** 整体操作是否成功 */
  success: boolean;
  /** 目标会话 ID */
  sessionId: string;
  /** 发送成功的消息 ID (若有) */
  messageId?: string;
  /** 生成的草稿 ID (若有) */
  draftId?: number;
  /** 异常信息 (若有) */
  error?: string;
  /** 视觉红点是否已被显式清除 */
  redDotCleared: boolean;
}

/**
 * Coordinator 初始化配置选项
 */
export interface CoordinatorConfig {
  /** 短消息防抖合并窗口毫秒数，默认 1500ms (1.5秒) */
  debounceMs?: number;
  /** 最长等待时间毫秒数 (防止高频连发无限延迟)，默认 5000ms (5秒) */
  maxWaitMs?: number;
  /** 人机协同退避静默时长毫秒数，默认 10 分钟 (600,000ms) */
  takeoverDurationMs?: number;
  /** 自动回复成功后是否自动显式清除视觉红点，默认 true */
  autoMarkRead?: boolean;
  /** 聚合消息触发回调处理函数 */
  onConsolidatedMessage?: (
    message: ConsolidatedMessage
  ) => Promise<void | CoordinatorDispatchResult> | void;
}

/**
 * 会话编排器事件清单
 */
export interface CoordinatorEvents {
  /** 消息压入防抖队列事件 */
  message_queued: (sessionId: string, message: KK9Message, queueLength: number) => void;
  /** 消息防抖合并触发事件 */
  consolidated: (message: ConsolidatedMessage) => void;
  /** 撤回即时熔断事件 (防抖期内消息被撤回) */
  recall_fused: (sessionId: string, recalledMessageId: string, remainingCount: number) => void;
  /** 人机协同退避触发事件 */
  takeover: (sessionId: string, takeoverUntil: number, message?: KK9Message) => void;
  /** 消息被静默拦截抑制事件 (处于人工退避、会话禁用或空队列) */
  suppressed: (
    sessionId: string,
    reason: 'human_takeover' | 'session_disabled' | 'empty_queue' | 'recalled',
    message?: KK9Message
  ) => void;
  /** 消息分发完成事件 */
  reply_dispatched: (sessionId: string, result: CoordinatorDispatchResult) => void;
  /** 异常事件 */
  error: (error: Error) => void;
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
  debounceTimer: NodeJS.Timeout | null;
  maxWaitTimer: NodeJS.Timeout | null;
  firstReceivedAt: number;
}

/**
 * 发送回复选项
 */
export interface DispatchReplyOptions extends SendOptions {
  /** 显式指定运行模式 (auto: 自动发送, draft: 保存草稿, disabled: 禁用) */
  mode?: SessionMode;
}
