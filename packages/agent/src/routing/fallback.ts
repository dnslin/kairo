import type { AgentReplyResult, ConsolidatedMessage } from '../types/index.js';
import type { FallbackConfig } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('global-fallback-handler');

export const DEFAULT_FALLBACK_APOLOGY =
  '当前网络繁忙，消息已记录，稍后为您处理';

/**
 * 全局宕机兜底处理器 (Global Outage Fallback Handler)
 * 当所有模型 (包含主模型与所有 Failover 备用节点) 均不可用时，优雅返回安抚话术，
 * 确保消息流程闭环并消除未读红点，避免网关层抛出未捕获异常。
 */
export class FallbackHandler {
  private defaultApologyMessage: string;
  private customHandler?: (
    threadId: string,
    message: ConsolidatedMessage,
    error: Error
  ) => Promise<string> | string;

  constructor(config?: FallbackConfig) {
    this.defaultApologyMessage =
      config?.defaultApologyMessage || DEFAULT_FALLBACK_APOLOGY;
    this.customHandler = config?.customHandler;
  }

  /**
   * 处理全局模型宕机/故障，生成闭环安抚回复
   */
  public async handle(
    threadId: string,
    message: ConsolidatedMessage,
    error: Error
  ): Promise<AgentReplyResult> {
    log.warn(
      {
        threadId,
        sender: message.sender,
        sessionId: message.sessionId,
        err: error.message,
      },
      '触发全局宕机安抚兜底机制'
    );

    let apology = this.defaultApologyMessage;
    if (this.customHandler) {
      try {
        apology = await this.customHandler(threadId, message, error);
      } catch (handlerErr) {
        log.error(
          { handlerErr },
          '自定义兜底处理器执行异常，回退到默认安抚话术'
        );
      }
    }

    return {
      content: apology,
      toolCalls: [],
      finishReason: 'stop',
      aborted: false,
    };
  }

  public getDefaultApologyMessage(): string {
    return this.defaultApologyMessage;
  }
}
