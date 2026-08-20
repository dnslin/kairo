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

export * from './types/index.js';
export * from './utils/errors.js';
export { createChildLogger, logger } from './utils/logger.js';
