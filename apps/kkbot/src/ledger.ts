import type { WorkAdmissionGate } from './gate.js';
import { createChildLogger } from '@kkbot/driver';
const defaultShutdownLogger = createChildLogger('shutdown');

export const DEFAULT_SHUTDOWN_DEADLINE_MS = 10_000;

export type FinalizerFn = () => Promise<void> | void;

export interface LedgerRecordOptions {
  id: string;
  owner: string;
  dependencies?: string[];
  finalizer: FinalizerFn | null;
}

export interface LedgerEntry {
  id: string;
  startupGenerationId: string;
  owner: string;
  dependencies: string[];
  finalizer: FinalizerFn | null;
  transferredTo?: string | null;
  acquiredAt: number;
}

export interface FinalizerError {
  resourceId: string;
  owner: string;
  error: Error;
}

export interface ShutdownResult {
  successful: boolean;
  executedResources: string[];
  errors: FinalizerError[];
  triggerReason?: unknown;
}

export interface ExecuteShutdownOptions {
  ledger: AcquisitionLedger;
  gate: WorkAdmissionGate;
  triggerReason?: unknown;
  /** 整条逆拓扑 Shutdown 的统一 deadline，默认 10 秒。 */
  /** 直接指定整条 Shutdown 的绝对截止时间；存在时优先于 deadlineMs。 */
  deadlineAt?: number;
  deadlineMs?: number;
  logger?: {
    info?: (obj: Record<string, unknown> | string, msg?: string) => void;
    error?: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn?: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

/**
 * 资源取得账本（AcquisitionLedger）
 * 严格记录当前启动代次下已成功取得的资源、所属 owner、依赖关系与唯一 finalizer。
 */
export class AcquisitionLedger {
  readonly startupGenerationId: string;
  private readonly entries = new Map<string, LedgerEntry>();

  constructor(startupGenerationId: string) {
    this.startupGenerationId = startupGenerationId;
  }

  /**
   * 登记已成功取得的资源
   */
  record(options: LedgerRecordOptions): void {
    const entry: LedgerEntry = {
      id: options.id,
      startupGenerationId: this.startupGenerationId,
      owner: options.owner,
      dependencies: options.dependencies ? [...options.dependencies] : [],
      finalizer: options.finalizer,
      transferredTo: null,
      acquiredAt: Date.now(),
    };
    this.entries.set(options.id, entry);
  }

  /**
   * 转移资源所有权
   * 更新 owner 并替换/清空其直接 finalizer，确保任意时刻只有一个合法 closer。
   */
  transferOwnership(
    resourceId: string,
    newOwner: string,
    newFinalizer: FinalizerFn | null = null
  ): void {
    const entry = this.entries.get(resourceId);
    if (!entry) {
      return;
    }
    entry.owner = newOwner;
    entry.transferredTo = newOwner;
    entry.finalizer = newFinalizer;
  }

  has(resourceId: string): boolean {
    return this.entries.has(resourceId);
  }

  get(resourceId: string): LedgerEntry | undefined {
    return this.entries.get(resourceId);
  }

  getAll(): LedgerEntry[] {
    return Array.from(this.entries.values());
  }

  /**
   * 计算依赖图的逆拓扑关闭顺序
   * 规则：使用者（依赖他者的组件）必须先于被依赖项关闭；
   * 并列节点按取得顺序的逆序稳定排列。
   */
  getReverseTopologicalOrder(): LedgerEntry[] {
    const allEntries = Array.from(this.entries.values());
    const idToEntry = new Map(allEntries.map(e => [e.id, e]));

    // 计算被依赖计数（若 A dependsOn B，则 B 必须等 A 关闭后才能关闭，即 B 的入度+1）
    const dependentsCount = new Map<string, number>();
    const dependentsMap = new Map<string, string[]>(); // B -> [A1, A2] (哪些节点必须先于 B 关闭)

    for (const entry of allEntries) {
      if (!dependentsCount.has(entry.id)) {
        dependentsCount.set(entry.id, 0);
      }
      for (const depId of entry.dependencies) {
        if (idToEntry.has(depId)) {
          dependentsCount.set(depId, (dependentsCount.get(depId) ?? 0) + 1);
          const list = dependentsMap.get(depId) ?? [];
          list.push(entry.id);
          dependentsMap.set(depId, list);
        }
      }
    }

    // 优先关闭没有后置依赖的顶层节点（入度为 0 的节点）
    const order: LedgerEntry[] = [];
    const visited = new Set<string>();

    // 辅助队列：使用逆取得顺序维持稳定性
    const getAvailable = (): LedgerEntry[] =>
      allEntries
        .filter(e => !visited.has(e.id) && (dependentsCount.get(e.id) ?? 0) === 0)
        .reverse();

    let available = getAvailable();

    while (available.length > 0) {
      const current = available[0];
      if (!current) {
        break;
      }
      visited.add(current.id);
      order.push(current);

      // 解除 current 对其依赖项的占用
      for (const depId of current.dependencies) {
        const count = dependentsCount.get(depId);
        if (count !== undefined && count > 0) {
          dependentsCount.set(depId, count - 1);
        }
      }

      available = getAvailable();
    }

    // 防御可能存在的环或孤立节点，全部按逆取得顺序追加
    for (let i = allEntries.length - 1; i >= 0; i--) {
      const e = allEntries[i];
      if (e && !visited.has(e.id)) {
        visited.add(e.id);
        order.push(e);
      }
    }

    return order;
  }
}

async function runFinalizerWithDeadline(
  finalizer: FinalizerFn,
  deadlineAt: number,
  onLateError: (error: Error) => void
): Promise<void> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) {
    throw new Error('资源 Finalizer 未执行：Shutdown deadline 已耗尽');
  }

