import type { CdpClient } from '../cdp/client.js';
import type { KK9Session, SelectorsConfig } from '../types/index.js';
import { DomError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('session-ops');

export class SessionOps {
  constructor(
    private readonly cdp: CdpClient,
    private readonly selectors: SelectorsConfig
  ) {}

  /**
   * 获取所有会话（优先通过 Vue 实例穿透虚拟滚动，降级为 DOM 遍历）
   */
  public async getSessions(): Promise<KK9Session[]> {
    const script = `
      (() => {
        // 1. 尝试穿透 Vue 虚拟滚动实例
        try {
          const scroller = document.querySelector('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
          if (scroller && scroller.__vue__ && Array.isArray(scroller.__vue__.items)) {
            return scroller.__vue__.items.map(item => {
              let lastMsg = '';
              let lastTime = '';
              if (item.lastMessage) {
                try {
                  const parsed = typeof item.lastMessage === 'string' ? JSON.parse(item.lastMessage) : item.lastMessage;
                  if (Array.isArray(parsed?.content)) {
                    lastMsg = parsed.content.map(c => c.text || (c.type === 1 ? '[图片]' : '')).filter(Boolean).join('');
                  } else if (typeof parsed?.content === 'string') {
                    lastMsg = parsed.content;
                  } else if (parsed?.text) {
                    lastMsg = String(parsed.text);
                  } else {
                    lastMsg = String(item.lastMessage);
                  }
                } catch {
                  lastMsg = String(item.lastMessage);
                }
              }

              if (item.lastMsgTime) {
                try {
                  lastTime = new Date(item.lastMsgTime).toLocaleTimeString();
                } catch {
                  lastTime = '';
                }
              }

              const type = (item.type === 1 || item.type === 2 || item.isGroup) ? 'group' : 'private';
              const unread = Boolean(
                item.unread ||
                (typeof item.userReadIndex === 'number' && typeof item.maxMessageIndex === 'number' && item.userReadIndex < item.maxMessageIndex) ||
                (typeof item.unreadCount === 'number' && item.unreadCount > 0)
              );

              const sessionName = String(item.typeName || item.name || item.title || item.senderName || '未命名会话');

              return {
                id: String(item.sesUUID || item.id || item.sessionId || ''),
                name: sessionName,
                type: type,
                unread: unread,
                unreadCount: Number(item.unreadCount || 0),
                lastMessage: lastMsg,
                lastMessageTime: lastTime,
                active: Boolean(item.isActive || item.selected)
              };
            }).filter(s => s.id.length > 0);
          }
        } catch (e) {
          console.warn('[KK9Driver] Vue virtual scroller inspect failed:', e);
        }

        // 2. 降级回退：遍历当前可视 DOM
        const items = document.querySelectorAll('${this.selectors.sessionItem}');
        const results = [];
        for (const item of items) {
          const titleEl = item.querySelector('${this.selectors.sessionTitle}');
          const unreadEl = item.querySelector('${this.selectors.sessionUnreadBadge}');
          const id = item.getAttribute('data-session-id') || item.getAttribute('id') || titleEl?.textContent?.trim() || '';
          const name = titleEl?.textContent?.trim() || '未命名会话';
          const unread = unreadEl !== null && window.getComputedStyle(unreadEl).display !== 'none';
          const active = item.classList.contains('active') || item.classList.contains('selected');

          if (id) {
            results.push({
              id,
              name,
              type: 'private',
              unread,
              active
            });
          }
        }
        return results;
      })()
    `;

    try {
      const sessions = await this.cdp.evaluate<KK9Session[]>(script);
      return Array.isArray(sessions) ? sessions : [];
    } catch (err) {
      log.error({ err: String(err) }, '获取会话列表失败');
      throw new DomError(`获取会话列表失败: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err : undefined);
    }
  }

  /**
   * 获取当前处于激活状态的会话
   */
  public async getCurrentSession(): Promise<KK9Session | null> {
    const sessions = await this.getSessions();
    const active = sessions.find((s) => s.active);
    if (active) return active;

    // 备用：直接查找 active 样式节点
    const script = `
      (() => {
        const el = document.querySelector('${this.selectors.activeSession}');
        if (!el) return null;
        const titleEl = el.querySelector('${this.selectors.sessionTitle}');
        return {
          id: el.getAttribute('data-session-id') || el.getAttribute('id') || titleEl?.textContent?.trim() || '',
          name: titleEl?.textContent?.trim() || '当前会话',
          type: 'private',
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
   * 点击切换到指定会话（支持虚拟滚动定位）
   */
  public async selectSession(sessionId: string): Promise<boolean> {
    const script = `
      (async () => {
        const id = ${JSON.stringify(sessionId)};

        // 1. 获取目标会话的核心标识与索引
        const scroller = document.querySelector('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        let targetSesUUID = id;
        let targetName = id;
        let targetIndex = -1;

        if (scroller && scroller.__vue__ && Array.isArray(scroller.__vue__.items)) {
          const items = scroller.__vue__.items;
          targetIndex = items.findIndex(it =>
            it.sesUUID === id ||
            it.typeName === id ||
            it.name === id ||
            String(it.id) === id ||
            (typeof it.typeName === 'string' && it.typeName.includes(id))
          );
          if (targetIndex >= 0) {
            targetSesUUID = items[targetIndex].sesUUID || targetSesUUID;
            targetName = items[targetIndex].typeName || items[targetIndex].name || targetName;
          }
        }

        // 2. 辅助函数: 在当前 DOM 查找并点击匹配项
        function tryClickVisibleDom() {
          const domItems = document.querySelectorAll('${this.selectors.sessionItem}');
          for (const item of domItems) {
            const matchId = item.getAttribute('data-sesuuid') || item.getAttribute('data-session-id') || item.getAttribute('id');
            const title = item.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim();
            if (matchId === targetSesUUID || matchId === id || title === targetName || title === id || (title && title.includes(id))) {
              item.scrollIntoView({ block: 'nearest' });
              if (typeof item.click === 'function') {
                item.click();
              } else {
                item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
              }
              return true;
            }
          }
          return false;
        }

        // 3. 辅助函数: 验证当前高亮会话是否已是目标会话
        function isTargetActive() {
          const selected = document.querySelector('${this.selectors.activeSession}') || document.querySelector('.chat-item.chat-selected');
          if (!selected) return false;
          const selectedUuid = selected.getAttribute('data-sesuuid');
          const selectedName = selected.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim();
          return (
            selectedUuid === targetSesUUID ||
            selectedUuid === id ||
            selectedName === targetName ||
            selectedName === id ||
            (selectedName && selectedName.includes(id))
          );
        }

        // 先检查当前是否已经处于该会话
        if (isTargetActive()) {
          return { success: true, method: 'already_active' };
        }

        // 4. 尝试在当前视口内直接点击
        if (tryClickVisibleDom()) {
          await new Promise(r => setTimeout(r, 300));
          if (isTargetActive()) {
            return { success: true, method: 'direct_dom_click' };
          }
        }

        // 5. 若在视口外且在 Vue 虚拟滚动列表中，执行精准滚动重排
        if (scroller && targetIndex >= 0) {
          const itemSize = scroller.__vue__?.itemSize || 64;
          if (typeof scroller.__vue__?.scrollToItem === 'function') {
            scroller.__vue__.scrollToItem(targetIndex);
          }
          scroller.scrollTop = targetIndex * itemSize;
          scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

          // 等待虚拟滚动 DOM 节点挂载
          await new Promise(r => setTimeout(r, 400));

          if (tryClickVisibleDom()) {
            await new Promise(r => setTimeout(r, 400));
            if (isTargetActive()) {
              return { success: true, method: 'scroller_scroll_and_click' };
            }
          }
        }

        return { success: false, method: 'activation_verification_failed' };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; method: string }>(script);
      log.debug({ sessionId, res }, '执行会话切换');
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ sessionId, err: String(err) }, '切换会话失败');
      return false;
    }
  }
}
