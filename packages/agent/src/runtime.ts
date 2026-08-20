import type {
  AgentExecuteOptions,
  AgentReplyResult,
  AgentRuntimeConfig,
  ConsolidatedMessage,
  LLMMessage,
  LLMProvider,
  TokenUsage,
  ToolExecutionRecord,
} from './types/index.js';
import { LayeredPromptCompiler } from './prompt/compiler.js';
import { SensitiveFilter } from './guardrails/sensitive-filter.js';
import { ThinkingTagCleaner } from './guardrails/thinking-tag-cleaner.js';
import { createChildLogger } from './utils/logger.js';
import { LLMExecutionError } from './utils/errors.js';

const log = createChildLogger('agent-runtime');

/**
 * KKBot 核心智能认知微内核 Runtime
 * 统一调度 4 层 Prompt 编译、入站越狱防御、Token 级流式 <think> 标签清洗、
 * 50ms 级 AbortSignal 中断控制与出站敏感词合规脱敏。
 */
export class KkbotAgentRuntime {
  private promptCompiler: LayeredPromptCompiler;
  private sensitiveFilter: SensitiveFilter;
  private llmProvider?: LLMProvider;

  constructor(config?: AgentRuntimeConfig) {
    this.promptCompiler = new LayeredPromptCompiler({
      soulPath: config?.soulPath,
      defaultSoul: config?.defaultSoul,
      watchSoul: config?.watchSoul ?? true,
    });

    this.sensitiveFilter = new SensitiveFilter({
      jailbreakPatterns: config?.jailbreakPatterns,
      sensitiveKeywords: config?.sensitiveKeywords,
      sensitivePatterns: config?.sensitivePatterns,
    });

    this.llmProvider = config?.llmProvider;
  }

  /**
   * 初始化运行时环境 (例如异步加载 soul.md 人设)
   */
  public async init(): Promise<void> {
    await this.promptCompiler.init();
  }

  /**
   * 关闭运行时与相关资源 (如文件监听器)
   */
  public async close(): Promise<void> {
    await this.promptCompiler.close();
  }

  /**
   * 获取内部 Prompt 编译器实例
   */
  public getPromptCompiler(): LayeredPromptCompiler {
    return this.promptCompiler;
  }

  /**
   * 获取内部敏感词过滤器实例
   */
  public getSensitiveFilter(): SensitiveFilter {
    return this.sensitiveFilter;
  }

