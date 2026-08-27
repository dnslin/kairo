export interface FakeModelStepResponse {
  text?: string;
  toolCalls?: Array<{
    id?: string;
    name?: string;
    input?: unknown;
    toolCallId?: string;
    toolName?: string;
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
  onGenerate?: (callCount: number, options: FakeModelCallOptions) => Promise<void> | void;
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
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  };
  warnings: unknown[];
  rawCall: { rawPrompt: null; rawSettings: Record<string, unknown> };
}

export interface FakeLanguageModel {
  readonly modelId: string;
  readonly provider: string;
  readonly specificationVersion: 'v2';
  readonly supportedUrls: Record<string, RegExp[]>;
  readonly callCount: number;
  doGenerate(options: FakeModelCallOptions): Promise<FakeModelGenerateResult>;
}

/**
 * 创建用于测试的 LanguageModelV2 (AI SDK v5+ 兼容) 虚拟模型夹具
 */
export function createFakeModel(options: FakeModelOptions = {}): FakeLanguageModel {
  const modelId = options.modelId ?? 'fake-model-001';
  const provider = options.provider ?? 'fake-provider';
  const responses = [...(options.responses ?? [])];

  let callCount = 0;

  return {
    specificationVersion: 'v2',
    supportedUrls: {},
    modelId,
    provider,
    get callCount(): number {
      return callCount;
    },
    doGenerate: async (callOptions: FakeModelCallOptions): Promise<FakeModelGenerateResult> => {
      callCount++;
      if (options.onGenerate) {
        await options.onGenerate(callCount, callOptions);
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
          const toolName = tc.name ?? tc.toolName ?? 'unknown_tool';
          const toolCallId = tc.id ?? tc.toolCallId ?? `call-${callCount}-${toolName}`;
          const inputData =
            tc.input ??
            (tc as { arguments?: unknown }).arguments ??
            (tc as { args?: unknown }).args ??
            {};
          content.push({
            type: 'tool-call',
            toolCallId,
            toolName,
            input: typeof inputData === 'string' ? inputData : JSON.stringify(inputData),
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

      const finishReason =
        response.finishReason ??
        (response.toolCalls && response.toolCalls.length > 0 ? 'tool-calls' : 'stop');

      return {
        content,
        finishReason,
        usage: {
          inputTokens,
          outputTokens,
          totalTokens,
        },
        warnings: [],
        rawCall: { rawPrompt: null, rawSettings: {} },
      };
    },
  };
}
