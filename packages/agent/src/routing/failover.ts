import type {
  LLMMessage,
  LLMStreamChunk,
  LLMToolDefinition,
  TokenUsage,
} from '../types/index.js';
import type {
  FailoverEvent,
  FailoverOptions,
  ModelEndpointConfig,
} from './types.js';
import { AgentError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('model-failover-manager');

/**
 * 单一模型调用超时异常
 */
export class ModelTimeoutError extends AgentError {
  public readonly modelName: string;
  public readonly timeoutMs: number;

  constructor(modelName: string, timeoutMs: number, originalCause?: Error) {
    super(
      `模型 [${modelName}] 调用超时 (${timeoutMs}ms)`,
      'MODEL_TIMEOUT_ERROR',
      originalCause
    );
    this.name = 'ModelTimeoutError';
    this.modelName = modelName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 所有可用模型均故障失效异常
 */
export class AllModelsFailedError extends AgentError {
  public readonly attemptedModels: string[];
  public readonly underlyingErrors: Error[];

  constructor(attemptedModels: string[], underlyingErrors: Error[]) {
    const errorDetails = attemptedModels
      .map((m, idx) => `[${m}]: ${underlyingErrors[idx]?.message || '未知异常'}`)
      .join('; ');
    const lastError = underlyingErrors[underlyingErrors.length - 1];
    super(
      `所有候选模型调用均已失败 (尝试模型: ${attemptedModels.join(' -> ')}): ${errorDetails}`,
      'ALL_MODELS_FAILED_ERROR',
      lastError
    );
    this.name = 'AllModelsFailedError';
    this.attemptedModels = attemptedModels;
    this.underlyingErrors = underlyingErrors;
  }
}

/**
 * 模型高可用故障转移与熔断降级管理器 (Failover Manager)
 * 监控模型调用耗时 (默认超时 15s) 与 503/429/500/网络异常，毫秒级无感切换至备用模型
 */
export class ModelFailoverManager {
  private defaultTimeoutMs: number;
  private defaultRetryStatusCodes: number[];
  private maxRetries?: number;
  private onFailoverCallback?: (event: FailoverEvent) => void;

  constructor(options?: FailoverOptions) {
    this.defaultTimeoutMs = options?.timeoutMs ?? 15000;
    this.defaultRetryStatusCodes = options?.retryStatusCodes ?? [
      503, 429, 500, 502, 504,
    ];
    if (options?.maxRetries !== undefined) {
      if (
        typeof options.maxRetries !== 'number' ||
        !Number.isInteger(options.maxRetries) ||
        options.maxRetries < 0
      ) {
        throw new RangeError(
          `maxRetries 必须为大于等于 0 的非负整数，当前输入: ${String(options.maxRetries)}`
        );
      }
      this.maxRetries = options.maxRetries;
    }
    this.onFailoverCallback = options?.onFailover;
  }

  /**
   * 计算有效的最大尝试调用次数
   */
  private resolveMaxAttempts(chainLength: number): number {
    if (chainLength <= 0) return 0;
    if (typeof this.maxRetries === 'number') {
      return Math.min(chainLength, this.maxRetries + 1);
    }
    return chainLength;
  }

  /**
   * 判断错误是否可重试/可切换备用节点
   * 仅针对服务端过载(503/500/502/504)、速率限制/配额超限(429)、调用超时及网络断连等可恢复异常执行 Failover；
   * 对于客户端错误 (400 参数错误、401 鉴权失效、403 权限拒绝、404 不存在) 及主动打断严禁切换备用节点。
   */
  public isRetryableError(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof ModelTimeoutError) return true;

    if (err instanceof Error) {
      if (
        err.name === 'AbortError' ||
        err.name === 'InboundSecurityBlockedError' ||
        err.message.includes('aborted') ||
        err.message.startsWith('INBOUND_SECURITY_BLOCKED')
      ) {
        return false;
      }

      // 检查 status 或 statusCode 属性
      const errorObj = err as unknown as Record<string, unknown>;
      const status = errorObj['status'] || errorObj['statusCode'];
      if (typeof status === 'number') {
        if ([400, 401, 403, 404, 422].includes(status)) {
          return false;
        }
        if (this.defaultRetryStatusCodes.includes(status)) {
          return true;
        }
      }

      const msg = err.message.toLowerCase();

      // 明确不可重试的客户端/鉴权/参数错误
      if (
        msg.includes('400') ||
        msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('404') ||
        msg.includes('422') ||
        msg.includes('unauthorized') ||
        msg.includes('forbidden') ||
        msg.includes('bad request') ||
        msg.includes('invalid api key') ||
        msg.includes('invalid_api_key') ||
        msg.includes('invalid_request_error') ||
        msg.includes('authentication_error') ||
        msg.includes('permission_denied')
      ) {
        return false;
      }

      // 匹配明确可重试的服务端状态码与网络/超时特征
      if (
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('504') ||
        msg.includes('service unavailable') ||
        msg.includes('internal server error') ||
        msg.includes('bad gateway') ||
        msg.includes('gateway timeout') ||
        msg.includes('rate limit') ||
        msg.includes('rate_limit') ||
        msg.includes('too many requests') ||
        msg.includes('quota') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('enotfound') ||
        msg.includes('network') ||
        msg.includes('fetch failed') ||
        msg.includes('socket hang up')
      ) {
        return true;
      }

      return false;
    }

    return false;
  }

  /**
   * 统一触发 Failover 报警日志与审计回调
   */
  private notifyFailover(
    currentModel: ModelEndpointConfig,
    nextModel: ModelEndpointConfig | undefined,
    error: Error,
    attempt: number,
    mode: '阻塞' | '流式'
  ): void {
    if (nextModel) {
      log.warn(
        {
          failedModel: currentModel.name,
          nextModel: nextModel.name,
          attempt,
          err: error.message,
          mode,
        },
        `${mode}模型调用异常，触发 Failover 故障转移`
      );
    } else {
      log.warn(
        {
          failedModel: currentModel.name,
          nextModel: '无',
          attempt,
          err: error.message,
          mode,
        },
        `${mode}模型调用异常且已无可用备用节点 (候选模型耗尽)`
      );
    }

    if (this.onFailoverCallback) {
      try {
        this.onFailoverCallback({
          fromModel: currentModel.name,
          toModel: nextModel?.name,
          error,
          attempt,
          timestamp: Date.now(),
        });
      } catch (callbackErr) {
        log.warn({ callbackErr }, 'Failover 回调函数执行异常');
      }
    }
  }

  /**
   * 带超时保护的阻塞对话生成执行
   */
  public async executeChatWithTimeout(
    model: ModelEndpointConfig,
    messages: LLMMessage[],
    options?: {
      signal?: AbortSignal;
      temperature?: number;
      maxTokens?: number;
      tools?: LLMToolDefinition[];
    }
  ): Promise<{
    content: string;
    usage?: TokenUsage;
    finishReason?: string;
    toolCalls?: Array<{
      id?: string;
      callId?: string;
      name: string;
      arguments?: Record<string, unknown>;
      args?: Record<string, unknown>;
    }>;
  }> {
    const timeoutMs = model.timeoutMs ?? this.defaultTimeoutMs;
    const timeoutController = new AbortController();

    // 监听外部主动打断信号
    const abortListener = (): void => {
      timeoutController.abort();
    };

    if (options?.signal) {
      if (options.signal.aborted) {
        throw new Error('执行已被外部 Signal 中断');
      }
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    let isTimedOut = false;
    const timer = setTimeout(() => {
      isTimedOut = true;
      timeoutController.abort();
    }, timeoutMs);

    try {
      const response = await model.provider.chat(messages, {
        signal: timeoutController.signal,
        temperature: options?.temperature,
        maxTokens: options?.maxTokens,
        tools: options?.tools,
      });
      return response;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      if (isTimedOut) {
        throw new ModelTimeoutError(model.name, timeoutMs, cause);
      }
      if (options?.signal?.aborted) {
        const abortErr = new Error('外部调用主动中断');
        abortErr.name = 'AbortError';
        throw abortErr;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      if (options?.signal) {
        options.signal.removeEventListener('abort', abortListener);
      }
    }
  }

  /**
   * 带超时保护与多模型 Failover 的阻塞调用
   */
  public async executeChat(
    candidateChain: ModelEndpointConfig[],
    messages:
      | LLMMessage[]
      | ((model: ModelEndpointConfig) => Promise<LLMMessage[]> | LLMMessage[]),
    options?: {
      signal?: AbortSignal;
      temperature?: number;
      maxTokens?: number;
      tools?: LLMToolDefinition[];
    }
  ): Promise<{
    content: string;
    usage?: TokenUsage;
    finishReason?: string;
    toolCalls?: Array<{
      id?: string;
      callId?: string;
      name: string;
      arguments?: Record<string, unknown>;
      args?: Record<string, unknown>;
    }>;
    executedModel: ModelEndpointConfig;
  }> {
    if (candidateChain.length === 0) {
      throw new Error('Failover 候选模型链为空');
    }

    const maxAttempts = this.resolveMaxAttempts(candidateChain.length);

    const attemptedModels: string[] = [];
    const underlyingErrors: Error[] = [];

    for (let i = 0; i < maxAttempts; i++) {
      const currentModel = candidateChain[i]!;
      attemptedModels.push(currentModel.name);

      // 若外部已中止，直接退出
      if (options?.signal?.aborted) {
        const abortErr = new Error('外部调用主动中断');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      try {
        log.debug(
          { model: currentModel.name, attempt: i + 1 },
          '正在尝试通过模型生成回复'
        );
        const currentMessages =
          typeof messages === 'function' ? await messages(currentModel) : messages;
        const result = await this.executeChatWithTimeout(
          currentModel,
          currentMessages,
          options
        );
        return {
          ...result,
          executedModel: currentModel,
        };
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        underlyingErrors.push(error);

        // 如果是外部主动打断、入站安全拦截或不可重试错误 (如 400/401)，严禁 Failover 重试，直接向外抛出
        if (
          options?.signal?.aborted ||
          error.name === 'AbortError' ||
          error.name === 'InboundSecurityBlockedError' ||
          error.message.startsWith('INBOUND_SECURITY_BLOCKED') ||
          !this.isRetryableError(error)
        ) {
          throw error;
        }

        const nextModel = i + 1 < maxAttempts ? candidateChain[i + 1] : undefined;
        this.notifyFailover(currentModel, nextModel, error, i + 1, '阻塞');
      }
    }

    // 所有候选模型均已失败
    throw new AllModelsFailedError(attemptedModels, underlyingErrors);
  }

  /**
   * 带 Failover 容灾机制的流式生成调用
   */
  public async *executeChatStream(
    candidateChain: ModelEndpointConfig[],
    messages:
      | LLMMessage[]
      | ((model: ModelEndpointConfig) => Promise<LLMMessage[]> | LLMMessage[]),
    options?: {
      signal?: AbortSignal;
      temperature?: number;
      maxTokens?: number;
      tools?: LLMToolDefinition[];
    }
  ): AsyncIterable<LLMStreamChunk & { executedModel?: ModelEndpointConfig }> {
    if (candidateChain.length === 0) {
      throw new Error('Failover 候选模型链为空');
    }

    const maxAttempts = this.resolveMaxAttempts(candidateChain.length);

    const attemptedModels: string[] = [];
    const underlyingErrors: Error[] = [];

    for (let i = 0; i < maxAttempts; i++) {
      const currentModel = candidateChain[i]!;
      attemptedModels.push(currentModel.name);

      if (options?.signal?.aborted) {
        const abortErr = new Error('外部调用主动中断');
        abortErr.name = 'AbortError';
        throw abortErr;
      }

      const timeoutMs = currentModel.timeoutMs ?? this.defaultTimeoutMs;
      const timeoutController = new AbortController();

      const abortListener = (): void => {
        timeoutController.abort();
      };
      if (options?.signal) {
        options.signal.addEventListener('abort', abortListener, { once: true });
      }

      let isTimedOut = false;
      const timer = setTimeout(() => {
        isTimedOut = true;
        timeoutController.abort();
      }, timeoutMs);

      let hasYieldedAny = false;

      try {
        const currentMessages =
          typeof messages === 'function' ? await messages(currentModel) : messages;

        if (typeof currentModel.provider.chatStream !== 'function') {
          // 若当前模型不支持 stream，执行阻塞调用并模拟单 chunk 输出
          const resp = await currentModel.provider.chat(currentMessages, {
            signal: timeoutController.signal,
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
          });
          hasYieldedAny = true;
          yield {
            delta: resp.content,
            finishReason: resp.finishReason,
            usage: resp.usage,
            executedModel: currentModel,
          };
          return;
        }

        const stream = currentModel.provider.chatStream(currentMessages, {
          signal: timeoutController.signal,
          temperature: options?.temperature,
          maxTokens: options?.maxTokens,
        });

        for await (const chunk of stream) {
          hasYieldedAny = true;
          yield {
            ...chunk,
            executedModel: currentModel,
          };
        }

        // 成功完成完整流式生成
        return;
      } catch (err: unknown) {
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener('abort', abortListener);
        }

        let error: Error;
        const cause = err instanceof Error ? err : new Error(String(err));
        if (isTimedOut) {
          error = new ModelTimeoutError(currentModel.name, timeoutMs, cause);
        } else {
          error = cause;
        }
        // 若外部调用方主动打断、入站安全拦截或不可重试错误，直接向外抛出
        if (
          options?.signal?.aborted ||
          error.name === 'AbortError' ||
          error.name === 'InboundSecurityBlockedError' ||
          error.message.startsWith('INBOUND_SECURITY_BLOCKED') ||
          !this.isRetryableError(error)
        ) {
          throw error;
        }

        // 核心安全契约：若已经产出了部分 Token，严禁切换到备用模型重复生成完整回复
        if (hasYieldedAny) {
          log.error(
            { model: currentModel.name, err: error.message },
            '流式生成途中发生异常，因已输出部分 Token，拒绝透明 Failover 避免产生重复/矛盾文本'
          );
          throw error;
        }

        // 仅在首个 chunk 产出前允许 Failover 故障转移
        underlyingErrors.push(error);

        const nextModel = i + 1 < maxAttempts ? candidateChain[i + 1] : undefined;
        this.notifyFailover(currentModel, nextModel, error, i + 1, '流式');
      } finally {
        clearTimeout(timer);
        if (options?.signal) {
          options.signal.removeEventListener('abort', abortListener);
        }
      }
    }

    throw new AllModelsFailedError(attemptedModels, underlyingErrors);
  }
}
