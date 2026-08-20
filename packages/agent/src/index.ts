/**
 * @kkbot/agent: 核心智能认知微内核与 ReAct 运行时
 */

export { KkbotAgentRuntime } from './runtime.js';
export {
  LayeredPromptCompiler,
  DEFAULT_SOUL_PROMPT,
} from './prompt/compiler.js';
export { ThinkingTagCleaner } from './guardrails/thinking-tag-cleaner.js';
export {
  SensitiveFilter,
  DEFAULT_JAILBREAK_PATTERNS,
} from './guardrails/sensitive-filter.js';
export {
  AgentMemoryManager,
  initMemorySchema,
  MEMORY_SCHEMA_SQL,
} from './memory/index.js';
export {
  MultiModalRouter,
  FileCardAwareness,
} from './multimodal/index.js';
export {
  IntentModelRouter,
  ModelFailoverManager,
  ModelTimeoutError,
  AllModelsFailedError,
  FallbackHandler,
  DEFAULT_FALLBACK_APOLOGY,
} from './routing/index.js';
export type {
  AgentExecuteOptions,
  AgentReplyResult,
  AgentRuntimeConfig,
  ConsolidatedMessage,
  EmployeeOrgContext,
  FailoverEvent,
  FailoverOptions,
  FallbackConfig,
  FileCardInfo,
  FileCategory,
  ImageMediaSource,
  ImageSourceType,
  IntentClassificationResult,
  IntentFeatures,
  IntentRouterOptions,
  IntentRule,
  L1MessageWindow,
  L2WorkingSummary,
  L3ColleagueProfile,
  LayeredPromptResult,
  LLMMessage,
  LLMProvider,
  LLMStreamChunk,
  MemoryConfig,
  MemoryContextOptions,
  MemoryContextResult,
  ModelEndpointConfig,
  ModelIntentLevel,
  MultiModalContentPart,
  MultiModalProcessResult,
  MultiModalRouterOptions,
  OcrEngine,
  OcrResult,
  PromptCompilerOptions,
  SaveMemoryMessageInput,
  SensitiveCheckResult,
  SensitiveFilterResult,
  ThinkingCleanResult,
  TokenUsage,
  ToolExecutionRecord,
  UpdateColleagueProfileInput,
  UserProfilePreference,
} from './types/index.js';
export * from './utils/errors.js';
export { createChildLogger, logger } from './utils/logger.js';
export * from './tools/index.js';
