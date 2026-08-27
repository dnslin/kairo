/**
 * @kkbot/agent：KKBot 的 Mastra-native Agent、Tool 与 Processor 定义。
 */

export { createChildLogger, logger } from './utils/logger.js';
export * from './utils/errors.js';
export * from './tools/index.js';
export * from './processors/index.js';
export { Memory } from '@mastra/memory';

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
export {
  KKBotAgent,
  DEFAULT_KKBOT_INSTRUCTIONS,
  deriveUserMessageId,
  deriveAssistantMessageId,
  ensureMastraThread,
  createMastraTextMessage,
  removeMastraMessage,
  resetObservationalMemoryScope,
  type MastraTextMessageV2,
  type KKBotAgentOptions,
  type ExecuteAgentOptions,
  type AgentInput,
  type TierAgentInput,
  type MastraAgentInput,
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
  getAvailableMcpFixturePort,
  type SseMcpServerFixtureOptions,
  type SseMcpServerFixture,
} from './testing/sse-mcp-fixture.js';
