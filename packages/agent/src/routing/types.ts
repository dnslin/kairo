import type { ConsolidatedMessage, LLMProvider } from '../types/index.js';

/**
 * 模型意图推理级别
 * FAST: 极速轻量模型 (300ms 快速响应，问候打招呼、查员工工位/电话、日常闲聊，降低 70%+ Token 成本)
 * DEEP: 深度推理模型 (代码排错、长文档综合对比、故障分析、多步决策)
 */
export type ModelIntentLevel = 'FAST' | 'DEEP';

/**
 * 意图分类特征分析结果
 */
export interface IntentFeatures {
  /** 文本总字符数 */
  charCount: number;
  /** 是否包含代码块 (```) 或明显代码语法 */
  hasCode: boolean;
  /** 是否包含图片媒体 */
  hasImages: boolean;
  /** 是否包含办公文件卡片 (.xlsx, .pdf, .docx 等) */
  hasFileCards: boolean;
  /** 是否包含多模态附件 (图片或文件卡片) */
  hasMultiModal: boolean;
  /** 是否匹配日常打招呼/闲聊 */
  isChitchat: boolean;
  /** 是否匹配员工档案/工位/电话查询 */
  isOrgQuery: boolean;
  /** 是否包含深度推理/排错/对比关键词 */
  hasReasoningKeywords: boolean;
}

/**
 * 意图分类器判定结果
 */
export interface IntentClassificationResult {
  /** 判定意图级别 */
  intentLevel: ModelIntentLevel;
  /** 判定理由说明 */
  reason: string;
  /** 置信度 (0.0 ~ 1.0) */
  confidence: number;
  /** 命中的关键词列表 */
  matchedKeywords: string[];
  /** 预估复杂度分数 (0 ~ 100) */
  estimatedComplexity: number;
  /** 提取的特征详情 */
  features: IntentFeatures;
}

/**
 * 自定义意图路由规则
 */
export interface IntentRule {
  /** 规则名称 */
  name: string;
  /** 匹配成功后的目标意图级别 */
  intentLevel: ModelIntentLevel;
  /** 匹配函数 (支持同步与异步) */
  match: (message: ConsolidatedMessage | string) => boolean | Promise<boolean>;
  /** 规则优先级 (数字越大优先级越高) */
  priority?: number;
}

/**
 * 模型端点配置
 */
export interface ModelEndpointConfig {
  /** 端点唯一标识 (如 fast-primary, deep-primary, backup-ds3) */
  id: string;
  /** 模型展示名称 (如 DeepSeek-V3-Fast, DeepSeek-R1-Deep) */
  name: string;
  /** 底层 LLMProvider 实现 */
  provider: LLMProvider;
  /** 适用的意图级别 (FAST 或 DEEP) */
  intentLevel?: ModelIntentLevel;
  /** 是否原生支持 Vision 多模态 */
  supportsVision?: boolean;
  /** 单次调用超时时间 (毫秒，默认 15000ms = 15s) */
  timeoutMs?: number;
  /** 优先级 (数字越大越优先) */
  priority?: number;
  /** 是否作为备用降级节点 (Failover Backup) */
  isBackup?: boolean;
}

/**
 * 意图分流路由器配置选项
 */
export interface IntentRouterOptions {
  /** 极速轻量模型端点 */
  fastModel?: ModelEndpointConfig | LLMProvider;
  /** 深度推理模型端点 */
  deepModel?: ModelEndpointConfig | LLMProvider;
  /** 全局备用容灾模型列表 */
  backupModels?: ModelEndpointConfig[];
  /** 自定义扩展意图规则 */
  customRules?: IntentRule[];
  /** 默认意图级别 (默认 FAST) */
  defaultIntent?: ModelIntentLevel;
  /** 长文本判为 DEEP 的阈值字符数 (默认 300) */
  longTextThreshold?: number;
  /** 默认模型调用超时毫秒数 (默认 15000ms) */
  defaultTimeoutMs?: number;
}

/**
 * Failover 故障转移事件
 */
export interface FailoverEvent {
  /** 故障发生的源模型标识 */
  fromModel: string;
  /** 切换到的目标备用模型标识 (若已无可用模型则为 undefined) */
  toModel?: string;
  /** 导致切换的异常错误 */
  error: Error;
  /** 当前重试/转移序号 (从 1 开始) */
  attempt: number;
  /** 转移发生的时间戳 */
  timestamp: number;
}

/**
 * Failover 故障转移管理器选项
 */
export interface FailoverOptions {
  /** 最大重试/切换次数 (默认候选模型总数 - 1) */
  maxRetries?: number;
  /** 默认超时时间 (毫秒，默认 15000ms = 15s) */
  timeoutMs?: number;
  /** 触发 Failover 的 HTTP 状态码列表 (默认 [503, 429, 500, 502, 504]) */
  retryStatusCodes?: number[];
  /** Failover 发生时的监听回调 */
  onFailover?: (event: FailoverEvent) => void;
}

/**
 * 全局宕机安抚兜底配置
 */
export interface FallbackConfig {
  /** 默认全局安抚话术 (默认: "当前网络繁忙，消息已记录，稍后为您处理") */
  defaultApologyMessage?: string;
  /** 自定义兜底回复生成器 */
  customHandler?: (
    threadId: string,
    message: ConsolidatedMessage,
    error: Error
  ) => Promise<string> | string;
}
