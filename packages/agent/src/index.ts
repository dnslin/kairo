/**
 * @kkbot/agent: 核心智能认知微内核与 ReAct 运行时
 */

export { KkbotAgentRuntime } from './runtime.js';
export { LayeredPromptCompiler, DEFAULT_SOUL_PROMPT } from './prompt/compiler.js';
export { ThinkingTagCleaner } from './guardrails/thinking-tag-cleaner.js';
export { SensitiveFilter, DEFAULT_JAILBREAK_PATTERNS } from './guardrails/sensitive-filter.js';
export { AgentMemoryManager, initMemorySchema, MEMORY_SCHEMA_SQL } from './memory/index.js';
export { MultiModalRouter, FileCardAwareness } from './multimodal/index.js';
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
export * from './hitl/index.js';

export * from './processors/index.js';
// ============================================================================
// Mastra-Native Agent 架构 (Issue #174)
// ============================================================================
export {
  resolveModelTier,
  type ModelTier,
  type NormalizedModelTierInput,
  type NormalizedAttachmentFact,
} from './routing/tier-policy.js';
export {
  MastraModelFactory,
  type ModelFactoryConfig,
  type TierModelConfig,
  type TierModelEntry,
  type KKBotRequestContextValues,
} from './models/factory.js';
export { Memory } from '@mastra/memory';
export {
  KKBotAgent,
  deriveUserMessageId,
  deriveAssistantMessageId,
  ensureMastraThread,
  createMastraTextMessage,
  removeMastraMessage,
  resetObservationalMemoryScope,
  type MastraTextMessageV2,
  type KKBotAgentOptions,
  type ExecuteAgentOptions,
  type KKBotAgentRunResult,
  type AgentTokenUsage,
} from './agent.js';
export {
  createFakeModel,
  type FakeLanguageModel,
  type FakeModelGenerateResult,
  type FakeModelStepResponse,
  type FakeModelCallOptions,
  type FakeModelOptions,
  type FakeModelContentPart,
} from './testing/fake-model.js';
export {
  createSseMcpServerFixture,
  type SseMcpServerFixtureOptions,
  type SseMcpServerFixture,
} from './testing/sse-mcp-fixture.js';
