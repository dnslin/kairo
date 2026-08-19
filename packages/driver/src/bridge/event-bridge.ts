import EventEmitter from 'node:events';
import { CdpClient } from '../cdp/client.js';
import type {
  CdpConfig,
  ConnectionStatus,
  DriverConfig,
  EventBridgeConfig,
  EventBridgeEvents,
  KK9Message,
  KK9RecalledEvent,
  KK9Session,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import {
  extractRecalledEventsFromPayload,
  generateMessageFingerprint,
  normalizeNativeMessage,
  normalizeRecalledEvent,
} from './converter.js';

const log = createChildLogger('event-bridge');

const DEFAULT_BINDING_NAME = '__kkbot_native_bridge';
const DEFAULT_MAX_FINGERPRINTS = 10000;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface KK9EventBridge {
  on<U extends keyof EventBridgeEvents>(event: U, listener: EventBridgeEvents[U]): this;
  emit<U extends keyof EventBridgeEvents>(event: U, ...args: Parameters<EventBridgeEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class KK9EventBridge extends EventEmitter {
  private readonly cdp: CdpClient;
  private readonly bindingName: string;
  private readonly maxFingerprints: number;
  private readonly currentUserId?: string | number;
  private readonly enableRecallHook: boolean;
  private attached = false;
  private isConnecting = false;
  private readonly knownFingerprints = new Set<string>();
  private readonly knownRecalledIds = new Set<string>();

  constructor(
    config: EventBridgeConfig | DriverConfig | { cdp: CdpConfig },
    cdpClient?: CdpClient
  ) {
    super();
    const bridgeConfig = config as EventBridgeConfig;
    this.bindingName = bridgeConfig.bindingName || DEFAULT_BINDING_NAME;
    this.maxFingerprints = bridgeConfig.maxFingerprints || DEFAULT_MAX_FINGERPRINTS;
    this.currentUserId = bridgeConfig.currentUserId;
    this.enableRecallHook = bridgeConfig.enableRecallHook ?? true;

    this.cdp = cdpClient || new CdpClient(config.cdp);
    this.wireCdpEvents();
  }

  /**
   * 获取底层连接状态
   */
  public getStatus(): ConnectionStatus {
    return this.cdp.getStatus();
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
      await this.reattach();
      log.info({ binding: this.bindingName }, 'KK9 原生事件直连桥就绪');
    } finally {
      this.isConnecting = false;
    }
  }

  /**
   * 主动断开连接并清理事件桥
   */
  public async disconnect(): Promise<void> {
    this.attached = false;
    await this.cdp.disconnect();
    log.info('KK9 原生事件直连桥已断开');
  }

  /**
   * 重新注入 CDP Binding 与渲染进程 Hook 脚本
   */
  public async reattach(): Promise<boolean> {
    try {
      await this.cdp.sendCommand('Runtime.enable');
      await this.cdp.sendCommand('Runtime.addBinding', { name: this.bindingName }).catch(() => {});

      const hookScript = this.buildInBrowserHookScript();
      await this.cdp.evaluate(hookScript);
      this.attached = true;
      log.debug({ binding: this.bindingName }, '原生事件桥 Hook 注入成功');
      return true;
    } catch (err) {
      log.warn({ err: String(err) }, '注入原生事件桥 Hook 失败');
      this.attached = false;
      return false;
    }
  }

  /**
   * 解析外部原始消息载荷并返回标准 KK9Message 实体
   */
  public parseRawMessage(raw: unknown, sessionContext?: Partial<KK9Session>): KK9Message[] {
    return normalizeNativeMessage(raw, {
      session: sessionContext,
      currentUserId: this.currentUserId,
    });
  }

  /**
   * 处理从 CDP Runtime.bindingCalled 接收到的事件数据
   */
  private handleBindingPayload(payloadStr: string): void {
    let parsed: { type?: string; data?: unknown; event?: string } | null = null;
    try {
      parsed = JSON.parse(payloadStr) as { type?: string; data?: unknown; event?: string };
    } catch {
      log.warn({ payload: payloadStr.slice(0, 100) }, '收到非 JSON 格式的原生事件载荷');
      return;
    }

    if (!parsed || typeof parsed !== 'object') {
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
        const rawData = data as { sesUUID?: string; messages?: unknown[] };
        const sessionContext: Partial<KK9Session> | undefined = rawData?.sesUUID
          ? { id: rawData.sesUUID, name: rawData.sesUUID }
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
    });

    for (const msg of messages) {
      if (msg.isMe) {
        continue;
      }

      const fingerprint =
        msg.id || generateMessageFingerprint(msg.sessionId, msg.sender, msg.time, msg.content);
      if (this.knownFingerprints.has(fingerprint)) {
        continue;
      }

      this.recordFingerprint(fingerprint);

      log.debug({ id: msg.id, sender: msg.sender, content: msg.content }, '原生事件桥接收到新消息');
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
    if (!evt || !evt.messageId) return;
    this.handleRecalledEvent(evt);
  }

  /**
   * 触发单条撤回事件
   */
  private handleRecalledEvent(evt: KK9RecalledEvent): void {
    if (!this.enableRecallHook) return;
    if (this.knownRecalledIds.has(evt.messageId)) {
      return;
    }

    this.recordRecalledId(evt.messageId);
    log.info(
      { messageId: evt.messageId, sessionId: evt.sessionId, sender: evt.sender },
      '捕获到原生消息撤回事件'
    );
    this.emit('recalled', evt);
  }

  /**
   * 记录去重指纹（带 FIFO 淘汰）
   */
  private recordFingerprint(fingerprint: string): void {
    this.knownFingerprints.add(fingerprint);
    if (this.knownFingerprints.size > this.maxFingerprints) {
      const oldest = this.knownFingerprints.values().next().value;
      if (oldest) this.knownFingerprints.delete(oldest);
    }
  }

  /**
   * 记录已撤回消息 ID（带 FIFO 淘汰）
   */
  private recordRecalledId(id: string): void {
    this.knownRecalledIds.add(id);
    if (this.knownRecalledIds.size > this.maxFingerprints) {
      const oldest = this.knownRecalledIds.values().next().value;
      if (oldest) this.knownRecalledIds.delete(oldest);
    }
  }

  /**
   * 监听底层 CDP 状态、心跳与 binding 回调
   */
  private wireCdpEvents(): void {
    this.cdp.on('status', (status: ConnectionStatus) => {
      this.emit('status', status);
      if (status === 'connected') {
        void this.reattach();
      } else if (status === 'disconnected') {
        this.attached = false;
      }
    });

    this.cdp.on('heartbeat', (uptime: number) => this.emit('heartbeat', uptime));
    this.cdp.on('error', (err: Error) => this.emit('error', err));

    this.cdp.on('Runtime.bindingCalled', (rawParams: unknown) => {
      const params = rawParams as { name?: string; payload?: string };
      if (params?.name === this.bindingName && typeof params.payload === 'string') {
        this.handleBindingPayload(params.payload);
      }
    });
  }

  /**
   * 构建渲染进程中的 JS Hook 注入脚本
   */
  private buildInBrowserHookScript(): string {
    const binding = this.bindingName;
    return `
      (() => {
        if (typeof window.__kkbot_bridge_cleanup === 'function') {
          try {
            window.__kkbot_bridge_cleanup();
          } catch (e) {
            console.warn('[KK9EventBridge] 清理前序 Hook 异常:', e);
          }
        }

        function postEvent(type, data) {
          if (typeof window[${JSON.stringify(binding)}] === 'function') {
            try {
              window[${JSON.stringify(binding)}](JSON.stringify({ type, data, timestamp: Date.now() }));
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
              return {
                messageId: msgId,
                sessionId: String(m.sessionID || m.sessionId || defaultSessionId || ''),
                sender: String(m.sender || m.senderName || contentObj.sender || ''),
                time: new Date().toLocaleTimeString(),
                timestamp: Date.now(),
                raw: m
              };
            }
          }
          if (m.event === 'CancelMessage' || m.type === 'CancelMessage') {
            const msgId = String(m.msgID || m.msgId || m.id || '');
            if (msgId) {
              return {
                messageId: msgId,
                sessionId: String(m.sessionID || m.sessionId || defaultSessionId || ''),
                sender: String(m.sender || m.senderName || ''),
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
            postEvent('recalled', {
              messageId: String(revokePayload.msgID || revokePayload.msgId || revokePayload.id || ''),
              sessionId: String(sesUUID || ''),
              sender: String(revokePayload.sender || revokePayload.senderName || '某人'),
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
            postEvent('recalled', {
              messageId: String(payload.msgID || payload.msgId || payload.id || ''),
              sessionId: String(payload.sessionID || payload.sessionId || ''),
              sender: String(payload.sender || payload.senderName || payload.fromUserName || '某人'),
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
          const chatContainers = document.querySelectorAll('.chat-container, .chat-content, .message-content-box');
          chatContainers.forEach(container => {
            const vm = container.__vue__;
            if (vm && typeof vm.addRevokeMsg === 'function' && !vm.__kkbot_revoke_active) {
              vm.__kkbot_revoke_active = true;
              const origAdd = vm.addRevokeMsg;
              vm.addRevokeMsg = function(data) {
                if (data && (data.msgID || data.msgId || data.id)) {
                  postEvent('recalled', {
                    messageId: String(data.msgID || data.msgId || data.id),
                    sessionId: String(vm.sesInfo?.sesUUID || vm.sessionID || ''),
                    sender: String(data.sender || data.senderName || '某人'),
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
                    (el.classList?.contains('system-msg') || el.classList?.contains('rcd-item') || el.classList?.contains('system-recall')) &&
                    text.includes('撤回')
                  ) {
                    const id = el.getAttribute('id') || el.getAttribute('data-id') || el.getAttribute('data-msgid');
                    if (id) {
                      postEvent('recalled', {
                        messageId: String(id),
                        sessionId: '',
                        sender: text.replace(/撤回.*$/, '').trim() || '某人',
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

        window.__kkbot_bridge_cleanup = () => {
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
