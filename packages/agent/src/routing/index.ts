/**
 * 意图驱动模型分流、Failover 故障转移与宕机兜底模块导出
 */

export { IntentModelRouter } from './intent-router.js';
export {
  ModelFailoverManager,
  ModelTimeoutError,
  AllModelsFailedError,
} from './failover.js';
export {
  FallbackHandler,
  DEFAULT_FALLBACK_APOLOGY,
} from './fallback.js';
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
} from './types.js';
