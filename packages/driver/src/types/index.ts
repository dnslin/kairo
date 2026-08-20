/**
 * @kkbot/driver 强类型定义
 */

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export type KK9SessionType = 'private' | 'group';

export type KK9MessageType = 'text' | 'image' | 'file' | 'quote' | 'rich-text' | 'system';

/**
 * 文本样式属性
 */
export interface TextStyle {
  /** 16进制颜色如 "#ff4d4f" 或颜色名称 */
  color?: string;
  /** 字号大小，如 14, 16, "16px" */
  fontSize?: number | string;
  /** 粗体 */
  bold?: boolean;
  /** 斜体 */
  italic?: boolean;
  /** 下划线 */
  underline?: boolean;
  /** 删除线 */
  strikethrough?: boolean;
  /** 背景高亮色 */
  backgroundColor?: string;
}

/**
 * 富文本片段
 */
export interface TextSegment {
  text: string;
  style?: TextStyle;
}

/**
 * 格式化富文本输入，支持纯文本、片段数组或原始 HTML 对象
 */
export type FormattedText = string | TextSegment[] | { html: string };

/**
 * 引用/回复目标定义
 */
export interface KK9ReplyTarget {
  /** 消息 DOM id 如 "msg-123327741" 或 SHA-256 指纹 */
  messageId?: string;
  /** 消息在列表中的索引 */
  msgIdx?: number;
  /** 被引用者昵称 */
  sender?: string;
  /** 被引用消息摘要内容 */
  content?: string;
}

/**
 * 被引用/回复消息元数据
 */
export interface KK9ReplyInfo {
  replyToSender: string;
  replyToContent: string;
  replyToId?: string;
}

/**
 * 群聊 @ 提及元数据
 */
export interface KK9MentionInfo {
  isAtMe: boolean;
  isAtAll: boolean;
  mentionedUsers: string[];
}

/**
 * 发送消息时的 @ 提及目标
 */
export interface KK9MentionTarget {
  uid: number | string;
  name: string;
}
/**
 * 图片元数据（支持本地缓存路径与远程 URI）
 */
export interface KK9ImageInfo {
  /** 本地缓存图片绝对路径 (如 C:\Users\...\file-cache\image\xxx.png) */
  filePath?: string;
  /** 图片 URL 或 file:// 地址 */
  url?: string;
  /** 远程服务器资源 URI */
  uri?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 图片 MIME 类型 (如 image/png, image/jpeg) */
  mimeType?: string;
  /** 图片大小 (字节) */
  size?: number;
}

/**
 * 文件卡片元数据
 */
export interface KK9FileInfo {
  fileName: string;
  fileSize?: string;
  fileExt?: string;
  filePath?: string;
}

export interface KK9Session {
  id: string;
  name: string;
  type: KK9SessionType;
  unread: boolean;
  unreadCount?: number;
  /** 标记是否有未读 @ 我或 @ 全体 */
  unreadAt?: boolean;
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
  senderId?: string;
  content: string;
  time: string;
  isMe: boolean;
  timestamp: number;
  /** 消息分类类型 */
  messageType?: KK9MessageType;
  /** 是否已被撤回 */
  isRecalled?: boolean;
  /** 是否 @ 了当前机器人 */
  atMe?: boolean;
  /** 是否 @ 了全体成员 */
  atAll?: boolean;
  /** @ 提及详情 */
  mentions?: KK9MentionInfo;
  /** 引用回复信息 */
  replyTo?: KK9ReplyInfo;
  /** 文件卡片信息 */
  fileInfo?: KK9FileInfo;
  /** 消息中包含的图片列表（单图或图文混排多图） */
  images?: KK9ImageInfo[];
  raw?: Record<string, unknown>;
}

/**
 * 员工档案与组织架构信息
 */
export interface KK9Employee {
  /** 唯一员工 UID */
  id: number | string;
  /** 工号 / 登录账号 (login_name) */
  loginName: string;
  /** 真实姓名 */
  name: string;
  /** 岗位 / 职称 (pos) */
  position?: string;
  /** 物理工位 / 办公区 */
  region?: string;
  /** 个性签名 (sig) */
  signature?: string;
  /** 手机号 */
  phone?: string;
  /** 电子邮箱 */
  email?: string;
  /** 头像地址 */
  avatarUrl?: string;
  /** 原始对象备份 */
  raw?: Record<string, unknown>;
  /** 抽取时间戳 (毫秒) */
  updatedAt: number;
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
  /** 是否允许轮询自动在未读会话间切换（设为 false 时仅在当前激活会话监听） */
  autoSwitchSession?: boolean;
}

export interface DriverConfig {
  cdp: CdpConfig;
  selectors?: Partial<SelectorsConfig>;
  polling?: Partial<PollingConfig>;
}
export interface EventBridgeConfig {
  cdp: CdpConfig;
  /** 自定义 CDP 绑定名称 (默认 '__kkbot_native_bridge') */
  bindingName?: string;
  /** 去重指纹最大缓存数量 (默认 10000) */
  maxFingerprints?: number;
  /** 当前用户 UID / 账号 (用于识别自身发出消息 isMe) */
  currentUserId?: string | number;
  /** 是否启用消息撤回原生事件捕获 (默认 true) */
  enableRecallHook?: boolean;
}

/**
 * 发送操作结果与快捷撤回方法
 */
export interface SendResult {
  success: boolean;
  messageId?: string;
  recall?: () => Promise<boolean>;
  error?: string;
  verifyLatencyMs?: number;
}

/**
 * 消息撤回事件元数据
 */
export interface KK9RecalledEvent {
  messageId: string;
  sessionId: string;
  sender: string;
  time: string;
  timestamp?: number;
}

export interface PreSendCheckResult {
  canSend: boolean;
  reason?:
    | 'session_switched'
    | 'message_gone'
    | 'new_incoming_messages'
    | 'input_not_empty'
    | 'unknown';
  details?: string;
}

export interface SendOptions {
  targetSessionId?: string;
  verifyTimeoutMs?: number;
  /** 引用/回复目标 */
  replyTo?: string | KK9ReplyTarget;
  /** 群聊 @ 提及目标（支持单个/多个成员或 'all' 全体成员） */
  mentions?: KK9MentionTarget | KK9MentionTarget[] | string | string[];
}

export interface SendFileOptions {
  targetSessionId?: string;
  verifyTimeoutMs?: number;
}
export interface DriverEvents {
  status: (status: ConnectionStatus) => void;
  message: (message: KK9Message) => void;
  /** 专为群聊 @ 我/全体 派发的快捷事件 */
  at: (message: KK9Message) => void;
  /** 消息撤回事件 */
  recalled: (event: KK9RecalledEvent) => void;
  error: (error: Error) => void;
  heartbeat: (uptimeMs: number) => void;
}
/**
 * 原生事件桥事件契约（与 DriverEvents 100% 同构）
 */
export type EventBridgeEvents = DriverEvents;

export type {
  CardThemeType,
  CardThemeCustom,
  CardTheme,
  CardTagVariant,
  CardTag,
  CardHeader,
  CardFieldVariant,
  CardFieldSpan,
  CardField,
  CardActionVariant,
  CardAction,
  CardFooter,
  CardData,
  RenderCanvasOptions,
  ResolvedCardTheme,
  CardLayoutResult,
} from './card.js';
