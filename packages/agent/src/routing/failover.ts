import type {
  LLMMessage,
  LLMStreamChunk,
  TokenUsage,
} from '../types/index.js';
import type {
  FailoverEvent,
  FailoverOptions,
  ModelEndpointConfig,
} from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('model-failover-manager');

/**
 * 单一模型调用超时异常
 */
export class ModelTimeoutError extends Error {
  public readonly modelName: string;
  public readonly timeoutMs: number;

  constructor(modelName: string, timeoutMs: number) {
    super(`模型 [${modelName}] 调用超时 (${timeoutMs}ms)`);
    this.name = 'ModelTimeoutError';
    this.modelName = modelName;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * 所有可用模型均故障失效异常
 */
export class AllModelsFailedError extends Error {
  public readonly attemptedModels: string[];
  public readonly underlyingErrors: Error[];

  constructor(attemptedModels: string[], underlyingErrors: Error[]) {
    const errorDetails = attemptedModels
      .map((m, idx) => `[${m}]: ${underlyingErrors[idx]?.message || '未知异常'}`)
      .join('; ');
    super(`所有候选模型调用均已失败 (尝试模型: ${attemptedModels.join(' -> ')}): ${errorDetails}`);
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
  private onFailoverCallback?: (event: FailoverEvent) => void;

  constructor(options?: FailoverOptions) {
    this.defaultTimeoutMs = options?.timeoutMs ?? 15000;
    this.defaultRetryStatusCodes = options?.retryStatusCodes ?? [
      503, 429, 500, 502, 504,
    ];
    this.onFailoverCallback = options?.onFailover;
  }

  /**
   * 判断错误是否可重试/可切换备用节点
   */
  public isRetryableError(err: unknown): boolean {
    if (!err) return false;
    if (err instanceof ModelTimeoutError) return true;

    // 检查 Error 实例中的状态码或关键词
    if (err instanceof Error) {
      // 检查 status 或 statusCode 属性
      const errorObj = err as unknown as Record<string, unknown>;
      const status = errorObj['status'] || errorObj['statusCode'];
      if (
        typeof status === 'number' &&
        this.defaultRetryStatusCodes.includes(status)
      ) {
        return true;
      }

      const msg = err.message.toLowerCase();
      // 匹配 HTTP 状态码
      if (
        msg.includes('503') ||
        msg.includes('429') ||
        msg.includes('500') ||
        msg.includes('502') ||
        msg.includes('504') ||
        msg.includes('rate limit') ||
        msg.includes('quota') ||
        msg.includes('timeout') ||
        msg.includes('timed out') ||
        msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('network') ||
        msg.includes('fetch failed')
      ) {
        return true;
      }

      // 如果是 AbortError，需确认是否为调用方主动打断
      if (err.name === 'AbortError' || msg.includes('aborted')) {
        return false;
      }

      return true;
    }

    return true;
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
    }
  ): Promise<{
    content: string;
    usage?: TokenUsage;
    finishReason?: string;
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
      });
      return response;
    } catch (err: unknown) {
      if (isTimedOut) {
        throw new ModelTimeoutError(model.name, timeoutMs);
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
    }
  ): Promise<{
    content: string;
    usage?: TokenUsage;
    finishReason?: string;
    executedModel: ModelEndpointConfig;
  }> {
    if (candidateChain.length === 0) {
      throw new Error('Failover 候选模型链为空');
    }

    const attemptedModels: string[] = [];
    const underlyingErrors: Error[] = [];

    for (let i = 0; i < candidateChain.length; i++) {
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

        // 如果是外部主动打断或入站安全拦截，严禁 Failover 重试，直接向外抛出
        if (
          options?.signal?.aborted ||
          error.name === 'AbortError' ||
          error.name === 'InboundSecurityBlockedError' ||
          error.message.startsWith('INBOUND_SECURITY_BLOCKED')
        ) {
          throw error;
        }
        const nextModel = candidateChain[i + 1];
        log.warn(
          {
            failedModel: currentModel.name,
            nextModel: nextModel?.name ?? '无',
            attempt: i + 1,
            err: error.message,
          },
          '模型调用异常，触发 Failover 故障转移'
        );

        // 触发 Failover 事件回调
        if (this.onFailoverCallback) {
          try {
            this.onFailoverCallback({
              fromModel: currentModel.name,
              toModel: nextModel?.name,
              error,
              attempt: i + 1,
              timestamp: Date.now(),
            });
          } catch (callbackErr) {
            log.warn({ callbackErr }, 'Failover 回调函数执行异常');
          }
        }
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
    }
  ): AsyncIterable<LLMStreamChunk & { executedModel?: ModelEndpointConfig }> {
    if (candidateChain.length === 0) {
      throw new Error('Failover 候选模型链为空');
    }

    const attemptedModels: string[] = [];
    const underlyingErrors: Error[] = [];

    for (let i = 0; i < candidateChain.length; i++) {
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
        if (isTimedOut) {
          error = new ModelTimeoutError(currentModel.name, timeoutMs);
        } else if (err instanceof Error) {
          error = err;
        } else {
          error = new Error(String(err));
        }

        // 若外部调用方主动打断或入站安全拦截，直接向外抛出
        if (
          options?.signal?.aborted ||
          error.name === 'AbortError' ||
          error.name === 'InboundSecurityBlockedError' ||
          error.message.startsWith('INBOUND_SECURITY_BLOCKED')
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

        const nextModel = candidateChain[i + 1];
        log.warn(
          {
            failedModel: currentModel.name,
            nextModel: nextModel?.name ?? '无',
            attempt: i + 1,
            err: error.message,
          },
          '流式模型首个 Chunk 产出前发生异常，尝试 Failover 故障转移'
        );

        if (this.onFailoverCallback) {
          try {
            this.onFailoverCallback({
              fromModel: currentModel.name,
              toModel: nextModel?.name,
              error,
              attempt: i + 1,
              timestamp: Date.now(),
            });
          } catch (callbackErr) {
            log.warn({ callbackErr }, 'Failover 回调函数执行异常');
          }
        }
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
