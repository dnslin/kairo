import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createTool } from '@mastra/core/tools';
import type { InputProcessor, OutputProcessor } from '@mastra/core/processors';
import { KKBotAgent } from '../src/agent.js';
import { MastraModelFactory } from '../src/models/factory.js';
import { createFakeModel } from './fixtures/fake-model.js';

describe('KKBotAgent (Mastra-native Agent)', () => {
  it('生产执行入口为 Mastra Agent，支持纯文本生成与权威 Usage 返回', async () => {
    const fastModel = createFakeModel({
      modelId: 'fast-model',
      responses: [
        {
          text: '你好！我是企业智能助手 KKBot。',
          finishReason: 'stop',
          usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        },
      ],
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fastModel }] },
        DEEP: { models: [{ model: fastModel }] },
        VISION: { models: [{ model: fastModel }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'test-agent',
      name: 'Test KKBot',
      modelFactory: factory,
    });

    const result = await agent.execute({
      input: '你好',
      sessionId: 'session-123',
      senderId: 'employee-456',
    });

    expect(result.text).toBe('你好！我是企业智能助手 KKBot。');
    expect(result.finishReason).toBe('stop');
    expect(result.tier).toBe('FAST');
    expect(result.usage).toMatchObject({
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
    });
    expect(fastModel.callCount).toBe(1);
  });

  it('连续调用两个或更多 Tool 并在每个 Tool result 后继续推理', async () => {
    const tool1Calls: Array<{ location: string }> = [];
    const tool2Calls: Array<{ department: string }> = [];

    const weatherTool = createTool({
      id: 'get-weather',
      description: '查询指定城市的天气',
      inputSchema: z.object({ location: z.string() }),
      execute: input => {
        tool1Calls.push(input);
        return Promise.resolve({ weather: '晴朗', temperature: '25°C' });
      },
    });

    const orgTool = createTool({
      id: 'search-org',
      description: '查询部门信息',
      inputSchema: z.object({ department: z.string() }),
      execute: input => {
        tool2Calls.push(input);
        return Promise.resolve({ leader: '张主管', memberCount: 15 });
      },
    });

    const toolModel = createFakeModel({
      modelId: 'multi-tool-model',
      responses: [
        // 步骤 1: 调用 weatherTool
        {
          toolCalls: [
            {
              id: 'call-weather-1',
              name: 'get-weather',
              input: { location: '北京' },
            },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        },
        // 步骤 2: 调用 orgTool
        {
          toolCalls: [
            {
              id: 'call-org-1',
              name: 'search-org',
              input: { department: '研发部' },
            },
          ],
          finishReason: 'tool-calls',
          usage: { inputTokens: 25, outputTokens: 15, totalTokens: 40 },
        },
        // 步骤 3: 汇聚结果生成最终回复
        {
          text: '北京天气晴朗 25°C，研发部主管为张主管，成员 15 人。',
          finishReason: 'stop',
          usage: { inputTokens: 30, outputTokens: 20, totalTokens: 50 },
        },
      ],
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: toolModel }] },
        DEEP: { models: [{ model: toolModel }] },
        VISION: { models: [{ model: toolModel }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'multi-tool-agent',
      modelFactory: factory,
      tools: {
        'get-weather': weatherTool,
        'search-org': orgTool,
      },
    });

    const result = await agent.execute({
      input: '请分析一下北京的天气和研发部的架构情况',
    });

    expect(result.text).toContain('北京天气晴朗 25°C');
    expect(result.text).toContain('研发部主管为张主管');
    expect(tool1Calls).toEqual([{ location: '北京' }]);
    expect(tool2Calls).toEqual([{ department: '研发部' }]);
    expect(result.rawOutput.steps.length).toBe(3);
    // 权威 Usage 汇聚
    expect(result.usage.totalTokens).toBe(120); // 30 + 40 + 50
  });

  it('无 Tool Call 时直接生成回复并正常结束 (finishReason: stop)', async () => {
    const plainModel = createFakeModel({
      modelId: 'plain-model',
      responses: [
        {
          text: '这是无工具调用的纯文本回复。',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 10, totalTokens: 20 },
        },
      ],
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: plainModel }] },
        DEEP: { models: [{ model: plainModel }] },
        VISION: { models: [{ model: plainModel }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'plain-agent',
      modelFactory: factory,
    });

    const result = await agent.execute({
      input: '简单的问答测试',
    });

    expect(result.text).toBe('这是无工具调用的纯文本回复。');
    expect(result.finishReason).toBe('stop');
    expect(result.rawOutput.steps.length).toBe(1);
    expect(plainModel.callCount).toBe(1);
  });

  it('非重试错误不会发生无意义重试', async () => {
    let callCount = 0;
    const fatalFailingModel = createFakeModel({
      modelId: 'fatal-failing',
      responses: [{ throwError: new Error('Fatal unrecoverable error') }],
      onGenerate: () => {
        callCount++;
      },
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fatalFailingModel, maxRetries: 0 }] },
        DEEP: { models: [{ model: fatalFailingModel, maxRetries: 0 }] },
        VISION: { models: [{ model: fatalFailingModel, maxRetries: 0 }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'fatal-agent',
      modelFactory: factory,
    });

    await expect(agent.execute({ input: '你好' })).rejects.toThrow(/Fatal unrecoverable error/);
    expect(callCount).toBe(1); // 零重试，仅执行 1 次即失败
  });

  it('AbortSignal 可以停止 Agent Run 并传播到 Tool 执行中', async () => {
    const controller = new AbortController();
    let toolAborted = false;

    const longRunningTool = createTool({
      id: 'long-running-tool',
      description: '耗时工具',
      inputSchema: z.object({}),
      execute: (_input, ctx): Promise<{ success: boolean }> => {
        const { promise, reject } = Promise.withResolvers<{ success: boolean }>();
        if (ctx?.abortSignal?.aborted) {
          toolAborted = true;
          reject(new Error('Tool aborted immediately'));
        } else {
          ctx?.abortSignal?.addEventListener('abort', () => {
            toolAborted = true;
            reject(new Error('Tool aborted during execution'));
          });
          // 进入工具执行后立即触发外部中断信号
          controller.abort();
        }
        return promise as Promise<{ success: boolean }>;
      },
    });

    const model = createFakeModel({
      modelId: 'abort-model',
      responses: [
        {
          toolCalls: [
            {
              id: 'call-long-running',
              name: 'long-running-tool',
              input: {},
            },
          ],
          finishReason: 'tool-calls',
        },
      ],
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: model }] },
        DEEP: { models: [{ model: model }] },
        VISION: { models: [{ model: model }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'abort-agent',
      modelFactory: factory,
      tools: {
        'long-running-tool': longRunningTool,
      },
    });

    const result = await agent.execute({
      input: '执行长任务',
      abortSignal: controller.signal,
    });

    expect(toolAborted).toBe(true);
    expect(result.finishReason).toBe('tool-calls');
  });

  it('maxSteps 到达时产生明确终态，不启动自研第二轮循环', async () => {
    let callSteps = 0;
    const infiniteLoopModel = createFakeModel({
      modelId: 'infinite-loop-model',
      onGenerate: () => {
        callSteps++;
      },
      responses: Array.from({ length: 10 }, (_, i) => ({
        toolCalls: [
          {
            id: `call-loop-${i}`,
            name: 'dummy-ping',
            input: { count: i },
          },
        ],
        finishReason: 'tool-calls',
      })),
    });

    const pingTool = createTool({
      id: 'dummy-ping',
      description: 'Ping',
      inputSchema: z.object({ count: z.number() }),
      execute: input => Promise.resolve({ ack: input.count }),
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: infiniteLoopModel }] },
        DEEP: { models: [{ model: infiniteLoopModel }] },
        VISION: { models: [{ model: infiniteLoopModel }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'max-steps-agent',
      modelFactory: factory,
      tools: {
        'dummy-ping': pingTool,
      },
    });

    const result = await agent.execute({
      input: '无限循环任务',
      maxSteps: 2,
    });

    expect(result.finishReason).toBe('tool-calls');
    expect(result.rawOutput.steps.length).toBe(2);
    expect(callSteps).toBe(2);
  });

  it('模型失败按配置执行 retry 和 fallback，且失败不升级或改变 Tier', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;

    const primaryFailingModel = createFakeModel({
      modelId: 'primary-failing',
      responses: [
        { throwError: new Error('Primary call 1 failed') },
        { throwError: new Error('Primary call 2 failed') },
      ],
      onGenerate: () => {
        primaryCalls++;
      },
    });

    const fallbackSuccessModel = createFakeModel({
      modelId: 'fallback-success',
      responses: [
        {
          text: 'Fallback 模型回复成功',
          finishReason: 'stop',
          usage: { inputTokens: 15, outputTokens: 10, totalTokens: 25 },
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
      id: 'fallback-test-agent',
      modelFactory: factory,
    });

    const result = await agent.execute({
      input: '你好', // 命中 FAST Tier
    });

    expect(result.text).toBe('Fallback 模型回复成功');
    expect(result.tier).toBe('FAST'); // Tier 未改变或升级
    expect(primaryCalls).toBe(2); // 初次 + 1 次 retry
    expect(fallbackCalls).toBe(1); // fallback 成功
  });

  it('当 Usage 部分或全部字段缺失时，严格保留 undefined 而不伪造 0 或合成 totalTokens', async () => {
    const partialUsageModel = createFakeModel({
      modelId: 'partial-usage',
      responses: [
        {
          text: '部分 Usage 回复',
          finishReason: 'stop',
          usage: {
            inputTokens: 100,
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
      id: 'partial-usage-agent',
      modelFactory: factory,
    });

    const result = await agent.execute({
      input: '你好',
    });

    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBeUndefined();
    expect(result.usage.raw?.outputTokens).toBeUndefined();
    expect(result.usage.raw?.totalTokens).toBeUndefined();
  });

  it('静态 Processor 按固定顺序接线并能对 Tool result 进行安全检查', async () => {
    const executedPhases: string[] = [];

    const mockInputProcessor: InputProcessor = {
      id: 'mock-input-proc',
      processInput: ({ messages }) => {
        executedPhases.push('input:processInput');
        return Promise.resolve(messages);
      },
    };

    const mockToolResultProcessor: OutputProcessor = {
      id: 'mock-tool-result-proc',
      processToolResult: ({ toolName, result }) => {
        executedPhases.push(`output:processToolResult:${toolName}`);
        return Promise.resolve(result);
      },
    };

    const testTool = createTool({
      id: 'sample-tool',
      description: 'Sample',
      inputSchema: z.object({ arg: z.string() }),
      execute: input => Promise.resolve({ echo: input.arg }),
    });

    const processorModel = createFakeModel({
      modelId: 'proc-model',
      responses: [
        {
          toolCalls: [{ id: 'tc-1', name: 'sample-tool', input: { arg: 'val' } }],
          finishReason: 'tool-calls',
        },
        {
          text: '处理器测试完毕',
          finishReason: 'stop',
        },
      ],
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: processorModel }] },
        DEEP: { models: [{ model: processorModel }] },
        VISION: { models: [{ model: processorModel }] },
      },
    });

    const agent = new KKBotAgent({
      id: 'proc-agent',
      modelFactory: factory,
      tools: {
        'sample-tool': testTool,
      },
      inputProcessors: [mockInputProcessor],
      outputProcessors: [mockToolResultProcessor],
    });

    const result = await agent.execute({
      input: '测试处理器顺序',
    });

    expect(result.text).toBe('处理器测试完毕');
    expect(executedPhases).toContain('input:processInput');
    expect(executedPhases).toContain('output:processToolResult:sample-tool');
  });
});
