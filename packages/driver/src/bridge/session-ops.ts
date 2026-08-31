import type { CdpClient } from '../cdp/client.js';
import type { KK9Session } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { callIpcToData } from './rpc.js';

const log = createChildLogger('bridge-session-ops');

interface RawConversationData {
  sessionsInfo?: Record<string, RawSessionItem>;
  usersInfo?: Record<string, Record<string, unknown>>;
  groupsInfo?: Record<string, Record<string, unknown>>;
}

interface RawSessionItem {
  id: number | string;
  type: number; // 0: 私聊, 1: 群聊/讨论组, 2: 讨论组, 3: 服务号/微应用
  creater: number | string;
  createrName?: string;
  typeID: number | string;
  typeName?: string;
  maxMessageIndex?: number;
  userReadIndex?: number;
  lastMessage?: string;
  lastMsgTime?: number;
  atState?: number;
  sesUUID?: string;
  sesTypeID?: number | string;
}

export class BridgeSessionOps {
  constructor(private readonly cdp: CdpClient) {}

  /**
   * 优先通过 IPC toData('getConversations') 获取全量会话列表
   */
  public async getSessions(): Promise<KK9Session[]> {
    try {
      // 1. 获取当前活跃会话与 sortedSessions 状态
      const activeInfo = await this.cdp.evaluate<{
        activeUuid?: string;
        activeId?: string | number;
        sortedSessions?: Array<{
          id?: string | number;
          sesUUID?: string;
          name?: string;
          type?: number;
        }>;
      }>(`
        (() => {
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const active = editor?.activedSes;
          return {
            activeUuid: active?.sesUUID || '',
            activeId: active?.id || '',
            sortedSessions: editor?.sortedSessions?.map(s => ({
              id: s.id,
              sesUUID: s.sesUUID,
              name: s.name || s.typeName,
              type: s.type
            })) || []
          };
        })()
      `);

      // 2. 调用底层 IPC 获取权威会话数据
      const ipcRes = await callIpcToData<RawConversationData>(this.cdp, 'getConversations');
      const sessionsMap = ipcRes.data?.sessionsInfo || {};

      const sessions: KK9Session[] = [];
      for (const [key, item] of Object.entries(sessionsMap)) {
        if (!item) continue;

        let lastMsg = '';
        if (item.lastMessage) {
          try {
            const rawMsg: unknown =
              typeof item.lastMessage === 'string'
                ? JSON.parse(item.lastMessage)
                : item.lastMessage;
            if (rawMsg && typeof rawMsg === 'object') {
              const record = rawMsg as Record<string, unknown>;
              if (Array.isArray(record.content)) {
                lastMsg = record.content
                  .map((c: unknown) => {
                    if (c && typeof c === 'object') {
                      const itemObj = c as Record<string, unknown>;
                      return (
                        (typeof itemObj.text === 'string' ? itemObj.text : '') ||
                        (itemObj.type === 1 ? '[图片]' : '')
                      );
                    }
                    return '';
                  })
                  .filter(Boolean)
                  .join('');
              } else if (typeof record.content === 'string') {
                lastMsg = record.content;
              } else if (typeof record.text === 'string') {
                lastMsg = record.text;
              } else {
                lastMsg = String(item.lastMessage);
              }
            } else {
              lastMsg = String(item.lastMessage);
            }
          } catch {
            lastMsg = String(item.lastMessage);
          }
        }

        let lastTime = '';
        if (item.lastMsgTime) {
          try {
            const ts = item.lastMsgTime < 10000000000 ? item.lastMsgTime * 1000 : item.lastMsgTime;
            lastTime = new Date(ts).toLocaleTimeString();
          } catch {
            lastTime = '';
          }
        }

        const isGroup = item.type === 1 || item.type === 2;
        const sessionType = isGroup ? 'group' : 'private';

        // 判定未读数与未读状态
        const maxIdx = item.maxMessageIndex ?? 0;
        const readIdx = item.userReadIndex ?? 0;
        const unreadCount = Math.max(0, maxIdx - readIdx);
        const unread = unreadCount > 0;

        // 判定未读 @ 状态 (atState > 1 表示有未读 @ 提醒)
        const unreadAt = Boolean((item.atState && item.atState > 1) || lastMsg.includes('[@有人@我]') || lastMsg.includes('[@全体成员]'));

        // 寻找 sesUUID (优先从 item 自身、sortedSessions 匹配或拼装)
        let sesUUID = item.sesUUID || '';
        if (!sesUUID) {
          const matchedSorted = activeInfo?.sortedSessions?.find(
            s => String(s.id) === String(item.id) || String(s.id) === key
          );
          sesUUID = matchedSorted?.sesUUID || `${item.type}-${item.sesTypeID || item.typeID || item.id}`;
        }

        const sessionName = item.typeName || item.createrName || `会话_${String(item.id)}`;
        const isActive =
          activeInfo?.activeUuid === sesUUID ||
          String(activeInfo?.activeId) === String(item.id) ||
          String(activeInfo?.activeId) === key;

        sessions.push({
          id: sesUUID || String(item.id),
          name: sessionName,
          type: sessionType,
          unread,
          unreadCount,
          unreadAt,
          lastMessage: lastMsg,
          lastMessageTime: lastTime,
          active: Boolean(isActive),
        });
      }

      return sessions;
    } catch (err) {
      log.warn({ err: String(err) }, 'Bridge 获取会话列表异常，尝试回退降级');
      return [];
    }
  }