  let timedOut = false;
  const finalizerPromise = Promise.resolve().then(finalizer);
  void finalizerPromise.catch(error => {
    if (timedOut) {
      onLateError(error instanceof Error ? error : new Error(String(error)));
    }
  });
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`资源 Finalizer 超过 Shutdown deadline（剩余预算 ${remainingMs}ms）`));
    }, remainingMs);
  });
  try {
    await Promise.race([finalizerPromise, timeoutPromise]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * 执行统一逆拓扑优雅关闭
 * 1. 立即关闭 Work Admission Gate
 * 2. 遍历 Acquisition Ledger 逆拓扑 finalizer 并逐一执行
 * 3. 容忍单个 finalizer 失败，聚合所有错误，最终返回关闭报告
 */
export async function executeReverseShutdown(
  options: ExecuteShutdownOptions
): Promise<ShutdownResult> {
  const {
    ledger,
    gate,
    triggerReason,
    logger,
    deadlineMs = DEFAULT_SHUTDOWN_DEADLINE_MS,
    deadlineAt = Date.now() + Math.max(1, deadlineMs),
  } = options;
  const diagnosticLogger = logger ?? defaultShutdownLogger;

  // 1. 第一动作：坚决关闭准入门
  gate.close();

  const shutdownOrder = ledger.getReverseTopologicalOrder();
  const result: ShutdownResult = {
    successful: true,
    executedResources: [],
    errors: [],
    triggerReason,
  };

  // 2. 逆拓扑执行所有 finalizer
  for (const entry of shutdownOrder) {
    if (!entry.finalizer) {
      continue;
    }

    result.executedResources.push(entry.id);
    try {
      await runFinalizerWithDeadline(entry.finalizer, deadlineAt, error => {
        diagnosticLogger.error?.(
          { resourceId: entry.id, owner: entry.owner, err: error },
          '资源 Finalizer 在 deadline 后失败，补充记录迟到诊断'
        );
      });
    } catch (err) {
      const errorObj = err instanceof Error ? err : new Error(String(err));
      result.errors.push({
        resourceId: entry.id,
        owner: entry.owner,
        error: errorObj,
      });
      result.successful = false;
      diagnosticLogger.error?.(
        { resourceId: entry.id, owner: entry.owner, err: errorObj },
        '资源 Finalizer 执行异常或超时，记录并继续释放其余资源'
      );
    }
  }

  return result;
}
