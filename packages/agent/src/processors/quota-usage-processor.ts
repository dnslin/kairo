import type { ProcessOutputResultArgs, Processor } from '@mastra/core/processors';
import {
  getProcessorParentSignal,
  runBoundedProcessorExecution,
} from './processor-utils.js';
import type { MastraDBMessage } from '@mastra/core/agent';

export interface QuotaUsageProcessorOptions {
  timeoutMs?: number;
  usageHook?: (
    args: ProcessOutputResultArgs & { signal?: AbortSignal }
  ) => Promise<boolean> | boolean;
}

const DEFAULT_QUOTA_USAGE_TIMEOUT_MS = 5000;

/**
 * QuotaUsageProcessor: Token 实际消耗幂等结算集成点
 *
 * 核心契约 (Spec §4.9, §9.11, Issue #179, #181):
 * 1. 在模型执行完成后，只按权威完整 Run Usage 执行幂等结算。
 * 2. 传递结合了父 AbortSignal 与 timeoutMs 的 AbortSignal 给 hook。
 * 3. 运行中父 Abort 触发时 fail-closed 中止（保持 held_unknown 状态，防止伪造成功结算）。
 * 4. 运行中超时或异常时 fail-closed 阻断。
 */
export class QuotaUsageProcessor implements Processor<'quota-usage'> {
  readonly id = 'quota-usage' as const;
  readonly name = 'Token 配额 Usage 结算门禁';
  private timeoutMs: number;
  private usageHook?: (
    args: ProcessOutputResultArgs & { signal?: AbortSignal }
  ) => Promise<boolean> | boolean;

  constructor(options?: QuotaUsageProcessorOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_QUOTA_USAGE_TIMEOUT_MS;
    this.usageHook = options?.usageHook;
  }

  async processOutputResult(args: ProcessOutputResultArgs): Promise<MastraDBMessage[]> {
    const parentSignal = getProcessorParentSignal(args);
    if (parentSignal?.aborted) {
      throw new Error('QuotaUsageProcessor 结算前已被信号中止');
    }

    const usageHook = this.usageHook;
    if (usageHook) {
      const settled = await runBoundedProcessorExecution({
        parentSignal,
        timeoutMs: this.timeoutMs,
        timeoutMessage: `QuotaUsageProcessor 结算执行超时 (超过 ${this.timeoutMs}ms)`,
        parentAbortMessage: 'QuotaUsageProcessor 运行中被父 AbortSignal 中止',
        execute: signal => usageHook({ ...args, signal }),
      });

      if (settled === false) {
        args.abort('Token Usage 权威结算失败，为防止越界已中止交付', { retry: false });
      }
    }

    return args.messages;
  }
}
