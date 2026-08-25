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

/**
 * 创建用于测试的 LanguageModelV2 (AI SDK v5+ 兼容) Fake Model
 */
export function createFakeModel(options: FakeModelOptions = {}) {
  const modelId = options.modelId ?? 'fake-model-1';
  const provider = options.provider ?? 'fake-provider';
  let callCount = 0;
  const responses = options.responses ? [...options.responses] : [];

  const fakeModel = {
    specificationVersion: 'v2' as const,
    provider,
    modelId,
    supportedUrls: {},
    get callCount() {
      return callCount;
    },
    doGenerate: (callOptions: FakeModelCallOptions) => {
      callCount++;
      if (options.onGenerate) {
        options.onGenerate(callCount, callOptions);
      }

      // 检查调用选项中的 abortSignal
      if (callOptions?.abortSignal?.aborted) {
        return Promise.reject(new Error('FakeModel: Call aborted by signal'));
      }

      const response = responses.shift() ?? {
        text: `Fake response from ${modelId} (step ${callCount})`,
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
    doStream: () => {
      return Promise.reject(new Error('doStream is not implemented for FakeModel (use generate)'));
    },
  };

  return fakeModel;
}
