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

        // 1. 尝试直接在当前视口 DOM 查找并点击
        const domItems = document.querySelectorAll('${this.selectors.sessionItem}');
        for (const item of domItems) {
          const matchId = item.getAttribute('data-sesuuid') || item.getAttribute('data-session-id') || item.getAttribute('id');
          const title = item.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim();
          if (matchId === id || title === id || title?.includes(id)) {
            item.scrollIntoView({ block: 'nearest' });
            if (typeof item.click === 'function') {
              item.click();
            } else {
              item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
            }
            return { success: true, method: 'direct_dom_click' };
          }
        }

        // 2. 若不在当前视口，穿透 Vue 虚拟滚动实例
        const scroller = document.querySelector('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        if (scroller && scroller.__vue__ && Array.isArray(scroller.__vue__.items)) {
          const items = scroller.__vue__.items;
          const targetIndex = items.findIndex(it =>
            it.sesUUID === id ||
            it.typeName === id ||
            it.name === id ||
            String(it.id) === id ||
            (typeof it.typeName === 'string' && it.typeName.includes(id))
          );

          if (targetIndex >= 0) {
            const targetItem = items[targetIndex];

            // 2.1 优先尝试调用父级 Vue 组件的会话切换方法
            const parentVue = scroller.__vue__.$parent;
            if (parentVue) {
              if (typeof parentVue.toggleSession === 'function') {
                try {
                  parentVue.toggleSession(targetItem);
                  return { success: true, method: 'vue_toggleSession' };
                } catch {}
              }
              if (typeof parentVue.focusSession === 'function') {
                try {
                  parentVue.focusSession(targetItem);
                  return { success: true, method: 'vue_focusSession' };
                } catch {}
              }
              if (typeof parentVue.chatWith === 'function') {
                try {
                  parentVue.chatWith(targetItem);
                  return { success: true, method: 'vue_chatWith' };
                } catch {}
              }
            }

            // 2.2 驱动虚拟滚动组件滚动并触发重排
            const itemSize = scroller.__vue__.itemSize || 64;
            if (typeof scroller.__vue__.scrollToItem === 'function') {
              scroller.__vue__.scrollToItem(targetIndex);
            }
            scroller.scrollTop = targetIndex * itemSize;
            scroller.dispatchEvent(new Event('scroll', { bubbles: true }));

            // 等待渲染刷新
            await new Promise(r => setTimeout(r, 400));

            // 2.3 再次在挂载的 DOM 中查找并点击
            const updatedItems = document.querySelectorAll('${this.selectors.sessionItem}');
            for (const it of updatedItems) {
              const mId = it.getAttribute('data-sesuuid') || it.getAttribute('data-session-id') || it.getAttribute('id');
              const t = it.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim();
              if (mId === id || mId === targetItem.sesUUID || t === id || (t && t.includes(id))) {
                if (typeof it.click === 'function') {
                  it.click();
                } else {
                  it.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
                return { success: true, method: 'scroll_and_click' };
              }
            }
          }
        }

        return { success: false, method: 'not_found' };
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
