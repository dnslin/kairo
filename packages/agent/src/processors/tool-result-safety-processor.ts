import type { ProcessToolResultArgs, Processor } from '@mastra/core/processors';
import { SensitiveFilter, DEFAULT_JAILBREAK_PATTERNS } from '../guardrails/sensitive-filter.js';

export interface ToolResultSafetyProcessorOptions {
  jailbreakPatterns?: RegExp[];
  sensitiveKeywords?: string[];
  sensitivePatterns?: RegExp[];
  maxResultChars?: number;
}

/**
 * ToolResultSafetyProcessor: Tool 执行结果安全检查处理器
 *
 * 核心契约 (Spec §4.9, §4.11, MCPPROC-01):
 * 1. MCP Tool 与本地 Tool 结果在进入下一模型 Step 前必须经过该检查。
 * 2. 防止不受信任的外部 MCP 服务或本地工具结果注入恶意提示词或泄漏未授权机密。
 * 3. 策略命中时调用 abort(reason, { retry: false }) 抛出 TripWire，阻止模型看到恶意内容。
 */
export class ToolResultSafetyProcessor implements Processor<'tool-result-safety'> {
  readonly id = 'tool-result-safety' as const;
  readonly name = '工具结果安全检查器';
  private filter: SensitiveFilter;
  private maxResultChars: number;

  constructor(options?: ToolResultSafetyProcessorOptions) {
    this.filter = new SensitiveFilter({
      jailbreakPatterns: options?.jailbreakPatterns ?? DEFAULT_JAILBREAK_PATTERNS,
      sensitiveKeywords: options?.sensitiveKeywords,
      sensitivePatterns: options?.sensitivePatterns,
    });
    this.maxResultChars = options?.maxResultChars ?? 8000;
    if (!Number.isInteger(this.maxResultChars) || this.maxResultChars < 1) {
      throw new Error('Tool result 最大长度必须是正整数');
    }
  }

  processToolResult(args: ProcessToolResultArgs): undefined {
    let serializedResult = '';
    if (typeof args.result === 'string') {
      serializedResult = args.result;
    } else if (args.result !== undefined && args.result !== null) {
      try {
        const serialized = JSON.stringify(args.result);
        if (serialized === undefined) {
          throw new TypeError('JSON.stringify 返回 undefined');
        }
        serializedResult = serialized;
      } catch (serializationError) {
        throw new Error(
          `Tool result [${args.toolName}] 无法序列化，拒绝将未经检查的结果传入模型`,
          { cause: serializationError }
        );
      }
    }

    if (serializedResult.length > 0) {
      const inboundCheck = this.filter.checkInbound(serializedResult);
      if (!inboundCheck.safe) {
        const reason = `Tool result 包含安全违规或提示词注入: ${inboundCheck.reason ?? '恶意指令拦截'}`;
        args.abort(reason, { retry: false });
      }

      const outboundCheck = this.filter.checkOutbound(serializedResult);
      if (!outboundCheck.safe) {
        const reason = `Tool result 包含敏感数据违规: ${outboundCheck.reason ?? '敏感词拦截'}`;
        args.abort(reason, { retry: false });
      }

      if (serializedResult.length > this.maxResultChars) {
        if (!args.messageList || typeof args.messageList.updateToolInvocation !== 'function') {
          throw new Error('Tool result 过大但缺少可写回的 MessageList，拒绝继续执行');
        }
        const updated = args.messageList.updateToolInvocation({
          type: 'tool-invocation',
          toolInvocation: {
            state: 'result',
            toolCallId: args.toolCallId,
            toolName: args.toolName,
            args: args.args,
            result: {
              truncated: true,
              summary: serializedResult.slice(0, this.maxResultChars),
              reference: `tool:${args.toolName}:${args.toolCallId}`,
            },
          },
        });
        if (!updated) {
          throw new Error('Tool result 过大但 MessageList 写回失败，拒绝继续执行');
        }
      }
    }

    return undefined;
  }
}
