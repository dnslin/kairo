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

export class DomLocator {
  constructor(
    private readonly connector: CdpConnector,
    private readonly selectors: SelectorsConfig
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

    const response = (await this.connector.evaluate(script)) as {
      result?: { value?: SessionInfo[] };
    };

    const sessions = response.result?.value || [];
    log.debug({ count: sessions.length }, 'Sessions retrieved');
    return sessions;
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
            if (node.nodeType === 3) {
              const text = node.textContent?.trim();
              if (text) result += text;
            } else if (node.nodeType === 1) {
              const tag = node.tagName;
              if (tag === 'IMG') {
                result += node.getAttribute('alt') || '[image]';
              } else if (node.classList.contains('emoji-span')) {
                result += node.getAttribute('data-emoji') || '[emoji]';
              } else if (node.classList.contains('emoticon')) {
                result += node.textContent || '[emoticon]';
              } else if (node.classList.contains('sticker')) {
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
          const id = item.id || '';
          const contentEl = item.querySelector('${this.selectors.messageContent}');
          const senderEl = item.querySelector('${this.selectors.messageSender}');
          const timeEl = item.querySelector('${this.selectors.messageTime}');
          const isRight = item.querySelector('${this.selectors.messageRight}') !== null;
          
          if (contentEl) {
            messages.push({
              id: id,
              sender: senderEl ? senderEl.textContent.trim() : '',
              content: extractContent(contentEl),
              time: timeEl ? timeEl.textContent.trim() : '',
              isMe: isRight
            });
          }
        });
        
        return messages;
      })()
    `;

    const response = (await this.connector.evaluate(script)) as {
      result?: { value?: MessageInfo[] };
    };

    const messages = response.result?.value || [];
    log.debug({ count: messages.length }, 'Messages retrieved');
    return messages;
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

    const response = (await this.connector.evaluate(script)) as {
      result?: { value?: { found: boolean; editable: boolean } };
    };

    return response.result?.value || { found: false, editable: false };
  }

  async setInputText(text: string): Promise<boolean> {
    const escapedText = text.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');

    const script = `
      (function() {
        const inputBox = document.querySelector('${this.selectors.inputBox}');
        if (!inputBox) return false;
        
        inputBox.focus();
        inputBox.innerHTML = '${escapedText}';
        
        inputBox.dispatchEvent(new Event('input', { bubbles: true }));
        inputBox.dispatchEvent(new Event('change', { bubbles: true }));
        
        return true;
      })()
    `;

    const response = (await this.connector.evaluate(script)) as {
      result?: { value?: boolean };
    };

    const success = response.result?.value === true;
    log.debug({ success, textLength: text.length }, 'Input text set');
    return success;
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

    const response = (await this.connector.evaluate(script)) as {
      result?: { value?: boolean };
    };

    const success = response.result?.value === true;
    log.debug({ success }, 'Send button clicked');
    return success;
  }

  async selectSession(sessionId: string): Promise<boolean> {
    const script = `
      (function() {
        const item = document.querySelector('${this.selectors.sessionItem}[data-sesuuid="${sessionId}"]');
        if (!item) return false;
        
        item.click();
        return true;
      })()
    `;

    const response = (await this.connector.evaluate(script)) as {
      result?: { value?: boolean };
    };

    const success = response.result?.value === true;
    log.debug({ success, sessionId }, 'Session selected');
    return success;
  }
}
