import type { ProcessOutputResultArgs, Processor } from '@mastra/core/processors';
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
    const parentSignal =
      args.abortSignal ??
      (args.requestContext && typeof args.requestContext.get === 'function'
        ? args.requestContext.get('abortSignal')
        : undefined);

    if (parentSignal?.aborted) {
      throw new Error('QuotaUsageProcessor 结算前已被信号中止');
    }

    if (this.usageHook) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combinedSignal = parentSignal
        ? AbortSignal.any([parentSignal, timeoutSignal])
        : timeoutSignal;

      if (combinedSignal.aborted) {
        if (parentSignal?.aborted) {
          throw new Error('QuotaUsageProcessor 结算前已被信号中止');
        }
        throw new Error(`QuotaUsageProcessor 结算执行超时 (超过 ${this.timeoutMs}ms)`);
      }

      const abortPromise = new Promise<never>((_, reject) => {
        combinedSignal.addEventListener(
          'abort',
          () => {
            if (parentSignal?.aborted) {
              reject(new Error('QuotaUsageProcessor 运行中被父 AbortSignal 中止'));
            } else {
              reject(new Error(`QuotaUsageProcessor 结算执行超时 (超过 ${this.timeoutMs}ms)`));
            }
          },
          { once: true }
        );
      });

      const hookPromise = Promise.resolve(
        this.usageHook({
          ...args,
          signal: combinedSignal,
        })
      );

      const settled = await Promise.race([hookPromise, abortPromise]);

      if (settled === false) {
        args.abort('Token Usage 权威结算失败，为防止越界已中止交付', { retry: false });
      }
    }

    return args.messages;
  }
}
