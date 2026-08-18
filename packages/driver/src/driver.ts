import EventEmitter from 'node:events';
import { CdpClient } from './cdp/client.js';
import { MessageOps } from './dom/message-ops.js';
import { resolveSelectors } from './dom/selectors.js';
import { SendOps } from './dom/send-ops.js';
import { SessionOps } from './dom/session-ops.js';
import type { ConnectionStatus, DriverConfig, DriverEvents, KK9Message, KK9Session, PollingConfig, SelectorsConfig, SendResult } from './types/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('kk9-driver');

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface KK9Driver {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class KK9Driver extends EventEmitter {
  private readonly cdp: CdpClient;
  private readonly selectors: SelectorsConfig;
  private readonly sessionOps: SessionOps;
  private readonly messageOps: MessageOps;
  private readonly sendOps: SendOps;

  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly knownFingerprints = new Set<string>();

  constructor(private readonly config: DriverConfig) {
    super();
    this.selectors = resolveSelectors(config.selectors);
    this.cdp = new CdpClient(config.cdp);
    this.sessionOps = new SessionOps(this.cdp, this.selectors);
    this.messageOps = new MessageOps(this.cdp, this.selectors);
    this.sendOps = new SendOps(this.cdp, this.selectors);

    this.wireCdpEvents();
  }

  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
  }

  public async connect(): Promise<void> {
    await this.cdp.connect();
  }

  public async disconnect(): Promise<void> {
    this.stopPolling();
    await this.cdp.disconnect();
  }

  public async getSessions(): Promise<KK9Session[]> {
    return this.sessionOps.getSessions();
  }

  public async getCurrentSession(): Promise<KK9Session | null> {
    return this.sessionOps.getCurrentSession();
  }

  public async selectSession(sessionId: string): Promise<boolean> {
    return this.sessionOps.selectSession(sessionId);
  }

  public async getRecentMessages(limit = 20, session?: KK9Session): Promise<KK9Message[]> {
    const targetSession = session || (await this.getCurrentSession()) || undefined;
    return this.messageOps.getRecentMessages(limit, targetSession);
  }

  public async sendText(text: string, options: { verifyTimeoutMs?: number; targetSessionId?: string } = {}): Promise<SendResult> {
    return this.sendOps.sendText(text, options);
  }

  public async sendImage(imagePath: string, options: { verifyTimeoutMs?: number; targetSessionId?: string } = {}): Promise<SendResult> {
    return this.sendOps.sendImage(imagePath, options);
  }

  /**
   * 启动智能轮询监听器（未读会话优先 + 当前会话回退）
   */
  public startPolling(customPolling?: Partial<PollingConfig>): void {
    if (this.isPolling) return;

    const pollConfig: PollingConfig = {
      intervalMs: customPolling?.intervalMs ?? this.config.polling?.intervalMs ?? 3000,
      switchDelayMs: customPolling?.switchDelayMs ?? this.config.polling?.switchDelayMs ?? 500,
      maxSessionsPerCycle: customPolling?.maxSessionsPerCycle ?? this.config.polling?.maxSessionsPerCycle ?? 10,
      maxMessagesPerSession: customPolling?.maxMessagesPerSession ?? this.config.polling?.maxMessagesPerSession ?? 20,
    };

    this.isPolling = true;
    log.info(pollConfig, '启动消息智能轮询器');

    const pollLoop = async (): Promise<void> => {
      if (!this.isPolling) return;

      try {
        if (this.getStatus() === 'connected') {
          await this.executePollCycle(pollConfig);
        }
      } catch (err) {
        log.warn({ err: String(err) }, '轮询周期异常，等待下一周期');
      }

      if (this.isPolling) {
        this.pollTimer = setTimeout(() => {
          void pollLoop();
        }, pollConfig.intervalMs);
      }
    };

    void pollLoop();
  }

  public stopPolling(): void {
    this.isPolling = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('已停止消息轮询器');
  }

  private async executePollCycle(config: PollingConfig): Promise<void> {
    const sessions = await this.getSessions();
    const unreadSessions = sessions.filter((s) => s.unread);

    if (unreadSessions.length > 0) {
      const batch = unreadSessions.slice(0, config.maxSessionsPerCycle);
      for (const session of batch) {
        if (!this.isPolling) break;

        const switched = await this.selectSession(session.id);
        if (switched) {
          await new Promise((r) => setTimeout(r, config.switchDelayMs));
          await this.collectAndEmitMessages(session, config.maxMessagesPerSession);
        }
      }
    } else {
      // 无未读会话时，回退到当前激活会话提取
      const current = await this.getCurrentSession();
      if (current) {
        await this.collectAndEmitMessages(current, config.maxMessagesPerSession);
      }
    }
  }

  private async collectAndEmitMessages(session: KK9Session, limit: number): Promise<void> {
    const messages = await this.getRecentMessages(limit, session);
    for (const msg of messages) {
      // 过滤自身发出的消息
      if (msg.isMe) continue;

      if (!this.knownFingerprints.has(msg.id)) {
        this.knownFingerprints.add(msg.id);
        // 限制内存指纹集合大小，防止无限内存增长
        if (this.knownFingerprints.size > 10000) {
          const firstKey = this.knownFingerprints.values().next().value;
          if (firstKey) this.knownFingerprints.delete(firstKey);
        }

        log.debug({ id: msg.id, sender: msg.sender, content: msg.content }, '捕获新消息并触发事件');
        this.emit('message', msg);
      }
    }
  }

  private wireCdpEvents(): void {
    this.cdp.on('status', (status: ConnectionStatus) => this.emit('status', status));
    this.cdp.on('heartbeat', (uptime: number) => this.emit('heartbeat', uptime));
    this.cdp.on('error', (err: Error) => this.emit('error', err));
  }
}
