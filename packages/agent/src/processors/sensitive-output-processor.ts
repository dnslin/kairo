import type {
  ProcessOutputResultArgs,
  Processor,
  ProcessorMessageResult,
} from '@mastra/core/processors';
import type { MastraDBMessage } from '@mastra/core/agent';
import { SensitiveFilter } from '../guardrails/sensitive-filter.js';
import { extractTextFromMastraContent, replaceMastraContentText } from './content-utils.js';

export interface SensitiveOutputProcessorOptions {
  sensitiveKeywords?: string[];
  sensitivePatterns?: RegExp[];
  blockedPatterns?: RegExp[];
}

/**
 * SensitiveOutputProcessor: 出站敏感内容安全脱敏与最后一道安全门
 *
 * 核心契约 (Spec §4.9, §4.24, ADR 0011, MCPPROC-01):
 * 1. 作为 Agent 内容安全闭环的最后一道防线。
 * 2. 对可脱敏的敏感词与隐私模式执行确定性掩码替换。
 * 3. 对致命敏感违规 (blockedPatterns) 实行 fail-closed 阻断 (abort)，严禁向 Gateway 暴露或交付原始正文。
 * 4. 独立于 Observability Trace SensitiveDataFilter，不混淆两者生命周期。
 */
export class SensitiveOutputProcessor implements Processor<'sensitive-output'> {
  readonly id = 'sensitive-output' as const;
  readonly name = '出站敏感内容安全门禁';
  private filter: SensitiveFilter;
  private blockedPatterns: RegExp[];

  constructor(options?: SensitiveOutputProcessorOptions) {
    this.filter = new SensitiveFilter({
      sensitiveKeywords: options?.sensitiveKeywords,
      sensitivePatterns: options?.sensitivePatterns,
    });
    this.blockedPatterns = options?.blockedPatterns ?? [];
  }

  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult {
    const updatedMessages: MastraDBMessage[] = args.messages.map(msg => {
      if (msg.role === 'assistant') {
        const text = extractTextFromMastraContent(msg.content);
        if (text.length > 0) {
          // 1. 致命违规检测 (blockedPatterns -> abort fail-closed)
          for (const pattern of this.blockedPatterns) {
            pattern.lastIndex = 0;
            if (pattern.test(text)) {
              args.abort(`出站安全拦截: 检测到致命敏感数据泄漏模式 [${pattern.source}]`, {
                retry: false,
              });
            }
          }

          // 2. 普通敏感词脱敏替换
          const filterRes = this.filter.filterOutbound(text);
          if (filterRes.filteredText !== text) {
            return {
              ...msg,
              content: replaceMastraContentText(msg.content, filterRes.filteredText),
            };
          }
        }
      }
      return msg;
    });

    return updatedMessages;
  }
}
