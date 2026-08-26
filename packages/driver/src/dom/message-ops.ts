import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { CdpClient } from '../cdp/client.js';
import { normalizeNativeMessage } from '../bridge/converter.js';
import type {
  KK9FileInfo,
  KK9ImageInfo,
  KK9Message,
  KK9MessageType,
  KK9MentionInfo,
  KK9ReplyInfo,
  KK9Session,
  SelectorsConfig,
} from '../types/index.js';
import { DomError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('message-ops');

/**
 * 将图片读取为 Data URL Base64 格式（便于直接喂给视觉/多模态 LLM）
 */
export function readImageAsBase64(imageInfo: KK9ImageInfo): string | null {
  if (!imageInfo.filePath || !fs.existsSync(imageInfo.filePath)) {
    return null;
  }
  const mimeType = imageInfo.mimeType || 'image/png';
  const buf = fs.readFileSync(imageInfo.filePath);
  return `data:${mimeType};base64,${buf.toString('base64')}`;
}

/**
 * 将缓存的图片文件另存为指定的目标文件路径（如自动补全 .png 扩展名）
 */
export function saveImageToFile(imageInfo: KK9ImageInfo, destPath: string): boolean {
  if (!imageInfo.filePath || !fs.existsSync(imageInfo.filePath)) {
    return false;
  }
  fs.copyFileSync(imageInfo.filePath, destPath);
  return true;
}

interface RawMessageData {
  sender: string;
  senderId?: string;
  time: string;
  content: string;
  isMe: boolean;
  timestamp?: number;
  messageType?: KK9MessageType;
  atMe?: boolean;
  atAll?: boolean;
  mentions?: KK9MentionInfo;
  replyTo?: KK9ReplyInfo;
  fileInfo?: KK9FileInfo;
  images?: KK9ImageInfo[];
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
  public static generateFingerprint(
    sessionId: string,
    sender: string,
    time: string,
    content: string
  ): string {
    const raw = `${sessionId}\x00${sender}\x00${time}\x00${content}`;
    return createHash('sha256').update(raw).digest('hex');
  }

  /**
   * 读取当前激活会话的最近消息列表
   */
  public async getRecentMessages(
    limit = 20,
    session?: KK9Session,
    knownBotSentIds?: Set<string>,
    currentUserId?: string | number
  ): Promise<KK9Message[]> {
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
              return node.getAttribute('emoji') || node.getAttribute('alt') || '[图片]';
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
              const fileName = node.querySelector('.file-name, .name, [class*="filename"]')?.textContent?.trim() || '';
              return fileName ? ('[文件: ' + fileName + ']') : '[file]';
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
          const senderEl = item.querySelector('${this.selectors.messageSender}') ||
            item.querySelector('.rcd-basic-name .username, .username, .sender-name, .nickname, .name');
          const timeEl = item.querySelector('${this.selectors.messageTime}') ||
            item.querySelector('.rcd-time, .message-time, .time');
          const contentEl = item.querySelector('${this.selectors.messageContent}') ||
            item.querySelector('.rcd-content, .message-content, .content, .chat-content-text');

          const sender = senderEl?.textContent?.trim() || '';
          const time = timeEl?.textContent?.trim() || '';
          let content = extractContent(contentEl).trim();
          const domMsgId = item.getAttribute('data-msg-id') ||
            item.getAttribute('data-id') ||
            item.getAttribute('id') ||
            undefined;
          const senderId = item.getAttribute('data-sender-id') ||
            item.getAttribute('data-uid') ||
            item.getAttribute('data-sender') ||
            '';
          const isMe = item.matches('${this.selectors.messageIsMe}') ||
            item.querySelector('${this.selectors.messageIsMe}') !== null ||
            item.classList.contains('message-right') ||
            item.classList.contains('rcd-msg-right') ||
            item.classList.contains('is-me');

          // 1. 提取引用/回复消息
          let replyTo = undefined;
          let detectedType = undefined;
          const quoteEl = item.querySelector('.rcd-quote, .quote-content, .refer-content, .refer-msg, .reply-content, [class*="refer"], [class*="quote"]');
          const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
          const nativeTimestampValue =
            vueMsg?.timestamp ?? vueMsg?.sendTime ?? vueMsg?.sendTimeStamp ?? vueMsg?.timeStamp;
          const nativeTimestamp =
            typeof nativeTimestampValue === 'number'
              ? nativeTimestampValue < 10000000000
                ? nativeTimestampValue * 1000
                : nativeTimestampValue
              : 0;
          if (vueMsg && vueMsg.contentType === 13 && vueMsg.content?.replyedName) {
            const replyToSender = vueMsg.content.replyedName;
            const rawReplyContent = vueMsg.content.replyedContent;
            let replyToContent = '';
            if (Array.isArray(rawReplyContent?.content)) {
              replyToContent = rawReplyContent.content.map((c) => c.text || '').filter(Boolean).join('');
            } else if (typeof rawReplyContent === 'string') {
              replyToContent = rawReplyContent;
            } else if (rawReplyContent?.text) {
              replyToContent = String(rawReplyContent.text);
            }
            replyTo = {
              replyToSender,
              replyToContent: replyToContent || '[消息]',
              replyToId: String(vueMsg.content.replyedMsgId || ''),
            };
            detectedType = 'quote';
          } else if (quoteEl) {
            const replyToSender = quoteEl.querySelector('.quote-sender, .refer-name, .replyed-name, .name')?.textContent?.trim().replace(/:$/, '') || '';
            const replyToContent = quoteEl.querySelector('.quote-text, .refer-text, .replyed-view, .text')?.textContent?.trim() || quoteEl.textContent?.trim() || '';
            const replyToId = quoteEl.getAttribute('data-msg-id') || undefined;
            if (replyToContent) {
              replyTo = { replyToSender, replyToContent, replyToId };
              detectedType = 'quote';
            }
          }

          // 2. 提取文件卡片信息
          let fileInfo = undefined;
          const fileEl = item.querySelector('.file-card, .is-card, [class*="file-card"], .file-content');
          if (fileEl) {
            const fileName = fileEl.querySelector('.file-name, .name, [class*="filename"]')?.textContent?.trim() || '';
            const fileSize = fileEl.querySelector('.file-size, .size, [class*="filesize"]')?.textContent?.trim() || undefined;
            const fileExt = fileName.includes('.') ? (fileName.split('.').pop() || '') : undefined;
            if (fileName) {
              fileInfo = { fileName, fileSize, fileExt };
              detectedType = 'file';
            }
          }

          // 3. 提取 @ 提及状态与元数据
          const atEls = item.querySelectorAll('.rcd-msg-at, .at-user, .at-me, .mention, span[data-uid], span.at-text, span[data-at="me"], .at-msg');
          const mentionedUsers = Array.from(new Set(Array.from(atEls).map(el => el.textContent?.trim().replace(/^@/, '')).filter(Boolean)));
          const hasAtMeDom = Boolean(item.querySelector('.at-me, span[data-at="me"], .is-at-me, .rcd-msg-at.at-me'));
          const hasAtAllDom = Boolean(item.querySelector('.at-all, span[data-at="all"], .is-at-all'));
          const textAtAll = /@(全体成员|所有人|all)/i.test(content);
          const atAll = hasAtAllDom || textAtAll;
          const hasAtMeVue = Boolean(vueMsg && (vueMsg.atState === 2 || (Array.isArray(vueMsg.atMemberIDList) && window.loginID && vueMsg.atMemberIDList.includes(window.loginID))));
          const atMe = !isMe && (hasAtMeDom || hasAtMeVue);

          const mentions = {
            isAtMe: atMe,
            isAtAll: atAll,
            mentionedUsers
          };

          // 4. 提取图片列表与图文混排信息 (单图/多图)
          const images = [];
          if (Array.isArray(vueMsg?.content?.content)) {
            for (const c of vueMsg.content.content) {
              if (c.type === 1) {
                const filePath = c.filepath || c.filepath_h || undefined;
                const url = filePath ? ('file:///' + filePath.replace(/\\\\/g, '/')) : undefined;
                images.push({
                  filePath,
                  url,
                  uri: c.uri || c.uri_h || undefined,
                  width: c.width || undefined,
                  height: c.height || undefined,
                  mimeType: c.mimetype || undefined,
                  size: c.size || undefined,
                });
              }
            }
          }

          if (images.length === 0) {
            const domImgs = Array.from(item.querySelectorAll('img:not(.emoji-image):not(.emoji-span img):not(.emoticon):not([emoji])'));
            for (const img of domImgs) {
              const src = img.src || img.getAttribute('data-src') || '';
              let filePath = undefined;
              if (src.startsWith('file:///')) {
                filePath = decodeURIComponent(src.replace('file:///', ''));
              }
              images.push({
                filePath,
                url: src,
                uri: img.getAttribute('data-uri') || img.getAttribute('data-urih') || undefined,
                width: img.naturalWidth || parseInt(img.getAttribute('width') || '0', 10) || undefined,
                height: img.naturalHeight || parseInt(img.getAttribute('height') || '0', 10) || undefined,
              });
            }
          }

          // 5. 消息类型分类推断
          if (!detectedType) {
            if (images.length > 0) {
              if (!content || content === '[image]' || content === '[图片]') {
                detectedType = 'image';
                content = '[图片]';
              } else {
                detectedType = 'rich-text';
              }
            } else if (item.querySelector('span[style], font, strong, em, del, b, i, u, s')) {
              detectedType = 'rich-text';
            } else if (item.classList.contains('system-msg') || item.querySelector('.system-msg')) {
              detectedType = 'system';
            } else {
              detectedType = 'text';
            }
          }

          if (content || sender || fileInfo || images.length > 0) {
            rawList.push({
              sender,
              senderId: senderId || undefined,
              time,
              content: content || (images.length > 0 ? '[图片]' : ''),
              isMe,
              timestamp: nativeTimestamp,
              messageType: detectedType,
              atMe,
              atAll,
              mentions,
              replyTo,
              fileInfo,
              images: images.length > 0 ? images : undefined,
              raw: vueMsg ? Object.assign({ id: vueMsg.msgID || vueMsg.msgId || vueMsg.id || domMsgId }, vueMsg) : (domMsgId ? { id: domMsgId } : undefined)
            });
          }
        }
        return rawList;
      })()
    `;

    try {
      const rawMessages = await this.cdp.evaluate<RawMessageData[]>(script);
      if (!Array.isArray(rawMessages)) return [];

      return normalizeNativeMessage(
        {
          messages: rawMessages,
          session: {
            id: currentSessionId,
            name: currentSessionName,
            type: currentSessionType,
          },
        },
        {
          currentUserId,
          knownBotSentIds,
        }
      );
    } catch (err) {
      log.error({ err: String(err) }, '获取消息列表失败');
      throw new DomError(
        `获取消息列表失败: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
  }
}
