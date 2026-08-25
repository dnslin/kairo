import { Agent, type ToolsInput } from '@mastra/core/agent';
import {
  RequestContext,
  MASTRA_THREAD_ID_KEY,
  MASTRA_RESOURCE_ID_KEY,
} from '@mastra/core/request-context';
import type {
  InputProcessorOrWorkflow,
  OutputProcessorOrWorkflow,
  ErrorProcessorOrWorkflow,
} from '@mastra/core/processors';
import type { FullOutput } from '@mastra/core/stream';
import {
  resolveModelTier,
  type ModelTier,
  type NormalizedModelTierInput,
} from './routing/tier-policy.js';
import type { MastraModelFactory, KKBotRequestContextValues } from './models/factory.js';

export type AgentGenerateRawOutput = FullOutput<unknown>;

export interface KKBotAgentOptions {
  id?: string;
  name?: string;
  instructions?: string;
  modelFactory: MastraModelFactory;
  tools?: ToolsInput;
  /** 默认单轮推理最大 Step 数，默认 5 */
  maxSteps?: number;
  /** 构造期静态绑定的输入处理器管道（按固定数组顺序执行） */
  inputProcessors?: InputProcessorOrWorkflow[];
  /** 构造期静态绑定的输出处理器管道（按固定数组顺序执行） */
  outputProcessors?: OutputProcessorOrWorkflow[];
  /** 构造期静态绑定的错误处理器管道（按固定数组顺序执行） */
  errorProcessors?: ErrorProcessorOrWorkflow[];
}

export interface ExecuteAgentOptions {
  input: string | NormalizedModelTierInput;
  /** 规则版本，默认 'v1.0' */
  rulesVersion?: string;
  sessionId?: string;
  senderId?: string;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  requestContext?: RequestContext<KKBotRequestContextValues>;
  activeTools?: string[];
}

export interface AgentTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  /** 总 Token 数（权威返回值，禁止本地猜测填补） */
  totalTokens?: number;
  raw?: Record<string, unknown>;
}

export interface KKBotAgentRunResult {
  text: string;
  finishReason?: string;
  tier: ModelTier;
  usage: AgentTokenUsage;
  rawOutput: AgentGenerateRawOutput;
}

/**
 * KKBotAgent: Mastra-native Agent 核心执行入口
 *
 * 核心契约：
 * 1. 生产执行者必须是 Mastra Agent 实例 (this.mastraAgent.generate)。
 * 2. 由 ModelTierPolicy 计算确定性 ModelTier 并注入 RequestContext。
 * 3. 不调用旧 KkbotAgentRuntime、自定义 Tool Executor 或自定义模型循环。
 * 4. retry、fallback、Tool Calling Loop、AbortSignal 和 maxSteps 均由 Mastra 原生持有并执行。
 * 5. Token Usage 直接从 Mastra 权威结果读取，不使用旧 Runtime 估算。
 */
export class KKBotAgent {
  readonly mastraAgent: Agent;
  readonly modelFactory: MastraModelFactory;

  constructor(options: KKBotAgentOptions) {
    this.modelFactory = options.modelFactory;

    this.mastraAgent = new Agent({
      id: options.id ?? 'kkbot-mastra-agent',
      name: options.name ?? 'KKBot Agent',
      instructions: options.instructions ?? '你是企业智能助手 KKBot。',
      model: options.modelFactory.createDynamicModelResolver(),
      tools: options.tools,
      inputProcessors: options.inputProcessors,
      outputProcessors: options.outputProcessors,
      errorProcessors: options.errorProcessors,
      defaultOptions: {
        maxSteps: options.maxSteps ?? 5,
      },
    });
  }

  async execute(options: ExecuteAgentOptions): Promise<KKBotAgentRunResult> {
    const normalizedInput: NormalizedModelTierInput =
      typeof options.input === 'string' ? { text: options.input } : options.input;

    const tier = resolveModelTier(normalizedInput, options.rulesVersion ?? 'v1.0');

    const reqCtx = new RequestContext<KKBotRequestContextValues>();
    if (options.requestContext) {
      for (const [key, value] of options.requestContext.entries()) {
        reqCtx.setRaw(key, value);
      }
    }
    reqCtx.set('tier', tier);

    if (options.sessionId) {
      reqCtx.setRaw(MASTRA_THREAD_ID_KEY, options.sessionId);
    }
    if (options.senderId) {
      reqCtx.setRaw(MASTRA_RESOURCE_ID_KEY, options.senderId);
    }
    const rawOutput = await this.mastraAgent.generate(normalizedInput.text, {
      requestContext: reqCtx,
      abortSignal: options.abortSignal,
      maxSteps: options.maxSteps,
      activeTools: options.activeTools,
      memory: options.sessionId
        ? {
            thread: options.sessionId,
            resource: options.senderId ?? 'default-employee',
            options: {
              readOnly: true,
            },
          }
        : undefined,
    });

    const usageSource = rawOutput.totalUsage ?? rawOutput.usage;
    const rawUsage =
      usageSource?.raw && typeof usageSource.raw === 'object'
        ? (usageSource.raw as Record<string, unknown>)
        : undefined;

    const usage: AgentTokenUsage = {
      inputTokens: usageSource?.inputTokens,
      outputTokens: usageSource?.outputTokens,
      totalTokens: usageSource?.totalTokens,
      raw: rawUsage,
    };

    return {
      text: rawOutput.text ?? '',
      finishReason: rawOutput.finishReason,
      tier,
      usage,
      rawOutput,
    };
  }
}
