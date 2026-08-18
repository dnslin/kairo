import { createHash } from 'node:crypto';
import type { CdpClient } from '../cdp/client.js';
import type { KK9Message, KK9Session, SelectorsConfig } from '../types/index.js';
import { DomError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('message-ops');

interface RawMessageData {
  sender: string;
  time: string;
  content: string;
  isMe: boolean;
  raw?: Record<string, unknown>;
}

export class MessageOps {
  constructor(
    private readonly cdp: CdpClient,
    private readonly selectors: SelectorsConfig
  ) {}

  /**
   * 生成强唯一 SHA-256 指纹（使用不可见空字符分隔）
   */
  public static generateFingerprint(sessionId: string, sender: string, time: string, content: string): string {
    const raw = `${sessionId}\x00${sender}\x00${time}\x00${content}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * 读取当前激活会话的最近消息列表
   */
  public async getRecentMessages(limit = 20, session?: KK9Session): Promise<KK9Message[]> {
    const currentSessionId = session?.id || '';
    const currentSessionName = session?.name || '';
    const currentSessionType = session?.type || 'private';

    const script = `
      (() => {
        function extractContent(node) {
          if (!node) return '';
          if (node.nodeType === Node.TEXT_NODE) {
            return node.textContent || '';
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toUpperCase();
            if (tag === 'IMG') {
              return node.getAttribute('emoji') || node.getAttribute('alt') || '[image]';
            }
            if (node.classList.contains('emoji-span')) {
              return node.getAttribute('data-emoji') || '[emoji]';
            }
            if (node.classList.contains('emoticon')) {
              return node.textContent || '[emoticon]';
            }
            if (node.classList.contains('sticker')) {
              return '[sticker]';
            }
            if (node.classList.contains('is-card') || node.classList.contains('file-card')) {
              return '[file]';
            }
            let text = '';
            for (let i = 0; i < node.childNodes.length; i++) {
              text += extractContent(node.childNodes[i]);
            }
            return text;
          }
          return '';
        }

        const items = document.querySelectorAll('${this.selectors.messageItem}');
        const rawList = [];
        const startIndex = Math.max(0, items.length - ${Math.max(1, limit)});

        for (let i = startIndex; i < items.length; i++) {
          const item = items[i];
          const senderEl = item.querySelector('${this.selectors.messageSender}');
          const timeEl = item.querySelector('${this.selectors.messageTime}');
          const contentEl = item.querySelector('${this.selectors.messageContent}');

          const sender = senderEl?.textContent?.trim() || '';
          const time = timeEl?.textContent?.trim() || '';
          const content = extractContent(contentEl).trim();

          const isMe = item.matches('${this.selectors.messageIsMe}') ||
            item.querySelector('${this.selectors.messageIsMe}') !== null ||
            item.classList.contains('message-right') ||
            item.classList.contains('is-me');

          if (content || sender) {
            rawList.push({
              sender,
              time,
              content,
              isMe
            });
          }
        }
        return rawList;
      })()
    `;

    try {
      const rawMessages = await this.cdp.evaluate<RawMessageData[]>(script);
      if (!Array.isArray(rawMessages)) return [];

      const now = Date.now();
      return rawMessages.map((raw) => {
        const fp = MessageOps.generateFingerprint(currentSessionId, raw.sender, raw.time, raw.content);
        return {
          id: fp,
          sessionId: currentSessionId,
          sessionName: currentSessionName,
          sessionType: currentSessionType,
          sender: raw.sender,
          content: raw.content,
          time: raw.time,
          isMe: raw.isMe,
          timestamp: now,
        };
      });
    } catch (err) {
      log.error({ err: String(err) }, '获取消息列表失败');
      throw new DomError(`获取消息列表失败: ${err instanceof Error ? err.message : String(err)}`, err instanceof Error ? err : undefined);
    }
  }
}
