import type { MessageExtractor, Message } from '../extract/extractor.js';
import type { WatcherConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const logger = createChildLogger('watch');

export class WatcherError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'WatcherError';
    this.originalCause = originalCause;
  }
}

export class MessageWatcher {
  private running = false;
  private pendingTimeout: ReturnType<typeof setTimeout> | null = null;
  private knownFingerprints = new Set<string>();

  constructor(
    private readonly extractor: MessageExtractor,
    private readonly config: WatcherConfig
  ) {
    void this.extractor;
    void this.config;
    logger.debug('MessageWatcher 已初始化');
  }

  start(onNewMessage: (msg: Message) => void): void {
    if (this.running) {
      return;
    }

    this.running = true;
    logger.info('启动消息监听');

    const loop = async (): Promise<void> => {
      while (this.running) {
        await this.poll(onNewMessage);
        if (!this.running) {
          break;
        }
        await this.sleep(this.config.intervalMs);
      }
    };

    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.pendingTimeout) {
      clearTimeout(this.pendingTimeout);
      this.pendingTimeout = null;
    }
    logger.info('停止消息监听');
  }

  private async poll(onNewMessage: (msg: Message) => void): Promise<void> {
    // 捕获提取失败，记录日志但不中断轮询
    let messages: Message[] = [];
    try {
      messages = await this.extractor.getRecentMessages(this.config.maxMessages);
    } catch (error) {
      logger.error({ err: error }, '提取消息失败');
      return;
    }
    for (const message of messages) {
      if (this.knownFingerprints.has(message.fingerprint)) {
        continue;
      }
      // 指纹去重：仅首次出现的消息触发回调
      this.knownFingerprints.add(message.fingerprint);
      try {
        onNewMessage(message);
      } catch (error) {
        // 回调异常仅记录，继续后续消息处理
        logger.error({ err: error, fingerprint: message.fingerprint }, '回调处理失败');
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => {
      this.pendingTimeout = setTimeout(() => {
        this.pendingTimeout = null;
        resolve();
      }, ms);
    });
  }
}
