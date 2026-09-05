import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { MastraLanguageModelV2Mock } from '@mastra/core/test-utils/llm-mock';

// 仅替代模型网络边界；Memory、Agent 和 PostgreSQL 均使用真实实现。
export function createTestModel() {
  const inputs: string[] = [];
  const model = new MastraLanguageModelV2Mock({
    provider: 'kairo-test',
    modelId: 't12-contract',
    doGenerate: options => {
      const input = JSON.stringify(options.prompt);
      inputs.push(input);
      return Promise.resolve({
        content: [
          { type: 'text', text: '<observations>\n员工确认的项目代号是蓝鲸。\n</observations>' },
        ],
        finishReason: 'stop',
        usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
        warnings: [],
      });
    },
    doStream: options => {
      inputs.push(JSON.stringify(options.prompt));
      return Promise.resolve({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'observation' });
            controller.enqueue({
              type: 'text-delta',
              id: 'observation',
              delta: '<observations>\n员工确认的项目代号是蓝鲸。\n</observations>',
            });
            controller.enqueue({ type: 'text-end', id: 'observation' });
            controller.enqueue({
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
            });
            controller.close();
          },
        }),
      });
    },
  });
  return { model, inputs };
}

// 显式启用真实门禁时，配置缺失直接失败，不回退到确定性模型。
export function createApprovedTestModel() {
  const id = process.env.KAIRO_T12_MODEL;
  const url = process.env.KAIRO_T12_MODEL_URL;
  const apiKey = process.env.KAIRO_T12_MODEL_API_KEY;
  if (!id || !id.includes('/') || !url || !apiKey) {
    throw new Error(
      '真实模型门禁需要 KAIRO_T12_MODEL（供应商/模型）、KAIRO_T12_MODEL_URL 和 KAIRO_T12_MODEL_API_KEY'
    );
  }
  const inputs: string[] = [];
  const model = new ModelRouterLanguageModel({ id: id as `${string}/${string}`, url, apiKey });
  const generate = model.doGenerate.bind(model);
  const stream = model.doStream.bind(model);
  model.doGenerate = async options => {
    inputs.push(JSON.stringify(options.prompt));
    return generate(options);
  };
  model.doStream = async options => {
    inputs.push(JSON.stringify(options.prompt));
    return stream(options);
  };
  return { model, inputs };
}
