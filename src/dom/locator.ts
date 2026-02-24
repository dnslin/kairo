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

export class DomLocator {
  constructor(
    private readonly connector: CdpConnector,
    private selectors: SelectorsConfig
  ) {}

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

    const script = `
      (function() {
        const targetId = '${escapedSessionId}';
        const items = document.querySelectorAll('${this.selectors.sessionItem}');
        const item = Array.from(items).find(el => el.getAttribute('data-sesuuid') === targetId);
        if (!item) return false;
        
        item.click();
        return true;
      })()
    `;

    try {
      const response = (await this.connector.evaluate(script)) as {
        result?: { value?: boolean };
      };

      const success = response.result?.value === true;
      log.debug({ success, sessionId }, 'Session selected');
      return success;
    } catch (error) {
      log.error({ err: error, sessionId }, 'Failed to select session');
      return false;
    }
  }

  updateSelectors(selectors: SelectorsConfig): void {
    log.info('Selectors configuration updated');
    this.selectors = selectors;
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
