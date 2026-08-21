import type { KK9Message, KK9SessionType } from '@kkbot/driver';
import type { ToolRegistry, ReadWriteSplitExecutor, ToolCallRequest } from '../tools/index.js';
import type { ApprovalManager, LeaderApprovalRouter } from '../hitl/index.js';
import type {
  MultiModalContentPart,
  MultiModalRouterOptions,
  OcrEngine,
} from '../multimodal/types.js';
import type { MultiModalRouter } from '../multimodal/router.js';
import type {
  FailoverOptions,
  FallbackConfig,
  IntentRouterOptions,
  ModelEndpointConfig,
  ModelIntentLevel,
} from '../routing/types.js';
import type { IntentModelRouter } from '../routing/intent-router.js';
import type { ModelFailoverManager } from '../routing/failover.js';
import type { FallbackHandler } from '../routing/fallback.js';

/**
 * 聚合防抖消息实体契约
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
 * 用户画像与沟通偏好
 */
export interface UserProfilePreference {
  /** 称呼偏好 / 昵称 */
  nickname?: string;
  /** 口吻风格偏好 (如: 简明扼要、详细专业、幽默亲和) */
  tonePreference?: string;
  /** 语言偏好 */
  language?: string;
  /** 自定义画像字段 */
  customPreferences?: Record<string, string>;
}

/**
 * 员工组织与岗位环境上下文
 */
export interface EmployeeOrgContext {
  /** 员工唯一标识 */
  employeeId?: string;
  /** 员工姓名 */
  name?: string;
  /** 所属部门名称 */
  department?: string;
  /** 完整部门路径层级 (如: 研发中心/架构组) */
  departmentPath?: string;
  /** 岗位/职位 */
  jobTitle?: string;
  /** 工作协同边界 (如: 仅限内部系统支持/仅限审批协助) */
  collaborationBoundary?: string;
}

/**
 * Token 统计消耗
 */
export interface TokenUsage {
  /** Prompt 输入消耗 Token 数 */
  promptTokens: number;
  /** 回复生成消耗 Token 数 */
  completionTokens: number;
  /** 总计消耗 Token 数 */
  totalTokens: number;
}

/**
 * 工具调用元数据记录
 */
export interface ToolExecutionRecord {
  /** 工具调用唯一标识 */
  toolCallId: string;
  /** 工具名称 */
  toolName: string;
  /** 工具入参 */
  arguments: Record<string, unknown> | string;
  /** 工具执行结果 */
  result?: unknown;
  /** 工具执行异常信息 (若有) */
  error?: string;
  /** 工具执行状态 */
  status?: 'success' | 'error' | 'suspended';
  /** 关联生成的审批任务 ID (若挂起) */
  approvalTaskId?: string;
  /** 工具调用耗时 (毫秒) */
  durationMs?: number;
}

/**
 * Agent 认知内核回复结果
 */
export interface AgentReplyResult {
  /** 最终清洗过滤后的回复文本 */
  content: string;
  /** 剥离出的思考过程 (若模型输出了思考链) */
  thinkingContent?: string;
  /** 工具调用执行记录 */
  toolCalls: ToolExecutionRecord[];
  /** Token 消耗统计 (若底层支持返回) */
  usage?: TokenUsage;
  /** 结束原因: stop (自然结束), tool_calls (工具调用), abort (被主动打断), length (长度截断), error (异常) */
  finishReason: 'stop' | 'tool_calls' | 'abort' | 'length' | 'error' | (string & {});
  /** 是否已被 AbortSignal 打断 */
  aborted?: boolean;
}

/**
 * Agent 执行调用选项
 */
export interface AgentExecuteOptions {
  /** 用于中断在途请求的 AbortSignal 实例 */
  signal?: AbortSignal;
  /** 是否启用流式处理 */
  stream?: boolean;
  /** 实时文本 Chunk 回调 (已剥离 <think> 标签并经过敏感词清洗) */
  onChunk?: (chunk: string) => void;
  /** 实时思考 Chunk 回调 (仅接收剥离出来的思考片段) */
  onThinkingChunk?: (thinkingChunk: string) => void;
  /** 用户画像偏好 */
  userProfile?: UserProfilePreference;
  /** 员工所在组织环境上下文 */
  employeeContext?: EmployeeOrgContext;
  /** 覆盖默认 System Prompt */
  systemPromptOverride?: string;
  /** L1 会话历史消息列表 (按 user/assistant 角色插入在 system 之后、当前 user 之前) */
  historyMessages?: LLMMessage[];
  /** 检索与知识事实列表 (用于 Layer 4 防幻觉依据) */
  retrievedFacts?: string[] | string;
  /** 自定义 OCR 识别引擎 */
  ocrEngine?: OcrEngine;
  /** 强制指定意图推理级别 (跳过意图分类器自动判断) */
  intentLevelOverride?: ModelIntentLevel;
  temperature?: number;
  /** 最大输出 Token 数 */
  maxTokens?: number;
  /** 待执行的工具调用请求集 */
  toolCalls?: ToolCallRequest[];
  /** 关联的已审批任务 ID (用于高危工具授权放行) */
  approvedTaskId?: string;
}

/**
 * Prompt 编译器配置选项与上下文
 */
export interface PromptCompilerOptions {
  /** soul.md 路径 (可选，默认使用内部默认人设) */
  soulPath?: string;
  /** 默认人设预设内容 (当文件不存在时使用) */
  defaultSoul?: string;
  /** 系统时间戳 (支持 Date、时间戳数字或格式化字符串) */
  timestamp?: Date | number | string;
  /** 用户画像偏好 */
  userProfile?: UserProfilePreference;
  /** 员工组织环境 */
  employeeContext?: EmployeeOrgContext;
  /** 检索召回事实依据 (Layer 4) */
  retrievedFacts?: string[] | string;
  /** 自定义扩展指令 */
  customInstructions?: string;
}

