import type { Client } from '@libsql/client';
import type { DatabaseOptions, SessionMessage } from '@kkbot/store';
import type { LLMProvider } from '../types/index.js';

/**
 * 记忆引擎初始化配置
 */
export interface MemoryConfig {
  /** 共享的 LibSQL Client 实例 */
  client?: Client;
  /** 数据库连接配置 (未提供 client 时使用) */
  database?: DatabaseOptions;
  /** L1 短期滑动窗口消息数限制 (默认 20 条) */
  l1WindowSize?: number;
  /** L2 滚动摘要触发消息轮次阈值 (默认 10 轮/条) */
  l2SummaryThreshold?: number;
  /** LLM Provider 实例 (用于 L2 异步滚动摘要与 L3 画像提炼) */
  llmProvider?: LLMProvider;
  /** 是否启用 L3 员工画像 (默认 true) */
  l3Enabled?: boolean;
  /** 是否在初始化时自动执行 schema DDL 初始化 (默认 true) */
  autoInitSchema?: boolean;
}

/**
 * L1 短期会话消息滑动窗口
 */
export interface L1MessageWindow {
  /** 会话 ID (对应 KK9 sessionId / threadId) */
  threadId: string;
  /** 历史消息列表 (严格按时序递增排序，且排除了已撤回消息) */
  messages: SessionMessage[];
  /** 提取的消息总数 */
  totalCount: number;
  /** 过滤排除的已撤回消息数 */
  filteredRecalledCount: number;
  /** 格式化后的对话文本 (方便直接阅读或注入上下文) */
  formattedText: string;
}

/**
 * L2 滚动工作记忆 / 摘要实体
 */
export interface L2WorkingSummary {
  /** 会话 ID (对应 threadId) */
  threadId: string;
  /** 提炼的事实性工作摘要内容 */
  summary: string;
  /** 摘要已覆盖的历史消息数量 */
  messageCountCovered: number;
  /** 最后被摘要的消息 ID */
  lastMessageId?: string | null;
  /** 上次生成摘要的时间戳 (ms) */
  lastSummarizedAt: number;
  /** 更新时间戳 (ms) */
  updatedAt: number;
}

/**
 * L3 员工实体画像与长期协同档案
 */
export interface L3ColleagueProfile {
  /** 员工唯一标识 (对应 KK9 senderId / 员工 UID / resourceId) */
  resourceId: string;
  /** 员工姓名 (可选) */
  name?: string;
  /** 所属部门 (可选) */
  department?: string;
  /** 岗位职称 (可选) */
  position?: string;
  /** 业务与沟通偏好 (如常用技术栈、常查报表、沟通风格) */
  preferences: Record<string, unknown>;
  /** 关键事实与业务背景条目 */
  keyFacts: string[];
  /** 最近参与的工作话题 (支持跨会话多话题平滑过渡) */
  recentTopics: string[];
  /** 完整的自然语言画像认知总结 (可选) */
  rawSummary?: string;
  /** 画像最近更新时间戳 (ms) */
  updatedAt: number;
}

/**
 * 3-Tier 记忆上下文检索选项
 */
export interface MemoryContextOptions {
  /** 会话 ID (对应 threadId / KK9 sessionId) */
  threadId: string;
  /** 员工 UID (对应 resourceId / KK9 senderId) */
  resourceId?: string;
  /** 是否检索 L1 消息滑动窗口 (默认 true) */
  includeL1?: boolean;
  /** 是否检索 L2 滚动工作摘要 (默认 true) */
  includeL2?: boolean;
  /** 是否检索 L3 员工画像 (默认 true) */
  includeL3?: boolean;
  /** L1 滑动窗口消息数量覆盖 (可选，覆盖默认配置) */
  l1Limit?: number;
}

/**
 * 3-Tier 记忆上下文检索结果
 */
export interface MemoryContextResult {
  /** 会话 ID */
  threadId: string;
  /** 员工 UID */
  resourceId?: string;
  /** L1 短期滑动窗口 */
  l1Window?: L1MessageWindow;
  /** L2 滚动工作摘要 */
  l2Summary?: L2WorkingSummary;
  /** L3 员工实体画像 */
  l3Profile?: L3ColleagueProfile;
  /** 结构化组装的多层记忆上下文纯文本 (可直接注入 Prompt Layer 2 / Layer 4) */
  combinedContext: string;
}

/**
 * 写入 L1 消息的入参
 */
export interface SaveMemoryMessageInput {
  /** 会话 ID (对应 KK9 sessionId / threadId) */
  threadId: string;
  /** 发送者展示名称 */
  sender: string;
  /** 消息正文文本 */
  content: string;
  /** 发送者唯一 ID (对应 resourceId / 员工 UID) */
  senderId?: string;
  /** 消息原生 ID */
  messageId?: string;
  /** 消息类型 (默认 'text') */
  messageType?: string;
  /** 是否来自机器人自身 */
  isFromSelf?: boolean;
  /** 是否已撤回 */
  isRecalled?: boolean;
  /** 引用回复的目标消息 ID */
  replyTargetId?: string;
  /** 消息创建时间戳 (ms) */
  createdAt?: number;
}

/**
 * 更新 L3 画像的入参
 */
export interface UpdateColleagueProfileInput {
  name?: string;
  department?: string;
  position?: string;
  preferences?: Record<string, unknown>;
  keyFacts?: string[];
  recentTopics?: string[];
  rawSummary?: string;
}
