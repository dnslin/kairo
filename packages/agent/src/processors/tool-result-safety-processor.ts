import type { ProcessToolResultArgs, Processor } from '@mastra/core/processors';
import { SensitiveFilter, DEFAULT_JAILBREAK_PATTERNS } from '../guardrails/sensitive-filter.js';

export interface ToolResultSafetyProcessorOptions {
  jailbreakPatterns?: RegExp[];
  sensitiveKeywords?: string[];
  sensitivePatterns?: RegExp[];
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

  constructor(options?: ToolResultSafetyProcessorOptions) {
    this.filter = new SensitiveFilter({
      jailbreakPatterns: options?.jailbreakPatterns ?? DEFAULT_JAILBREAK_PATTERNS,
      sensitiveKeywords: options?.sensitiveKeywords,
      sensitivePatterns: options?.sensitivePatterns,
    });
  }

  processToolResult(args: ProcessToolResultArgs): undefined {
    let serializedResult = '';
    if (typeof args.result === 'string') {
      serializedResult = args.result;
    } else if (args.result !== undefined && args.result !== null) {
      try {
        serializedResult = JSON.stringify(args.result) ?? '';
      } catch {
        serializedResult = '';
      }
    }

    if (serializedResult.length > 0) {
      // 1. 检查是否存在提示词注入与越狱
      const inboundCheck = this.filter.checkInbound(serializedResult);
      if (!inboundCheck.safe) {
        const reason = `Tool result 包含安全违规或提示词注入: ${inboundCheck.reason ?? '恶意指令拦截'}`;
        args.abort(reason, { retry: false });
      }

      // 2. 检查是否存在未授权敏感外发
      const outboundCheck = this.filter.checkOutbound(serializedResult);
      if (!outboundCheck.safe) {
        const reason = `Tool result 包含敏感数据违规: ${outboundCheck.reason ?? '敏感词拦截'}`;
        args.abort(reason, { retry: false });
      }
    }

    return undefined;
  }
}