  /**
   * 设置或切换底层的 LLM Provider
   */
  public setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
  }

  /**
   * 统一执行入口
   * 接收防抖合并后的聚合消息，经过 4 层组装、双向护栏与 LLM 推理生成回复
   */
  public async execute(
    threadId: string,
    message: ConsolidatedMessage,
    options?: AgentExecuteOptions
  ): Promise<AgentReplyResult> {
    // 1. 预检查：若调用前已被打断，立即瞬间返回 abort 状态
    if (options?.signal?.aborted) {
      log.debug({ threadId }, '执行前已收到 Abort 信号，直接中止');
      return {
        content: '',
        toolCalls: [],
        finishReason: 'abort',
        aborted: true,
      };
    }

    // 2. 入站安全护栏：检查提示词注入与越狱
    const inboundCheck = this.sensitiveFilter.checkInbound(message.content);
    if (!inboundCheck.safe) {
      log.warn(
        { threadId, reason: inboundCheck.reason, sender: message.sender },
        '入站消息触发安全合规拦截'
      );
      return {
        content:
          '抱歉，当前输入触发了企业安全合规策略，已被系统拦截。请通过正常业务流程咨询。',
        toolCalls: [],
        finishReason: 'stop',
        aborted: false,
      };
    }

    // 3. 编译 4 层结构化 System Prompt
    let systemPrompt = options?.systemPromptOverride;
    if (!systemPrompt) {
      const promptResult = await this.promptCompiler.compile({
        userProfile: options?.userProfile,
        employeeContext: options?.employeeContext,
        retrievedFacts: options?.retrievedFacts,
      });
      systemPrompt = promptResult.fullPrompt;
    }

    if (!this.llmProvider) {
      throw new LLMExecutionError(
        '未配置有效 LLMProvider，无法执行大模型推理生成'
      );
    }

    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message.content },
    ];

    let rawContent = '';
    let thinkingContent = '';
    let usage: TokenUsage | undefined;
    let finishReason:
      | 'stop'
      | 'tool_calls'
      | 'abort'
      | 'length'
      | 'error'
      | (string & {}) = 'stop';
    const toolCalls: ToolExecutionRecord[] = [];

    // 4. 执行推理 (流式优先或非流式)
    const isStreamMode =
      (options?.stream ?? false) ||
      Boolean(options?.onChunk) ||
      Boolean(options?.onThinkingChunk);

    if (isStreamMode && typeof this.llmProvider.chatStream === 'function') {
      const cleaner = new ThinkingTagCleaner();

      try {
        const stream = this.llmProvider.chatStream(messages, {
          signal: options?.signal,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        });

        for await (const chunk of stream) {
          if (options?.signal?.aborted) {
            log.info({ threadId }, '流式生成过程中收到 AbortSignal 打断信号');
            return {
              content: this.sensitiveFilter.filterOutbound(
                cleaner.getAccumulatedCleaned()
              ).filteredText,
              thinkingContent: cleaner.getAccumulatedThinking() || undefined,
              toolCalls,
              usage,
              finishReason: 'abort',
              aborted: true,
            };
          }

          if (chunk.usage) {
            usage = chunk.usage;
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }

          const { cleanedChunk, thinkingChunk } = cleaner.feed(chunk.delta);

          if (cleanedChunk && options?.onChunk) {
            options.onChunk(cleanedChunk);
          }
          if (thinkingChunk && options?.onThinkingChunk) {
            options.onThinkingChunk(thinkingChunk);
          }
        }

        // 冲刷末尾可能未闭合的缓冲区
        const flushed = cleaner.flush();
        if (flushed.cleanedChunk && options?.onChunk) {
          options.onChunk(flushed.cleanedChunk);
        }
        if (flushed.thinkingChunk && options?.onThinkingChunk) {
          options.onThinkingChunk(flushed.thinkingChunk);
        }

        rawContent = cleaner.getAccumulatedCleaned();
        thinkingContent = cleaner.getAccumulatedThinking();
      } catch (err: unknown) {
        if (
          options?.signal?.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return {
            content: this.sensitiveFilter.filterOutbound(
              cleaner.getAccumulatedCleaned()
            ).filteredText,
            thinkingContent: cleaner.getAccumulatedThinking() || undefined,
            toolCalls,
            usage,
            finishReason: 'abort',
            aborted: true,
          };
        }
        throw new LLMExecutionError(
          `LLM 流式调用异常: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        );
      }
    } else {
      // 非流式标准调用
      try {
        const resp = await this.llmProvider.chat(messages, {
          signal: options?.signal,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        });

        const cleaned = ThinkingTagCleaner.clean(resp.content);
        rawContent = cleaned.cleanedText;
        thinkingContent = cleaned.thinkingText;
        usage = resp.usage;
        finishReason = resp.finishReason ?? 'stop';
      } catch (err: unknown) {
        if (
          options?.signal?.aborted ||
          (err instanceof Error && err.name === 'AbortError')
        ) {
          return {
            content: '',
            toolCalls: [],
            finishReason: 'abort',
            aborted: true,
          };
        }
        throw new LLMExecutionError(
          `LLM 阻塞调用异常: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        );
      }
    }

    // 若流结束后 signal 处于 aborted 状态，立即返回 abort 结果
    if (options?.signal?.aborted) {
      return {
        content: this.sensitiveFilter.filterOutbound(rawContent).filteredText,
        thinkingContent: thinkingContent || undefined,
        toolCalls,
        usage,
        finishReason: 'abort',
        aborted: true,
      };
    }

    // 5. 出站安全护栏：敏感词脱敏
    const filterResult = this.sensitiveFilter.filterOutbound(rawContent);
    const finalContent = filterResult.filteredText;

    return {
      content: finalContent,
      thinkingContent: thinkingContent || undefined,
      toolCalls,
      usage,
      finishReason,
      aborted: false,
    };
  }
}
