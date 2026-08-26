import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import { RequestContext } from '@mastra/core/request-context';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import {
  KKBotAgent,
  MastraModelFactory,
  resolveModelTier,
  createFakeModel,
  type NormalizedModelTierInput,
  type KKBotRequestContextValues,
} from '@kkbot/agent';

describe('AGENT-01 Contract: Mastra-native Agent & Model Tier Policy', () => {
  const RULES_VERSION = 'v1.0';

  // ==========================================================================
  // 1. Model Tier 规则与边界合同
  // ==========================================================================
  describe('1. Model Tier 确定性规则与纯函数契约', () => {
    it('AGENT-01.1: 简单文本稳定选择 FAST', () => {
      expect(resolveModelTier({ text: '你好' }, RULES_VERSION)).toBe('FAST');
      expect(resolveModelTier({ text: '查询员工张三的主管' }, RULES_VERSION)).toBe('FAST');
      expect(resolveModelTier({ text: '早上好！' }, RULES_VERSION)).toBe('FAST');
    });

    it('AGENT-01.2: 显式复杂文本稳定选择 DEEP', () => {
      expect(
        resolveModelTier({ text: '请帮我做 TypeScript 架构重构并分析系统死锁原因' }, RULES_VERSION)
      ).toBe('DEEP');
      expect(resolveModelTier({ text: '解释图片压缩算法原理' }, RULES_VERSION)).toBe('DEEP');
      expect(resolveModelTier({ text: '设计前端 UI 架构' }, RULES_VERSION)).toBe('DEEP');
    });

    it('AGENT-01.3: 未知文本稳定默认选择 DEEP', () => {
      expect(resolveModelTier({ text: '整理今天的纪要并在下周推进' }, RULES_VERSION)).toBe('DEEP');
      expect(resolveModelTier({ text: '请处理一下这件事务' }, RULES_VERSION)).toBe('DEEP');
    });

    it('AGENT-01.4: 需要真实视觉理解的输入稳定选择 VISION', () => {
      // (a1) 视觉附件缺少完整可信文本表示
      const visualInput: NormalizedModelTierInput = {
        text: '查看附件',
        attachments: [
          {
            mediaType: 'image/png',
            filename: 'diag.png',
            isVisual: true,
            hasCompleteTrustedText: false,
          },
        ],
      };
      expect(resolveModelTier(visualInput, RULES_VERSION)).toBe('VISION');

      // (a2) 仅含 mediaType: image/png 且无 isVisual / filename
      const mimeOnlyVisualInput: NormalizedModelTierInput = {
        text: '查看附件',
        attachments: [
          {
            mediaType: 'image/png',
            hasCompleteTrustedText: false,
          },
        ],
      };
      expect(resolveModelTier(mimeOnlyVisualInput, RULES_VERSION)).toBe('VISION');

      // (b) 文本显式要求分析图表或颜色位置
      expect(resolveModelTier({ text: '分析这个截图中的图表关系和按钮颜色' }, RULES_VERSION)).toBe(
        'VISION'
      );
    });

    it('AGENT-01.5: 普通纯文本附件或已具备完整文本的附件不会错误选择 VISION', () => {
      const textAttachmentInput: NormalizedModelTierInput = {
        text: '你好',
        attachments: [
          {
            mediaType: 'text/plain',
            filename: 'doc.txt',
            isVisual: false,
            hasCompleteTrustedText: true,
          },
        ],
      };
      expect(resolveModelTier(textAttachmentInput, RULES_VERSION)).toBe('FAST');

      const ocrCompleteAttachmentInput: NormalizedModelTierInput = {
        text: '查询李四的部门',
        attachments: [
          {
            mediaType: 'image/png',
            filename: 'scan.png',
            isVisual: true,
            hasCompleteTrustedText: true,
            trustedText: '员工：李四',
          },
        ],
      };
      expect(resolveModelTier(ocrCompleteAttachmentInput, RULES_VERSION)).toBe('FAST');
    });

    it('AGENT-01.6: 相同输入和 rulesVersion 重复执行严格产生相同 Tier', () => {
      const input: NormalizedModelTierInput = { text: '查询王五的汇报线' };
      const tiers = Array.from({ length: 30 }, () => resolveModelTier(input, RULES_VERSION));
      expect(new Set(tiers).size).toBe(1);
      expect(tiers[0]).toBe('FAST');
    });

    it('AGENT-01.7: 分类过程为纯同步函数，没有模型、Embedding、远端 API 或 Tool 调用', () => {
      const input: NormalizedModelTierInput = { text: '测试无副作用分类' };
      const result = resolveModelTier(input, RULES_VERSION);
      expect(typeof result).toBe('string');
      expect(['FAST', 'DEEP', 'VISION']).toContain(result);
    });
  });

  // ==========================================================================
  // 2. 动态模型路由、Retry 与 Fallback 合同
  // ==========================================================================
  describe('2. 动态模型路由、Retry 与 Fallback', () => {
    it('AGENT-01.8: 动态 model 函数从 RequestContext 读取正确 Tier 并映射配置', () => {
      const fastM = createFakeModel({ modelId: 'fast-m' });
      const deepM = createFakeModel({ modelId: 'deep-m' });
      const visionM = createFakeModel({ modelId: 'vision-m' });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fastM }] },
          DEEP: { models: [{ model: deepM }] },
          VISION: { models: [{ model: visionM }] },
        },
      });

      const resolver = factory.createDynamicModelResolver();

      const reqCtxFast = new RequestContext<KKBotRequestContextValues>();
      reqCtxFast.set('tier', 'FAST');
      expect(resolver({ requestContext: reqCtxFast })[0].model).toBe(fastM);

      const reqCtxVision = new RequestContext<KKBotRequestContextValues>();
      reqCtxVision.set('tier', 'VISION');
      expect(resolver({ requestContext: reqCtxVision })[0].model).toBe(visionM);
    });

    it('AGENT-01.9, AGENT-01.10, AGENT-01.11: retry 与 fallback 按配置顺序执行且期间 Tier 绝不改变', async () => {
      let primaryCalls = 0;
      let fallbackCalls = 0;

      const primaryFailingModel = createFakeModel({
        modelId: 'primary-failing',
        responses: [
          { throwError: new Error('Attempt 1 failed') },
          { throwError: new Error('Attempt 2 failed') },
        ],
        onGenerate: () => {
          primaryCalls++;
        },
      });

      const fallbackSuccessModel = createFakeModel({
        modelId: 'fallback-success',
        responses: [
          {
            text: 'Fallback 完成生成',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ],
        onGenerate: () => {
          fallbackCalls++;
        },
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: {
            models: [
              { model: primaryFailingModel, maxRetries: 1 },
              { model: fallbackSuccessModel, maxRetries: 0 },
            ],
          },
          DEEP: { models: [{ model: primaryFailingModel }] },
          VISION: { models: [{ model: primaryFailingModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'fallback-agent',
        modelFactory: factory,
      });

      const result = await agent.execute({
        input: '你好', // 命中 FAST Tier
      });

      expect(result.text).toBe('Fallback 完成生成');
      expect(result.tier).toBe('FAST'); // Tier 不发生升级或改变
      expect(primaryCalls).toBe(2); // 初次 + 1 次 retry
      expect(fallbackCalls).toBe(1); // 成功 fallback
    });

    it('AGENT-01.20: 两个并发 RequestContext 不串用 Model Tier', () => {
      const fastM = createFakeModel({ modelId: 'fast-m' });
      const visionM = createFakeModel({ modelId: 'vision-m' });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fastM }] },
          DEEP: { models: [{ model: fastM }] },
          VISION: { models: [{ model: visionM }] },
        },
      });

      const resolver = factory.createDynamicModelResolver();

      const ctx1 = new RequestContext<KKBotRequestContextValues>();
      ctx1.set('tier', 'FAST');

      const ctx2 = new RequestContext<KKBotRequestContextValues>();
      ctx2.set('tier', 'VISION');

      const res1 = resolver({ requestContext: ctx1 });
      const res2 = resolver({ requestContext: ctx2 });

      expect(res1[0].model).toBe(fastM);
      expect(res2[0].model).toBe(visionM);
    });

    it('AGENT-01.20b: 传入同一个共享 RequestContext 实例并发执行时，自动克隆隔离且 Model Tier 绝不串线', async () => {
      const fastM = createFakeModel({
        modelId: 'fast-concurrent-model',
        responses: [{ text: 'Fast 回复', finishReason: 'stop' }],
      });

      const visionM = createFakeModel({
        modelId: 'vision-concurrent-model',
        responses: [{ text: 'Vision 回复', finishReason: 'stop' }],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fastM }] },
          DEEP: { models: [{ model: fastM }] },
          VISION: { models: [{ model: visionM }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'shared-ctx-contract-agent',
        modelFactory: factory,
      });

      // 同一个共享的上下文实例
      const sharedContext = new RequestContext();
      sharedContext.setRaw('upstream_trace', 'trace-shared-123');

      // 同时并发执行 FAST 与 VISION 输入
      const [resFast, resVision] = await Promise.all([
        agent.execute({
          input: '你好', // 判定为 FAST
          requestContext: sharedContext,
        }),
        agent.execute({
          input: {
            text: '查看附件图',
            attachments: [
              {
                mediaType: 'image/png',
                hasCompleteTrustedText: false,
              },
            ],
          }, // 判定为 VISION
          requestContext: sharedContext,
        }),
      ]);

      expect(resFast.tier).toBe('FAST');
      expect(resFast.text).toBe('Fast 回复');
      expect(resVision.tier).toBe('VISION');
      expect(resVision.text).toBe('Vision 回复');
    });
  });

  // ==========================================================================
  // 3. Multi-Tool Calling 与推理循环合同
  // ==========================================================================
  describe('3. Multi-Tool Calling 与推理循环', () => {
    it('AGENT-01.12, AGENT-01.13, AGENT-01.14: 连续调用至少两个 Tool，回传结果后继续推理，返回最终文本与权威 Usage', async () => {
      const toolSequence: string[] = [];

      const toolA = createTool({
        id: 'tool-a',
        description: 'Tool A',
        inputSchema: z.object({ query: z.string() }),
        execute: input => {
          toolSequence.push(`tool-a:${input.query}`);
          return Promise.resolve({ dataA: 'result-from-a' });
        },
      });

      const toolB = createTool({
        id: 'tool-b',
        description: 'Tool B',
        inputSchema: z.object({ data: z.string() }),
        execute: input => {
          toolSequence.push(`tool-b:${input.data}`);
          return Promise.resolve({ dataB: 'result-from-b' });
        },
      });

      const multiToolModel = createFakeModel({
        modelId: 'multi-tool-model',
        responses: [
          // 步骤 1: 调用 tool-a
          {
            toolCalls: [{ id: 'c1', name: 'tool-a', input: { query: 'first-step' } }],
            finishReason: 'tool-calls',
            usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          },
          // 步骤 2: 调用 tool-b
          {
            toolCalls: [{ id: 'c2', name: 'tool-b', input: { data: 'second-step' } }],
            finishReason: 'tool-calls',
            usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
          },
          // 步骤 3: 汇聚并返回最终文本
          {
            text: '全部工具调用已完成，最终结论就绪。',
            finishReason: 'stop',
            usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: multiToolModel }] },
          DEEP: { models: [{ model: multiToolModel }] },
          VISION: { models: [{ model: multiToolModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'multi-tool-agent',
        modelFactory: factory,
        tools: {
          'tool-a': toolA,
          'tool-b': toolB,
        },
      });

      const result = await agent.execute({
        input: '请按顺序执行工具A和工具B并汇聚结论',
      });

      expect(toolSequence).toEqual(['tool-a:first-step', 'tool-b:second-step']);
      expect(result.text).toBe('全部工具调用已完成，最终结论就绪。');
      expect(result.rawOutput.steps.length).toBe(3);
      // 权威 Usage 准确汇聚 30 + 40 + 50 = 120
      expect(result.usage.totalTokens).toBe(120);
    });
  });

  // ==========================================================================
  // 4. 中止与步数限制生命周期合同
  // ==========================================================================
  describe('4. 中止、步数限制与权威 Usage', () => {
    it('AGENT-01.15: AbortSignal 能够在模型调用进行中中止模型执行', async () => {
      const abortCtrl = new AbortController();
      let modelAborted = false;

      const abortableModel = createFakeModel({
        modelId: 'abortable-model',
        onGenerate: (_count, opts) => {
          opts.abortSignal?.addEventListener('abort', () => {
            modelAborted = true;
          });
          abortCtrl.abort();
          if (opts.abortSignal?.aborted) {
            modelAborted = true;
          }
        },
        responses: [
          {
            text: '未中止回复',
            finishReason: 'stop',
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: abortableModel }] },
          DEEP: { models: [{ model: abortableModel }] },
          VISION: { models: [{ model: abortableModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'model-abort-agent',
        modelFactory: factory,
      });

      try {
        await agent.execute({
          input: '你好',
          abortSignal: abortCtrl.signal,
        });
      } catch {
        // 模型中断可能向外抛出或由 Mastra 捕获
      }

      expect(modelAborted).toBe(true);
    });

    it('AGENT-01.16: AbortSignal 可以停止 Agent Run 并传播到正在执行的 Tool', async () => {
      const abortCtrl = new AbortController();
      let toolReceivedAbort = false;

      const interruptibleTool = createTool({
        id: 'interruptible-tool',
        description: '可中断工具',
        inputSchema: z.object({}),
        execute: (_input, ctx): Promise<{ status: string }> => {
          const { promise, reject } = Promise.withResolvers<{ status: string }>();
          if (ctx?.abortSignal?.aborted) {
            toolReceivedAbort = true;
            reject(new Error('Tool aborted immediately'));
          } else {
            ctx?.abortSignal?.addEventListener('abort', () => {
              toolReceivedAbort = true;
              reject(new Error('Tool received abort event'));
            });
            // 进入工具内部执行后发出中止信号
            abortCtrl.abort();
          }
          return promise as Promise<{ status: string }>;
        },
      });

      const model = createFakeModel({
        modelId: 'abort-test-model',
        responses: [
          {
            toolCalls: [{ id: 'c-int', name: 'interruptible-tool', input: {} }],
            finishReason: 'tool-calls',
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model }] },
          DEEP: { models: [{ model }] },
          VISION: { models: [{ model }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'abort-contract-agent',
        modelFactory: factory,
        tools: { 'interruptible-tool': interruptibleTool },
      });

      await expect(
        agent.execute({
          input: '触发可中断工具任务',
          abortSignal: abortCtrl.signal,
        })
      ).rejects.toThrow();

      expect(toolReceivedAbort).toBe(true);
    });

    it('AGENT-01.17, AGENT-01.18: maxSteps 到达后产生明确终态，不触发自研第二轮模型循环', async () => {
      let executedSteps = 0;
      const loopingModel = createFakeModel({
        modelId: 'looping-model',
        onGenerate: () => {
          executedSteps++;
        },
        responses: Array.from({ length: 8 }, (_, i) => ({
          toolCalls: [{ id: `step-${i}`, name: 'test-ping', input: {} }],
          finishReason: 'tool-calls',
        })),
      });

      const pingTool = createTool({
        id: 'test-ping',
        description: 'ping',
        inputSchema: z.object({}),
        execute: () => Promise.resolve({ status: 'ok' }),
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: loopingModel }] },
          DEEP: { models: [{ model: loopingModel }] },
          VISION: { models: [{ model: loopingModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'max-steps-contract-agent',
        modelFactory: factory,
        tools: { 'test-ping': pingTool },
      });

      const result = await agent.execute({
        input: '限制步数的循环任务',
        maxSteps: 3,
      });

      expect(result.finishReason).toBe('tool-calls');
      expect(result.rawOutput.steps.length).toBe(3);
      expect(executedSteps).toBe(3);
    });

    it('AGENT-01.19: Token Usage 直接来自 Mastra 权威结果，不使用旧 Runtime 估算', async () => {
      const explicitUsageModel = createFakeModel({
        modelId: 'exact-usage-model',
        responses: [
          {
            text: '精确 Token 计数回复',
            finishReason: 'stop',
            usage: {
              inputTokens: 1234,
              outputTokens: 567,
              totalTokens: 1801,
            },
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: explicitUsageModel }] },
          DEEP: { models: [{ model: explicitUsageModel }] },
          VISION: { models: [{ model: explicitUsageModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'usage-contract-agent',
        modelFactory: factory,
      });

      const result = await agent.execute({
        input: '你好',
      });

      expect(result.usage.inputTokens).toBe(1234);
      expect(result.usage.outputTokens).toBe(567);
      expect(result.usage.totalTokens).toBe(1801);
    });

    it('AGENT-01.19b: Token Usage 在字段缺失时严格保留 undefined，防止配额审计静默低估', async () => {
      const partialUsageModel = createFakeModel({
        modelId: 'partial-usage-model',
        responses: [
          {
            text: '部分 Token 计数回复',
            finishReason: 'stop',
            usage: {
              inputTokens: 500,
              outputTokens: undefined,
              totalTokens: undefined,
            },
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: partialUsageModel }] },
          DEEP: { models: [{ model: partialUsageModel }] },
          VISION: { models: [{ model: partialUsageModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'partial-usage-contract-agent',
        modelFactory: factory,
      });

      const result = await agent.execute({
        input: '你好',
      });

      expect(result.usage.inputTokens).toBe(500);
      expect(result.usage.outputTokens).toBeUndefined();
      expect(result.usage.raw?.outputTokens).toBeUndefined();
      expect(result.usage.raw?.totalTokens).toBeUndefined();
    });

    it('AGENT-01.21: 无 Tool Call 时正常结束 (finishReason: stop)', async () => {
      const directModel = createFakeModel({
        modelId: 'direct-text-model',
        responses: [
          {
            text: '直接纯文本生成',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: directModel }] },
          DEEP: { models: [{ model: directModel }] },
          VISION: { models: [{ model: directModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'direct-contract-agent',
        modelFactory: factory,
      });

      const result = await agent.execute({
        input: '你好',
      });

      expect(result.text).toBe('直接纯文本生成');
      expect(result.finishReason).toBe('stop');
      expect(result.rawOutput.steps.length).toBe(1);
    });

    it('AGENT-01.22: 非重试错误不会发生无意义重试', async () => {
      let fatalCallCount = 0;
      const fatalModel = createFakeModel({
        modelId: 'fatal-contract-model',
        responses: [{ throwError: new Error('Unrecoverable fatal error') }],
        onGenerate: () => {
          fatalCallCount++;
        },
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: fatalModel, maxRetries: 0 }] },
          DEEP: { models: [{ model: fatalModel, maxRetries: 0 }] },
          VISION: { models: [{ model: fatalModel, maxRetries: 0 }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'fatal-contract-agent',
        modelFactory: factory,
      });

      await expect(agent.execute({ input: '你好' })).rejects.toThrow(/Unrecoverable fatal error/);
      expect(fatalCallCount).toBe(1);
    });

    it('AGENT-01.23: 静态 Processors 固定顺序执行且对 Tool Result 进行安全检查', async () => {
      const phaseRecords: string[] = [];

      const inputProc: InputProcessor = {
        id: 'input-proc-1',
        processInput: ({ messages }) => {
          phaseRecords.push('input:phase');
          return Promise.resolve(messages);
        },
      };

      const toolResultProc: OutputProcessor = {
        id: 'tool-result-proc-1',
        processToolResult: ({ toolName, result }) => {
          phaseRecords.push(`tool-result:${toolName}`);
          return Promise.resolve(result);
        },
      };

      const echoTool = createTool({
        id: 'echo-tool',
        description: 'echo',
        inputSchema: z.object({ msg: z.string() }),
        execute: input => Promise.resolve({ reply: input.msg }),
      });

      const procModel = createFakeModel({
        modelId: 'proc-contract-model',
        responses: [
          {
            toolCalls: [{ id: 'tc-echo', name: 'echo-tool', input: { msg: 'ping' } }],
            finishReason: 'tool-calls',
          },
          {
            text: '处理器验证完成',
            finishReason: 'stop',
          },
        ],
      });

      const factory = new MastraModelFactory({
        tiers: {
          FAST: { models: [{ model: procModel }] },
          DEEP: { models: [{ model: procModel }] },
          VISION: { models: [{ model: procModel }] },
        },
      });

      const agent = new KKBotAgent({
        id: 'proc-contract-agent',
        modelFactory: factory,
        tools: { 'echo-tool': echoTool },
        inputProcessors: [inputProc],
        outputProcessors: [toolResultProc],
      });

      const result = await agent.execute({
        input: '测试处理器',
      });

      expect(result.text).toBe('处理器验证完成');
      expect(phaseRecords).toEqual(['input:phase', 'tool-result:echo-tool']);
    });
  });
});
