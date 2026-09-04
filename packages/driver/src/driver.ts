import EventEmitter from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient } from './cdp/client.js';
import { KK9EventBridge } from './bridge/event-bridge.js';
import { BridgeSessionOps } from './bridge/session-ops.js';
import { BridgeMessageOps } from './bridge/message-ops.js';
import { BridgeOrgOps } from './bridge/org-ops.js';
import { createMessageIdentityKey } from './bridge/converter.js';

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
import { InMemorySendOperationStore, type SendOperationStore } from './send-operation.js';
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
  private readonly bridgeSessionOps: BridgeSessionOps;
  private readonly bridgeMessageOps: BridgeMessageOps;
  private readonly bridgeOrgOps: BridgeOrgOps;

  // 保留旧版 DOM 操作层（作为后备回退）
  private readonly domSessionOps: SessionOps;
  private readonly domMessageOps: MessageOps;
  private readonly domSendOps: SendOps;
  private readonly domOrgOps: OrgOps;

  private isPolling = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();
  private readonly knownBotSentMessageKeys = new Set<string>();

  constructor(
    private readonly config: DriverConfig,
    sendOperationStore: SendOperationStore = new InMemorySendOperationStore()
  ) {
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
    this.bridgeMessageOps = new BridgeMessageOps(this.cdp, sendOperationStore);
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
  }

  public async disconnect(): Promise<void> {
    this.invalidated = true;
    this.stopPolling();
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

  private async resolveSessionTarget(target: string): Promise<KK9Session | null> {
    const normalizedTarget = target.trim();
    if (!normalizedTarget) return null;

    const sessions = await this.getSessions();
    const idMatch = sessions.find(session => session.id === normalizedTarget);
    if (idMatch) return idMatch;

    const nameMatches = sessions.filter(session => session.name === normalizedTarget);
    return nameMatches.length === 1 ? nameMatches[0]! : null;
  }

  private async resolveTargetOptions<T extends SendOptions>(options: T): Promise<T | null> {
    if (!options.targetSessionId) return options;
    const targetSession = await this.resolveSessionTarget(options.targetSessionId);
    return targetSession ? { ...options, targetSessionId: targetSession.id } : null;
  }

  private unresolvedTargetResult(target: string): SendResult {
    return {
      success: false,
      status: 'failed',
      error: `目标会话无法唯一解析 [${target}]`,
      isPreTrigger: true,
    };
  }

  public async getCurrentSession(): Promise<KK9Session | null> {
    const session = await this.bridgeSessionOps.getCurrentSession();
    if (session) {
      return session;
    }
    return this.domSessionOps.getCurrentSession();
  }

  public async selectSession(sessionId: string): Promise<boolean> {
    const targetSession = await this.resolveSessionTarget(sessionId);
    if (!targetSession) return false;

    const success = await this.bridgeSessionOps.selectSession(targetSession.id);
    if (success) return true;
    return this.domSessionOps.selectSession(targetSession.id);
  }

  /**
   * 显式消除指定会话的未读红点（优先通过 IPC readMessage 同步到服务端）
   */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    const targetSession = await this.resolveSessionTarget(sessionId);
    return targetSession ? this.bridgeSessionOps.markSessionRead(targetSession.id) : false;
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
    const bridgeResult = await this.bridgeMessageOps.getRecentMessagesResult(
      limit,
      targetSession,
      this.knownBotSentMessageKeys,
      this.config.currentUserId
    );

    if (bridgeResult.kind === 'ok') {
      return bridgeResult.value;
    }

    if (targetSession) {
      const activeSessionId = await this.domSessionOps.getActiveSessionId();
      if (activeSessionId !== targetSession.id) {
        log.warn(
          {
            targetSessionId: targetSession.id,
            activeSessionId,
            bridgeError: bridgeResult.error,
          },
          '显式目标不是当前 DOM 会话，拒绝历史消息 fallback'
        );
        return [];
      }
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
    const resolvedOptions = await this.resolveTargetOptions(options);
    if (!resolvedOptions) return this.unresolvedTargetResult(options.targetSessionId || '');

    const res = await this.bridgeMessageOps.sendText(text, resolvedOptions);
    if (
      !res.success &&
      res.isPreTrigger &&
      !resolvedOptions.targetSessionId &&
      !resolvedOptions.operationId
    ) {
      const domRes = await this.domSendOps.sendText(text, resolvedOptions);
      this.rememberBotSentMessage(domRes, resolvedOptions.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, resolvedOptions.targetSessionId);
    return res;
  }

  /**
   * 发送富文本与带 @ 提及的消息
   */
  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const resolvedOptions = await this.resolveTargetOptions(options);
    if (!resolvedOptions) return this.unresolvedTargetResult(options.targetSessionId || '');

    const res = await this.bridgeMessageOps.sendRichText(content, resolvedOptions);
    if (
      !res.success &&
      res.isPreTrigger &&
      !resolvedOptions.targetSessionId &&
      !resolvedOptions.operationId
    ) {
      const domRes = await this.domSendOps.sendRichText(content, resolvedOptions);
      this.rememberBotSentMessage(domRes, resolvedOptions.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, resolvedOptions.targetSessionId);
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
    const resolvedOptions = await this.resolveTargetOptions(options);
    if (!resolvedOptions) return this.unresolvedTargetResult(options.targetSessionId || '');

    const res = await this.bridgeMessageOps.sendReply(replyTo, content, resolvedOptions);
    if (
      !res.success &&
      res.isPreTrigger &&
      !resolvedOptions.targetSessionId &&
      !resolvedOptions.operationId
    ) {
      const domRes = await this.domSendOps.sendReply(replyTo, content, resolvedOptions);
      this.rememberBotSentMessage(domRes, resolvedOptions.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, resolvedOptions.targetSessionId);
    return res;
  }

  /**
   * 发送文件
   */
  public async sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    const resolvedOptions = await this.resolveTargetOptions(options);
    if (!resolvedOptions) return this.unresolvedTargetResult(options.targetSessionId || '');

    const res = await this.bridgeMessageOps.sendFile(filePath, resolvedOptions);
    if (
      !res.success &&
      res.isPreTrigger &&
      !resolvedOptions.targetSessionId &&
      !resolvedOptions.operationId
    ) {
      const domRes = await this.domSendOps.sendFile(filePath, resolvedOptions);
      this.rememberBotSentMessage(domRes, resolvedOptions.targetSessionId);
      return domRes;
    }
    this.rememberBotSentMessage(res, resolvedOptions.targetSessionId);
    return res;
  }
  /**
   * 只查询发送操作状态，不触发新的发送动作
   */
  public getSendStatus(operationId: string): Promise<SendResult> {
    return this.bridgeMessageOps.getSendStatus(operationId);
  }

  /**
   * 发送本地图片
   */
  public async sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    const resolvedOptions = await this.resolveTargetOptions(options);
    if (!resolvedOptions) return this.unresolvedTargetResult(options.targetSessionId || '');

    const res = await this.bridgeMessageOps.sendImage(imagePath, resolvedOptions);
    if (
      !res.success &&
      res.isPreTrigger &&
      !resolvedOptions.targetSessionId &&
      !resolvedOptions.operationId
    ) {
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
    if (typeof session === 'string') {
      const targetSession = await this.resolveSessionTarget(session);
      return targetSession
        ? this.bridgeMessageOps.recallMessage(messageId, targetSession.id)
        : false;
    }
    return this.bridgeMessageOps.recallMessage(messageId, session?.id);
  }

  private handleRecalledEvent(event: KK9RecalledEvent): void {
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

  /**
   * 通过私聊会话 ID 或会话实体直接获取对应员工的详细档案
   * @param session 会话 ID 字符串（如 "0-9529"）或 KK9Session 实体
   * @returns 员工档案；若为群聊、无效输入或查询无果则返回 null
   */
  public async getEmployeeBySession(session: string | KK9Session): Promise<KK9Employee | null> {
    if (!session) return null;

    let targetSessionId = '';
    if (typeof session === 'object') {
      if (session.type !== 'private') {
        return null;
      }
      targetSessionId = session.id?.trim() || '';
    } else if (typeof session === 'string') {
      targetSessionId = session.trim();
    }

    if (!targetSessionId) return null;

    // 1. 如果格式是 "0-12345" 形式的标准私聊 sesUUID
    if (targetSessionId.startsWith('0-')) {
      const uid = targetSessionId.slice(2).trim();
      if (uid) {
        return this.getUserProfile(uid);
      }
    }

    // 2. 如果明确是群聊格式 "1-..." 或讨论组 "2-..."，直接拒止
    if (/^[123]-/.test(targetSessionId)) {
      return null;
    }

    // 3. 尝试通过会话名称或内部 ID 匹配会话
    const resolved = await this.resolveSessionTarget(targetSessionId);
    if (resolved && resolved.type === 'private' && resolved.id.startsWith('0-')) {
      const uid = resolved.id.slice(2).trim();
      if (uid) {
        return this.getUserProfile(uid);
      }
    }

    // 4. 若传入的是纯数字 UID 形式，尝试直接查询
    if (/^\d+$/.test(targetSessionId)) {
      return this.getUserProfile(targetSessionId);
    }

    return null;
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

  private async collectAndEmitMessages(session: KK9Session, limit: number): Promise<void> {
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
