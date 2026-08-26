import { Agent, type ToolsInput } from '@mastra/core/agent';
import type { Memory } from '@mastra/memory';
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
  memory?: Memory;
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
      memory: options.memory,
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

/**
 * 确定性派生 user message ID
 * 规则：基于 (sessionId, nativeMessageId) 生成稳定唯一 ID
 */
export function deriveUserMessageId(sessionId: string, nativeMessageId: string): string {
  return `msg_user_${sessionId}_${nativeMessageId}`;
}

/**
 * 确定性派生 assistant message ID
 * 规则：基于 deliveryId 生成稳定唯一 ID
 */
export function deriveAssistantMessageId(deliveryId: string): string {
  return `msg_asst_${deliveryId}`;
}

/**
 * 确保 Mastra Thread 存在并归属于指定 resourceId
 */
export async function ensureMastraThread(
  memory: Memory,
  threadId: string,
  resourceId: string
): Promise<void> {
  const existing = await memory.getThreadById({ threadId });
  if (!existing) {
    await memory.createThread({ threadId, resourceId });
  }
}

export interface MastraTextMessageV2 {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: {
    format: 2;
    parts: Array<{ type: 'text'; text: string }>;
    content: string;
  };
  threadId: string;
  resourceId: string;
  createdAt: Date;
}

/**
 * 构造符合 Mastra V2 规范的文本消息实体 (MastraDBMessage)
 */
export function createMastraTextMessage(options: {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  threadId: string;
  resourceId: string;
  createdAt?: Date;
}): MastraTextMessageV2 {
  return {
    id: options.id,
    role: options.role,
    content: {
      format: 2,
      parts: [{ type: 'text', text: options.content }],
      content: options.content,
    },
    threadId: options.threadId,
    resourceId: options.resourceId,
    createdAt: options.createdAt ?? new Date(),
  };
}

/**
 * 从 Mastra Thread Memory 中安全删除指定 Message ID
 * 删除完成后自动等待 memory.settled() 排空向量清理与后台任务
 */
export async function removeMastraMessage(
  memory: Memory,
  messageId: string
): Promise<void> {
  try {
    await (memory as unknown as { deleteMessages: (ids: string[] | { messageIds: string[] }) => Promise<void> }).deleteMessages([messageId]);
  } catch (err) {
    try {
      await (memory as unknown as { deleteMessages: (ids: string[] | { messageIds: string[] }) => Promise<void> }).deleteMessages({ messageIds: [messageId] });
    } catch {
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  // 等待内存后台任务排空
  if (typeof memory.settled === 'function') {
    await memory.settled();
  }
}

/**
 * 重置指定 Thread / Resource 的 Observational Memory 范围 (Scope Reset)
 * 1. 直接调用 storage memory domain 的 clearObservationalMemory 清除观察
 * 2. 不删除 Thread 显式消息（保留会话中其他合法 user/operator/sent assistant，避免丢消息）
 * 3. 等待 memory.settled() 排空；任何清理异常直接失败 (Fail-Closed)
 */
export async function resetObservationalMemoryScope(options: {
  memory: Memory;
  threadId: string;
  resourceId?: string;
  storage?: unknown;
}): Promise<void> {
  const { memory, threadId, resourceId, storage: explicitStorage } = options;

  const storage =
    explicitStorage ??
    (memory as unknown as { storage?: { getStore?: (domain: string) => Promise<unknown> } }).storage;

  if (!storage || typeof (storage as { getStore?: (domain: string) => Promise<unknown> }).getStore !== 'function') {
    throw new Error('执行 Observational Memory Scope Reset 必须提供有效的 Storage 实例');
  }

  try {
    const memDomain = (await (storage as { getStore: (domain: string) => Promise<unknown> }).getStore('memory')) as {
      clearObservationalMemory?: (threadId: string | null, resourceId?: string | null) => Promise<void>;
    } | null;

    if (!memDomain || typeof memDomain.clearObservationalMemory !== 'function') {
      throw new Error('Storage Memory Domain 未提供 clearObservationalMemory 能力');
    }

    await memDomain.clearObservationalMemory(threadId, resourceId ?? null);
    if (resourceId) {
      await memDomain.clearObservationalMemory(null, resourceId);
    }
  } catch (omErr) {
    // Fail-Closed: OM scope 清理失败直接抛出异常
    throw new Error(`Observational Memory scope 清理失败: ${omErr instanceof Error ? omErr.message : String(omErr)}`);
  }

  // 等待内存后台任务排空
  if (typeof memory.settled === 'function') {
    await memory.settled();
  }
}
