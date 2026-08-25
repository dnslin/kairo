import { describe, it, expect } from 'vitest';
import { RequestContext } from '@mastra/core/request-context';
import {
  MastraModelFactory,
  type ModelFactoryConfig,
  type KKBotRequestContextValues,
} from '../../src/models/factory.js';

describe('MastraModelFactory', () => {
  function createDummyModel(modelId: string, text: string, tokenCount: number) {
    return {
      specificationVersion: 'v2' as const,
      provider: 'test-provider',
      modelId,
      supportedUrls: {},
      doGenerate: () =>
        Promise.resolve({
          content: [{ type: 'text' as const, text }],
          finishReason: 'stop' as const,
          usage: { inputTokens: tokenCount, outputTokens: tokenCount, totalTokens: tokenCount * 2 },
          warnings: [],
        }),
      doStream: () => Promise.reject(new Error('未在此测试用例中实现流式')),
    };
  }

  const dummyFastModel = createDummyModel('fast-model-1', 'fast', 1);
  const dummyDeepPrimary = createDummyModel('deep-primary', 'deep primary', 5);
  const dummyDeepFallback = createDummyModel('deep-fallback', 'deep fallback', 5);
  const dummyVisionModel = createDummyModel('vision-model-1', 'vision', 10);
  const config: ModelFactoryConfig = {
    tiers: {
      FAST: {
        models: [
          {
            model: dummyFastModel,
            maxRetries: 2,
          },
        ],
      },
      DEEP: {
        models: [
          {
            model: dummyDeepPrimary,
            maxRetries: 1,
          },
          {
            model: dummyDeepFallback,
            maxRetries: 0,
          },
        ],
      },
      VISION: {
        models: [
          {
            model: dummyVisionModel,
            maxRetries: 1,
          },
        ],
      },
    },
  };

  it('按 Tier 直接解析出配置的 ModelWithRetries 数组', () => {
    const factory = new MastraModelFactory(config);

    const fastModels = factory.resolveModelsForTier('FAST');
    expect(fastModels).toHaveLength(1);
    expect(fastModels[0].model).toBe(dummyFastModel);
    expect(fastModels[0].maxRetries).toBe(2);

    const deepModels = factory.resolveModelsForTier('DEEP');
    expect(deepModels).toHaveLength(2);
    expect(deepModels[0].model).toBe(dummyDeepPrimary);
    expect(deepModels[0].maxRetries).toBe(1);
    expect(deepModels[1].model).toBe(dummyDeepFallback);
    expect(deepModels[1].maxRetries).toBe(0);

    const visionModels = factory.resolveModelsForTier('VISION');
    expect(visionModels).toHaveLength(1);
    expect(visionModels[0].model).toBe(dummyVisionModel);
  });

  it('动态 model resolver 能够从 RequestContext 读取已确定的 Tier 并返回对应模型链', () => {
    const factory = new MastraModelFactory(config);
    const dynamicResolver = factory.createDynamicModelResolver();

    const reqCtxFast = new RequestContext<KKBotRequestContextValues>();
    reqCtxFast.set('tier', 'FAST');
    const resolvedFast = dynamicResolver({ requestContext: reqCtxFast });
    expect(resolvedFast[0].model).toBe(dummyFastModel);

    const reqCtxDeep = new RequestContext<KKBotRequestContextValues>();
    reqCtxDeep.set('tier', 'DEEP');
    const resolvedDeep = dynamicResolver({ requestContext: reqCtxDeep });
    expect(resolvedDeep[0].model).toBe(dummyDeepPrimary);

    const reqCtxVision = new RequestContext<KKBotRequestContextValues>();
    reqCtxVision.set('tier', 'VISION');
    const resolvedVision = dynamicResolver({ requestContext: reqCtxVision });
    expect(resolvedVision[0].model).toBe(dummyVisionModel);
  });

  it('RequestContext 缺失或包含非法 tier 时明确抛出可诊断错误，禁止静默降级', () => {
    const factory = new MastraModelFactory(config);
    const dynamicResolver = factory.createDynamicModelResolver();

    const emptyReqCtx = new RequestContext<KKBotRequestContextValues>();
    expect(() => dynamicResolver({ requestContext: emptyReqCtx })).toThrow(/ModelTier 无效或缺失/);

    const invalidReqCtx = new RequestContext();
    invalidReqCtx.set('tier', 'INVALID_TIER');
    expect(() => dynamicResolver({ requestContext: invalidReqCtx })).toThrow(
      /ModelTier 无效或缺失/
    );

    expect(() => dynamicResolver({})).toThrow(/RequestContext 缺失/);
  });

  it('两个并发 RequestContext 不会互相串用 Model Tier', () => {
    const factory = new MastraModelFactory(config);
    const dynamicResolver = factory.createDynamicModelResolver();

    const reqCtx1 = new RequestContext<KKBotRequestContextValues>();
    reqCtx1.set('tier', 'FAST');

    const reqCtx2 = new RequestContext<KKBotRequestContextValues>();
    reqCtx2.set('tier', 'VISION');

    const res1 = dynamicResolver({ requestContext: reqCtx1 });
    const res2 = dynamicResolver({ requestContext: reqCtx2 });

    expect(res1[0].model).toBe(dummyFastModel);
    expect(res2[0].model).toBe(dummyVisionModel);
  });
});
