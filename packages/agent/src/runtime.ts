import type {
  AgentExecuteOptions,
  AgentReplyResult,
  AgentRuntimeConfig,
  ConsolidatedMessage,
  LLMMessage,
  LLMProvider,
  ModelEndpointConfig,
  TokenUsage,
  ToolExecutionRecord,
} from './types/index.js';
import { LayeredPromptCompiler } from './prompt/compiler.js';
import { SensitiveFilter } from './guardrails/sensitive-filter.js';
import { ThinkingTagCleaner } from './guardrails/thinking-tag-cleaner.js';
import { MultiModalRouter } from './multimodal/router.js';
import { IntentModelRouter } from './routing/intent-router.js';
import {
  AllModelsFailedError,
  ModelFailoverManager,
} from './routing/failover.js';
import { FallbackHandler } from './routing/fallback.js';
import { createChildLogger } from './utils/logger.js';
import { LLMExecutionError } from './utils/errors.js';

const log = createChildLogger('agent-runtime');

/**
 * KKBot 核心智能认知微内核 Runtime
 * 统一调度 4 层 Prompt 编译、多模态附件感知、OCR 降级、意图动态模型分流、
 * 模型高可用 Failover 容灾、Token 级流式 <think> 标签清洗、50ms 级 AbortSignal 中断控制与全局宕机安抚兜底。
 */
export class KkbotAgentRuntime {
  private promptCompiler: LayeredPromptCompiler;
  private sensitiveFilter: SensitiveFilter;
  private multiModalRouter: MultiModalRouter;
  private intentRouter: IntentModelRouter;
  private failoverManager: ModelFailoverManager;
  private fallbackHandler: FallbackHandler;
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

    if (config?.multiModalRouter instanceof MultiModalRouter) {
      this.multiModalRouter = config.multiModalRouter;
    } else {
      this.multiModalRouter = new MultiModalRouter(config?.multiModalRouter);
    }

    if (config?.intentRouter instanceof IntentModelRouter) {
      this.intentRouter = config.intentRouter;
    } else {
      this.intentRouter = new IntentModelRouter({
        fastModel: config?.fastModel || config?.llmProvider,
        deepModel: config?.deepModel || config?.llmProvider,
        backupModels: config?.backupModels,
        ...(typeof config?.intentRouter === 'object' ? config.intentRouter : {}),
      });
    }

    if (config?.failoverManager instanceof ModelFailoverManager) {
      this.failoverManager = config.failoverManager;
    } else {
      this.failoverManager = new ModelFailoverManager(config?.failoverManager);
    }

    if (config?.fallbackHandler instanceof FallbackHandler) {
      this.fallbackHandler = config.fallbackHandler;
    } else {
      this.fallbackHandler = new FallbackHandler(config?.fallbackHandler);
    }

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
   * 获取内部多模态感知路由器
   */
  public getMultiModalRouter(): MultiModalRouter {
    return this.multiModalRouter;
  }

  /**
   * 获取内部动态意图模型分流路由器
   */
  public getIntentRouter(): IntentModelRouter {
    return this.intentRouter;
  }

  /**
   * 获取内部 Failover 故障转移管理器
   */
  public getFailoverManager(): ModelFailoverManager {
    return this.failoverManager;
  }

  /**
   * 获取内部全局宕机兜底处理器
   */
  public getFallbackHandler(): FallbackHandler {
    return this.fallbackHandler;
  }

  /**
   * 设置或切换底层的默认 LLM Provider
   */
  public setLLMProvider(provider: LLMProvider): void {
    this.llmProvider = provider;
    if (!this.intentRouter.getFastModel()) {
      this.intentRouter.setFastModel(provider);
    }
    if (!this.intentRouter.getDeepModel()) {
      this.intentRouter.setDeepModel(provider);
    }
  }

  /**
   * 配置极速轻量模型端点 (FAST)
   */
  public setFastModel(model: ModelEndpointConfig | LLMProvider): void {
    this.intentRouter.setFastModel(model);
  }

  /**
   * 配置深度推理模型端点 (DEEP)
   */
  public setDeepModel(model: ModelEndpointConfig | LLMProvider): void {
    this.intentRouter.setDeepModel(model);
  }

  /**
   * 添加全局备用容灾模型节点 (Failover Backup)
   */
  public addBackupModel(model: ModelEndpointConfig): void {
    this.intentRouter.addBackupModel(model);
  }

