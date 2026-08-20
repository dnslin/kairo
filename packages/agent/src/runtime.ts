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
import { ToolRegistry } from './tools/registry.js';
import { ReadWriteSplitExecutor } from './tools/executor.js';
import type { ApprovalManager } from './hitl/manager.js';
import type { LeaderApprovalRouter } from './hitl/router.js';
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
  private toolRegistry?: ToolRegistry;
  private toolExecutor?: ReadWriteSplitExecutor;
  private approvalManager?: ApprovalManager;
  private leaderRouter?: LeaderApprovalRouter;
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
    this.toolRegistry = config?.toolRegistry;
    this.approvalManager = config?.approvalManager;
    this.leaderRouter = config?.leaderRouter;

    if (config?.toolExecutor) {
      this.toolExecutor = config.toolExecutor;
    } else if (config?.toolRegistry || config?.approvalManager) {
      this.toolExecutor = new ReadWriteSplitExecutor(
        config.toolRegistry ?? new ToolRegistry(),
        {
          approvalManager: config.approvalManager,
          leaderRouter: config.leaderRouter,
        }
      );
    }
  }
  /**
   * 初始化运行时环境 (例如异步加载 soul.md 人设)
   */
  public async init(): Promise<void> {
    await this.promptCompiler.init();
    await this.approvalManager?.init();
  }

  /**
   * 关闭运行时与相关资源 (如文件监听器)
   */
  public async close(): Promise<void> {
    await this.promptCompiler.close();
    await this.approvalManager?.close();
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
   * 获取工具注册中心实例
   */
  public getToolRegistry(): ToolRegistry | undefined {
    return this.toolRegistry;
  }

  /**
   * 获取工具调度执行器实例
   */
  public getToolExecutor(): ReadWriteSplitExecutor | undefined {
    return this.toolExecutor;
  }

  /**
   * 获取审批状态机管理器实例
   */
  public getApprovalManager(): ApprovalManager | undefined {
    return this.approvalManager;
  }

  /**
   * 获取主管路由解析器实例
   */
  public getLeaderRouter(): LeaderApprovalRouter | undefined {
    return this.leaderRouter;
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
      return this.createAbortResult();
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

    // 4. 工具调度与高危审批拦截执行 (若传入了待执行工具调用)
    if (options?.toolCalls && options.toolCalls.length > 0 && this.toolExecutor) {
      const batchRes = await this.toolExecutor.executeBatch(options.toolCalls, {
        threadId,
        senderId: message.senderId,
        signal: options?.signal,
        approvedTaskId: options?.approvedTaskId,
      });

      for (const r of batchRes.results) {
        const originalReq = options.toolCalls.find(c => c.callId === r.callId);
        const contentStr =
          typeof r.output === 'string'
            ? r.output
            : JSON.stringify(r.output ?? (r.error ? { error: r.error } : {}));

        // 向对话历史追加 role: 'tool' 消息，回传给 LLM ReAct 循环
        messages.push({
          role: 'tool',
          name: r.toolName,
          toolCallId: r.callId,
          content: contentStr,
        });

        toolCalls.push({
          toolCallId: r.callId,
          toolName: r.toolName,
          arguments: originalReq?.args ?? {},
          result: r.output,
          error: r.error,
          status: r.suspended ? 'suspended' : r.success ? 'success' : 'error',
          approvalTaskId: r.approvalTaskId,
          durationMs: r.durationMs,
        });
      }

      if (batchRes.suspendedCount > 0) {
        const suspendedTask = batchRes.results.find(r => r.suspended);
        let taskMsg = '该操作涉及敏感权限，已为您提交审批，等待主管决议中...';
        if (
          suspendedTask?.output &&
          typeof suspendedTask.output === 'object' &&
          'message' in suspendedTask.output &&
          typeof suspendedTask.output.message === 'string'
        ) {
          taskMsg = suspendedTask.output.message;
        }
        return {
          content: taskMsg,
          toolCalls,
          finishReason: 'tool_calls',
          aborted: false,
        };
      }
    }

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
            return this.createAbortResult(
              cleaner.getAccumulatedCleaned(),
              cleaner.getAccumulatedThinking(),
              toolCalls,
              usage
            );
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
          return this.createAbortResult(
            cleaner.getAccumulatedCleaned(),
            cleaner.getAccumulatedThinking(),
            toolCalls,
            usage
          );
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
          return this.createAbortResult('', '', [], usage);
        }
        throw new LLMExecutionError(
          `LLM 阻塞调用异常: ${err instanceof Error ? err.message : String(err)}`,
          err instanceof Error ? err : undefined
        );
      }
    }

    // 若流结束后 signal 处于 aborted 状态，立即返回 abort 结果
    if (options?.signal?.aborted) {
      return this.createAbortResult(
        rawContent,
        thinkingContent,
        toolCalls,
        usage
      );
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

  /**
   * 统一构建中断/取消状态的返回实体
   */
  private createAbortResult(
    rawContent = '',
    thinkingContent = '',
    toolCalls: ToolExecutionRecord[] = [],
    usage?: TokenUsage
  ): AgentReplyResult {
    const filtered = rawContent
      ? this.sensitiveFilter.filterOutbound(rawContent).filteredText
      : '';

    return {
      content: filtered,
      thinkingContent: thinkingContent || undefined,
      toolCalls,
      usage,
      finishReason: 'abort',
      aborted: true,
    };
  }
}
