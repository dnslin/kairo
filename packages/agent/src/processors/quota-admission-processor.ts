import type { ProcessInputArgs, ProcessInputResult, Processor } from '@mastra/core/processors';
import {
  getProcessorParentSignal,
  runBoundedProcessorExecution,
} from './processor-utils.js';

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
    const parentSignal = getProcessorParentSignal(args);
    if (parentSignal?.aborted) {
      throw new Error('QuotaAdmissionProcessor 执行前已被信号中止');
    }

    const admissionHook = this.admissionHook;
    if (admissionHook) {
      const allowed = await runBoundedProcessorExecution({
        parentSignal,
        timeoutMs: this.timeoutMs,
        timeoutMessage: `QuotaAdmissionProcessor 准入执行超时 (超过 ${this.timeoutMs}ms)`,
        parentAbortMessage: 'QuotaAdmissionProcessor 运行中被父 AbortSignal 中止',
        execute: signal => admissionHook({ ...args, signal }),
      });

      if (!allowed) {
        args.abort('当前请求已超出每日 Token 配额上限或准入被拒绝', { retry: false });
      }
    }

    return args.messages;
  }
}
