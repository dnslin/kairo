/**
 * @kkbot/agent/memory: 3-Tier 记忆管理引擎
 */

export { AgentMemoryManager } from './manager.js';
export { initMemorySchema, MEMORY_SCHEMA_SQL } from './schema.js';
export type {
  L1MessageWindow,
  L2WorkingSummary,
  L3ColleagueProfile,
  MemoryConfig,
  MemoryContextOptions,
  MemoryContextResult,
  SaveMemoryMessageInput,
  UpdateColleagueProfileInput,
} from './types.js';
