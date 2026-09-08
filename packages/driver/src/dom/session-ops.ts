import type { CdpClient } from '../cdp/client.js';
import type { KK9Session, SelectorsConfig } from '../types/index.js';
import { DomError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import { VUE_SCROLLER_HELPERS_SCRIPT } from './helpers.js';

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
        ${VUE_SCROLLER_HELPERS_SCRIPT}

        // 1. 尝试穿透 Vue 虚拟滚动实例
        try {
          const items = getVueScrollerItems('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
          if (items) {
            return items.map(item => {
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

              const isGroup = Boolean(
                item.type === 1 ||
                item.type === 2 ||
                item.sesTypeID === 1 ||
                item.sesTypeID === 2 ||
                item.isGroup ||
                item.groupInfo
              );
              const type = isGroup ? 'group' : 'private';

              const unread = Boolean(
                item.unread ||
                (typeof item.userReadIndex === 'number' && typeof item.maxMessageIndex === 'number' && item.userReadIndex < item.maxMessageIndex) ||
                (typeof item.unreadCount === 'number' && item.unreadCount > 0)
              );

              const unreadAt = Boolean(
                item.atState > 0 ||
                item.hasAtMe ||
                item.hasAtAll ||
                item.unreadAt ||
                lastMsg.includes('[@有人@我]') ||
                lastMsg.includes('[@全体成员]') ||
                lastMsg.includes('[@有人提到我]')
              );

              const sessionName = String(item.typeName || item.name || item.title || item.senderName || '未命名会话');

              return {
                id: String(item.sesUUID || item.id || item.sessionId || ''),
                name: sessionName,
                type: type,
                unread: unread,
                unreadCount: Number(item.unreadCount || 0),
                unreadAt: unreadAt,
                lastMessage: lastMsg,
                lastMessageTime: lastTime,
                active: Boolean(item.isActive || item.selected)
              };
            }).filter(s => s.id.length > 0);
          }
        } catch {
          console.warn('[KairoDriver] Vue滚动列表检查失败');
        }

        // 2. 降级回退：遍历当前可视 DOM
        const items = document.querySelectorAll('${this.selectors.sessionItem}');
        const results = [];
        for (const item of items) {
          const titleEl = item.querySelector('${this.selectors.sessionTitle}');
          const unreadEl = item.querySelector('${this.selectors.sessionUnreadBadge}');
          const id = item.getAttribute('data-sesuuid') || item.getAttribute('data-session-id') || item.getAttribute('id') || titleEl?.textContent?.trim() || '';
          const name = titleEl?.textContent?.trim() || '未命名会话';
          const unread = unreadEl !== null && window.getComputedStyle(unreadEl).display !== 'none';
          const active = item.classList.contains('active') || item.classList.contains('selected') || item.classList.contains('chat-selected');

          const hasAtBadge = item.querySelector('.badge-at, .at-tips, [class*="at-tips"], [class*="badge-at"], [class*="at-badge"], .is-at') !== null;
          const previewText = item.querySelector('.last-msg, .chat-item-msg, .desc')?.textContent?.trim() || '';
          const unreadAt = hasAtBadge || previewText.includes('[@有人@我]') || previewText.includes('[@全体成员]');

          const isGroupDom = item.classList.contains('group-session') ||
            item.querySelector('.group-avatar, .discuss-avatar, [class*="group"]') !== null ||
            item.getAttribute('data-type') === '1' ||
            item.getAttribute('data-type') === '2';
          const type = isGroupDom ? 'group' : 'private';

          if (id) {
            results.push({
              id,
              name,
              type,
              unread,
              unreadAt,
              lastMessage: previewText,
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
      throw new DomError(
        `获取会话列表失败: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
  }

  public async getActiveSessionId(): Promise<string | null> {
    const script = `
      (() => {
        const selected = document.querySelector('.chat-item.chat-selected') ||
          document.querySelector('${this.selectors.activeSession}');
        if (!selected) return null;
        return selected.getAttribute('data-sesuuid') ||
          selected.getAttribute('data-session-id') ||
          selected.getAttribute('id') ||
          null;
      })()
    `;

    try {
      const sessionId = await this.cdp.evaluate<string | null>(script);
      return sessionId?.trim() || null;
    } catch {
      return null;
    }
  }

  /**
   * 获取当前处于激活状态的会话
   */
  public async getCurrentSession(): Promise<KK9Session | null> {
    const script = `
      (() => {
        const el = document.querySelector('.chat-item.chat-selected') ||
          document.querySelector('${this.selectors.activeSession}');
        if (!el) return null;
        const titleEl = el.querySelector('${this.selectors.sessionTitle}');
        const id = el.getAttribute('data-sesuuid') || el.getAttribute('data-session-id') || el.getAttribute('id') || '';
        const name = titleEl?.textContent?.trim() || '';
        return { id, name };
      })()
    `;

    try {
      const activeDom = await this.cdp.evaluate<{ id: string; name: string } | null>(script);
      if (activeDom && (activeDom.id || activeDom.name)) {
        const sessions = await this.getSessions();
        const matched = sessions.find(
          s =>
            s.id === activeDom.id ||
            s.name === activeDom.name ||
            (activeDom.id && s.id.includes(activeDom.id))
        );
        if (matched) {
          return { ...matched, active: true };
        }
        return {
          id: activeDom.id,
          name: activeDom.name || '当前会话',
          type: 'private',
          unread: false,
          active: true,
        };
      }
      return null;
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
        ${VUE_SCROLLER_HELPERS_SCRIPT}
        const id = ${JSON.stringify(sessionId)};

        // 1. 获取目标会话的核心标识与索引
        const scroller = document.querySelector('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        const scrollerItems = getVueScrollerItems('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        const { index: targetIndex, item: targetItem } = findVueSessionItem(scrollerItems, id);
        if (Array.isArray(scrollerItems) && !targetItem) {
          return { success: false, method: 'target_not_unique' };
        }

        const targetSesUUID = targetItem?.sesUUID || id;
        const targetName = targetItem?.typeName || targetItem?.name || id;

        function findVisibleTarget() {
          const domItems = Array.from(document.querySelectorAll('${this.selectors.sessionItem}'));
          const idMatches = domItems.filter(item => {
            const matchId = item.getAttribute('data-sesuuid') || item.getAttribute('data-session-id') || item.getAttribute('id');
            return matchId === targetSesUUID || matchId === id;
          });
          if (idMatches.length === 1) return idMatches[0];
          if (idMatches.length > 1) return null;

          const nameMatches = domItems.filter(item => {
            const title = item.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim();
            return title === targetName || title === id;
          });
          return nameMatches.length === 1 ? nameMatches[0] : null;
        }

        // 2. 辅助函数: 在当前 DOM 查找并点击唯一精确匹配项
        function tryClickVisibleDom() {
          const item = findVisibleTarget();
          if (!item) return false;
          item.scrollIntoView({ block: 'nearest' });
          if (typeof item.click === 'function') {
            item.click();
          } else {
            item.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return true;
        }

        // 3. 辅助函数: 验证当前高亮会话是否已是目标会话
        function isTargetActive() {
          const selected = document.querySelector('${this.selectors.activeSession}') || document.querySelector('.chat-item.chat-selected');
          if (!selected) return false;
          const selectedUuid = selected.getAttribute('data-sesuuid') || selected.getAttribute('data-session-id') || selected.getAttribute('id');
          if (selectedUuid) {
            return selectedUuid === targetSesUUID || selectedUuid === id;
          }
          return findVisibleTarget() === selected;
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

  /**
   * 显式消除指定会话的未读红点与 @ 提示（视觉红点守卫）
   * @param sessionId 目标会话 ID
   * @returns 是否成功清除红点
   */
  public async markSessionRead(sessionId: string): Promise<boolean> {
    const script = `
      (() => {
        ${VUE_SCROLLER_HELPERS_SCRIPT}
        const id = ${JSON.stringify(sessionId)};

        // 1. 尝试从 Vue 虚拟滚动数据层清除未读标记
        const scrollerItems = getVueScrollerItems('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        const { item } = findVueSessionItem(scrollerItems, id);
        if (item) {
          if (typeof item.unread !== 'undefined') item.unread = false;
          if (typeof item.unreadCount !== 'undefined') item.unreadCount = 0;
          if (typeof item.unreadAt !== 'undefined') item.unreadAt = false;
          if (typeof item.atState !== 'undefined') item.atState = 0;
          if (typeof item.hasAtMe !== 'undefined') item.hasAtMe = false;
          if (typeof item.hasAtAll !== 'undefined') item.hasAtAll = false;
        }

        // 2. 遍历可见 DOM 元素隐藏未读徽标
        const domItems = document.querySelectorAll('${this.selectors.sessionItem}');
        let domMatched = false;
        for (const el of domItems) {
          const matchId = el.getAttribute('data-sesuuid') || el.getAttribute('data-session-id') || el.getAttribute('id');
          const title = el.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim();
          if (matchId === id || title === id || (title && title.includes(id))) {
            domMatched = true;
            const badge = el.querySelector('${this.selectors.sessionUnreadBadge}');
            if (badge && badge instanceof HTMLElement) {
              badge.style.display = 'none';
            }
            const atBadge = el.querySelector('.badge-at, .at-tips, [class*="at-tips"], [class*="badge-at"], [class*="at-badge"], .is-at');
            if (atBadge && atBadge instanceof HTMLElement) {
              atBadge.style.display = 'none';
            }
            break;
          }
        }

        return { success: true, vueUpdated: Boolean(item), domUpdated: domMatched };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean }>(script);
      log.debug({ sessionId, res }, '执行会话未读红点消除');
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ sessionId, err: String(err) }, '消除会话未读红点失败');
      return false;
    }
  }
}
