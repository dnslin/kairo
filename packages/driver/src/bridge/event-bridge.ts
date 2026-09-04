import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import { CdpClient } from '../cdp/client.js';
import type {
  CdpConfig,
  CdpConnectionIdentity,
  CdpConnectionLostEvent,
  ConnectionStatus,
  DriverConfig,
  DriverHealthEvent,
  EventBridgeConfig,
  DriverEvents,
  KK9Message,
  KK9RecalledEvent,
  KK9Session,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  createMessageIdentityKey,
  type InboundNormalizationDiagnostic,
  extractRecalledEventsFromPayload,
  normalizeNativeMessage,
  normalizeRecalledEvent,
  toSafeString,
} from './converter.js';

const log = createChildLogger('event-bridge');

const DEFAULT_BINDING_NAME = '__kairo_native_bridge';
const DEFAULT_MAX_MESSAGE_IDS = 10000;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface KK9EventBridge {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class KK9EventBridge extends EventEmitter {
  private readonly cdp: CdpClient;
  private readonly startupGenerationId: string;
  private readonly bindingName: string;
  private readonly maxMessageIds: number;
  private readonly currentUserId?: string | number;
  private readonly enableRecallHook: boolean;
  private attached = false;
  private isConnecting = false;
  private lastAttachError: Error | null = null;
  private injectionIdentity: CdpConnectionIdentity | null = null;
  private readonly knownMessageKeys = new Set<string>();
  private readonly knownRecalledMessageKeys = new Set<string>();
  private readonly knownBotSentMessageKeys: Set<string>;

  constructor(
    config: EventBridgeConfig | DriverConfig | { cdp: CdpConfig },
    cdpClient?: CdpClient
  ) {
    super();
    const bridgeConfig = config as EventBridgeConfig;
    this.startupGenerationId = bridgeConfig.startupGenerationId ?? randomUUID();
    this.bindingName = bridgeConfig.bindingName || DEFAULT_BINDING_NAME;
    this.maxMessageIds = bridgeConfig.maxMessageIds || DEFAULT_MAX_MESSAGE_IDS;
    this.currentUserId = bridgeConfig.currentUserId;
    this.enableRecallHook = bridgeConfig.enableRecallHook ?? true;
    this.knownBotSentMessageKeys = bridgeConfig.knownBotSentMessageKeys ?? new Set<string>();

    this.cdp =
      cdpClient || new CdpClient(config.cdp, { startupGenerationId: this.startupGenerationId });
    this.wireCdpEvents();
  }

  /**
   * 获取底层连接状态
   */
  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
  }
  public getStartupGenerationId(): string {
    return this.startupGenerationId;
  }

  public getConnectionIdentity(): CdpConnectionIdentity | null {
    return this.injectionIdentity;
  }

  /**
   * 检查页面 Hook 是否已成功注入
   */
  public isAttached(): boolean {
    return this.attached;
  }

  /**
   * 获取底层 CDP 客户端实例
   */
  public getCdpClient(): CdpClient {
    return this.cdp;
  }

  /**
   * 记录由 Bot 自身发出的消息身份（sessionId:nativeMessageId）。
   */
  public recordBotSentMessageId(sessionId: string, messageId: string): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSessionId || !normalizedMessageId) return;
    const messageKey = createMessageIdentityKey(normalizedSessionId, normalizedMessageId);
    this.knownBotSentMessageKeys.add(messageKey);
    if (this.knownBotSentMessageKeys.size > this.maxMessageIds) {
      const firstKey = this.knownBotSentMessageKeys.values().next().value;
      if (firstKey) this.knownBotSentMessageKeys.delete(firstKey);
    }
  }

  /**
   * 判断指定会话中的消息 ID 是否为 Bot 自身发出。
   */
  public isBotSentMessageId(sessionId: string, messageId: string): boolean {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId.trim();
    if (!normalizedSessionId || !normalizedMessageId) return false;
    return this.knownBotSentMessageKeys.has(
      createMessageIdentityKey(normalizedSessionId, normalizedMessageId)
    );
  }

  /**
   * 连接 CDP 并完成原生事件桥注入
   */
  public async connect(): Promise<void> {
    if (this.getStatus() === 'connected' && this.attached) {
      return;
    }
    if (this.isConnecting) {
      return;
    }

    this.isConnecting = true;
    try {
      if (this.getStatus() !== 'connected') {
        await this.cdp.connect();
      }
      const attached = await this.reattach();
      if (!attached) {
        const cause =
          this.lastAttachError ??
          new Error(`EventBridge 注入失败 (启动代次: ${this.startupGenerationId})`);
        throw new Error(`EventBridge 注入失败 (启动代次: ${this.startupGenerationId})`, { cause });
      }
      log.info(
        { binding: this.bindingName, startupGenerationId: this.startupGenerationId },
        'KK9 原生事件直连桥就绪'
      );
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * 主动断开连接并清理事件桥
   */
  public async disconnect(): Promise<void> {
    this.attached = false;
    this.injectionIdentity = null;
    await this.cdp.disconnect();
    log.info({ startupGenerationId: this.startupGenerationId }, 'KK9 原生事件直连桥已断开');
  }

  /**
   * 重新注入 CDP Binding 与渲染进程 Hook 脚本
   */
  public async reattach(): Promise<boolean> {
    const connectionIdentity = this.getCdpConnectionIdentity();
    if (this.attached && this.sameConnectionIdentity(this.injectionIdentity, connectionIdentity)) {
      return true;
    }

    if (connectionIdentity && connectionIdentity.startupGenerationId !== this.startupGenerationId) {
      const cause = new Error(
        `CDP 连接身份属于启动代次 ${connectionIdentity.startupGenerationId}，期望 ${this.startupGenerationId}`
      );
      this.lastAttachError = cause;
      this.emitHealth('connection_identity_mismatch', cause, connectionIdentity);
      return false;
    }

    try {
      await this.cdp.sendCommand('Runtime.enable');
      await this.cdp.sendCommand('Runtime.addBinding', { name: this.bindingName });

      const hookScript = this.buildInBrowserHookScript(connectionIdentity);
      const injectionResult = await this.cdp.evaluate<{
        ok?: boolean;
        busFound?: boolean;
        sessionsHooked?: number;
      }>(hookScript);
      if (!injectionResult?.ok || injectionResult.busFound !== true) {
        throw new Error(
          `EventBridge 注入返回无效: ok=${String(injectionResult?.ok)}, busFound=${String(injectionResult?.busFound)}, sessionsHooked=${String(injectionResult?.sessionsHooked)}`
        );
      }
      this.injectionIdentity = connectionIdentity;
      this.lastAttachError = null;
      this.attached = true;
      log.debug(
        { binding: this.bindingName, startupGenerationId: this.startupGenerationId },
        '原生事件桥 Hook 注入成功'
      );
      return true;
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      this.lastAttachError = cause;
      log.warn(
        { err: cause.message, startupGenerationId: this.startupGenerationId },
        '注入原生事件桥 Hook 失败'
      );
      this.attached = false;
      this.injectionIdentity = null;
      this.emitHealth('event_bridge_invalidated', cause, connectionIdentity);
      return false;
    }
  }

  private getCdpConnectionIdentity(): CdpConnectionIdentity | null {
    const cdp = this.cdp as CdpClient & {
      getConnectionIdentity?: () => CdpConnectionIdentity | null;
    };
    return typeof cdp.getConnectionIdentity === 'function' ? cdp.getConnectionIdentity() : null;
  }
  private sameConnectionIdentity(
    left: CdpConnectionIdentity | null,
    right: CdpConnectionIdentity | null
  ): boolean {
    if (left === null || right === null) {
      return left === right;
    }
    return (
      left.startupGenerationId === right.startupGenerationId &&
      left.connectionId === right.connectionId
    );
  }

  private emitHealth(
    kind: DriverHealthEvent['kind'],
    cause: Error,
    connectionIdentity: CdpConnectionIdentity | null
  ): void {
    const event: DriverHealthEvent = {
      kind,
      startupGenerationId: this.startupGenerationId,
      connectionIdentity,
      expectedConnectionIdentity: this.injectionIdentity,
      observedAt: Date.now(),
      cause,
    };
    this.emit('health', event);
  }
  private reportNormalizationDiagnostic(diagnostic: InboundNormalizationDiagnostic): void {
    log.warn(
      {
        kind: diagnostic.kind,
        missingFields: diagnostic.missingFields,
        sessionId: diagnostic.sessionId,
        source: diagnostic.source,
        observedAt: diagnostic.observedAt,
      },
      '丢弃缺少入站身份字段的消息'
    );
  }

  /**
   * 解析外部原始消息载荷并返回标准 KK9Message 实体
   */
  public parseRawMessage(raw: unknown, sessionContext?: Partial<KK9Session>): KK9Message[] {
    return normalizeNativeMessage(raw, {
      session: sessionContext,
      currentUserId: this.currentUserId,
      knownBotSentMessageKeys: this.knownBotSentMessageKeys,

      source: 'event_bridge',
      onDiagnostic: diagnostic => this.reportNormalizationDiagnostic(diagnostic),
    });
  }

  /**
   * 处理从 CDP Runtime.bindingCalled 接收到的事件数据
   */
  private handleBindingPayload(payloadStr: string): void {
    if (!this.attached) {
      return;
    }

    let parsed: {
      type?: string;
      data?: unknown;
      event?: string;
      generationId?: string;
      connectionId?: string;
    } | null = null;
    try {
      parsed = JSON.parse(payloadStr) as {
        type?: string;
        data?: unknown;
        event?: string;
        generationId?: string;
        connectionId?: string;
      };
    } catch (err) {
      const errorType = err instanceof Error ? err.constructor.name : typeof err;
      log.warn({ errorType }, '收到非 JSON 格式的原生事件载荷');
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
      return;
    }

    if (parsed.generationId && parsed.generationId !== this.startupGenerationId) {
      const cause = new Error(
        `EventBridge 事件属于启动代次 ${parsed.generationId}，期望 ${this.startupGenerationId}`
      );
      this.emitHealth('connection_identity_mismatch', cause, this.getCdpConnectionIdentity());
      return;
    }

    if (
      parsed.connectionId &&
      this.injectionIdentity?.connectionId &&
      parsed.connectionId !== this.injectionIdentity.connectionId
    ) {
      const cause = new Error(
        `EventBridge 事件连接身份 ${parsed.connectionId} 与当前注入身份不一致`
      );
      this.emitHealth('connection_identity_mismatch', cause, this.getCdpConnectionIdentity());
      return;
    }

    const currentIdentity = this.getCdpConnectionIdentity();
    if (!this.sameConnectionIdentity(this.injectionIdentity, currentIdentity)) {
      const cause = new Error('EventBridge 注入身份与当前 CDP 连接身份不一致');
      this.attached = false;
      this.emitHealth('connection_identity_mismatch', cause, currentIdentity);
      return;
    }

    const eventType = parsed.type || parsed.event;
    const data = parsed.data !== undefined ? parsed.data : parsed;

    // 1. 优先提取载荷中可能包含的消息撤回事件
    if (this.enableRecallHook) {
      const recalledEvents = extractRecalledEventsFromPayload(data);
      for (const evt of recalledEvents) {
        this.handleRecalledEvent(evt);
      }
    }

    // 2. 分发业务事件
    switch (eventType) {
      case 'receive-message': {
        this.handleIncomingMessages(data);
        break;
      }
      case 'session-msg': {
        const rawData = data as {
          sesUUID?: string;
          sessionId?: string;
          sessionID?: string;
          messages?: unknown[];
          session?: Record<string, unknown>;
          type?: unknown;
          sessionType?: unknown;
        };
        const sessionObj = rawData?.session || (rawData as Record<string, unknown>);
        const isGroup =
          rawData?.sessionType === 'group' ||
          rawData?.type === 1 ||
          rawData?.type === 'group' ||
          sessionObj?.type === 1 ||
          sessionObj?.type === 'group' ||
          sessionObj?.sessionType === 1 ||
          sessionObj?.sessionType === 'group';
        const sessionType = isGroup ? 'group' : 'private';
        const sesId =
          rawData?.sesUUID ||
          rawData?.sessionId ||
          rawData?.sessionID ||
          sessionObj?.id ||
          sessionObj?.sesUUID;
        const sessionContext: Partial<KK9Session> | undefined = sesId
          ? {
              id: toSafeString(sesId),
              name: toSafeString(sessionObj?.name ?? sesId),
              type: sessionType,
            }
          : undefined;
        this.handleIncomingMessages(data, sessionContext);
        break;
      }
      case 'recalled':
      case 'CancelMessage':
      case 'revokeMsg': {
        this.handleRecalledPayload(data);
        break;
      }
      default: {
        // 未知或通用事件，尝试兼容推断
        if (data && typeof data === 'object') {
          const obj = data as Record<string, unknown>;
          if (obj['msgID'] || obj['messageId'] || obj['event'] === 'CancelMessage') {
            this.handleRecalledPayload(obj);
          } else {
            this.handleIncomingMessages(data);
          }
        }
        break;
      }
    }
  }

  /**
   * 标准化消息并派发 message 和 at 事件
   */
  private handleIncomingMessages(payload: unknown, sessionContext?: Partial<KK9Session>): void {
    const messages = normalizeNativeMessage(payload, {
      session: sessionContext,
      currentUserId: this.currentUserId,
      knownBotSentMessageKeys: this.knownBotSentMessageKeys,

      source: 'event_bridge',
      onDiagnostic: diagnostic => this.reportNormalizationDiagnostic(diagnostic),
    });
    for (const msg of messages) {
      const messageKey = createMessageIdentityKey(msg.sessionId, msg.id);

      if (this.knownMessageKeys.has(messageKey)) {
        continue;
      }

      this.recordMessageId(messageKey);
      log.debug(
        {
          id: msg.id,
          messageId: msg.messageId ?? msg.id,
          sessionId: msg.sessionId,
          sender: msg.sender,
          direction: msg.direction,
          origin: msg.origin,
          status: 'received',
        },
        '原生事件桥接收到新消息'
      );
      this.emit('message', msg);

      if (msg.atMe || msg.atAll || msg.mentions?.isAtMe || msg.mentions?.isAtAll) {
        log.info({ id: msg.id, sender: msg.sender, mentions: msg.mentions }, '捕获到 @ 提及事件');
        this.emit('at', msg);
      }
    }
  }

  /**
   * 处理撤回事件并去重派发
   */
  private handleRecalledPayload(payload: unknown): void {
    if (!this.enableRecallHook) return;
    const evt = normalizeRecalledEvent(payload);
    if (!evt || !evt.messageId || !evt.sessionId) return;
    this.handleRecalledEvent(evt);
  }

  /**
   * 触发单条撤回事件
   */
  private handleRecalledEvent(evt: KK9RecalledEvent): void {
    if (!this.enableRecallHook || !evt.messageId || !evt.sessionId) return;
    const messageKey = createMessageIdentityKey(evt.sessionId, evt.messageId);
    if (this.knownRecalledMessageKeys.has(messageKey)) {
      return;
    }

    this.recordRecalledKey(messageKey);
    log.info(
      { messageId: evt.messageId, sessionId: evt.sessionId, sender: evt.sender },
      '捕获到原生消息撤回事件'
    );
    this.emit('recalled', evt);
  }

  /**
   * 记录去重消息 ID（带 FIFO 淘汰）
   */
  private recordMessageId(messageKey: string): void {
    this.knownMessageKeys.add(messageKey);
    if (this.knownMessageKeys.size > this.maxMessageIds) {
      const oldest = this.knownMessageKeys.values().next().value;
      if (oldest) this.knownMessageKeys.delete(oldest);
    }
  }

  /**
   * 记录已撤回消息 ID（带 FIFO 淘汰）
   */
  private recordRecalledKey(messageKey: string): void {
    this.knownRecalledMessageKeys.add(messageKey);
    if (this.knownRecalledMessageKeys.size > this.maxMessageIds) {
      const oldest = this.knownRecalledMessageKeys.values().next().value;
      if (oldest) this.knownRecalledMessageKeys.delete(oldest);
    }
  }

  /**
   * 监听底层 CDP 状态、心跳与 binding 回调
   */
  private wireCdpEvents(): void {
    this.cdp.on('status', (status: ConnectionStatus) => {
      this.emit('status', status);
      if (status !== 'connected') {
        this.attached = false;
        this.injectionIdentity = null;
      }
    });

    this.cdp.on('connection_lost', (event: CdpConnectionLostEvent) => {
      const wasAttached = this.attached;
      this.attached = false;
      this.injectionIdentity = null;
      if (wasAttached) {
        this.emitHealth('event_bridge_invalidated', event.cause, event.connectionIdentity);
      }
    });

    this.cdp.on('heartbeat', (uptime: number) => this.emit('heartbeat', uptime));
    this.cdp.on('error', (err: Error) => this.emit('error', err));

    this.cdp.on('Runtime.bindingCalled', (rawParams: unknown) => {
      const params = rawParams as { name?: string; payload?: string };
      if (
        this.attached &&
        params?.name === this.bindingName &&
        typeof params.payload === 'string'
      ) {
        this.handleBindingPayload(params.payload);
      }
    });
  }

  /**
   * 构建渲染进程中的 JS Hook 注入脚本
   */
  private buildInBrowserHookScript(connectionIdentity: CdpConnectionIdentity | null): string {
    const binding = this.bindingName;
    const generationId = JSON.stringify(this.startupGenerationId);
    const connectionId = JSON.stringify(connectionIdentity?.connectionId ?? '');
    return `
      (() => {
        if (typeof window.__kairo_bridge_cleanup === 'function') {
          try {
            window.__kairo_bridge_cleanup();
          } catch (e) {
            console.warn('[KK9EventBridge] 清理前序 Hook 异常:', e);
          }
        }

        function postEvent(type, data) {
          if (typeof window[${JSON.stringify(binding)}] === 'function') {
            try {
              window[${JSON.stringify(binding)}](JSON.stringify({ generationId: ${generationId}, connectionId: ${connectionId}, type, data, timestamp: Date.now() }));
            } catch (e) {
              console.error('[KK9EventBridge] 无法派发事件到 CDP binding:', e);
            }
          }
        }

        const getMainPageVm = () => document.querySelector('#main-page, .main-page, #app, .app-container')?.__vue__;
        const getEditorVm = () => document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const getChatContentVm = () => {
          const containers = Array.from(document.querySelectorAll('.chat-container, .chat-content, .message-content-box'));
          for (const node of containers) {
            const vm = node.__vue__;
            if (vm && (vm.$options?.name === 'chat-content' || vm.$options?._componentTag === 'chat-content')) {
              return vm;
            }
          }
          return document.querySelector('.chat-content, .message-content-box')?.__vue__ || null;
        };

        const getBus = () => {
          const main = getMainPageVm();
          const editor = getEditorVm();
          const chat = getChatContentVm();
          return main?.$bus || editor?.$bus || chat?.$bus || window.vueBus || window.$bus || null;
        };

        const bus = getBus();
        const unbindFns = [];
        const hookedSessions = new Set();

        function resolveSenderName(senderId, msgId, sesUUID) {
          const main = getMainPageVm();
          const editor = getEditorVm();
          const myUid = main?.userID || editor?.userID;
          const myName = editor?.activedSes?.createrName || main?.userName;

          if (senderId && String(senderId) === String(myUid)) {
            return myName || '我';
          }

          // 1. 尝试从当前 chat-content 实例消息列表中反查原消息发送者
          if (msgId) {
            const chatContainers = document.querySelectorAll('.chat-container, .chat-content, .message-content-box');
            for (const container of chatContainers) {
              const vm = container.__vue__;
              if (vm && Array.isArray(vm.messages)) {
                const orig = vm.messages.find(m => String(m.id) === String(msgId) || String(m.msgID) === String(msgId));
                if (orig) {
                  if (String(orig.sender) === String(myUid)) {
                    return myName || '我';
                  }
                  if (orig.senderName) return String(orig.senderName);
                  if (orig.sendName) return String(orig.sendName);
                  if (orig.sender) senderId = orig.sender;
                }
              }
            }
          }

          // 2. 尝试从会话列表（sortedSessions）中反查联系人姓名
          if (sesUUID && editor?.sortedSessions) {
            const ses = editor.sortedSessions.find(s => s.sesUUID === sesUUID || String(s.id) === sesUUID);
            if (ses) {
              if (ses.type === 0) { // 私聊
                if (senderId && String(senderId) === String(myUid)) {
                  return ses.createrName || myName || '我';
                }
                return ses.typeName || ses.createrName || ses.name || (senderId ? String(senderId) : '对方');
              }
              if (ses.name) return ses.name;
            }
          }

          if (senderId && String(senderId) === String(myUid)) {
            return myName || '我';
          }

          return senderId ? String(senderId) : (myName || '我');
        }

        function onBus(event, handler) {
          if (!bus || typeof bus.$on !== 'function') return;
          bus.$on(event, handler);
          unbindFns.push(() => {
            try {
              bus.$off(event, handler);
            } catch (e) {}
          });
        }

        function parseRecallFromMsg(m, defaultSessionId) {
          if (!m) return null;
          let contentObj = m.content;
          if (typeof contentObj === 'string' && contentObj.includes('CancelMessage')) {
            try { contentObj = JSON.parse(contentObj); } catch {}
          }
          if (contentObj && (contentObj.event === 'CancelMessage' || contentObj.type === 'CancelMessage')) {
            const msgId = String(contentObj.msgID || contentObj.msgId || contentObj.id || m.msgID || m.id || '');
            if (msgId) {
              const sessionId = String(m.sessionID || m.sessionId || defaultSessionId || '');
              const rawSender = m.sender || m.senderName || contentObj.sender || contentObj.senderName;
              return {
                messageId: msgId,
                sessionId,
                sender: resolveSenderName(rawSender, msgId, sessionId),
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                raw: m
              };
            }
          }
          if (m.event === 'CancelMessage' || m.type === 'CancelMessage') {
            const msgId = String(m.msgID || m.msgId || m.id || '');
            if (msgId) {
              const sessionId = String(m.sessionID || m.sessionId || defaultSessionId || '');
              const rawSender = m.sender || m.senderName;
              return {
                messageId: msgId,
                sessionId,
                sender: resolveSenderName(rawSender, msgId, sessionId),
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                raw: m
              };
            }
          }
          return null;
        }

        function hookSession(sesUUID) {
          if (!sesUUID || hookedSessions.has(sesUUID) || !bus || typeof bus.$on !== 'function') return;
          hookedSessions.add(sesUUID);

          // 监听会话增量消息
          onBus(sesUUID + '-msg', (msgArray) => {
            if (!msgArray) return;
            const msgs = Array.isArray(msgArray) ? msgArray : [msgArray];
            for (const m of msgs) {
              const recallEvt = parseRecallFromMsg(m, sesUUID);
              if (recallEvt && recallEvt.messageId) {
                postEvent('recalled', recallEvt);
              }
            }
            postEvent('session-msg', { sesUUID, messages: msgs });
          });

          // 监听会话专用撤回事件
          onBus(sesUUID + '-revokeMsg', (revokePayload) => {
            if (!revokePayload) return;
            const msgId = String(revokePayload.msgID || revokePayload.msgId || revokePayload.id || '');
            postEvent('recalled', {
              messageId: msgId,
              sessionId: String(sesUUID || ''),
              sender: resolveSenderName(revokePayload.sender || revokePayload.senderName, msgId, sesUUID),
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now(),
              raw: revokePayload,
            });
          });
        }

        if (bus && typeof bus.$on === 'function') {
          // 1. 监听全局 receive-message
          onBus('receive-message', (payload) => {
            if (!payload) return;
            const sesUUID = payload?.session?.sesUUID || payload?.sesUUID || payload?.sessionID;
            if (sesUUID) hookSession(sesUUID);

            const msgs = Array.isArray(payload.message) ? payload.message : Array.isArray(payload.messages) ? payload.messages : [payload];
            for (const m of msgs) {
              const recallEvt = parseRecallFromMsg(m, sesUUID);
              if (recallEvt && recallEvt.messageId) {
                postEvent('recalled', recallEvt);
              }
            }

            postEvent('receive-message', payload);
          });

          // 2. 监听全局 CancelMessage
          onBus('CancelMessage', (payload) => {
            if (!payload) return;
            const msgId = String(payload.msgID || payload.msgId || payload.id || '');
            const sessionId = String(payload.sessionID || payload.sessionId || '');
            postEvent('recalled', {
              messageId: msgId,
              sessionId,
              sender: resolveSenderName(payload.sender || payload.senderName || payload.fromUserName, msgId, sessionId),
              time: new Date().toLocaleTimeString(),
              timestamp: Date.now(),
              raw: payload,
            });
          });

          // 3. 预先挂钩所有已知会话
          const editor = getEditorVm();
          const sortedSessions = editor?.sortedSessions || [];
          if (Array.isArray(sortedSessions)) {
            sortedSessions.forEach(s => {
              if (s && s.sesUUID) hookSession(s.sesUUID);
            });
          }
          if (editor?.activedSes?.sesUUID) {
            hookSession(editor.activedSes.sesUUID);
          }
        }

        // 4. 挂钩所有 chat-content 组件实例的撤回方法
        function hookChatContentInstances() {
          const main = getMainPageVm();
          const editor = getEditorVm();
          const myUid = main?.userID || editor?.userID;
          const chatContainers = document.querySelectorAll('.chat-container, .chat-content, .message-content-box');
          chatContainers.forEach(container => {
            const vm = container.__vue__;
            if (vm && typeof vm.addRevokeMsg === 'function' && !vm.__kairo_revoke_active) {
              vm.__kairo_revoke_active = true;
              const origAdd = vm.addRevokeMsg;
              vm.addRevokeMsg = function(data) {
                if (data && (data.msgID || data.msgId || data.id)) {
                  const msgId = String(data.msgID || data.msgId || data.id);
                  const sessionId = String(vm.sesInfo?.sesUUID || vm.sessionID || '');
                  postEvent('recalled', {
                    messageId: msgId,
                    sessionId,
                    sender: resolveSenderName(data.sender || vm.loginID || myUid, msgId, sessionId),
                    time: new Date().toLocaleTimeString(),
                    timestamp: Date.now(),
                    raw: data
                  });
                }
                return origAdd.apply(this, arguments);
              };
            }
          });
        }
        hookChatContentInstances();
        // 5. DOM 变动监听器（作为系统气泡撤回提示的终极兜底守卫）
        let observer = null;
        try {
          observer = new MutationObserver((mutations) => {
            hookChatContentInstances();
            for (const m of mutations) {
              for (const node of m.addedNodes) {
                if (node && node.nodeType === 1) {
                  const el = node;
                  const text = el.textContent?.trim() || '';
                  if (
                    (el.classList?.contains('system-msg') ||
                      el.classList?.contains('rcd-item') ||
                      el.classList?.contains('system-recall')) &&
                    text.includes('撤回')
                  ) {
                    const nativeId = el.getAttribute('data-msgid');
                    const sessionId =
                      el.getAttribute('data-session-id') || el.getAttribute('data-sessionid');
                    if (nativeId && sessionId) {
                      postEvent('recalled', {
                        messageId: nativeId,
                        sessionId,
                        sender: 'unknown',
                        time: new Date().toLocaleTimeString(),
                        timestamp: Date.now()
                      });
                    }
                  }
                }
              }
            }
          });
          observer.observe(document.body, { childList: true, subtree: true });
        } catch {}

        window.__kairo_bridge_cleanup = () => {
          unbindFns.forEach(fn => {
            try { fn(); } catch (e) {}
          });
          if (observer) {
            try { observer.disconnect(); } catch (e) {}
          }
        };

        return { ok: true, busFound: !!bus, sessionsHooked: hookedSessions.size };
      })()
    `;
  }
}
