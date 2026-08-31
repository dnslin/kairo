import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mime from 'mime-types';
import type { CdpClient } from '../cdp/client.js';
import type {
  FormattedText,
  KK9ReplyTarget,
  PreSendCheckResult,
  SelectorsConfig,
  SendFileOptions,
  SendOptions,
  SendResult,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';
import { VUE_SCROLLER_HELPERS_SCRIPT } from './helpers.js';
import { parseFormattedTextToKK } from './rich-text.js';

const log = createChildLogger('send-ops');

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function buildMentionNodes(mentions?: SendOptions['mentions']): Array<Record<string, unknown>> {
  if (!mentions) return [];
  const list = Array.isArray(mentions) ? mentions : [mentions];
  const nodes: Array<Record<string, unknown>> = [];

  for (const m of list) {
    if (m === 'all' || m === '全体成员' || m === '所有人') {
      nodes.push({
        type: 2,
        replyMemberID: 0,
        replyMemberType: 1,
        replyMemberName: '全体成员',
      });
    } else if (typeof m === 'string') {
      nodes.push({
        type: 2,
        replyMemberID: 0,
        replyMemberType: 0,
        replyMemberName: m.replace(/^@/, ''),
      });
    } else if (typeof m === 'object' && m !== null) {
      nodes.push({
        type: 2,
        replyMemberID: Number(m.uid) || 0,
        replyMemberType: 0,
        replyMemberName: m.name.replace(/^@/, ''),
      });
    }
  }

  return nodes;
}

export class SendOps {
  constructor(
    private readonly cdp: CdpClient,
    private readonly selectors: SelectorsConfig
  ) {}

  /**
   * 发送前原子状态安全校验（防串线）
   */
  public async checkPreSendState(expectedSessionId: string): Promise<PreSendCheckResult> {
    const script = `
      (() => {
        ${VUE_SCROLLER_HELPERS_SCRIPT}
        const expected = ${JSON.stringify(expectedSessionId)};

        // 1. 检查当前活跃节点
        const activeItem = document.querySelector('.chat-item.chat-selected') ||
          document.querySelector('${this.selectors.activeSession}');
        const activeTitle = activeItem?.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim() || '';
        const activeId = activeItem?.getAttribute('data-sesuuid') ||
          activeItem?.getAttribute('data-session-id') ||
          activeItem?.getAttribute('id') ||
          '';

        // 2. 检查右侧聊天面板标题栏
        const headerTitle = document.querySelector('.chat-header, .chat-title, .head-title')?.textContent?.trim() || '';

        // 3. 尝试从 Vue 实例获取目标信息
        const scrollerItems = getVueScrollerItems('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        const { item: matchedItem } = findVueSessionItem(scrollerItems, expected);
        const expectedName = matchedItem?.typeName || matchedItem?.name || expected;
        const expectedUuid = matchedItem?.sesUUID || expected;

        // 4. 多重综合比对
        const isMatch =
          activeId === expected ||
          activeId === expectedUuid ||
          activeTitle === expected ||
          activeTitle === expectedName ||
          (activeTitle && expectedName && activeTitle.includes(expectedName)) ||
          (activeTitle && expected && activeTitle.includes(expected)) ||
          headerTitle.includes(expected) ||
          headerTitle.includes(expectedName);

        if (!isMatch) {
          return {
            canSend: false,
            reason: 'session_switched',
            details: '当前活跃会话 [' + (activeTitle || activeId || '未知') + '] 与目标会话 [' + expected + '] 不一致',
          };
        }

        return { canSend: true };
      })()
    `;
    try {
      const res = await this.cdp.evaluate<PreSendCheckResult>(script);
      if (!res) {
        return {
          canSend: false,
          reason: 'unknown',
          details: '发送前状态校验未获得有效返回结果 (Fail-Closed)',
        };
      }
      return res;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn({ err: errMsg }, '发送前校验脚本执行异常，执行 Fail-Closed 拦截');
      return {
        canSend: false,
        reason: 'unknown',
        details: `发送前状态校验异常: ${errMsg} (Fail-Closed)`,
      };
    }
  }

  private async ensureWindowActivated(
    contextLabel = '窗口'
  ): Promise<{ success: true } | { success: false; result: SendResult }> {
    try {
      await this.cdp.bringToFront();
      return { success: true };
    } catch (bringErr) {
      const msg = bringErr instanceof Error ? bringErr.message : String(bringErr);
      log.warn({ err: bringErr }, `bringToFront 激活${contextLabel}失败 (触发前失败)`);
      return {
        success: false,
        result: {
          success: false,
          error: `激活${contextLabel}失败: ${msg}`,
          isPreTrigger: true,
        },
      };
    }
  }

  private postTriggerUnknown(label: string, verifyLatencyMs?: number): SendResult {
    return {
      success: false,
      error: `${label}发送动作已触发，但当前 Driver 没有权威 native ack，结果为 unknown`,
      isPreTrigger: false,
      verifyLatencyMs,
    };
  }

  private postTriggerFailure(label: string, error: unknown, startTime: number): SendResult {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error({ err: errorMsg }, `${label}发送后响应丢失，结果为 unknown`);
    return {
      success: false,
      error: `${label}发送动作响应丢失: ${errorMsg}`,
      isPreTrigger: false,
      verifyLatencyMs: Date.now() - startTime,
    };
  }

  public async activateQuoteTarget(replyTo: string | KK9ReplyTarget): Promise<boolean> {
    const targetObj =
      typeof replyTo === 'string' ? { content: replyTo, messageId: replyTo } : replyTo;
    const script = `
      (() => {
        const target = ${JSON.stringify(targetObj)};
        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        if (!editor) return false;

        const msgItems = Array.from(document.querySelectorAll('.rcd-item, .message-item, .msg-item'));
        for (let i = msgItems.length - 1; i >= 0; i--) {
          const item = msgItems[i];
          const vMsg = item.__vue__?.msgitem || item.__vue__?.message;
          const text = item.textContent || '';
          if (vMsg && (vMsg.id == target.messageId || (target.content && text.includes(target.content)))) {
            if (typeof editor.insertReplyMsg === 'function') {
              editor.insertReplyMsg(vMsg);
              return true;
            }
          }
        }

        return false;
      })()
    `;

    try {
      const res = await this.cdp.evaluate<boolean>(script);
      return Boolean(res);
    } catch (err) {
      log.warn({ err: String(err) }, '激活引用消息目标异常');
      return false;
    }
  }

  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.sendRichText(text, options);
  }

  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const parsed = parseFormattedTextToKK(content);
    if (!parsed.plainText.trim() && !options.mentions) {
      return { success: false, error: '富文本内容不能为空', isPreTrigger: true };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return {
          success: false,
          error: `发送前检查未通过: ${check.reason} (${check.details})`,
          isPreTrigger: true,
        };
      }
    }
    if (options.replyTo) {
      return this.sendReply(options.replyTo, content, options);
    }

    const mentionNodes = buildMentionNodes(options.mentions);

    const script = `
      (() => {
        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        if (editor && typeof editor.sendMessage === 'function') {
          const contentNodes = [];
          const mentionNodes = ${JSON.stringify(mentionNodes)};
          for (const mn of mentionNodes) {
            contentNodes.push(mn);
            contentNodes.push({ type: 0, text: ' ' });
          }
          if (${JSON.stringify(parsed.plainText)}) {
            contentNodes.push({ type: 0, text: ${JSON.stringify(parsed.plainText)} });
          }

          const payload = {
            type: 'PicText',
            content: contentNodes,
            font: ${JSON.stringify(parsed.font)}
          };
          editor.sendMessage(payload);
          return { success: true, method: 'vue_native_pictext' };
        }

        const input = document.querySelector('${this.selectors.inputBox}') || document.querySelector('.chat-sendArea');
        if (!input) return { success: false, error: '未找到输入框元素' };

        input.focus();
        input.textContent = ${JSON.stringify(parsed.plainText)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        const sendBtn = document.querySelector('.sendMsg-btn a.button') ||
          document.querySelector('${this.selectors.sendButton}') ||
          document.querySelector('.sendMsg-btn');
        if (sendBtn) {
          if (typeof sendBtn.click === 'function') sendBtn.click();
          else sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { success: true, method: 'dom_click' };
        }

        return { success: false, error: '未找到发送按钮' };
      })()
    `;

    const startTime = Date.now();
    const activated = await this.ensureWindowActivated('窗口');
    if (!activated.success) {
      return activated.result;
    }

    try {
      const injectRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!injectRes?.success) {
        return { success: false, error: injectRes?.error || '注入富文本失败', isPreTrigger: true };
      }

      return this.postTriggerUnknown('富文本', Date.now() - startTime);
    } catch (err) {
      return this.postTriggerFailure('富文本', err, startTime);
    }
  }

  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const parsed = parseFormattedTextToKK(content);
    if (!parsed.plainText.trim()) {
      return { success: false, error: '回复内容不能为空', isPreTrigger: true };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return {
          success: false,
          error: `发送前检查未通过: ${check.reason} (${check.details})`,
          isPreTrigger: true,
        };
      }
    }
    const targetObj =
      typeof replyTo === 'string' ? { content: replyTo, messageId: replyTo } : replyTo;
    const mentionNodes = buildMentionNodes(options.mentions);

    const script = `
      (() => {
        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        if (!editor || typeof editor.sendMessage !== 'function') {
          return { success: false, error: '未找到编辑器实例' };
        }

        const target = ${JSON.stringify(targetObj)};
        const mentionNodes = ${JSON.stringify(mentionNodes)};

        let targetMsg = null;
        const msgItems = Array.from(document.querySelectorAll('.rcd-item, .message-item, .msg-item'));
        for (let i = msgItems.length - 1; i >= 0; i--) {
          const item = msgItems[i];
          const vMsg = item.__vue__?.msgitem || item.__vue__?.message;
          const text = item.textContent || '';
          if (vMsg && (vMsg.id == target.messageId || (target.content && text.includes(target.content)))) {
            targetMsg = vMsg;
            break;
          }
        }

        if (!targetMsg && editor.activedSes?.lastMessage) {
          targetMsg = editor.activedSes.lastMessage;
        }

        const replyContentNodes = [];
        for (const mn of mentionNodes) {
          replyContentNodes.push(mn);
          replyContentNodes.push({ type: 0, text: ' ' });
        }
        replyContentNodes.push({ type: 0, text: ${JSON.stringify(parsed.plainText)} });

        if (targetMsg) {
          const replyPayload = {
            type: 'Reply',
            replyedID: targetMsg.sender || 0,
            replyedName: targetMsg.senderName || '',
            replyedNameEN: targetMsg.senderNameEN || targetMsg.senderName || '',
            replyedNameTC: targetMsg.senderNameTC || targetMsg.senderName || '',
            replyedMsgId: targetMsg.id || 0,
            replyedMsgIndex: targetMsg.msgIdx || 0,
            replyedContentType: targetMsg.contentType || 4,
            replyedContent: targetMsg.content?.replyContent || targetMsg.content || '',
            replyContent: {
              content: replyContentNodes,
              font: ${JSON.stringify(parsed.font)}
            }
          };
          editor.sendMessage(replyPayload);
          if (typeof editor.cancelReply === 'function') editor.cancelReply();
          return { success: true, method: 'vue_native_reply' };
        } else {
          const payload = {
            type: 'PicText',
            content: replyContentNodes,
            font: ${JSON.stringify(parsed.font)}
          };
          editor.sendMessage(payload);
          return { success: true, method: 'vue_native_pictext_fallback' };
        }
      })()
    `;

    const startTime = Date.now();
    const activated = await this.ensureWindowActivated('回复窗口');
    if (!activated.success) {
      return activated.result;
    }

    try {
      const sendRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!sendRes?.success) {
        return { success: false, error: sendRes?.error || '发送回复消息失败', isPreTrigger: true };
      }

      return this.postTriggerUnknown('回复消息', Date.now() - startTime);
    } catch (err) {
      return this.postTriggerFailure('回复消息', err, startTime);
    }
  }

  public async sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `文件不存在: ${fullPath}`, isPreTrigger: true };
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      return { success: false, error: `不能发送目录: ${fullPath}`, isPreTrigger: true };
    }
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return {
        success: false,
        error: `文件大小超出限制 (100MB): ${stats.size} bytes`,
        isPreTrigger: true,
      };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason}`, isPreTrigger: true };
      }
    }

    const fileName = path.basename(fullPath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    const startTime = Date.now();

    const activated = await this.ensureWindowActivated('文件发送窗口');
    if (!activated.success) {
      return activated.result;
    }

    try {
      const injectScript = `
        (() => {
          const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
          if (editor && typeof editor.sendMessage === 'function') {
            const filePayload = {
              type: 'File',
              mimetype: ${JSON.stringify(mimeType)},
              filepath: ${JSON.stringify(fullPath)},
              size: ${JSON.stringify(String(stats.size))},
              isValid: true,
              filename: ${JSON.stringify(fileName)}
            };
            editor.sendMessage(filePayload);
            return { success: true, method: 'vue_native_file_send' };
          }

          return { success: false, error: '未找到编辑器实例' };
        })()
      `;

      const injectRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(injectScript);
      if (!injectRes?.success) {
        return {
          success: false,
          error: injectRes?.error || '文件发送初始化失败',
          isPreTrigger: true,
        };
      }

      return this.postTriggerUnknown('文件', Date.now() - startTime);
    } catch (err) {
      return this.postTriggerFailure('文件', err, startTime);
    }
  }

  public async sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    const fullPath = path.resolve(imagePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `图片文件不存在: ${fullPath}`, isPreTrigger: true };
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_IMAGE_SIZE_BYTES) {
      return {
        success: false,
        error: `图片大小超出限制 (10MB): ${stats.size} bytes`,
        isPreTrigger: true,
      };
    }

    const mimeType = mime.lookup(fullPath) || 'image/png';
    if (!mimeType.startsWith('image/')) {
      return { success: false, error: `不支持的图片格式: ${mimeType}`, isPreTrigger: true };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason}`, isPreTrigger: true };
      }
    }

    const base64Data = fs.readFileSync(fullPath).toString('base64');
    const startTime = Date.now();

    const activated = await this.ensureWindowActivated('图片发送窗口');
    if (!activated.success) {
      return activated.result;
    }

    try {
      const clipScript = `
        (async () => {
          try {
            window.focus();
            const input = document.querySelector('${this.selectors.inputBox}');
            if (input) input.focus();

            const byteCharacters = atob('${base64Data}');
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: '${mimeType}' });

            await navigator.clipboard.write([
              new ClipboardItem({ ['${mimeType}']: blob })
            ]);
            return { success: true };
          } catch (e) {
            return { success: false, error: String(e) };
          }
        })()
      `;

      const clipRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(clipScript);
      if (!clipRes?.success) {
        return { success: false, error: `剪贴板写入失败: ${clipRes?.error}`, isPreTrigger: true };
      }

      await sleep(400);

      const isMac = process.platform === 'darwin';
      await this.cdp.dispatchKeyEvent({
        type: 'keyDown',
        modifiers: isMac ? 8 : 2,
        windowsVirtualKeyCode: 86,
        key: 'v',
        code: 'KeyV',
      });
      await this.cdp.dispatchKeyEvent({
        type: 'keyUp',
        modifiers: isMac ? 8 : 2,
        windowsVirtualKeyCode: 86,
        key: 'v',
        code: 'KeyV',
      });

      const waitImgScript = `
        (async () => {
          const start = Date.now();
          while (Date.now() - start < 3000) {
            const input = document.querySelector('.chat-sendArea, .chat-editor');
            const img = input?.querySelector('img');
            if (img) {
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return { ready: true };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          return { ready: false };
        })()
      `;

      const waitRes = await this.cdp.evaluate<{ ready: boolean }>(waitImgScript);
      if (!waitRes?.ready) {
        log.warn('图片粘贴后在输入框渲染超时');
      }

      const sendScript = `
        (() => {
          const sendBtn = document.querySelector('.sendMsg-btn a.button') ||
            document.querySelector('.sendMsg-btn a') ||
            document.querySelector('.sendMsg-btn .button') ||
            document.querySelector('${this.selectors.sendButton}') ||
            document.querySelector('.sendMsg-btn');

          if (!sendBtn) return { success: false, error: '未找到发送按钮' };

          sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          if (typeof sendBtn.click === 'function') {
            sendBtn.click();
          } else {
            sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return { success: true };
        })()
      `;

      const sendRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(sendScript);
      if (!sendRes?.success) {
        return { success: false, error: `点击发送图片失败: ${sendRes?.error}`, isPreTrigger: true };
      }

      return this.postTriggerUnknown('图片', Date.now() - startTime);
    } catch (err) {
      return this.postTriggerFailure('图片', err, startTime);
    }
  }

  public async recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false;

    try {
      const checkScript = `
        (() => {
          const targetId = ${JSON.stringify(messageId)};
          const items = document.querySelectorAll('${this.selectors.messageItem}');
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');

            const isMe = item.matches('${this.selectors.messageIsMe}') ||
              item.classList.contains('rcd-msg-right') ||
              item.classList.contains('rcd-msg-me') ||
              item.classList.contains('is-me') ||
              item.querySelector('${this.selectors.messageIsMe}') !== null ||
              Boolean(vueMsg?.isMe) ||
              Boolean(vueMsg?.isFromSelf);

            const sender = item.querySelector('${this.selectors.messageSender}')?.textContent?.trim() || vueMsg?.senderName || '';
            const time = item.querySelector('${this.selectors.messageTime}')?.textContent?.trim() || '';
            let sendTime = 0;
            if (vueMsg && vueMsg.sendTime) {
              const n = Number(vueMsg.sendTime);
              sendTime = n < 10000000000 ? n * 1000 : n;
            } else if (vueMsg && vueMsg.time) {
              const p = new Date(vueMsg.time).getTime();
              if (!isNaN(p)) sendTime = p;
            }

            if (targetId && (rawId === targetId || item.id === targetId || String(targetId).includes(String(rawId)) || (rawId && String(rawId).includes(String(targetId))))) {
              return {
                isMe,
                sender,
                time,
                timestamp: sendTime || Date.now(),
              };
            }
          }
          return null;
        })()
      `;

      const msgInfo = await this.cdp.evaluate<{
        isMe: boolean;
        sender?: string;
        time?: string;
        timestamp?: number;
      } | null>(checkScript);

      if (!msgInfo) {
        log.warn({ messageId, sessionId }, '未找到待撤回的目标消息，取消撤回');
        return false;
      }

      if (!msgInfo.isMe) {
        log.warn({ messageId, sender: msgInfo.sender }, '尝试撤回非自己发出的消息，安全拦截');
        return false;
      }

      if (msgInfo.timestamp) {
        let ts = msgInfo.timestamp;
        if (ts < 10_000_000_000) {
          ts *= 1000;
        }
        const elapsedMs = Date.now() - ts;
        if (elapsedMs > 120_000) {
          log.warn({ messageId, elapsedMs }, '消息已超过 2 分钟时效限制，拒绝撤回');
          return false;
        }
      }

      const recallScript = `
        (async () => {
          const targetId = ${JSON.stringify(messageId)};
          const targetSessionId = ${JSON.stringify(sessionId || '')};

          const items = document.querySelectorAll('${this.selectors.messageItem}');
          let matchedItem = null;
          let matchedVueMsg = null;

          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');
            const cleanRawId = rawId ? String(rawId).replace(/^msg-/, '') : '';
            const cleanTargetId = String(targetId).replace(/^msg-/, '');

            if (targetId && (rawId === targetId || cleanRawId === cleanTargetId || item.id === targetId || item.id === ('msg-' + targetId))) {
              matchedItem = item;
              matchedVueMsg = vueMsg;
              break;
            }
          }

          const app = document.querySelector('#app')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus || app?.$bus;
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const sesUUID = editor?.activedSes?.sesUUID || targetSessionId;
          const sessionID = matchedVueMsg?.sessionID || editor?.activedSes?.id || targetSessionId;
          const msgID = matchedVueMsg?.id || matchedVueMsg?.msgID || Number(targetId) || targetId;
          const msgIdx = matchedVueMsg?.msgIdx || 0;

          const ipc = window.ipcRenderer || (window.require ? window.require('electron')?.ipcRenderer : null);
          if (ipc && typeof ipc.send === 'function') {
            const key = '__kkbotRecallReqId';
            const current = typeof window[key] === 'number' ? window[key] : 900000;
            window[key] = current + 1;
            const requestId = current + 1;
            const replyChannel = 'data-' + requestId;

            const ipcPromise = new Promise(resolve => {
              ipc.once(replyChannel, (_event, payload) => resolve(payload));
              ipc.send('data', {
                id: requestId,
                args: ['cancelMessage', {
                  type: 'own',
                  sessionID,
                  msgID,
                  msgIdx
                }],
                progress: false
              });
            });

            const ipcRes = await ipcPromise;
            if (ipcRes && (ipcRes.code === 0 || ipcRes.code === undefined)) {
              if (bus && sesUUID) {
                bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
              }
              return { success: true, method: 'ipc_cancelMessage' };
            }
          }

          function findChatContentVm(vm) {
            if (!vm) return null;
            if (vm.$options?._componentTag === 'chat-content' || vm.$options?.name === 'chat-content') return vm;
            if (vm.$children) {
              for (const c of vm.$children) {
                const res = findChatContentVm(c);
                if (res) return res;
              }
            }
            return null;
          }
          const chatContent = findChatContentVm(app);
          if (chatContent && typeof chatContent.addRevokeMsg === 'function') {
            await chatContent.addRevokeMsg({ byAdmin: 0, msgID, msgIdex: msgIdx });
            return { success: true, method: 'chat_content_addRevokeMsg' };
          }

          if (bus && sesUUID) {
            bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
            bus.$emit('CancelMessage', { byAdmin: 0, event: 'CancelMessage', msgID, msgIdex: msgIdx });
            return { success: true, method: 'bus_revokeMsg' };
          }

          return { success: false, error: '未找到可用的底层撤回通道' };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean; error?: string }>(recallScript);
      return Boolean(res?.success);
    } catch (err) {
      log.error({ err: String(err), messageId }, '执行消息撤回异常');
      return false;
    }
  }
}
