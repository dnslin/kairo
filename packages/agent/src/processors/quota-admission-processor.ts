import type { ProcessInputArgs, ProcessInputResult, Processor } from '@mastra/core/processors';

export interface QuotaAdmissionProcessorOptions {
  timeoutMs?: number;
  admissionHook?: (args: ProcessInputArgs & { signal?: AbortSignal }) => Promise<boolean> | boolean;
}

const DEFAULT_QUOTA_ADMISSION_TIMEOUT_MS = 5000;

/**
 * QuotaAdmissionProcessor: 配额原子准入与预算预留集成点
 *
 * 核心契约 (Spec §4.9, §9.11, Issue #179, #181):
 * 1. 在模型调用前执行原子准入与最大 Token 预算预留。
 * 2. 传递结合了父 AbortSignal 与 timeoutMs 的 AbortSignal 给 hook，防止慢操作或已取消操作在后台误落库。
 * 3. 运行中父 Abort、超时或异常时立即 fail-closed 停止当前 Run。
 */
export class QuotaAdmissionProcessor implements Processor<'quota-admission'> {
  readonly id = 'quota-admission' as const;
  readonly name = 'Token 配额原子准入门禁';
  private timeoutMs: number;
  private admissionHook?: (
    args: ProcessInputArgs & { signal?: AbortSignal }
  ) => Promise<boolean> | boolean;

  constructor(options?: QuotaAdmissionProcessorOptions) {
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_QUOTA_ADMISSION_TIMEOUT_MS;
    this.admissionHook = options?.admissionHook;
  }

  async processInput(args: ProcessInputArgs): Promise<ProcessInputResult> {
    const parentSignal =
      args.abortSignal ??
      (args.requestContext && typeof args.requestContext.get === 'function'
        ? args.requestContext.get('abortSignal')
        : undefined);
    if (parentSignal?.aborted) {
      throw new Error('QuotaAdmissionProcessor 执行前已被信号中止');
    }

    if (this.admissionHook) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combinedSignal = parentSignal
        ? AbortSignal.any([parentSignal, timeoutSignal])
        : timeoutSignal;

      if (combinedSignal.aborted) {
        if (parentSignal?.aborted) {
          throw new Error('QuotaAdmissionProcessor 被父 AbortSignal 中止');
        }
        throw new Error(`QuotaAdmissionProcessor 准入执行超时 (超过 ${this.timeoutMs}ms)`);
      }

      const abortPromise = new Promise<never>((_, reject) => {
        combinedSignal.addEventListener(
          'abort',
          () => {
            if (parentSignal?.aborted) {
              reject(new Error('QuotaAdmissionProcessor 运行中被父 AbortSignal 中止'));
            } else {
              reject(new Error(`QuotaAdmissionProcessor 准入执行超时 (超过 ${this.timeoutMs}ms)`));
            }
          },
          { once: true }
        );
      });

      const hookPromise = Promise.resolve(
        this.admissionHook({
          ...args,
          signal: combinedSignal,
        })
      );

      const allowed = await Promise.race([hookPromise, abortPromise]);

      if (!allowed) {
        args.abort('当前请求已超出每日 Token 配额上限或准入被拒绝', { retry: false });
      }
    }

    return args.messages;
  }
}
