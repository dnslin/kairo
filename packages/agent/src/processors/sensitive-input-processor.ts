import type { ProcessInputArgs, ProcessInputResult, Processor } from '@mastra/core/processors';
import { SensitiveFilter } from '../guardrails/sensitive-filter.js';
import { extractTextFromMastraContent } from './content-utils.js';

export interface SensitiveInputProcessorOptions {
  sensitiveKeywords?: string[];
  sensitivePatterns?: RegExp[];
}

/**
 * SensitiveInputProcessor: 入站敏感词与违禁内容拦截处理器
 *
 * 核心契约 (Spec §4.9, MCPPROC-01):
 * 1. 拦截用户输入中的违禁词汇与机密特征。
 * 2. 策略命中时调用 abort(reason, { retry: false }) 确定性阻断。
 * 3. 自身异常或超时 fail-closed。
 */
export class SensitiveInputProcessor implements Processor<'sensitive-input'> {
  readonly id = 'sensitive-input' as const;
  readonly name = '入站敏感内容安全门禁';
  private filter: SensitiveFilter;

  constructor(options?: SensitiveInputProcessorOptions) {
    this.filter = new SensitiveFilter({
      sensitiveKeywords: options?.sensitiveKeywords,
      sensitivePatterns: options?.sensitivePatterns,
    });
  }

  processInput(args: ProcessInputArgs): ProcessInputResult {
    for (const msg of args.messages) {
      if (msg.role !== 'user') {
        continue;
      }

      const text = extractTextFromMastraContent(msg.content);
      if (text.length > 0) {
        const check = this.filter.checkOutbound(text);
        if (!check.safe) {
          const reason = check.reason ?? '输入内容包含敏感违禁词汇，已拒绝处理';
          args.abort(reason, { retry: false });
        }
      }
    }

    return args.messages;
  }
}
