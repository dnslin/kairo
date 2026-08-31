import EventEmitter from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient } from './cdp/client.js';
import { KK9EventBridge } from './bridge/event-bridge.js';
import { BridgeSessionOps } from './bridge/session-ops.js';
import { BridgeMessageOps } from './bridge/message-ops.js';
import { BridgeOrgOps } from './bridge/org-ops.js';
import { createMessageIdentityKey, normalizeRecalledEvent } from './bridge/converter.js';

import { OrgOps } from './dom/org-ops.js';
import { resolveSelectors } from './dom/selectors.js';
import { SendOps } from './dom/send-ops.js';
import { SessionOps } from './dom/session-ops.js';
import { MessageOps } from './dom/message-ops.js';

import type {
  CdpConnectionLostEvent,
  CompensationScanOptions,
  ConnectionStatus,
  DriverConfig,
  DriverEvents,
  DriverHealthEvent,
  DriverHealthSnapshot,
  FormattedText,
  IKK9Driver,
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
import { DriverError } from './utils/errors.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('kk9-driver');

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface KK9Driver {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class KK9Driver extends EventEmitter implements IKK9Driver {
  private readonly cdp: CdpClient;
  private readonly eventBridge: KK9EventBridge;
  private readonly startupGenerationId: string;
  private invalidated = false;
  private readonly selectors: SelectorsConfig;

  // Bridge 优先操作服务
  public bridgeSessionOps: BridgeSessionOps;
  public bridgeMessageOps: BridgeMessageOps;
  public bridgeOrgOps: BridgeOrgOps;

  // 保留旧版 DOM 操作层（作为后备回退与单元测试兼容）
  public domSessionOps: SessionOps;
  public domMessageOps: MessageOps;
  public domSendOps: SendOps;
  public domOrgOps: OrgOps;

  public get sessionOps(): SessionOps {
    return this.domSessionOps;
  }
  public set sessionOps(v: SessionOps) {
    this.domSessionOps = v;
  }

  public get messageOps(): MessageOps {
    return this.domMessageOps;
  }
  public set messageOps(v: MessageOps) {
    this.domMessageOps = v;
  }

  public get sendOps(): SendOps {
    return this.domSendOps;
  }
  public set sendOps(v: SendOps) {
    this.domSendOps = v;
  }

  public get orgOps(): OrgOps {
    return this.domOrgOps;
  }
  public set orgOps(v: OrgOps) {
    this.domOrgOps = v;
  }

  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private cancelBindingAttached = false;
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();
  private readonly knownBotSentMessageKeys = new Set<string>();

  private readonly handleCancelBinding = (rawParams: unknown): void => {
    if (
      !rawParams ||
      typeof rawParams !== 'object' ||
      !('name' in rawParams) ||
      !('payload' in rawParams) ||
      rawParams.name !== '__kkbot_on_recalled' ||
      typeof rawParams.payload !== 'string'
    ) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(rawParams.payload);
      const event = normalizeRecalledEvent(parsed);
      if (event) {
        this.handleRecalledEvent(event);
      }
    } catch {
      log.warn('解析撤回 binding 载荷失败');
    }
  };

  constructor(private readonly config: DriverConfig) {
    super();
    this.selectors = resolveSelectors(config.selectors);
    this.cdp = new CdpClient(config.cdp, {
      startupGenerationId: config.startupGenerationId,
    });
    this.startupGenerationId = this.cdp.getStartupGenerationId();
    this.eventBridge = new KK9EventBridge(
      {
        cdp: config.cdp,
        startupGenerationId: this.startupGenerationId,
        currentUserId: config.currentUserId,
        knownBotSentMessageKeys: this.knownBotSentMessageKeys,
      },
      this.cdp
    );

    // 初始化 Bridge 操作层
    this.bridgeSessionOps = new BridgeSessionOps(this.cdp);
    this.bridgeMessageOps = new BridgeMessageOps(this.cdp);
    this.bridgeOrgOps = new BridgeOrgOps(this.cdp);

    // 初始化 DOM 操作层 (保留)
    this.domSessionOps = new SessionOps(this.cdp, this.selectors);
    this.domMessageOps = new MessageOps(this.cdp, this.selectors);
    this.domSendOps = new SendOps(this.cdp, this.selectors);
    this.domOrgOps = new OrgOps(this.cdp);

    this.wireCdpEvents();
  }

  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
  }

  public getStartupGenerationId(): string {
    return this.startupGenerationId;
  }

  public getHealthSnapshot(): DriverHealthSnapshot {
    return {
      startupGenerationId: this.startupGenerationId,
      cdpStatus: this.cdp.getStatus(),
      cdpConnectionIdentity: this.cdp.getConnectionIdentity(),
      eventBridgeAttached: this.eventBridge.isAttached(),
      eventBridgeConnectionIdentity: this.eventBridge.getConnectionIdentity(),
    };
  }

  public async connect(): Promise<void> {
    if (this.invalidated) {
      throw new DriverError(
        `Driver 属于已失效的 startup generation ${this.startupGenerationId}，禁止原地重连`,
        'DRIVER_INVALIDATED'
      );
    }
    await this.eventBridge.connect();
    await this.setupCancelMessageHook();
  }

  public async disconnect(): Promise<void> {
    this.invalidated = true;
    this.stopPolling();
    if (this.cancelBindingAttached) {
      this.cdp.off('Runtime.bindingCalled', this.handleCancelBinding);
      this.cancelBindingAttached = false;
    }
    await this.eventBridge.disconnect();
  }

  /**
   * 优先通过 Bridge / IPC 获取会话列表，失败时回退至 DOM 遍历
   */
  public async getSessions(): Promise<KK9Session[]> {
    const sessions = await this.bridgeSessionOps.getSessions();
    if (sessions.length > 0) {
      return sessions;
    }
    return this.domSessionOps.getSessions();
  }

  public async getCurrentSession(): Promise<KK9Session | null> {
    const session = await this.bridgeSessionOps.getCurrentSession();
    if (session) {
      return session;
    }
    return this.domSessionOps.getCurrentSession();
  }

  public async selectSession(sessionId: string): Promise<boolean> {
    const success = await this.bridgeSessionOps.selectSession(sessionId);
    if (success) {
      return true;
    }
    return this.domSessionOps.selectSession(sessionId);
  }

  /**
   * 显式消除指定会话的未读红点（优先通过 IPC readMessage 同步到服务端）
   */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    return this.bridgeSessionOps.markSessionRead(sessionId);
  }

  public recordBotSentMessageId(sessionId: string, messageId: string): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSessionId || !normalizedMessageId) return;
    this.knownBotSentMessageKeys.add(
      createMessageIdentityKey(normalizedSessionId, normalizedMessageId)
    );
    if (this.knownBotSentMessageKeys.size > 10000) {
      const firstKey = this.knownBotSentMessageKeys.values().next().value;
      if (firstKey) this.knownBotSentMessageKeys.delete(firstKey);
    }
  }

  public isBotSentMessageId(sessionId: string, messageId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSessionId || !normalizedMessageId) return false;
    return this.knownBotSentMessageKeys.has(
      createMessageIdentityKey(normalizedSessionId, normalizedMessageId)
    );
  }

  private rememberBotSentMessage(result: SendResult, targetSessionId?: string): void {
    if (!result.success || !result.messageId) return;
    const sessionId = targetSessionId?.trim();
    if (!sessionId) return;
    this.recordBotSentMessageId(sessionId, result.messageId);
  }

  /**
   * 优先通过 Bridge / IPC getMessages 获取会话历史，失败时回退至 DOM 提取
   */
  public async getRecentMessages(limit = 20, session?: KK9Session): Promise<KK9Message[]> {
    const targetSession = session || (await this.getCurrentSession()) || undefined;
    const messages = await this.bridgeMessageOps.getRecentMessages(
      limit,
      targetSession,
      this.knownBotSentMessageKeys,
      this.config.currentUserId
    );

    if (messages.length > 0) {
      return messages;
    }

    return this.domMessageOps.getRecentMessages(
      limit,
      targetSession,
      this.knownBotSentMessageKeys,
      this.config.currentUserId
    );
  }

  public async scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]> {
    const toTimestamp = options.toTimestamp ?? Date.now();
    if (options.fromTimestamp > toTimestamp) {
      throw new DriverError(
        `补偿扫描时间窗口无效: from=${options.fromTimestamp}, to=${toTimestamp}`,
        'COMPENSATION_SCAN_INVALID_WINDOW'
      );
    }
    if (this.getStatus() !== 'connected') {
      throw new DriverError(
        `补偿扫描需要已连接的 CDP (当前状态: ${this.getStatus()})`,
        'COMPENSATION_SCAN_UNAVAILABLE'
      );
    }

    try {
      const allSessions = await this.getSessions();
      const requestedIds = options.sessionIds ? new Set(options.sessionIds) : null;
      const sessions = requestedIds
        ? allSessions.filter(session => requestedIds.has(session.id))
        : allSessions;
      const maxMessages = options.maxMessagesPerSession ?? 20;
      const switchDelayMs = options.switchDelayMs ?? this.config.polling?.switchDelayMs ?? 500;
      const seen = new Set<string>();
      const recovered: KK9Message[] = [];

      for (const session of sessions) {
        const switched = await this.selectSession(session.id);
        if (!switched) {
          throw new DriverError(
            `补偿扫描切换会话失败: ${session.id}`,
            'COMPENSATION_SCAN_SESSION_SWITCH_FAILED'
          );
        }
        if (switchDelayMs > 0) {
          await sleep(switchDelayMs);
        }

        const messages = await this.getRecentMessages(maxMessages, session);
        for (const message of messages) {
          if (message.timestamp < options.fromTimestamp || message.timestamp > toTimestamp) {
            continue;
          }
          const messageId = message.messageId || message.id;
          const key = createMessageIdentityKey(message.sessionId, messageId);

          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          recovered.push(message);
        }
      }

      return recovered;
    } catch (err) {
      if (err instanceof DriverError) {
        throw err;
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new DriverError(`补偿扫描失败: ${cause.message}`, 'COMPENSATION_SCAN_FAILED', cause);
    }
  }

  /**
   * 发送纯文本消息
   */
  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    const res = await this.bridgeMessageOps.sendText(text, options);
    if (!res.success && res.isPreTrigger && !options.targetSessionId) {
      const domRes = await this.domSendOps.sendText(text, options);
      this.rememberBotSentMessage(domRes, options.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, options.targetSessionId);
    return res;
  }

  /**
   * 发送富文本与带 @ 提及的消息
   */
  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const res = await this.bridgeMessageOps.sendRichText(content, options);
    if (!res.success && res.isPreTrigger && !options.targetSessionId) {
      const domRes = await this.domSendOps.sendRichText(content, options);
      this.rememberBotSentMessage(domRes, options.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, options.targetSessionId);
    return res;
  }

  /**
   * 发送引用/回复消息
   */
  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const res = await this.bridgeMessageOps.sendReply(replyTo, content, options);
    if (!res.success && res.isPreTrigger && !options.targetSessionId) {
      const domRes = await this.domSendOps.sendReply(replyTo, content, options);
      this.rememberBotSentMessage(domRes, options.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, options.targetSessionId);
    return res;
  }

  /**
   * 发送文件
   */
  public async sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    const res = await this.bridgeMessageOps.sendFile(filePath, options);
    if (!res.success && res.isPreTrigger && !options.targetSessionId) {
      const domRes = await this.domSendOps.sendFile(filePath, options);
      this.rememberBotSentMessage(domRes, options.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, options.targetSessionId);
    return res;
  }

  /**
   * 发送本地图片
   */
  public async sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    let resolvedOptions = options;
    if (options.targetSessionId) {
      const sessions = await this.getSessions();
      const idMatch = sessions.find(session => session.id === options.targetSessionId);
      const nameMatches = sessions.filter(session => session.name === options.targetSessionId);
      const targetSession = idMatch ?? (nameMatches.length === 1 ? nameMatches[0] : undefined);
      if (!targetSession) {
        return {
          success: false,
          error: `图片目标会话无法唯一解析 [${options.targetSessionId}]`,
          isPreTrigger: true,
        };
      }

      const switched = await this.selectSession(targetSession.id);
      if (!switched) {
        return {
          success: false,
          error: `图片目标会话切换失败 [${targetSession.id}]`,
          isPreTrigger: true,
        };
      }
      await sleep(300);

      const current = await this.getCurrentSession();
      if (!current || current.id !== targetSession.id) {
        return {
          success: false,
          error: `图片目标会话未激活 [${targetSession.id}]`,
          isPreTrigger: true,
        };
      }
      resolvedOptions = { ...options, targetSessionId: targetSession.id };
    }

    const res = await this.bridgeMessageOps.sendImage(imagePath, resolvedOptions);
    if (!res.success && res.isPreTrigger && !resolvedOptions.targetSessionId) {
      const domRes = await this.domSendOps.sendImage(imagePath, resolvedOptions);
      this.rememberBotSentMessage(domRes, resolvedOptions.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, resolvedOptions.targetSessionId);
    return res;
  }

  /**
   * 消息撤回 (Recall / CancelMessage)
   */
  public async recallMessage(messageId: string, session?: KK9Session | string): Promise<boolean> {
    const sessionId = typeof session === 'string' ? session : session?.id;
    return this.bridgeMessageOps.recallMessage(messageId, sessionId);
  }

  public handleRecalledEvent(event: KK9RecalledEvent): void {
    if (!event.messageId || !event.sessionId) {
      log.warn(
        { messageId: event.messageId, sessionId: event.sessionId },
        '丢弃缺少入站身份字段的撤回事件'
      );
      return;
    }
    const messageKey = createMessageIdentityKey(event.sessionId, event.messageId);

    if (this.knownRecalledMessageKeys.has(messageKey)) {
      return;
    }
    this.knownRecalledMessageKeys.add(messageKey);
    if (this.knownRecalledMessageKeys.size > 10000) {
      const firstKey = this.knownRecalledMessageKeys.values().next().value;
      if (firstKey) this.knownRecalledMessageKeys.delete(firstKey);
    }

    log.info({ messageId: event.messageId, sender: event.sender }, '捕获到消息撤回事件并派发');
    this.emit('recalled', event);
  }

  /**
   * 优先通过 Bridge / IPC 递归遍历企业全量员工档案
   */
  public async getOrgEmployees(timeoutMs?: number): Promise<KK9Employee[]> {
    const employees = await this.bridgeOrgOps.getOrgEmployees(timeoutMs);
    if (employees.length > 0) {
      return employees;
    }
    return this.domOrgOps.getEmployees(timeoutMs);
  }

  /**
   * 按 UID 精确单点查询员工档案
   */
  public async getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    const profile = await this.bridgeOrgOps.getUserProfile(userId);
    if (profile) {
      return profile;
    }
    return this.domOrgOps.getUserProfile(userId);
  }

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
    if (config.autoSwitchSession === false) {
      const current = await this.getCurrentSession();
      if (current) {
        await this.collectAndEmitMessages(current, config.maxMessagesPerSession);
      }
      return;
    }

    const sessions = await this.getSessions();
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
          const nativeId = node.getAttribute('data-msgid');
          if (text.includes('撤回了一条消息') && nativeId) {
            events.push({
              messageId: nativeId,
              sessionId: ${JSON.stringify(sessionId)},
              sender: 'unknown',
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
      // 忽略临时异常
    }
  }

  private async setupCancelMessageHook(): Promise<void> {
    if (!this.cancelBindingAttached) {
      try {
        await this.cdp.sendCommand('Runtime.enable');
        await this.cdp.sendCommand('Runtime.addBinding', { name: '__kkbot_on_recalled' });
        this.cdp.on('Runtime.bindingCalled', this.handleCancelBinding);
        this.cancelBindingAttached = true;
      } catch (err) {
        log.warn({ err: String(err) }, '撤回 binding 注入失败，保留 EventBridge 原生撤回路径');
      }
    }

    const hookScript = `
        if (typeof window.__kkbot_cancel_cleanup === 'function') {
          try { window.__kkbot_cancel_cleanup(); } catch (e) {}
        }
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

        function parseRecall(m, defaultSessionId) {
          if (!m) return null;
          let c = m.content;
          if (typeof c === 'string' && c.includes('CancelMessage')) {
            try { c = JSON.parse(c); } catch {}
          }
          if (c && (c.event === 'CancelMessage' || c.type === 'CancelMessage')) {
            return {
              messageId: String(c.msgID || c.msgId || c.id || m.msgID || m.id || ''),
              sessionId: String(m.sessionID || m.sessionId || defaultSessionId || ''),
              sender: String(m.sender || m.senderName || c.sender || ''),
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now()
            };
          }
          if (m.event === 'CancelMessage' || m.type === 'CancelMessage') {
            return {
              messageId: String(m.msgID || m.msgId || m.id || ''),
              sessionId: String(m.sessionID || m.sessionId || defaultSessionId || ''),
              sender: String(m.sender || m.senderName || ''),
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now()
            };
          }
          return null;
        }

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
            if (!data) return;
            const msgs = Array.isArray(data.message) ? data.message : Array.isArray(data.messages) ? data.messages : [data];
            for (const m of msgs) {
              const evt = parseRecall(m, data.session?.sesUUID || data.session?.id);
              if (evt && evt.messageId) {
                notifyRecalled(evt);
              }
            }
          });
        }
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
      const messageKey = createMessageIdentityKey(msg.sessionId, msg.id);

      if (!this.knownMessageKeys.has(messageKey)) {
        this.knownMessageKeys.add(messageKey);
        if (this.knownMessageKeys.size > 10000) {
          const firstKey = this.knownMessageKeys.values().next().value;
          if (firstKey) this.knownMessageKeys.delete(firstKey);
        }

        log.debug({ id: msg.id, sender: msg.sender, content: msg.content }, '捕获新消息并触发事件');
        this.emit('message', msg);

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
    this.cdp.on('connection_lost', (event: CdpConnectionLostEvent) => {
      this.invalidated = true;
      const health: DriverHealthEvent = {
        kind: 'cdp_invalidated',
        startupGenerationId: this.startupGenerationId,
        connectionIdentity: event.connectionIdentity,
        observedAt: event.observedAt,
        cause: event.cause,
      };
      this.emit('health', health);
    });

    this.eventBridge.on('message', (message: KK9Message) => this.emit('message', message));
    this.eventBridge.on('at', (message: KK9Message) => this.emit('at', message));
    this.eventBridge.on('recalled', (event: KK9RecalledEvent) => this.handleRecalledEvent(event));
    this.eventBridge.on('health', (event: DriverHealthEvent) => {
      this.invalidated = true;
      this.emit('health', event);
    });
    this.eventBridge.on('error', (err: Error) => this.emit('error', err));
  }
}
