import { isDispatchTerminal } from '../im-transport/send-policy.js';
import type { SendService } from '../im-transport/send-service.js';
import { AppError, getErrorType } from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import { createControlMessageHandler, type ContextMessageResult } from './control-message.js';
import type { ContextService } from './context-service.js';
import type { BatchingSettings, CollectedBatch, CollectorStore } from './collector-types.js';
import type { IngressResult } from './ingress.js';
import { INPUT_NOTICES, isEmptyInput } from './input-policy.js';

export interface CollectorOptions {
  botId: string;
  store: CollectorStore;
  contexts: ContextService;
  sender: Pick<SendService, 'send' | 'recover'>;
  /** 返回 true 才标记收尾；发送被其他在途调用占用时留给显式恢复。 */
  deliverReady(batch: CollectedBatch, recovery: boolean): Promise<boolean>;
  batching: BatchingSettings;
  logger: AppLogger;
}

export type CollectorResult =
  | ContextMessageResult
  | { status: 'collected'; batches: CollectedBatch[] }
  | { status: 'empty' };

export interface Collector {
  accept(input: IngressResult): Promise<CollectorResult>;
  /** 旧实例及其发送协调器停止后恢复；合法 ready 仍交给唯一调度入口。 */
  recover(): Promise<void>;
  /** 等待已开始的工作并报告定时器错误，不等待尚未到期的批次。 */
  settled(): Promise<void>;
  /** 清理本实例计时器并等待在途调用，不关闭调用方的连接池或 sender。 */
  close(): Promise<void>;
}

export function createCollector(options: CollectorOptions): Collector {
  const { store, sender } = options;
  const control = createControlMessageHandler(options);
  const timers = new Map<string, NodeJS.Timeout>();
  const finishing = new Map<string, Promise<void>>();
  const pending = new Set<Promise<unknown>>();
  const timerErrors: unknown[] = [];
  let closed = false;
  let recovering: Promise<void> | undefined;
  let closing: Promise<void> | undefined;

  function checkOpen(): void {
    if (closed) throw new AppError('cancelled');
  }

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    );
    return work;
  }

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    if (timerErrors.length === 1) throw timerErrors.shift();
    if (timerErrors.length > 1)
      throw new AggregateError(timerErrors.splice(0), '消息聚合计时处理失败');
  }

  function schedule(batch: CollectedBatch): void {
    if (closed) return;
    clearTimeout(timers.get(batch.batchId));
    const remaining = Math.max(0, Math.min(batch.quietDeadline, batch.maxDeadline) - Date.now());
    const timer = setTimeout(() => {
      if (closed || timers.get(batch.batchId) !== timer) return;
      timers.delete(batch.batchId);
      // 定时器没有直接调用方；错误保留给 settled/close，同时记录可关联诊断。
      void track(
        processBatch(batch.batchId, false).catch(error => {
          timerErrors.push(error);
          options.logger.error({
            event: '运行失败',
            sessionId: batch.sessionId,
            contextId: batch.threadId,
            errorType: getErrorType(error, 'storage'),
          });
        })
      );
    }, remaining);
    timers.set(batch.batchId, timer);
  }

  async function finish(batchId: string, recovery: boolean): Promise<void> {
    checkOpen();
    const batch = await store.finishBatch(batchId, () => Date.now());
    if (closed || !batch || batch.settledAt !== null) return;
    if (batch.status === 'collecting') {
      schedule(batch);
      return;
    }
    clearTimeout(timers.get(batchId));
    timers.delete(batchId);
    if (batch.status === 'discarded') return;
    if (batch.finishedAt === null) throw new Error(`已结束批次缺少结束时刻 [${batchId}]`);
    if (batch.status === 'ready' || batch.rejection === 'queue_full') {
      // 入队与满队列拒绝由同一个持久裁决处理；重放不能重新接纳已拒绝批次。
      if (!(await options.deliverReady(batch, recovery))) return;
    } else {
      if (batch.rejection === null) throw new Error(`拒绝批次缺少原因 [${batchId}]`);
      const first = (await store.getBatchMessages(batchId))[0];
      if (!first) throw new Error(`拒绝批次缺少原始消息 [${batchId}]`);
      checkOpen();
      const request = {
        subject: {
          kind: 'event' as const,
          botId: batch.botId,
          sessionId: batch.sessionId,
          messageId: first.messageId,
          threadId: batch.threadId,
        },
        purpose: `notice:input_${batch.rejection}` as const,
        text: INPUT_NOTICES[batch.rejection],
      };
      const dispatch = await (recovery ? sender.recover(request) : sender.send(request));
      if (!isDispatchTerminal(dispatch.status)) return;
    }
    if (!closed) await store.settleBatch(batchId, Date.now());
  }

  function processBatch(batchId: string, recovery: boolean): Promise<void> {
    const existing = finishing.get(batchId);
    // 后继处理自己的已提交状态；前驱异常仍由前驱调用方接收，不能短路后继。
    const proceed = (): Promise<void> => finish(batchId, recovery);
    const work = existing ? existing.then(proceed, proceed) : proceed();
    finishing.set(batchId, work);
    const release = (): void => {
      if (finishing.get(batchId) === work) finishing.delete(batchId);
    };
    void work.then(release, release);
    return work;
  }

  async function processBatches(batches: CollectedBatch[], recovery: boolean): Promise<void> {
    // 任一批失败也要等其余收尾，避免 close 提前释放仍在使用的连接或 sender。
    const results = await Promise.allSettled(
      batches.map(batch => processBatch(batch.batchId, recovery))
    );
    const errors = results
      .filter(result => result.status === 'rejected')
      .map(result => result.reason as unknown);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '消息批次收尾失败');
  }

  async function accept(input: IngressResult): Promise<CollectorResult> {
    checkOpen();
    const result = await control(input);
    checkOpen();
    if (result.status !== 'message') return result;
    if (isEmptyInput(result.message)) return { status: 'empty' };
    const batches = await store.collectMessage(result, options.batching, () => Date.now());
    checkOpen();
    // 旧批提示等待不能阻止新批计时，也不占用数据库 context 锁。
    await processBatches(batches, false);
    return { status: 'collected', batches };
  }

  async function recover(): Promise<void> {
    checkOpen();
    const batches = await store.listPendingBatches(options.botId);
    checkOpen();
    await processBatches(batches, true);
  }

  return {
    accept: input => track(accept(input)),
    recover(): Promise<void> {
      if (closed) return Promise.reject(new AppError('cancelled'));
      if (recovering) return recovering;
      recovering = track(recover());
      void recovering.then(
        () => {
          recovering = undefined;
        },
        () => {
          recovering = undefined;
        }
      );
      return recovering;
    },
    settled,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
      closing = settled();
      return closing;
    },
  };
}
