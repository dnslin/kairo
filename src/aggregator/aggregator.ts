import type { Message } from '../extract/index.js';
import type { AggregationConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('aggregator');

/**
 * 聚合桶：缓存同一会话的 pending 消息及其定时器
 */
interface PendingBucket {
  messages: Message[];
  windowTimer: ReturnType<typeof setTimeout>;
  maxTimer: ReturnType<typeof setTimeout>;
  firstReceivedAt: number;
}

/**
 * 消息聚合器错误
 */
export class AggregatorError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'AggregatorError';
    this.originalCause = originalCause;
  }
}

/**
 * 消息聚合器
 *
 * 在 watcher 和 processMessage 之间，按 sessionId 分桶缓存消息。
 * 滑动窗口 (windowMs) 内无新消息则触发 flush；
 * 超过最大等待时间 (maxWaitMs) 则强制 flush。
 */
export class MessageAggregator {
  private readonly buckets = new Map<string, PendingBucket>();

  constructor(
    private readonly config: AggregationConfig,
    private readonly onFlush: (sessionId: string, messages: Message[]) => void
  ) {
    log.debug(
      { enabled: config.enabled, windowMs: config.windowMs, maxWaitMs: config.maxWaitMs },
      '消息聚合器已初始化'
    );
  }

  /** 当前 pending 桶的数量 */
  get pendingCount(): number {
    return this.buckets.size;
  }

  /** watcher 调用此方法投递消息 */
  push(sessionId: string, msg: Message): void {
    if (!this.config.enabled) {
      this.onFlush(sessionId, [msg]);
      return;
    }

    let bucket = this.buckets.get(sessionId);

    if (!bucket) {
      bucket = {
        messages: [],
        windowTimer: setTimeout(() => this.flush(sessionId), this.config.windowMs),
        maxTimer: setTimeout(() => this.flush(sessionId), this.config.maxWaitMs),
        firstReceivedAt: Date.now(),
      };
      this.buckets.set(sessionId, bucket);
    } else {
      // 重置滑动窗口定时器
      clearTimeout(bucket.windowTimer);
      bucket.windowTimer = setTimeout(() => this.flush(sessionId), this.config.windowMs);
    }

    bucket.messages.push(msg);
    log.debug(
      { sessionId, count: bucket.messages.length },
      '消息入聚合桶，重置窗口计时器'
    );
  }

  /** 窗口到期或 maxWait 到期，批量回调 */
  private flush(sessionId: string): void {
    const bucket = this.buckets.get(sessionId);
    if (!bucket) return;

    clearTimeout(bucket.windowTimer);
    clearTimeout(bucket.maxTimer);
    this.buckets.delete(sessionId);

    const elapsed = Date.now() - bucket.firstReceivedAt;
    log.info(
      { sessionId, count: bucket.messages.length, elapsedMs: elapsed },
      '聚合窗口触发，合并消息'
    );

    this.onFlush(sessionId, bucket.messages);
  }

  /** 进程关闭时 flush 所有 pending 桶（不丢消息） */
  flushAll(): void {
    for (const sessionId of [...this.buckets.keys()]) {
      this.flush(sessionId);
    }
  }

  /**
   * 排空所有 pending 桶并返回消息，不触发 onFlush 回调。
   * 用于 shutdown 时安全获取未处理消息（不启动异步流程）。
   */
  drain(): Map<string, Message[]> {
    const result = new Map<string, Message[]>();
    for (const [sessionId, bucket] of this.buckets) {
      clearTimeout(bucket.windowTimer);
      clearTimeout(bucket.maxTimer);
      result.set(sessionId, bucket.messages);
    }
    this.buckets.clear();
    return result;
  }
}