  /**
   * 获取当前激活会话
   */
  public async getCurrentSession(): Promise<KK9Session | null> {
    const script = `
      (() => {
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const active = editor?.activedSes;
        if (!active) return null;

        const isGroup = active.type === 1 || active.type === 2;
        return {
          id: active.sesUUID || String(active.id),
          name: active.typeName || active.name || active.createrName || '当前会话',
          type: isGroup ? 'group' : 'private',
          unread: false,
          active: true
        };
      })()
    `;

    try {
      return await this.cdp.evaluate<KK9Session | null>(script);
    } catch {
      return null;
    }
  }

  /**
   * 切换到目标会话 (通过 Vue 状态调度 + DOM 触发)
   */
  public async selectSession(sessionId: string): Promise<boolean> {
    const targetId = sessionId.trim();
    if (!targetId) return false;

    const script = `
      (async () => {
        const target = ${JSON.stringify(targetId)};
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const bus = main?.$bus || app?.$bus;

        // 1. 检查是否已经是当前激活会话
        if (editor?.activedSes) {
          const cur = editor.activedSes;
          if (cur.sesUUID === target || String(cur.id) === target || cur.typeName === target || cur.name === target) {
            return { success: true, method: 'already_active' };
          }
        }

        // 2. 尝试从 sortedSessions 中查找目标并触发切换
        if (editor && Array.isArray(editor.sortedSessions)) {
          const found = editor.sortedSessions.find(s =>
            s.sesUUID === target ||
            String(s.id) === target ||
            s.typeName === target ||
            s.name === target ||
            (s.name && s.name.includes(target))
          );
          if (found) {
            // 通过 Vuex commit 或 $bus 触发切换
            if (bus) {
              bus.$emit('session-click', found);
              bus.$emit('store', { type: 'commit', method: 'saveActiveSes', payload: found });
            }
            if (typeof editor.onActivedSesChanged === 'function') {
              editor.onActivedSesChanged(found);
            }
            editor.activedSes = found;
            return { success: true, method: 'vue_session_switch' };
          }
        }

        // 3. 降级：点击可视 DOM
        const items = document.querySelectorAll('.chat-item, .session-item');
        for (const el of items) {
          const uid = el.getAttribute('data-sesuuid') || el.getAttribute('data-session-id') || el.getAttribute('id');
          const title = el.querySelector('.chat-title, .title, .name')?.textContent?.trim();
          if (uid === target || title === target || (title && title.includes(target))) {
            if (typeof el.click === 'function') el.click();
            else el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            return { success: true, method: 'dom_click_fallback' };
          }
        }

        return { success: false };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; method?: string }>(script);
      log.debug({ targetId, res }, '执行 Bridge 会话切换');
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ targetId, err: String(err) }, 'Bridge 切换会话异常');
      return false;
    }
  }

  /**
   * 通过原生 IPC toData('readMessage') 消除会话未读红点（真·已读同步到多端与服务端）
   */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    const targetId = sessionId.trim();
    if (!targetId) return false;

    try {
      const script = `
        (async () => {
          const target = ${JSON.stringify(targetId)};
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const app = document.querySelector('#app')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus || app?.$bus;

          let targetSession = null;
          if (editor?.sortedSessions) {
            targetSession = editor.sortedSessions.find(s =>
              s.sesUUID === target || String(s.id) === target || s.typeName === target || s.name === target
            );
          }
          if (!targetSession && editor?.activedSes) {
            if (editor.activedSes.sesUUID === target || String(editor.activedSes.id) === target) {
              targetSession = editor.activedSes;
            }
          }

          if (targetSession) {
            const sessionID = targetSession.id;
            const maxMsgIdx = targetSession.maxMessageIndex || 0;
            const type = targetSession.type || 0;

            const electron = window.require ? window.require('electron') : null;
            const ipc = window.ipcRenderer || electron?.ipcRenderer;
            if (!ipc || typeof ipc.send !== 'function' || typeof ipc.once !== 'function') {
              return { success: false };
            }

            const key = '__kkbot_rpc_id';
            const currentId = typeof window[key] === 'number' ? window[key] : 800000;
            window[key] = currentId + 1;
            const reqId = currentId + 1;
            const replyChannel = 'data-' + reqId;
            const readRes = await new Promise(resolve => {
              const onReply = (_event, payload) => {
                clearTimeout(timer);
                try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
                resolve(payload);
              };
              const timer = setTimeout(() => {
                try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
                resolve({ code: -2 });
              }, 4000);
              ipc.once(replyChannel, onReply);
              try {
                ipc.send('data', {
                  id: reqId,
                  args: ['readMessage', { type, sessionID, maxMsgIdx }],
                  progress: false
                });
              } catch (sendErr) {
                clearTimeout(timer);
                try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
                resolve({ code: -3 });
              }
            });

            if (!readRes || readRes.code !== 0) {
              return { success: false };
            }

            // native ack 成功后再更新客户端 Vuex 与本地状态
            targetSession.userReadIndex = maxMsgIdx;
            targetSession.atState = 0;
            if (bus) {
              bus.$emit('set-message-read', targetSession);
              bus.$emit('reload-atMsg-list');
              bus.$emit('flush-unread-total');
            }
            return { success: true };
          }

          return { success: false };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean }>(script, 6000);
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ targetId, err: String(err) }, 'Bridge 标记已读失败');
      return false;
    }
  }
}
