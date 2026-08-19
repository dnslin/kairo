import EventEmitter from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient } from './cdp/client.js';
import { MessageOps } from './dom/message-ops.js';
import { OrgOps } from './dom/org-ops.js';
import { resolveSelectors } from './dom/selectors.js';
import { SendOps } from './dom/send-ops.js';
import { SessionOps } from './dom/session-ops.js';
import type {
  ConnectionStatus,
  DriverConfig,
  DriverEvents,
  FormattedText,
  KK9Employee,
  KK9Message,
  KK9RecalledEvent,
  KK9ReplyTarget,
  KK9Session,
  PollingConfig,
  SelectorsConfig,
  SendFileOptions,
  SendOptions,
  SendResult,
} from './types/index.js';
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
  private readonly orgOps: OrgOps;
  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly knownFingerprints = new Set<string>();
  private readonly knownRecalledIds = new Set<string>();
  constructor(private readonly config: DriverConfig) {
    super();
    this.selectors = resolveSelectors(config.selectors);
    this.cdp = new CdpClient(config.cdp);
    this.sessionOps = new SessionOps(this.cdp, this.selectors);
    this.messageOps = new MessageOps(this.cdp, this.selectors);
    this.sendOps = new SendOps(this.cdp, this.selectors);
    this.orgOps = new OrgOps(this.cdp);
    this.wireCdpEvents();
  }

  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
  }

  public async connect(): Promise<void> {
    await this.cdp.connect();
    await this.setupCancelMessageHook();
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

  /**
   * 发送纯文本消息
   */
  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.sendOps.sendText(text, options);
  }

  /**
   * 发送富文本格式化消息
   */
  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    return this.sendOps.sendRichText(content, options);
  }

  /**
   * 快捷发送引用/回复消息
   */
  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    return this.sendOps.sendReply(replyTo, content, options);
  }

  /**
   * 发送本地文件
   */
  public async sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    return this.sendOps.sendFile(filePath, options);
  }

  /**
   * 发送本地图片
   */
  public async sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    return this.sendOps.sendImage(imagePath, options);
  }

  /**
   * 消息撤回 (Recall / CancelMessage) 全局 API
   */
  public async recallMessage(
    messageId: string,
    session?: KK9Session | string
  ): Promise<boolean> {
    const sessionId = typeof session === 'string' ? session : session?.id;
    return this.sendOps.recallMessage(messageId, sessionId);
  }

  /**
   * 处理并派发消息撤回事件 (自动去重)
   */
  public handleRecalledEvent(event: KK9RecalledEvent): void {
    if (!event.messageId || this.knownRecalledIds.has(event.messageId)) {
      return;
    }
    this.knownRecalledIds.add(event.messageId);
    if (this.knownRecalledIds.size > 10000) {
      const firstKey = this.knownRecalledIds.values().next().value;
      if (firstKey) this.knownRecalledIds.delete(firstKey);
    }

    log.info({ messageId: event.messageId, sender: event.sender }, '捕获到消息撤回事件并派发');
    this.emit('recalled', event);
  }

  /**
   * 从 KK9 客户端抽取企业全量员工档案名录
   */
  public async getOrgEmployees(timeoutMs?: number): Promise<KK9Employee[]> {
    return this.orgOps.getEmployees(timeoutMs);
  }

  /**
   * 按 UID 精确单点查询员工档案
   */
  public async getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    return this.orgOps.getUserProfile(userId);
  }

  /**
   * 启动智能轮询监听器（未读会话/@优先 + 当前会话回退）
   */
  public startPolling(customPolling?: Partial<PollingConfig>): void {
    if (this.isPolling) return;

    const pollConfig: PollingConfig = {
      intervalMs: customPolling?.intervalMs ?? this.config.polling?.intervalMs ?? 3000,
      switchDelayMs: customPolling?.switchDelayMs ?? this.config.polling?.switchDelayMs ?? 500,
      maxSessionsPerCycle:
        customPolling?.maxSessionsPerCycle ?? this.config.polling?.maxSessionsPerCycle ?? 10,
      maxMessagesPerSession:
        customPolling?.maxMessagesPerSession ?? this.config.polling?.maxMessagesPerSession ?? 20,
      autoSwitchSession:
        customPolling?.autoSwitchSession ?? this.config.polling?.autoSwitchSession ?? true,
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
    // 若禁用自动切换会话，仅在当前激活会话提取增量消息与撤回事件
    if (config.autoSwitchSession === false) {
      const current = await this.getCurrentSession();
      if (current) {
        await this.collectAndEmitMessages(current, config.maxMessagesPerSession);
      }
      return;
    }

    const sessions = await this.getSessions();
    // 排序：包含未读 @ 的会话最优先处理，其次是普通未读会话
    const unreadSessions = sessions
      .filter(s => s.unread || s.unreadAt)
      .sort((a, b) => {
        if (a.unreadAt && !b.unreadAt) return -1;
        if (!a.unreadAt && b.unreadAt) return 1;
        return (b.unreadCount || 0) - (a.unreadCount || 0);
      });

    if (unreadSessions.length > 0) {
      const batch = unreadSessions.slice(0, config.maxSessionsPerCycle);
      for (const session of batch) {
        if (!this.isPolling) break;

        const switched = await this.selectSession(session.id);
        if (switched) {
          await sleep(config.switchDelayMs);
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

  private async collectRecalledEvents(sessionId: string): Promise<void> {
    const script = `
      (() => {
        const events = [];
        if (Array.isArray(window.__kkbot_recalled_events) && window.__kkbot_recalled_events.length > 0) {
          events.push(...window.__kkbot_recalled_events.splice(0, window.__kkbot_recalled_events.length));
        }
        const recallNodes = document.querySelectorAll('.rcd-item.system-msg, .message-item.system-msg, .rcd-recall-msg, .system-recall');
        for (const node of recallNodes) {
          const text = node.textContent?.trim() || '';
          if (text.includes('撤回了一条消息')) {
            const id = node.getAttribute('id') || node.getAttribute('data-id') || ('recall_' + text + '_' + Date.now());
            const sender = text.replace(/撤回了一条消息.*$/, '').trim() || '某人';
            events.push({
              messageId: id,
              sessionId: ${JSON.stringify(sessionId)},
              sender,
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now()
            });
          }
        }
        return events;
      })()
    `;
    try {
      const events = await this.cdp.evaluate<KK9RecalledEvent[]>(script);
      if (Array.isArray(events)) {
        for (const evt of events) {
          this.handleRecalledEvent(evt);
        }
      }
    } catch {
      // 忽略临时执行异常
    }
  }

  private async setupCancelMessageHook(): Promise<void> {
    try {
      await this.cdp.sendCommand('Runtime.enable');
      await this.cdp.sendCommand('Runtime.addBinding', { name: '__kkbot_on_recalled' }).catch(() => {});

      this.cdp.on('Runtime.bindingCalled', (rawParams: unknown) => {
        const params = rawParams as { name?: string; payload?: string };
        if (params?.name === '__kkbot_on_recalled' && typeof params?.payload === 'string') {
          try {
            const evt = JSON.parse(params.payload) as KK9RecalledEvent;
            this.handleRecalledEvent(evt);
          } catch {
            // 忽略解析异常
          }
        }
      });
    } catch {
      // 忽略 CDP binding 异常
    }

    const hookScript = `
      (() => {
        if (window.__kkbot_cancel_hooked) return true;
        window.__kkbot_cancel_hooked = true;
        window.__kkbot_recalled_events = window.__kkbot_recalled_events || [];

        function notifyRecalled(evt) {
          window.__kkbot_recalled_events.push(evt);
          if (typeof window.__kkbot_on_recalled === 'function') {
            try {
              window.__kkbot_on_recalled(JSON.stringify(evt));
            } catch {}
          }
        }

        const getMainPageVm = () => document.querySelector('.main-page, #app, .app-container')?.__vue__;
        const getEditorVm = () => document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const getChatContentVm = () => document.querySelector('.chat-content, .message-content-box')?.__vue__;

        const bus = getMainPageVm()?.$bus || getEditorVm()?.$bus || getChatContentVm()?.$bus || (window.vueBus || window.$bus);
        if (bus && typeof bus.$on === 'function') {
          bus.$on('CancelMessage', (data) => {
            if (data && (data.msgID || data.msgId || data.id)) {
              notifyRecalled({
                messageId: String(data.msgID || data.msgId || data.id),
                sessionId: String(data.sessionID || data.sessionId || ''),
                sender: String(data.sender || data.senderName || ''),
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now()
              });
            }
          });
          bus.$on('receive-message', (data) => {
            if (data && (data.event === 'CancelMessage' || data.type === 'CancelMessage')) {
              notifyRecalled({
                messageId: String(data.msgID || data.msgId || data.id || ''),
                sessionId: String(data.sessionID || data.sessionId || ''),
                sender: String(data.sender || data.senderName || ''),
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now()
              });
            }
          });
        }
        return true;
      })()
    `;
    try {
      await this.cdp.evaluate(hookScript);
    } catch {
      // 忽略初始注入异常
    }
  }

  private async collectAndEmitMessages(session: KK9Session, limit: number): Promise<void> {
    await this.collectRecalledEvents(session.id);
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

        // 如果是 @ 提及消息，派发专用 at 事件
        if (msg.atMe || msg.atAll || msg.mentions?.isAtMe || msg.mentions?.isAtAll) {
          log.info({ id: msg.id, sender: msg.sender, mentions: msg.mentions }, '捕获到 @ 提及事件');
          this.emit('at', msg);
        }
      }
    }
  }

  private wireCdpEvents(): void {
    this.cdp.on('status', (status: ConnectionStatus) => this.emit('status', status));
    this.cdp.on('heartbeat', (uptime: number) => this.emit('heartbeat', uptime));
    this.cdp.on('error', (err: Error) => this.emit('error', err));
  }
}
