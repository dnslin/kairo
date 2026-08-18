import type { MessageExtractor, Message, SessionInfo } from '../extract/index.js';
import type { WatcherConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('watch');

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
  // TODO(#17): store 模块实现后，从持久化加载已处理指纹并定期清理
  private knownFingerprints = new Set<string>();

  constructor(
    private readonly extractor: MessageExtractor,
    private readonly config: WatcherConfig
  ) {
    log.debug('MessageWatcher 已初始化');
  }

  start(onNewMessage: (msg: Message) => void): void {
    if (this.running) {
      return;
    }

    this.running = true;
    log.info('启动消息监听');

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
    log.info('停止消息监听');
  }

  private async poll(onNewMessage: (msg: Message) => void): Promise<void> {
    // 获取全部会话
    let sessions: SessionInfo[];
    try {
      sessions = await this.extractor.getAllSessions();
    } catch (error) {
      log.error({ err: error }, '获取会话列表失败');
      return;
    }

    const unreadSessions = sessions.filter(s => s.unread);

    // 无未读 → 回退到当前会话轮询
    if (unreadSessions.length === 0) {
      await this.pollCurrentSession(onNewMessage);
      return;
    }

    // 依次处理未读会话
    const switchDelayMs = this.config.switchDelayMs ?? 500;
    const limit = this.config.maxSessionsPerCycle ?? 10;
    const toProcess = unreadSessions.slice(0, limit);
    for (const session of toProcess) {
      try {
        const messages = await this.extractor.getMessagesFromSession(
          session.id, this.config.maxMessages, switchDelayMs
        );
        for (const msg of messages) {
          if (!this.knownFingerprints.has(msg.fingerprint)) {
            this.knownFingerprints.add(msg.fingerprint);
            try {
              onNewMessage(msg);
            } catch (cbError) {
              log.error({ err: cbError, fingerprint: msg.fingerprint }, '回调处理失败');
            }
          }
        }
      } catch (error) {
        log.error({ err: error, sessionId: session.id }, '处理未读会话失败，跳过');
      }
    }
  }

  /** 回退路径：轮询当前会话的最近消息 */
  private async pollCurrentSession(onNewMessage: (msg: Message) => void): Promise<void> {
    let messages: Message[] = [];
    try {
      messages = await this.extractor.getRecentMessages(this.config.maxMessages);
    } catch (error) {
      log.error({ err: error }, '提取消息失败');
      return;
    }
    for (const message of messages) {
      if (this.knownFingerprints.has(message.fingerprint)) {
        continue;
      }
      this.knownFingerprints.add(message.fingerprint);
      try {
        onNewMessage(message);
      } catch (error) {
        log.error({ err: error, fingerprint: message.fingerprint }, '回调处理失败');
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
