import type { CdpConnector } from '../cdp/connector.js';
import type { SelectorsConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('dom');

export type SessionType = 'private' | 'group';

export interface SessionInfo {
  id: string;
  name: string;
  type: SessionType;
  lastMessage: string;
  time: string;
  unread: boolean;
  isSelected: boolean;
}

export interface MessageInfo {
  id: string;
  sender: string;
  content: string;
  time: string;
  isMe: boolean;
}

export interface ElementInfo {
  found: boolean;
  selector: string;
}

export interface MessageListInfo extends ElementInfo {
  childCount: number;
}

export interface MessageNodeInfo {
  id: string;
  index: number;
}

export interface MessageNodesInfo extends ElementInfo {
  count: number;
  nodes: MessageNodeInfo[];
}

export interface SendButtonInfo extends ElementInfo {
  visible: boolean;
  enabled: boolean;
}

export class DomLocatorError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'DomLocatorError';
    this.originalCause = originalCause;
  }
}

export interface GetAllSessionsOptions {
  /** 预留：未来可扩展的选项 */
  placeholder?: never;
}

export class DomLocator {
  constructor(
    private readonly connector: CdpConnector,
    private selectors: SelectorsConfig
  ) {}
  getConnector(): CdpConnector {
    return this.connector;
  }

