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
  /** Agent 唯一标识 */
  id?: string;
  /** Agent 名称 */
  name?: string;
  /** Agent 指令 Prompt */
  instructions?: string;
  /** 模型工厂实例 (持有 FAST/DEEP/VISION 动态模型配置与 fallback 链) */
  modelFactory: MastraModelFactory;
  /** 注册到 Agent 的 Tool 集合 */
  tools?: ToolsInput;
  /** 默认单轮推理最大 Step 数 (默认 5) */
  maxSteps?: number;
  /** 静态输入处理器列表 (按固定数组顺序执行) */
  inputProcessors?: InputProcessorOrWorkflow[];
  /** 静态输出处理器列表 (按固定数组顺序执行) */
  outputProcessors?: OutputProcessorOrWorkflow[];
  /** 静态错误处理器列表 (按固定数组顺序执行) */
  errorProcessors?: ErrorProcessorOrWorkflow[];
  /** 处理器触发重试的最大次数上限 */
  maxProcessorRetries?: number;
}

export interface ExecuteAgentOptions {
  /** 用户输入，支持纯文本或附带事实的规范化输入 */
  input: string | NormalizedModelTierInput;
  /** 模型等级规则版本 (默认 'v1.0') */
  rulesVersion?: string;
  /** 会话标识 (KK sessionId -> Mastra threadId) */
  sessionId?: string;
  /** 发送者标识 (KK senderId/employeeId -> Mastra resourceId) */
  senderId?: string;
  /** 外部中止信号 (控制模型与工具调用) */
  abortSignal?: AbortSignal;
  /** 本次执行的最大步数限制 (覆盖默认 maxSteps) */
  maxSteps?: number;
  /** 外部传入或共享的 RequestContext */
  requestContext?: RequestContext<KKBotRequestContextValues>;
  /** 本次执行启用的工具名白名单 */
  activeTools?: string[];
}

export interface AgentTokenUsage {
  /** 输入 Prompt Token 消耗 (权威值，未返回时为 undefined) */
  inputTokens?: number;
  /** 输出 Completion Token 消耗 (权威值，未返回时为 undefined) */
  outputTokens?: number;
  /** 总 Token 消耗 (权威值，未返回时为 undefined，禁止猜测填补) */
  totalTokens?: number;
  /** 原始 Provider Usage 事实 (若有) */
  raw?: Record<string, unknown>;
}

export interface KKBotAgentRunResult {
  /** 模型最终生成的文本回复 */
  text: string;
  /** 终态原因 ('stop' | 'tool-calls' | 'length' | 'error' | 等，未返回时为 undefined) */
  finishReason?: string;
  tier: ModelTier;
  /** Mastra 权威产出的 Token 使用量 (非估算) */
  usage: AgentTokenUsage;
  /** Mastra 原生返回的完整输出对象 */
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
      maxProcessorRetries: options.maxProcessorRetries,
      defaultOptions: {
        maxSteps: options.maxSteps ?? 5,
      },
    });
  }

  /**
   * 执行单轮 Agent 推理生成
   */
  async execute(options: ExecuteAgentOptions): Promise<KKBotAgentRunResult> {
    const normalizedInput: NormalizedModelTierInput =
      typeof options.input === 'string' ? { text: options.input } : options.input;

    const tier = resolveModelTier(normalizedInput, options.rulesVersion ?? 'v1.0');

    const reqCtx = options.requestContext ?? new RequestContext<KKBotRequestContextValues>();
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