/**
 * 4 层结构化 Prompt 组装结果
 */
export interface LayeredPromptResult {
  /** Layer 1: 基础人设与语气边界 */
  layer1: string;
  /** Layer 2: 动态上下文 (时间与用户画像) */
  layer2: string;
  /** Layer 3: 组织环境与协同边界 */
  layer3: string;
  /** Layer 4: 安全防幻觉与转人工约束 */
  layer4: string;
  /** 最终拼接编译出的完整 System Prompt */
  fullPrompt: string;
}

/**
 * 思考标签剥离清洗结果
 */
export interface ThinkingCleanResult {
  /** 清洗后移除了 <think> 标签的正文文本 */
  cleanedText: string;
  /** 提取出的思考过程文本 */
  thinkingText: string;
  /** 是否检测并处理了思考内容 */
  hasThinking: boolean;
}

/**
 * 敏感词/注入检测结果 (入站与出站)
 */
export interface SensitiveCheckResult {
  /** 是否安全通过 */
  safe: boolean;
  /** 拦截/警示原因说明 */
  reason?: string;
  /** 匹配到的敏感词列表 */
  matchedKeywords?: string[];
  /** 匹配到的正则规则列表 */
  matchedPatterns?: string[];
}

/**
 * 出站敏感词脱敏替换结果
 */
export interface SensitiveFilterResult {
  /** 是否安全通过 (若配置了硬拦截规则可能为 false) */
  safe: boolean;
  /** 经过脱敏替换后的文本 */
  filteredText: string;
  /** 触发匹配的规则或敏感词列表 */
  matchedRules: string[];
  /** 替换词发生次数 */
  replacedCount: number;
}

/**
 * 通用 LLM 消息结构
 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | MultiModalContentPart[];
  name?: string;
  toolCallId?: string;
}

/**
 * 通用 LLM 流式输出 Chunk 契约
 */
export interface LLMStreamChunk {
  /** 增量正文内容 */
  delta: string;
  /** 结束原因 */
  finishReason?: string;
  /** Token 消耗 (通常在最后一个 chunk 提供) */
  usage?: TokenUsage;
}

/**
 * LLM 客户端抽象接口 (支持离线测试 Mock 与真实模型接入)
 */
export interface LLMProvider {
  /** 完整对话生成 */
  chat(
    messages: LLMMessage[],
    options?: {
      signal?: AbortSignal;
      temperature?: number;
      maxTokens?: number;
    }
  ): Promise<{
    content: string;
    usage?: TokenUsage;
    finishReason?: string;
  }>;

  /** 流式对话生成 */
  chatStream?(
    messages: LLMMessage[],
    options?: {
      signal?: AbortSignal;
      temperature?: number;
      maxTokens?: number;
    }
  ): AsyncIterable<LLMStreamChunk>;
}

/**
 * KkbotAgentRuntime 初始化配置
 */
export interface AgentRuntimeConfig {
  /** soul.md 路径 */
  soulPath?: string;
  /** 默认人设预设内容 */
  defaultSoul?: string;
  /** 是否监听 soul.md 热重载 (默认 true) */
  watchSoul?: boolean;
  /** 入站注入防护自定义规则 */
  jailbreakPatterns?: RegExp[];
  /** 出站脱敏敏感词字典 */
  sensitiveKeywords?: string[];
  /** 出站敏感正则规则 */
  sensitivePatterns?: RegExp[];
  /** 底层默认 LLM Provider 实现 (向后兼容) */
  llmProvider?: LLMProvider;
  /** 工具注册中心实例 */
  toolRegistry?: ToolRegistry;
  /** 读写分流工具执行调度器实例 */
  toolExecutor?: ReadWriteSplitExecutor;
  /** HITL 审批状态机管理器实例 */
  approvalManager?: ApprovalManager;
  /** 主管路由解析器实例 */
  leaderRouter?: LeaderApprovalRouter;
  /** 极速轻量模型端点 (FAST) */
  fastModel?: ModelEndpointConfig | LLMProvider;
  /** 深度推理模型端点 (DEEP) */
  deepModel?: ModelEndpointConfig | LLMProvider;
  /** 备用容灾模型列表 (Failover Backups) */
  backupModels?: ModelEndpointConfig[];
  /** 自定义多模态附件感知路由器配置 */
  multiModalRouter?: MultiModalRouter | MultiModalRouterOptions;
  /** 自定义意图分流路由器配置 */
  intentRouter?: IntentModelRouter | IntentRouterOptions;
  /** 自定义 Failover 故障转移管理器配置 */
  failoverManager?: ModelFailoverManager | FailoverOptions;
  /** 自定义全局宕机安抚兜底处理器配置 */
  fallbackHandler?: FallbackHandler | FallbackConfig;
}

export type {
  L1MessageWindow,
  L2WorkingSummary,
  L3ColleagueProfile,
  MemoryConfig,
  MemoryContextOptions,
  MemoryContextResult,
  SaveMemoryMessageInput,
  UpdateColleagueProfileInput,
} from '../memory/types.js';

export type {
  FileCardInfo,
  FileCategory,
  ImageMediaSource,
  ImageSourceType,
  MultiModalContentPart,
  MultiModalProcessResult,
  MultiModalRouterOptions,
  OcrEngine,
  OcrResult,
} from '../multimodal/types.js';

export type {
  FailoverEvent,
  FailoverOptions,
  FallbackConfig,
  IntentClassificationResult,
  IntentFeatures,
  IntentRouterOptions,
  IntentRule,
  ModelEndpointConfig,
  ModelIntentLevel,
} from '../routing/types.js';
