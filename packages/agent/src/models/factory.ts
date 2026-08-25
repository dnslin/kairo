import type { ModelWithRetries } from '@mastra/core/agent';
import type { MastraModelConfig } from '@mastra/core/llm';
import type { RequestContext } from '@mastra/core/request-context';
import type { ModelTier } from '../routing/tier-policy.js';

export interface TierModelEntry {
  /** 模型实例或配置 */
  model: MastraModelConfig;
  /** 该模型的最大重试次数 (默认 0) */
  maxRetries?: number;
}

export interface TierModelConfig {
  /** 该 Tier 下的主模型及 fallback 备用模型链 */
  models: TierModelEntry[];
}

export interface ModelFactoryConfig {
  /** FAST | DEEP | VISION 各等级的模型与 fallback 配置 */
  tiers: Record<ModelTier, TierModelConfig>;
}

export interface KKBotRequestContextValues {
  tier: ModelTier;
  [key: string]: unknown;
}

/**
 * MastraModelFactory: 将 ModelTier 映射为 Mastra 原生 ModelWithRetries[] 动态配置
 *
 * 核心契约：
 * 1. 严格从 RequestContext 读取已由 ModelTierPolicy 确定的 ModelTier。
 * 2. 若 RequestContext 缺失或 tier 无效，明确抛出可诊断错误，禁止静默降级（DEEP 默认仅存在于 resolveModelTier 中）。
 * 3. 将 Tier 映射为配置好的 ModelWithRetries[] 数组（包含主模型与 fallback 备用模型）。
 * 4. retry 与 fallback 语义完全由 Mastra 原生持有与执行，不增加自研 failover 循环。
 * 5. 模型失败绝不升级 Tier，也不重新运行 Tier 分类。
 */
export class MastraModelFactory {
  constructor(private readonly config: ModelFactoryConfig) {}

  /**
   * 按指定 Tier 获取其配置的 ModelWithRetries 数组
   */
  resolveModelsForTier(tier: ModelTier): ModelWithRetries[] {
    const tierConfig = this.config.tiers[tier];
    if (!tierConfig || !tierConfig.models || tierConfig.models.length === 0) {
      throw new Error(`未找到 ModelTier [${tier}] 的模型配置`);
    }

    return tierConfig.models.map(entry => ({
      model: entry.model,
      maxRetries: entry.maxRetries ?? 0,
    }));
  }

  /**
   * 生成供 Mastra Agent `model` 属性使用的动态模型解析函数
   */
  createDynamicModelResolver(): ({
    requestContext,
  }: {
    requestContext?: RequestContext<KKBotRequestContextValues>;
  }) => ModelWithRetries[] {
    return ({ requestContext }) => {
      if (!requestContext || typeof requestContext.get !== 'function') {
        throw new Error('动态模型解析失败：RequestContext 缺失或未提供有效容器');
      }

      const rawTier = requestContext.get('tier');
      if (rawTier !== 'FAST' && rawTier !== 'DEEP' && rawTier !== 'VISION') {
        throw new Error(
          `动态模型解析失败：RequestContext 中的 ModelTier 无效或缺失 (值: ${String(rawTier)})`
        );
      }

      return this.resolveModelsForTier(rawTier);
    };
  }
}