  async getSessions(): Promise<SessionInfo[]> {
    const script = `
      (function() {
        const sessions = [];
        const items = document.querySelectorAll('${this.selectors.sessionItem}');
        
        items.forEach(item => {
          const id = item.getAttribute('data-sesuuid') || '';
          const nameEl = item.querySelector('${this.selectors.sessionName}');
          const timeEl = item.querySelector('${this.selectors.sessionTime}');
          const previewEl = item.querySelector('${this.selectors.sessionPreview}');
          const unreadEl = item.querySelector('${this.selectors.sessionUnread}');
          const avatarEl = item.querySelector('.chat-item-avatar');
          const isSelected = item.classList.contains('chat-selected');
          
          const hasGroupAvatar = avatarEl && avatarEl.querySelector('${this.selectors.groupAvatar}, ${this.selectors.discussAvatar}');
          
          sessions.push({
            id: id,
            name: nameEl ? nameEl.textContent.trim() : '',
            type: hasGroupAvatar ? 'group' : 'private',
            lastMessage: previewEl ? previewEl.textContent.trim() : '',
            time: timeEl ? timeEl.textContent.trim() : '',
            unread: !!unreadEl && unreadEl.offsetParent !== null,
            isSelected: isSelected
          });
        });
        
        return sessions;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: SessionInfo[] };
      };

      const sessions = response.result?.value || [];
      log.debug({ count: sessions.length }, 'Sessions retrieved');
      return sessions;
    } catch (error) {
      log.error({ err: error }, 'Failed to get sessions');
      throw new DomLocatorError('Failed to get sessions', error as Error);
    }
  }

  async getAllSessions(_options: GetAllSessionsOptions = {}): Promise<SessionInfo[]> {
    const scrollerSel = this.selectors.sessionScroller;

    try {
      // 优先从 vue-recycle-scroller 的 Vue 实例直接读取全部会话数据
      const script = `
        (function() {
          var scroller = document.querySelector('${scrollerSel}');
          if (!scroller) return { scrollerNotFound: true };
          var vue = scroller.__vue__;
          if (!vue || !vue.items || !vue.items.length) return { vueNotFound: true };

          var sessions = vue.items.map(function(item) {
            var isGroup = item.type === 1 || item.type === 2;
            var name = isGroup
              ? item.typeName
              : (item.creater === item.sesTypeID ? item.createrName : item.typeName);
            var unread = item.userReadIndex < item.maxMessageIndex;

            var lastMsg = '';
            if (item.lastMessage) {
              var msg;
              try {
                msg = typeof item.lastMessage === 'string'
                  ? JSON.parse(item.lastMessage)
                  : item.lastMessage;
              } catch(e) {
                msg = null;
              }
              if (msg && msg.content && msg.content.length) {
                lastMsg = msg.content.map(function(c) {
                  if (c.text) return c.text;
                  if (c.type === 1) return '[image]';
                  return '';
                }).join('');
              }
            }

            return {
              id: item.sesUUID || '',
              name: name || '',
              type: isGroup ? 'group' : 'private',
              lastMessage: lastMsg,
              time: item.lastMsgTime || '',
              unread: unread,
              isSelected: false
            };
          });

          return { sessions: sessions };
        })()
      `;

      const response = (await this.connector.evaluate(script)) as {
        result?: {
          value?: {
            scrollerNotFound?: boolean;
            vueNotFound?: boolean;
            sessions?: SessionInfo[];
          };
        };
      };

      const data = response.result?.value;

      // Vue 实例可用 → 直接返回全部会话
      if (data && !data.scrollerNotFound && !data.vueNotFound && data.sessions) {
        log.debug({ count: data.sessions.length }, '从 Vue 实例获取全部会话');
        return data.sessions;
      }

      // 回退到普通 getSessions
      log.warn('Vue 实例不可用，回退到 getSessions');
      return this.getSessions();
    } catch (error) {
      log.error({ err: error }, '获取全部会话失败');
      throw new DomLocatorError('Failed to get all sessions', error as Error);
    }
  }

  async getCurrentSession(): Promise<SessionInfo | null> {
    const sessions = await this.getSessions();
    return sessions.find(s => s.isSelected) || null;
  }

  async getMessages(limit = 20): Promise<MessageInfo[]> {
    const script = `
      (function() {
        function extractContent(el) {
          if (!el) return '';
          let result = '';
          el.childNodes.forEach(node => {
            if (node.nodeType === Node.TEXT_NODE) {
              const text = node.textContent;
              if (text) result += text;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
              const tag = node.tagName;
              if (tag === 'IMG') {
                result += node.getAttribute('emoji') || node.getAttribute('alt') || '[image]';
              } else if (node.classList && node.classList.contains('emoji-span')) {
                result += node.getAttribute('data-emoji') || '[emoji]';
              } else if (node.classList && node.classList.contains('emoticon')) {
                result += node.textContent || '[emoticon]';
              } else if (node.classList && node.classList.contains('sticker')) {
                result += '[sticker]';
              } else {
                result += extractContent(node);
              }
            }
          });
          return result.trim();
        }
        
        const messages = [];
        const items = document.querySelectorAll('${this.selectors.messageItem}');
        const lastItems = Array.from(items).slice(-${limit});
        
        lastItems.forEach(item => {
          const isSysMsg = item.querySelector('.rcd-sys') !== null;
          if (isSysMsg) return;
          const id = item.id || '';
          const contentEl = item.querySelector('${this.selectors.messageContent}');
          const senderEl = item.querySelector('${this.selectors.messageSender}');
          const timeEl = item.querySelector('${this.selectors.messageTime}');
          const isRight = item.querySelector('${this.selectors.messageRight}') !== null;
          let content = '';
          if (contentEl) {
            content = extractContent(contentEl);
          } else {
            const isCard = item.classList.contains('is-card');
            if (isCard) {
              content = '[file]';
            } else {
              const img = item.querySelector('img.pictext-pic');
              if (img) content = '[image]';
            }
          }
          if (content) {
            messages.push({
              id: id,
              sender: senderEl ? senderEl.textContent.trim() : '',
              content: content,
              time: timeEl ? timeEl.textContent.trim() : '',
              isMe: isRight
            });
          }
        });
        
        return messages;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: MessageInfo[] };
      };

      const messages = response.result?.value || [];
      log.debug({ count: messages.length }, 'Messages retrieved');
      return messages;
    } catch (error) {
      log.error({ err: error }, 'Failed to get messages');
      throw new DomLocatorError('Failed to get messages', error as Error);
    }
  }

  async getMessageNodes(): Promise<MessageNodesInfo> {
    const selector = this.selectors.messageItem;
    const script = `
      (function() {
        const items = document.querySelectorAll('${selector}');
        const nodes = Array.from(items).map((item, index) => ({
          id: item.id || '',
          index: index
        }));
        return {
          found: items.length > 0,
          selector: '${selector}',
          count: items.length,
          nodes: nodes
        };
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: MessageNodesInfo };
      };

      const result = response.result?.value || { found: false, selector, count: 0, nodes: [] };
      log.debug({ found: result.found, count: result.count }, '消息节点已定位');
      return result;
    } catch (error) {
      log.error({ err: error }, '获取消息节点失败');
      throw new DomLocatorError('Failed to get message nodes', error as Error);
    }
  }

  async getInputBox(): Promise<{ found: boolean; editable: boolean }> {
    const script = `
      (function() {
        const inputBox = document.querySelector('${this.selectors.inputBox}');
        if (!inputBox) return { found: false, editable: false };
        return {
          found: true,
          editable: inputBox.getAttribute('contenteditable') === 'true'
        };
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: { found: boolean; editable: boolean } };
      };

      return response.result?.value || { found: false, editable: false };
    } catch (error) {
      log.error({ err: error }, 'Failed to get input box');
      return { found: false, editable: false };
    }
  }
  async focusInputBox(): Promise<boolean> {
    const script = `
      (function() {
        const inputBox = document.querySelector('${this.selectors.inputBox}');
        if (!inputBox) return false;
        inputBox.focus();
        return true;
      })()
    `;
    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: boolean };
      };
      const success = response.result?.value === true;
      log.debug({ success }, 'Input box focused');
      return success;
    } catch (error) {
      log.error({ err: error }, 'Failed to focus input box');
      return false;
    }
  }
  async simulatePaste(): Promise<void> {
    const isMac = process.platform === 'darwin';
    const modifierKey = isMac ? 'Meta' : 'Control';
    const modifierCode = isMac ? 'MetaLeft' : 'ControlLeft';
    const modifierKeyCode = isMac ? 91 : 17;
    const modifierValue = isMac ? 8 : 2;
    await this.connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: modifierKey,
      code: modifierCode,
      windowsVirtualKeyCode: modifierKeyCode,
      nativeVirtualKeyCode: modifierKeyCode,
      modifiers: modifierValue,
    });
    await this.connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: modifierValue,
    });
    await this.connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: modifierValue,
    });
    await this.connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: modifierKey,
      code: modifierCode,
      windowsVirtualKeyCode: modifierKeyCode,
      nativeVirtualKeyCode: modifierKeyCode,
      modifiers: 0,
    });
  }

  async setInputText(text: string): Promise<boolean> {
    const escapedText = text
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\n/g, '\\n')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const script = `
      (function() {
        const inputBox = document.querySelector('${this.selectors.inputBox}');
        if (!inputBox) return false;
        
        inputBox.focus();
        inputBox.textContent = '${escapedText}';
        
        inputBox.dispatchEvent(new Event('input', { bubbles: true }));
        inputBox.dispatchEvent(new Event('change', { bubbles: true }));
        
        return true;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: boolean };
      };

      const success = response.result?.value === true;
      log.debug({ success, textLength: text.length }, 'Input text set');
      return success;
    } catch (error) {
      log.error({ err: error }, 'Failed to set input text');
      return false;
    }
  }

  async getSendButton(): Promise<SendButtonInfo> {
    const selector = this.selectors.sendButton;
    const script = `
      (function() {
        const btn = document.querySelector('${selector}');
        if (!btn) return { found: false, selector: '${selector}', visible: false, enabled: false };
        return {
          found: true,
          selector: '${selector}',
          visible: btn.offsetParent !== null,
          enabled: !btn.hasAttribute('disabled') && !btn.classList.contains('disabled')
        };
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: SendButtonInfo };
      };

      const result = response.result?.value || {
        found: false,
        selector,
        visible: false,
        enabled: false,
      };
      log.debug(
        { found: result.found, visible: result.visible, enabled: result.enabled },
        '发送按钮已定位'
      );
      return result;
    } catch (error) {
      log.error({ err: error }, '获取发送按钮失败');
      throw new DomLocatorError('获取发送按钮失败', error as Error);
    }
  }

  async clickSendButton(): Promise<boolean> {
    const script = `
      (function() {
        const sendBtn = document.querySelector('${this.selectors.sendButton}');
        if (!sendBtn) return false;
        
        sendBtn.click();
        return true;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: boolean };
      };

      const success = response.result?.value === true;
      log.debug({ success }, 'Send button clicked');
      return success;
    } catch (error) {
      log.error({ err: error }, 'Failed to click send button');
      return false;
    }
  }

  async selectSession(sessionId: string): Promise<boolean> {
    const escapedSessionId = sessionId.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const scrollerSel = this.selectors.sessionScroller;
    const itemSel = this.selectors.sessionItem;

    try {
      // 第一步：在当前 DOM 中直接查找并点击，同时检查 Vue 实例获取目标索引
      const initScript = `
        (function() {
          var targetId = '${escapedSessionId}';
          var items = document.querySelectorAll('${itemSel}');
          var item = Array.from(items).find(function(el) { return el.getAttribute('data-sesuuid') === targetId; });
          if (item) {
            item.click();
            return { found: true };
          }
          var scroller = document.querySelector('${scrollerSel}');
          if (!scroller || !scroller.__vue__ || !scroller.__vue__.items) {
            return { found: false, hasVue: false };
          }
          var vue = scroller.__vue__;
          var idx = vue.items.findIndex(function(it) { return it.sesUUID === targetId; });
          if (idx === -1) return { found: false, hasVue: true, index: -1 };
          return { found: false, hasVue: true, index: idx };
        })()
      `;

      const initResponse = (await this.connector.evaluate(initScript)) as {
        result?: {
          value?: {
            found: boolean;
            hasVue?: boolean;
            index?: number;
          };
        };
      };

      const initData = initResponse.result?.value;

      // 直接在 DOM 中找到并已点击
      if (initData?.found) {
        log.debug({ sessionId }, '会话选中（直接命中）');
        return true;
      }

      // Vue 实例不可用或目标不在列表中
      if (!initData?.hasVue || initData.index === undefined || initData.index === -1) {
        log.debug({ sessionId, hasVue: initData?.hasVue, index: initData?.index }, '会话未找到');
        return false;
      }

      // 第二步：通过 scrollToItem 滚动到目标位置
      const targetIndex = initData.index;
      const scrollScript = `
        (function() {
          var scroller = document.querySelector('${scrollerSel}');
          if (!scroller || !scroller.__vue__) return false;
          scroller.__vue__.scrollToItem(${String(targetIndex)});
          return true;
        })()
      `;
      const scrollResponse = (await this.connector.evaluate(scrollScript)) as {
        result?: { value?: boolean };
      };

      if (scrollResponse.result?.value !== true) {
        log.warn({ sessionId, targetIndex }, 'scrollToItem 调用失败');
        return false;
      }

      // 等待 vue-recycle-scroller 渲染新的 DOM 元素
      await new Promise(resolve => setTimeout(resolve, 300));

      // 第三步：在更新后的 DOM 中查找并点击
      const clickScript = `
        (function() {
          var targetId = '${escapedSessionId}';
          var items = document.querySelectorAll('${itemSel}');
          var item = Array.from(items).find(function(el) { return el.getAttribute('data-sesuuid') === targetId; });
          if (item) {
            item.click();
            return true;
          }
          return false;
        })()
      `;
      const clickResponse = (await this.connector.evaluate(clickScript)) as {
        result?: { value?: boolean };
      };

      if (clickResponse.result?.value === true) {
        log.debug({ sessionId, targetIndex }, '会话选中（scrollToItem 后命中）');
        return true;
      }

      log.debug({ sessionId, targetIndex }, 'scrollToItem 后仍未找到目标元素');
      return false;
    } catch (error) {
      log.error({ err: error, sessionId }, '选择会话失败');
      return false;
    }
  }

  updateSelectors(selectors: SelectorsConfig): void {
    log.info('Selectors configuration updated');
    this.selectors = selectors;
  }

  /** 获取当前激活会话的 ID（轻量查询，仅返回 ID 字符串） */
  async getActiveSessionId(): Promise<string | null> {
    const script = `
      (function() {
        var item = document.querySelector('${this.selectors.sessionItem}.chat-selected');
        if (!item) return null;
        return item.getAttribute('data-sesuuid') || null;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: string | null };
      };
      const sessionId = response.result?.value ?? null;
      log.debug({ sessionId }, '获取激活会话 ID');
      return sessionId;
    } catch (error) {
      log.error({ err: error }, '获取激活会话 ID 失败');
      return null;
    }
  }

  /** 检查指定内容和发送者的消息是否仍在 DOM 中 */
  async isMessageInDom(content: string, sender: string): Promise<boolean> {
    const escapedContent = content.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedSender = sender.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const script = `
      (function() {
        var targetContent = '${escapedContent}';
        var targetSender = '${escapedSender}';
        var items = document.querySelectorAll('${this.selectors.messageItem}');
        for (var i = items.length - 1; i >= 0; i--) {
          var item = items[i];
          var contentEl = item.querySelector('${this.selectors.messageContent}');
          var senderEl = item.querySelector('${this.selectors.messageSender}');
          var c = contentEl ? contentEl.textContent.trim() : '';
          var s = senderEl ? senderEl.textContent.trim() : '';
          if (c === targetContent && s === targetSender) return true;
        }
        return false;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: boolean };
      };
      const exists = response.result?.value === true;
      log.debug({ exists, content: content.slice(0, 20) }, '检查消息是否在 DOM 中');
      return exists;
    } catch (error) {
      log.error({ err: error }, '检查消息 DOM 存在性失败');
      return false;
    }
  }

  /** 检查指定消息之后是否有新的非自己发送的消息 */
  async hasNewMessagesSince(content: string, sender: string): Promise<boolean> {
    const escapedContent = content.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const escapedSender = sender.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    const script = `
      (function() {
        var targetContent = '${escapedContent}';
        var targetSender = '${escapedSender}';
        var items = document.querySelectorAll('${this.selectors.messageItem}');
        var targetIndex = -1;
        for (var i = items.length - 1; i >= 0; i--) {
          var item = items[i];
          var contentEl = item.querySelector('${this.selectors.messageContent}');
          var senderEl = item.querySelector('${this.selectors.messageSender}');
          var c = contentEl ? contentEl.textContent.trim() : '';
          var s = senderEl ? senderEl.textContent.trim() : '';
          if (c === targetContent && s === targetSender) {
            targetIndex = i;
            break;
          }
        }
        if (targetIndex === -1) return false;
        for (var j = targetIndex + 1; j < items.length; j++) {
          var isRight = items[j].querySelector('${this.selectors.messageRight}') !== null;
          var isSysMsg = items[j].querySelector('.rcd-sys') !== null;
          if (!isRight && !isSysMsg) return true;
        }
        return false;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: boolean };
      };
      const hasNew = response.result?.value === true;
      log.debug({ hasNew, content: content.slice(0, 20) }, '检查是否有新消息');
      return hasNew;
    } catch (error) {
      log.error({ err: error }, '检查新消息失败');
      return false;
    }
  }

  async getMessageList(): Promise<MessageListInfo> {
    const selector = this.selectors.messageContainer;
    const script = `
      (function() {
        const el = document.querySelector('${selector}');
        if (!el) return { found: false, selector: '${selector}', childCount: 0 };
        return {
          found: true,
          selector: '${selector}',
          childCount: el.children.length
        };
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: MessageListInfo };
      };

      const result = response.result?.value || { found: false, selector, childCount: 0 };
      log.debug({ found: result.found, childCount: result.childCount }, '消息列表已定位');
      return result;
    } catch (error) {
      log.error({ err: error }, '获取消息列表失败');
      throw new DomLocatorError('获取消息列表失败', error as Error);
    }
  }
}