  /**
   * 统一执行入口
   * 接收防抖合并后的聚合消息，经过多模态感知预处理、意图动态模型分流、
   * 4 层 System Prompt 组装、双向护栏、高可用 Failover 推理与全局宕机兜底生成回复
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

    // 2. 入站安全护栏：检查原始提示词注入与越狱
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

    // 3. 动态意图路由分流与候选容灾链生成
    let candidateChain: ModelEndpointConfig[];

    if (options?.intentLevelOverride) {
      const fastModel = this.intentRouter.getFastModel();
      const deepModel = this.intentRouter.getDeepModel();
      const primary =
        options.intentLevelOverride === 'FAST'
          ? fastModel || deepModel
          : deepModel || fastModel;

      if (primary) {
        candidateChain = [primary, ...this.intentRouter.getBackupModels()];
      } else if (this.llmProvider) {
        candidateChain = [
          { id: 'default', name: 'Default-LLM', provider: this.llmProvider },
        ];
      } else {
        throw new LLMExecutionError(
          '未配置有效 LLMProvider，无法执行大模型推理生成'
        );
      }
    } else {
      try {
        const routeResult = await this.intentRouter.route(message);
        candidateChain = routeResult.candidateChain;
      } catch (err: unknown) {
        if (this.llmProvider) {
          log.debug(
            { err: err instanceof Error ? err.message : String(err) },
            '意图路由器未配置独立端点，回退使用默认 LLMProvider'
          );
          candidateChain = [
            { id: 'default', name: 'Default-LLM', provider: this.llmProvider },
          ];
        } else {
          throw new LLMExecutionError(
            `未配置有效 LLMProvider 或意图路由失败: ${err instanceof Error ? err.message : String(err)}`,
            err instanceof Error ? err : undefined
          );
        }
      }
    }
    // 4. 编译 4 层结构化 System Prompt
    let systemPrompt = options?.systemPromptOverride;
    if (!systemPrompt) {
      const promptResult = await this.promptCompiler.compile({
        userProfile: options?.userProfile,
        employeeContext: options?.employeeContext,
        retrievedFacts: options?.retrievedFacts,
      });
      systemPrompt = promptResult.fullPrompt;
    }

    // 5. 模型消息构建工厂 (按候选模型端点能力动态适配多模态或 OCR 文本增强，并二次执行安全护栏防御)
    const buildMessagesForModel = async (
      model: ModelEndpointConfig
    ): Promise<LLMMessage[]> => {
      const multiModalResult = await this.multiModalRouter.process(message, {
        modelSupportsVision: Boolean(model.supportsVision),
        ocrEngine: options?.ocrEngine,
      });

      // 核心安全防护：对 OCR 提取内容及文件卡片元数据再次执行入站越狱/注入检测
      const secondCheck = this.sensitiveFilter.checkInbound(
        multiModalResult.enhancedContent
      );
      if (!secondCheck.safe) {
        log.warn(
          { threadId, reason: secondCheck.reason },
          '多模态提取文本或文件卡片注入触发了入站安全合规拦截'
        );
        const secErr = new Error(
          'INBOUND_SECURITY_BLOCKED: ' + (secondCheck.reason || '合规拦截')
        );
        secErr.name = 'InboundSecurityBlockedError';
        throw secErr;
      }

      const userContent =
        model.supportsVision &&
        multiModalResult.multiModalParts &&
        multiModalResult.multiModalParts.length > 0
          ? multiModalResult.multiModalParts
          : multiModalResult.enhancedContent;

      return [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ];
    };

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

    // 6. 执行推理 (流式优先或阻塞模式，接入 Failover 与全局兜底)
    const isStreamMode =
      (options?.stream ?? false) ||
      Boolean(options?.onChunk) ||
      Boolean(options?.onThinkingChunk);

    if (isStreamMode) {
      const cleaner = new ThinkingTagCleaner();

      try {
        const stream = this.failoverManager.executeChatStream(
          candidateChain,
          buildMessagesForModel,
          {
            signal: options?.signal,
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
          }
        );

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

        return await this.handleExecutionError(threadId, message, err);
      }
    } else {
      // 阻塞标准调用
      try {
        const resp = await this.failoverManager.executeChat(
          candidateChain,
          buildMessagesForModel,
          {
            signal: options?.signal,
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
          }
        );

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

        return await this.handleExecutionError(threadId, message, err);
      }
    }

    // 若生成结束后 signal 处于 aborted 状态，立即返回 abort 结果
    if (options?.signal?.aborted) {
      return this.createAbortResult(
        rawContent,
        thinkingContent,
        toolCalls,
        usage
      );
    }

    // 7. 出站安全护栏：敏感词脱敏
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
    const filterResult = this.sensitiveFilter.filterOutbound(rawContent);
    return {
      content: filterResult.filteredText,
      thinkingContent: thinkingContent || undefined,
      toolCalls,
      usage,
      finishReason: 'abort',
      aborted: true,
    };
  }
  /**
   * 统一异常分支处置 (区分合规拦截、全网宕机安抚与底层执行异常)
   */
  private async handleExecutionError(
    threadId: string,
    message: ConsolidatedMessage,
    err: unknown
  ): Promise<AgentReplyResult> {
    if (
      err instanceof Error &&
      (err.name === 'InboundSecurityBlockedError' ||
        err.message.includes('INBOUND_SECURITY_BLOCKED'))
    ) {
      return {
        content:
          '抱歉，多模态附件内容触发了企业安全合规策略，已被系统拦截。请通过正常业务流程咨询。',
        toolCalls: [],
        finishReason: 'stop',
        aborted: false,
      };
    }

    if (err instanceof AllModelsFailedError) {
      log.error(
        { threadId, err: err.message },
        '所有可用模型调用均已失败，触发全局宕机安抚兜底'
      );
      return await this.fallbackHandler.handle(threadId, message, err);
    }

    throw new LLMExecutionError(
      `大模型推理调用异常: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err : undefined
    );
  }
}
