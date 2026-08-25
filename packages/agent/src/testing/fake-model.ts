export interface FakeModelStepResponse {
  text?: string;
  toolCalls?: Array<{
    id?: string;
    name: string;
    input: Record<string, unknown> | string;
  }>;
  finishReason?: 'stop' | 'tool-calls' | 'length' | 'error' | 'other';
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  throwError?: Error;
}

export interface FakeModelCallOptions {
  prompt?: unknown;
  abortSignal?: AbortSignal;
  [key: string]: unknown;
}

export interface FakeModelOptions {
  modelId?: string;
  provider?: string;
  responses?: FakeModelStepResponse[];
  onGenerate?: (callCount: number, options: FakeModelCallOptions) => void;
}

export type FakeModelContentPart =
  | {
      type: 'tool-call';
      toolCallId: string;
      toolName: string;
      input: string;
    }
  | {
      type: 'text';
      text: string;
    };
export interface FakeModelGenerateResult {
  content: FakeModelContentPart[];
  finishReason: 'stop' | 'tool-calls' | 'length' | 'error' | 'other';
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  warnings: unknown[];
  rawCall: { rawPrompt: null; rawSettings: Record<string, unknown> };
}

export interface FakeLanguageModel {
  readonly specificationVersion: 'v2';
  readonly provider: string;
  readonly modelId: string;
  readonly supportedUrls: Record<string, unknown>;
  readonly callCount: number;
  doGenerate(callOptions: FakeModelCallOptions): Promise<FakeModelGenerateResult>;
  doStream(): Promise<never>;
}


/**
 * 创建用于测试的 LanguageModelV2 (AI SDK v5+ 兼容) 虚拟模型夹具
 */
export function createFakeModel(options: FakeModelOptions = {}): FakeLanguageModel {
  const modelId = options.modelId ?? 'fake-model-1';
  const provider = options.provider ?? 'fake-provider';
  let callCount = 0;
  const responses = options.responses ? [...options.responses] : [];

  const fakeModel: FakeLanguageModel = {
    specificationVersion: 'v2' as const,
    provider,
    modelId,
    supportedUrls: {},
    get callCount(): number {
      return callCount;
    },
    doGenerate: (callOptions: FakeModelCallOptions): Promise<FakeModelGenerateResult> => {
      callCount++;
      if (options.onGenerate) {
        options.onGenerate(callCount, callOptions);
      }

      if (callOptions?.abortSignal?.aborted) {
        return Promise.reject(new Error('虚拟模型调用被信号中止'));
      }

      const response = responses.shift() ?? {
        text: `来自 ${modelId} 的模拟回复（第 ${callCount} 步）`,
        finishReason: 'stop' as const,
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      };

      if (response.throwError) {
        return Promise.reject(response.throwError);
      }

      const content: FakeModelContentPart[] = [];

      if (response.toolCalls && response.toolCalls.length > 0) {
        for (const tc of response.toolCalls) {
          content.push({
            type: 'tool-call',
            toolCallId: tc.id ?? `call-${callCount}-${tc.name}`,
            toolName: tc.name,
            input: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
          });
        }
      }

      if (response.text !== undefined) {
        content.push({
          type: 'text',
          text: response.text,
        });
      }

      const inputTokens = response.usage !== undefined ? response.usage.inputTokens : 10;
      const outputTokens = response.usage !== undefined ? response.usage.outputTokens : 5;
      const totalTokens =
        response.usage !== undefined
          ? response.usage.totalTokens
          : inputTokens !== undefined && outputTokens !== undefined
            ? inputTokens + outputTokens
            : undefined;

      return Promise.resolve({
        content,
        finishReason: response.finishReason ?? (response.toolCalls?.length ? 'tool-calls' : 'stop'),
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        warnings: [],
        rawCall: { rawPrompt: null, rawSettings: {} },
      });
    },
    doStream: (): Promise<never> => {
      return Promise.reject(new Error('虚拟模型尚未实现 doStream（请使用 doGenerate）'));
    },
  };

  return fakeModel;
}
