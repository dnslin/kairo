import type { ProcessInputArgs, ProcessInputResult, Processor } from '@mastra/core/processors';
import { SensitiveFilter, DEFAULT_JAILBREAK_PATTERNS } from '../guardrails/sensitive-filter.js';
import { extractTextFromMastraContent } from './content-utils.js';

export interface PromptInjectionProcessorOptions {
  jailbreakPatterns?: RegExp[];
}

/**
 * PromptInjectionProcessor: 入站提示词注入与越狱检测处理器
 *
 * 核心契约 (Spec §4.9, MCPPROC-01):
 * 1. 拦截指令覆盖、角色扮演、DAN 模式与系统提示词窃取攻击。
 * 2. 策略命中时调用 abort(reason, { retry: false })，使用 Mastra 确定性拒绝语义阻断。
 * 3. 策略拒绝不触发 retry，fail-closed 停止当前 Run。
 */
export class PromptInjectionProcessor implements Processor<'prompt-injection'> {
  readonly id = 'prompt-injection' as const;
  readonly name = '提示词注入安全门禁';
  private filter: SensitiveFilter;

  constructor(options?: PromptInjectionProcessorOptions) {
    this.filter = new SensitiveFilter({
      jailbreakPatterns: options?.jailbreakPatterns ?? DEFAULT_JAILBREAK_PATTERNS,
    });
  }

  processInput(args: ProcessInputArgs): ProcessInputResult {
    for (const msg of args.messages) {
      if (msg.role !== 'user') {
        continue;
      }

      const text = extractTextFromMastraContent(msg.content);
      if (text.length > 0) {
        const check = this.filter.checkInbound(text);
        if (!check.safe) {
          const reason = check.reason ?? '检测到提示词注入或越狱攻击，已拒绝处理';
          args.abort(reason, { retry: false });
        }
      }
    }

    return args.messages;
  }
}
