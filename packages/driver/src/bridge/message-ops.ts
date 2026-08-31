import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mime from 'mime-types';
import type { CdpClient } from '../cdp/client.js';
import {
  normalizeNativeMessage,
  type InboundNormalizationDiagnostic,
} from './converter.js';
import { callIpcToData } from './rpc.js';
import { parseFormattedTextToKK } from '../dom/rich-text.js';
import type {
  FormattedText,
  KK9Message,
  KK9ReplyTarget,
  KK9Session,
  PreSendCheckResult,
  SendFileOptions,
  SendOptions,
  SendResult,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-message-ops');

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

export class BridgeMessageOps {
  constructor(private readonly cdp: CdpClient) {}

  /**
   * 优先通过底层 IPC toData('getMessages') 读取指定会话最近消息（无需切换 UI）
   */
  public async getRecentMessages(
    limit = 20,
    session?: KK9Session,
    knownBotSentMessageKeys?: Set<string>,
    currentUserId?: string | number
  ): Promise<KK9Message[]> {
    try {
      // 1. 获取目标会话 ID
      let targetSessionID: number | string | undefined;
      let targetSesUUID = '';
      let targetSessionName = '未知会话';
      let targetType = 0;
      let targetMaxMsgIdx = 999999;

      if (session) {
        targetSesUUID = session.id;
        targetSessionName = session.name;
        targetType = session.type === 'group' ? 1 : 0;
      }

      const sessionContext = await this.cdp.evaluate<{
        sessionID: number | string;
        maxMsgIdx: number;
        sesUUID: string;
        name: string;
        type: number;
      } | null>(`
        (() => {
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const targetSession = ${JSON.stringify(session || null)};
          let matched = editor?.activedSes;

          if (targetSession && editor?.sortedSessions) {
            const found = editor.sortedSessions.find(s =>
              s.sesUUID === targetSession.id ||
              String(s.id) === targetSession.id ||
              s.typeName === targetSession.name ||
              s.name === targetSession.name
            );
            if (found) matched = found;
          }

          if (!matched) return null;
          return {
            sessionID: matched.id,
            maxMsgIdx: matched.maxMessageIndex || 999999,
            sesUUID: matched.sesUUID || String(matched.id),
            name: matched.typeName || matched.name || matched.createrName || '未知会话',
            type: matched.type || 0
          };
        })()
      `);

      if (sessionContext?.sessionID) {
        targetSessionID = sessionContext.sessionID;
        targetMaxMsgIdx = sessionContext.maxMsgIdx;
        targetSesUUID = sessionContext.sesUUID;
        targetSessionName = sessionContext.name;
        targetType = sessionContext.type;
      } else if (session) {
        targetSessionID = parseInt(session.id.replace(/^[0-9]+-/, ''), 10) || session.id;
      }

      if (!targetSessionID) {
        return [];
      }

      // 2. 调用底层 IPC getMessages (纯后台查询，不改变任何可见 UI)
      const res = await callIpcToData<unknown[]>(this.cdp, 'getMessages', [
        {
          sessionID: targetSessionID,
          count: Math.max(1, limit),
          endIdx: targetMaxMsgIdx,
          sendTime: 0,
        },
      ]);

      if (res.code !== 0 || !Array.isArray(res.data)) {
        return [];
      }

      // 3. 规范化消息
      const isGroup = targetType === 1 || targetType === 2;
      return normalizeNativeMessage(
        {
          messages: res.data,
          session: {
            id: targetSesUUID || String(targetSessionID),
            name: targetSessionName,
            type: isGroup ? 'group' : 'private',
          },
        },
        {
          currentUserId,
          knownBotSentMessageKeys,
          source: 'polling',
          onDiagnostic: (diagnostic: InboundNormalizationDiagnostic) => {
            log.warn(
              {
                kind: diagnostic.kind,
                missingFields: diagnostic.missingFields,
                sessionId: diagnostic.sessionId,
              },
              '丢弃缺少入站身份字段的消息'
            );
          },
        }
      );
    } catch (err) {
      log.warn({ err: String(err) }, 'Bridge 获取历史消息异常');
      return [];
    }
  }

  /**
   * 自动对齐会话上下文 (若传入 targetSessionId 与当前激活不一致，自动在内存中对齐)
   */
  public async ensureTargetSessionContext(targetSessionId: string): Promise<boolean> {
    const target = targetSessionId.trim();
    if (!target) return true;

    const script = `
      (() => {
        const target = ${JSON.stringify(target)};
        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        const active = editor?.activedSes;
        if (active && (active.sesUUID === target || String(active.id) === target || active.name === target || active.typeName === target)) {
          return true;
        }

        if (editor?.sortedSessions) {
          const found = editor.sortedSessions.find(s =>
            s.sesUUID === target || String(s.id) === target || s.typeName === target || s.name === target || (s.name && s.name.includes(target))
          );
          if (found) {
            editor.activedSes = found;
            if (typeof editor.onActivedSesChanged === 'function') {
              editor.onActivedSesChanged(found);
            }
            return true;
          }
        }
        return false;
      })()
    `;

    try {
      const ok = await this.cdp.evaluate<boolean>(script);
      return Boolean(ok);
    } catch {
      return false;
    }
  }

  /**
   * 发送前原子状态校验
   */
  public async checkPreSendState(expectedSessionId: string): Promise<PreSendCheckResult> {
    const target = expectedSessionId.trim();
    const aligned = await this.ensureTargetSessionContext(target);
    if (!aligned) {
      return {
        canSend: false,
        reason: 'session_switched',
        details: `未在会话列表中找到目标会话 [${target}]`,
      };
    }
    return { canSend: true };
  }

  /**
   * 发送纯文本消息
   */
  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.sendRichText(text, options);
  }

  /**
   * 发送富文本与带 @ 提及的消息
   */
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
    const startTime = Date.now();

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
          return { success: true };
        }

        return { success: false, error: '未找到编辑器实例' };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!res?.success) {
        return { success: false, error: res?.error || '注入富文本失败', isPreTrigger: true };
      }

      return {
        success: true,
        verifyLatencyMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: `发送富文本异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: true,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 发送引用/回复消息
   */
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
    const startTime = Date.now();

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
          return { success: true, method: 'vue_pictext_fallback' };
        }
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!res?.success) {
        return { success: false, error: res?.error || '发送回复失败', isPreTrigger: true };
      }
      return { success: true, verifyLatencyMs: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        error: `发送回复异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: true,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 发送文件（通过 Vue File 协议原生分发）
   */
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

    const script = `
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
          return { success: true };
        }
        return { success: false, error: '未找到编辑器实例' };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!res?.success) {
        return { success: false, error: res?.error || '文件发送初始化失败', isPreTrigger: true };
      }
      return { success: true, verifyLatencyMs: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        error: `文件发送异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: true,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 发送本地图片（剪贴板注入 + 按键粘贴）
   */
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

    try {
      // 1. 激活前台
      await this.cdp.bringToFront();

      // 2. 写入剪贴板
      const clipScript = `
        (async () => {
          try {
            window.focus();
            const input = document.querySelector('${this.cdp ? '.chat-sendArea, .chat-editor, [contenteditable]' : ''}');
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

      await sleep(300);

      // 3. 模拟粘贴
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

      await sleep(400);

      // 4. 点击发送按钮
      const sendScript = `
        (() => {
          const sendBtn = document.querySelector('.sendMsg-btn a.button') ||
            document.querySelector('.sendMsg-btn a') ||
            document.querySelector('.sendMsg-btn .button') ||
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

      return { success: true, verifyLatencyMs: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        error: `发送图片异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: true,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 优先通过原生 IPC toData('cancelMessage') 撤回消息
   */
  public async recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false;

    try {
      const script = `
        (async () => {
          const targetId = ${JSON.stringify(messageId)};
          const targetSessionId = ${JSON.stringify(sessionId || '')};
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus;

          let matchedVueMsg = null;
          const items = document.querySelectorAll('.rcd-item, .message-item, .msg-item');
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vMsg?.id || vMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id');
            if (rawId && (String(rawId) === String(targetId) || String(targetId).includes(String(rawId)))) {
              matchedVueMsg = vMsg;
              break;
            }
          }

          const sesUUID = editor?.activedSes?.sesUUID || targetSessionId;
          const sessionID = matchedVueMsg?.sessionID || editor?.activedSes?.id || targetSessionId;
          const msgID = matchedVueMsg?.id || matchedVueMsg?.msgID || Number(targetId) || targetId;
          const msgIdx = matchedVueMsg?.msgIdx || 0;

          const electron = window.require ? window.require('electron') : null;
          const ipc = window.ipcRenderer || electron?.ipcRenderer;

          if (ipc) {
            const reqId = 960000 + Math.floor(Math.random() * 10000);
            const replyChannel = 'data-' + reqId;
            const ipcPromise = new Promise(resolve => {
              ipc.once(replyChannel, (_e, payload) => resolve(payload));
              ipc.send('data', {
                id: reqId,
                args: ['cancelMessage', {
                  type: 'own',
                  sessionID,
                  msgID,
                  msgIdx
                }],
                progress: false
              });
            });

            const res = await ipcPromise;
            if (res && (res.code === 0 || res.code === undefined)) {
              if (bus && sesUUID) {
                bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
              }
              return { success: true };
            }
          }

          if (bus && sesUUID) {
            bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
            bus.$emit('CancelMessage', { byAdmin: 0, event: 'CancelMessage', msgID, msgIdex: msgIdx });
            return { success: true };
          }

          return { success: false };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean }>(script);
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ messageId, err: String(err) }, 'Bridge 撤回消息失败');
      return false;
    }
  }
}
