import { randomUUID } from 'node:crypto';
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
  SendFileOptions,
  SendOptions,
  SendResult,
} from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-message-ops');

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function encodePayload(data: unknown): string {
  return JSON.stringify(encodeURIComponent(JSON.stringify(data)));
}

function isCdpUnavailableBeforeSend(cdp: CdpClient): boolean {
  const getStatus = (cdp as Partial<CdpClient>).getStatus;
  return typeof getStatus === 'function' && getStatus.call(cdp) !== 'connected';
}

const RESOLVE_RENDERER_SESSION_SCRIPT = `
  function resolveRendererSession(sessions, target) {
    if (!Array.isArray(sessions)) return null;
    const idMatch = sessions.find(s => s.sesUUID === target || String(s.id) === target);
    if (idMatch) return idMatch;
    const nameMatches = sessions.filter(s => s.typeName === target || s.name === target);
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }
`;

const CONFIRM_SENT_MESSAGE_SCRIPT = `
  async function waitForPersistedMessage(sessionID, msgFlag) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const messagesRes = await callIpc('getMessages', {
        sessionID,
        count: 100,
        endIdx: 2147483647,
        sendTime: 0
      });
      if (messagesRes?.code === 0 && Array.isArray(messagesRes.data)) {
        const found = messagesRes.data.find(message =>
          message && message.msgFlag === msgFlag && Number(message.id) > 0
        );
        if (found) return found;
      }
      if (attempt < 11) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    return null;
  }
`;

function createMessageFlag(kind: string): string {
  return `kkbot:${kind}:${randomUUID()}`;
}

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

      const encodedSession = encodePayload(session || null);
      const sessionContext = await this.cdp.evaluate<{
        sessionID: number | string;
        maxMsgIdx: number;
        sesUUID: string;
        name: string;
        type: number;
      } | null>(`
        (() => {
          const targetSession = JSON.parse(decodeURIComponent(${encodedSession}));
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
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
   * 发送纯文本消息
   */
  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.sendRichText(text, options);
  }

  /**
   * 通过纯底层 IPC (insertSendBefoeMsg + sendMessageNew) 发送富文本与带 @ 提及消息
   * 完全脱离 UI 与 DOM，零焦点干扰，支持多会话静默并发
   */
  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const parsed = parseFormattedTextToKK(content);
    if (!parsed.plainText.trim() && !options.mentions) {
      return { success: false, error: '富文本内容不能为空', isPreTrigger: true };
    }

    if (options.replyTo) {
      return this.sendReply(options.replyTo, content, options);
    }

    const mentionNodes = buildMentionNodes(options.mentions);
    const contentNodes: Array<Record<string, unknown>> = [];
    for (const mn of mentionNodes) {
      contentNodes.push(mn);
      contentNodes.push({ type: 0, text: ' ' });
    }
    if (parsed.plainText) {
      contentNodes.push({ type: 0, text: parsed.plainText });
    }

    const startTime = Date.now();
    const cdpWasUnavailable = isCdpUnavailableBeforeSend(this.cdp);
    const payloadData = {
      target: options.targetSessionId || '',
      msgFlag: createMessageFlag('text'),
      contentNodes,
      font: parsed.font,
      mentionMemberIds: mentionNodes.map(m => m['replyMemberID']),
      hasMentions: mentionNodes.length > 0,
    };

    const encoded = encodePayload(payloadData);

    const script = `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        ${RESOLVE_RENDERER_SESSION_SCRIPT}
        function nextRequestId() {
          const key = '__kkbot_rpc_id';
          const currentId = typeof window[key] === 'number' ? window[key] : 800000;
          window[key] = currentId + 1;
          return currentId + 1;
        }
        function callIpc(channel, ...args) {
          return new Promise((resolve) => {
            if (!ipc) return resolve({ error: 'no ipc' });
            const curId = nextRequestId();
            const reply = 'data-' + curId;
            const onReply = (event, payload) => {
              clearTimeout(timer);
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve(payload);
            };
            const timer = setTimeout(() => {
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve({ code: -2, error: 'IPC 请求超时' });
            }, 4000);
            ipc.once(reply, onReply);
            try {
              ipc.send('data', { id: curId, args: [channel, ...args], progress: false });
            } catch (sendErr) {
              clearTimeout(timer);
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve({ code: -3, error: String(sendErr) });
            }
          });
        }
        ${CONFIRM_SENT_MESSAGE_SCRIPT}
        const data = JSON.parse(decodeURIComponent(${encoded}));
        const target = data.target;

        let targetSes = editor?.activedSes;
        if (target) {
          if (!Array.isArray(editor?.sortedSessions)) {
            return { success: false, error: '当前会话列表不可用', isPreTrigger: true };
          }
          const found = resolveRendererSession(editor.sortedSessions, target);
          if (!found) {
            return { success: false, error: '未在会话列表中找到目标会话 [' + target + ']', isPreTrigger: true };
          }
          targetSes = found;
        }

        if (!targetSes) {
          return { success: false, error: '未指定目标会话且当前无激活会话', isPreTrigger: true };
        }

        const myUid = main?.userID || editor?.userID || 5761;
        const myName = main?.userName || editor?.userName || '我';

        const msgObj = {
          contentType: 4, // PicText
          content: {
            content: data.contentNodes,
            font: data.font
          },
          sender: myUid,
          senderName: myName,
          senderNameEN: myName,
          senderNameTC: myName,
          receiver: targetSes.typeID || targetSes.sesTypeID,
          sendTime: Math.floor(Date.now() / 1000),
          sessionType: targetSes.type,
          sessionID: targetSes.id,
          atState: data.hasMentions ? 2 : 1,
          atMemberIDList: data.mentionMemberIds || [],
          status: 1,
          type: 0,
          msgFlag: data.msgFlag,
          deviceID: main?.deviceID || editor?.deviceID || ''
        };

        const insertRes = await callIpc('insertSendBefoeMsg', msgObj);
        if (!insertRes || insertRes.code !== 0 || !insertRes.data) {
          return { success: false, error: 'insertSendBefoeMsg 写入失败', isPreTrigger: true };
        }

        const nativeId = insertRes.data.id;
        const nativeMsgIdx = insertRes.data.msgIdx;
        msgObj.id = nativeId;
        msgObj.msgIdx = nativeMsgIdx;

        const sendRes = await callIpc('sendMessageNew', {
          id: nativeId,
          content: msgObj.content,
          contentType: msgObj.contentType,
          sender: msgObj.sender,
          senderName: msgObj.senderName,
          senderNameEN: msgObj.senderNameEN,
          senderNameTC: msgObj.senderNameTC,
          receiver: msgObj.receiver,
          sessionType: msgObj.sessionType,
          sessionID: msgObj.sessionID,
          atState: msgObj.atState,
          msgFlag: msgObj.msgFlag,
          atMemberIDList: msgObj.atMemberIDList,
          type: msgObj.type
        });

        if (!sendRes || sendRes.code !== 0) {
          return {
            success: false,
            error: sendRes?.error || 'sendMessageNew 未返回成功 ack',
            isPreTrigger: false
          };
        }

        const confirmedMessage = await waitForPersistedMessage(targetSes.id, msgObj.msgFlag);
        if (!confirmedMessage) {
          return {
            success: false,
            error: 'sendMessageNew 已确认，但未解析到落库后的真实消息 ID',
            isPreTrigger: false
          };
        }
        msgObj.id = confirmedMessage.id;
        msgObj.msgIdx = confirmedMessage.msgIdx;

        try {
          if (store) {
            store.commit('updateSesLastMsg', { sesUUID: targetSes.sesUUID, message: confirmedMessage });
          }
          if (bus) {
            bus.$emit(targetSes.sesUUID + '-msg', [msgObj]);
          }
        } catch (updateErr) {}

        return { success: true, messageId: String(confirmedMessage.id) };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{
        success: boolean;
        messageId?: string;
        error?: string;
        isPreTrigger?: boolean;
      }>(script, 15000);

      if (!res?.success) {
        return {
          success: false,
          error: res?.error || '底层 IPC 发送失败',
          isPreTrigger: res?.isPreTrigger ?? false,
        };
      }

      return {
        success: true,
        messageId: res.messageId,
        verifyLatencyMs: Date.now() - startTime,
      };
    } catch (err) {
      return {
        success: false,
        error: `底层 IPC 发送异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: cdpWasUnavailable,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 通过纯底层 IPC 发送引用/回复消息
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

    const targetObj =
      typeof replyTo === 'string' ? { content: replyTo, messageId: replyTo } : replyTo;
    const mentionNodes = buildMentionNodes(options.mentions);
    const replyContentNodes: Array<Record<string, unknown>> = [];
    for (const mn of mentionNodes) {
      replyContentNodes.push(mn);
      replyContentNodes.push({ type: 0, text: ' ' });
    }
    replyContentNodes.push({ type: 0, text: parsed.plainText });

    const startTime = Date.now();
    const cdpWasUnavailable = isCdpUnavailableBeforeSend(this.cdp);
    const payloadData = {
      target: options.targetSessionId || '',
      msgFlag: createMessageFlag('reply'),
      targetRef: targetObj,
      replyContentNodes,
      font: parsed.font,
    };

    const encoded = encodePayload(payloadData);

    const script = `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        ${RESOLVE_RENDERER_SESSION_SCRIPT}
        function nextRequestId() {
          const key = '__kkbot_rpc_id';
          const currentId = typeof window[key] === 'number' ? window[key] : 800000;
          window[key] = currentId + 1;
          return currentId + 1;
        }
        function callIpc(channel, ...args) {
          return new Promise((resolve) => {
            if (!ipc) return resolve({ error: 'no ipc' });
            const curId = nextRequestId();
            const reply = 'data-' + curId;
            const onReply = (event, payload) => {
              clearTimeout(timer);
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve(payload);
            };
            const timer = setTimeout(() => {
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve({ code: -2, error: 'IPC 请求超时' });
            }, 4000);
            ipc.once(reply, onReply);
            try {
              ipc.send('data', { id: curId, args: [channel, ...args], progress: false });
            } catch (sendErr) {
              clearTimeout(timer);
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve({ code: -3, error: String(sendErr) });
            }
          });
        }
        ${CONFIRM_SENT_MESSAGE_SCRIPT}
        const data = JSON.parse(decodeURIComponent(${encoded}));
        const target = data.target;

        let targetSes = editor?.activedSes;
        if (target) {
          if (!Array.isArray(editor?.sortedSessions)) {
            return { success: false, error: '当前会话列表不可用', isPreTrigger: true };
          }
          const found = resolveRendererSession(editor.sortedSessions, target);
          if (!found) {
            return { success: false, error: '未找到目标会话 [' + target + ']', isPreTrigger: true };
          }
          targetSes = found;
        }

        if (!targetSes) return { success: false, error: '当前无目标会话', isPreTrigger: true };

        const targetRef = data.targetRef;
        if (!targetRef?.messageId) {
          return { success: false, error: '被回复消息缺少原生 messageId', isPreTrigger: true };
        }
        const targetMessagesRes = await callIpc('getMessages', {
          sessionID: targetSes.id,
          count: 200,
          endIdx: 2147483647,
          sendTime: 0
        });
        const targetMessage = targetMessagesRes?.code === 0 && Array.isArray(targetMessagesRes.data)
          ? targetMessagesRes.data.find(message => String(message?.id) === String(targetRef.messageId))
          : null;
        if (!targetMessage) {
          return { success: false, error: '未在目标会话历史中找到被回复消息', isPreTrigger: true };
        }

        const myUid = main?.userID || editor?.userID || 5761;
        const myName = main?.userName || editor?.userName || '我';
        const replyPayload = {
          type: 'Reply',
          replyedID: targetMessage.sender || 0,
          replyedName: targetMessage.senderName || '',
          replyedNameEN: targetMessage.senderNameEN || targetMessage.senderName || '',
          replyedNameTC: targetMessage.senderNameTC || targetMessage.senderName || '',
          replyedMsgId: targetMessage.id,
          replyedMsgIndex: targetMessage.msgIdx || 0,
          replyedContentType: targetMessage.contentType || 4,
          replyedContent: targetMessage.content?.replyContent || targetMessage.content || '',
          replyContent: {
            content: data.replyContentNodes,
            font: data.font
          }
        };

        const msgObj = {
          contentType: 13, // Reply
          content: replyPayload,
          sender: myUid,
          senderName: myName,
          senderNameEN: myName,
          senderNameTC: myName,
          receiver: targetSes.typeID || targetSes.sesTypeID,
          sendTime: Math.floor(Date.now() / 1000),
          sessionType: targetSes.type,
          sessionID: targetSes.id,
          atState: 1,
          atMemberIDList: [],
          status: 1,
          type: 0,
          msgFlag: data.msgFlag,
          deviceID: main?.deviceID || editor?.deviceID || ''
        };

        const insertRes = await callIpc('insertSendBefoeMsg', msgObj);
        if (!insertRes || insertRes.code !== 0 || !insertRes.data) {
          return { success: false, error: 'insertSendBefoeMsg 失败', isPreTrigger: true };
        }

        const nativeId = insertRes.data.id;
        msgObj.id = nativeId;
        msgObj.msgIdx = insertRes.data.msgIdx;

        const sendRes = await callIpc('sendMessageNew', {
          id: nativeId,
          content: msgObj.content,
          contentType: msgObj.contentType,
          sender: msgObj.sender,
          senderName: msgObj.senderName,
          senderNameEN: msgObj.senderNameEN,
          senderNameTC: msgObj.senderNameTC,
          receiver: msgObj.receiver,
          sessionType: msgObj.sessionType,
          sessionID: msgObj.sessionID,
          atState: msgObj.atState,
          msgFlag: msgObj.msgFlag,
          atMemberIDList: msgObj.atMemberIDList,
          type: msgObj.type
        });

        if (!sendRes || sendRes.code !== 0) {
          return {
            success: false,
            error: sendRes?.error || 'sendMessageNew 未返回成功 ack',
            isPreTrigger: false
          };
        }

        const confirmedMessage = await waitForPersistedMessage(targetSes.id, msgObj.msgFlag);
        if (!confirmedMessage) {
          return {
            success: false,
            error: 'sendMessageNew 已确认，但未解析到落库后的真实消息 ID',
            isPreTrigger: false
          };
        }
        msgObj.id = confirmedMessage.id;
        msgObj.msgIdx = confirmedMessage.msgIdx;

        try {
          if (store) {
            store.commit('updateSesLastMsg', { sesUUID: targetSes.sesUUID, message: confirmedMessage });
          }
          if (bus) {
            bus.$emit(targetSes.sesUUID + '-msg', [msgObj]);
          }
        } catch (updateErr) {}

        return { success: true, messageId: String(confirmedMessage.id) };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; messageId?: string; error?: string; isPreTrigger?: boolean }>(script, 15000);
      if (!res?.success) {
        return { success: false, error: res?.error || '底层回复发送失败', isPreTrigger: res?.isPreTrigger ?? false };
      }
      return { success: true, messageId: res.messageId, verifyLatencyMs: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        error: `发送回复异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: cdpWasUnavailable,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 通过纯底层 IPC 发送文件
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

    const fileName = path.basename(fullPath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    const startTime = Date.now();
    const cdpWasUnavailable = isCdpUnavailableBeforeSend(this.cdp);
    const payloadData = {
      target: options.targetSessionId || '',
      msgFlag: createMessageFlag('file'),
      fullPath,
      fileName,
      mimeType,
      sizeStr: String(stats.size),
    };

    const encoded = encodePayload(payloadData);

    const script = `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        ${RESOLVE_RENDERER_SESSION_SCRIPT}
        function nextRequestId() {
          const key = '__kkbot_rpc_id';
          const currentId = typeof window[key] === 'number' ? window[key] : 800000;
          window[key] = currentId + 1;
          return currentId + 1;
        }
        function callIpc(channel, ...args) {
          return new Promise((resolve) => {
            if (!ipc) return resolve({ error: 'no ipc' });
            const curId = nextRequestId();
            const reply = 'data-' + curId;
            const onReply = (event, payload) => {
              clearTimeout(timer);
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve(payload);
            };
            const timer = setTimeout(() => {
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve({ code: -2, error: 'IPC 请求超时' });
            }, 4000);
            ipc.once(reply, onReply);
            try {
              ipc.send('data', { id: curId, args: [channel, ...args], progress: false });
            } catch (sendErr) {
              clearTimeout(timer);
              try { ipc.removeListener(reply, onReply); } catch (e) {}
              resolve({ code: -3, error: String(sendErr) });
            }
          });
        }
        ${CONFIRM_SENT_MESSAGE_SCRIPT}
        const data = JSON.parse(decodeURIComponent(${encoded}));
        const target = data.target;

        let targetSes = editor?.activedSes;
        if (target) {
          if (!Array.isArray(editor?.sortedSessions)) {
            return { success: false, error: '当前会话列表不可用', isPreTrigger: true };
          }
          const found = resolveRendererSession(editor.sortedSessions, target);
          if (!found) {
            return { success: false, error: '未找到目标会话 [' + target + ']', isPreTrigger: true };
          }
          targetSes = found;
        }

        if (!targetSes) return { success: false, error: '当前无目标会话', isPreTrigger: true };

        const myUid = main?.userID || editor?.userID || 5761;
        const myName = main?.userName || editor?.userName || '我';

        const filePayload = {
          type: 'File',
          mimetype: data.mimeType,
          filepath: data.fullPath,
          size: data.sizeStr,
          isValid: true,
          filename: data.fileName
        };

        const msgObj = {
          contentType: 3, // File
          content: filePayload,
          sender: myUid,
          senderName: myName,
          senderNameEN: myName,
          senderNameTC: myName,
          receiver: targetSes.typeID || targetSes.sesTypeID,
          sendTime: Math.floor(Date.now() / 1000),
          sessionType: targetSes.type,
          sessionID: targetSes.id,
          atState: 1,
          atMemberIDList: [],
          status: 1,
          type: 0,
          msgFlag: data.msgFlag,
          filepath: data.fullPath,
          deviceID: main?.deviceID || editor?.deviceID || ''
        };

        const insertRes = await callIpc('insertSendBefoeMsg', msgObj);
        if (!insertRes || insertRes.code !== 0 || !insertRes.data) {
          return { success: false, error: 'insertSendBefoeMsg 写入失败', isPreTrigger: true };
        }

        const nativeId = insertRes.data.id;
        msgObj.id = nativeId;
        msgObj.msgIdx = insertRes.data.msgIdx;

        const sendRes = await callIpc('sendMessageNew', {
          id: nativeId,
          content: msgObj.content,
          contentType: msgObj.contentType,
          sender: msgObj.sender,
          senderName: msgObj.senderName,
          senderNameEN: msgObj.senderNameEN,
          senderNameTC: msgObj.senderNameTC,
          receiver: msgObj.receiver,
          sessionType: msgObj.sessionType,
          sessionID: msgObj.sessionID,
          atState: msgObj.atState,
          msgFlag: msgObj.msgFlag,
          atMemberIDList: msgObj.atMemberIDList,
          type: msgObj.type
        });

        if (!sendRes || sendRes.code !== 0) {
          return {
            success: false,
            error: sendRes?.error || 'sendMessageNew 未返回成功 ack',
            isPreTrigger: false
          };
        }

        const confirmedMessage = await waitForPersistedMessage(targetSes.id, msgObj.msgFlag);
        if (!confirmedMessage) {
          return {
            success: false,
            error: 'sendMessageNew 已确认，但未解析到落库后的真实消息 ID',
            isPreTrigger: false
          };
        }
        msgObj.id = confirmedMessage.id;
        msgObj.msgIdx = confirmedMessage.msgIdx;

        try {
          if (store) {
            store.commit('updateSesLastMsg', { sesUUID: targetSes.sesUUID, message: confirmedMessage });
          }
          if (bus) {
            bus.$emit(targetSes.sesUUID + '-msg', [msgObj]);
          }
        } catch (updateErr) {}

        return { success: true, messageId: String(confirmedMessage.id) };
      })()
    `;

    try {
      const res = await this.cdp.evaluate<{ success: boolean; messageId?: string; error?: string; isPreTrigger?: boolean }>(script, 15000);
      if (!res?.success) {
        return { success: false, error: res?.error || '文件底层发送失败', isPreTrigger: res?.isPreTrigger ?? false };
      }
      return { success: true, messageId: res.messageId, verifyLatencyMs: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        error: `文件发送异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: cdpWasUnavailable,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 发送本地图片
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

    const base64Data = fs.readFileSync(fullPath).toString('base64');
    const startTime = Date.now();
    const payloadData = {
      target: options.targetSessionId || '',
      base64Data,
      mimeType,
    };

    const encoded = encodePayload(payloadData);
    let sendMayHaveTriggered = false;

    try {
      await this.cdp.bringToFront();

      const clipScript = `
        (async () => {
          try {
            window.focus();
            const data = JSON.parse(decodeURIComponent(${encoded}));
            const target = data.target;
            ${RESOLVE_RENDERER_SESSION_SCRIPT}
            const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
            if (target) {
              if (!Array.isArray(editor?.sortedSessions)) {
                return { success: false, error: '当前会话列表不可用' };
              }
              const found = resolveRendererSession(editor.sortedSessions, target);
              if (!found) {
                return { success: false, error: '未找到目标会话 [' + target + ']' };
              }
              const active = editor?.activedSes;
              const isActive = Boolean(
                active &&
                (active.sesUUID === found.sesUUID || String(active.id) === String(found.id))
              );
              if (!isActive) {
                return { success: false, error: '目标会话尚未真实激活 [' + target + ']' };
              }
            }

            const input = document.querySelector('.chat-sendArea, .chat-editor, [contenteditable]');
            if (input) input.focus();

            const byteCharacters = atob(data.base64Data);
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: data.mimeType });

            await navigator.clipboard.write([
              new ClipboardItem({ [data.mimeType]: blob })
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

      sendMayHaveTriggered = true;
      const sendRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(sendScript);
      if (!sendRes?.success) {
        return { success: false, error: `点击发送图片失败: ${sendRes?.error}`, isPreTrigger: true };
      }

      return { success: true, verifyLatencyMs: Date.now() - startTime };
    } catch (err) {
      return {
        success: false,
        error: `发送图片异常: ${err instanceof Error ? err.message : String(err)}`,
        isPreTrigger: !sendMayHaveTriggered,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * 优先通过原生 IPC toData('cancelMessage') 撤回消息
   */
  public async recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false;

    const payloadData = {
      targetId: messageId,
      targetSessionId: sessionId || '',
    };
    const encoded = encodePayload(payloadData);

    try {
      const script = `
        (async () => {
          const data = JSON.parse(decodeURIComponent(${encoded}));
          const targetId = data.targetId;
          const targetSessionId = data.targetSessionId;
          ${RESOLVE_RENDERER_SESSION_SCRIPT}
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus;

          let targetSession = editor?.activedSes || null;
          if (targetSessionId) {
            if (!Array.isArray(editor?.sortedSessions)) {
              return { success: false };
            }
            targetSession = resolveRendererSession(editor.sortedSessions, targetSessionId);
            if (!targetSession) {
              return { success: false };
            }
          }
          if (!targetSession) {
            return { success: false };
          }

          let matchedVueMsg = null;
          const items = document.querySelectorAll('.rcd-item, .message-item, .msg-item');
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vMsg?.id || vMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id');
            if (rawId && String(rawId) === String(targetId)) {
              matchedVueMsg = vMsg;
              break;
            }
          }

          const sessionID = targetSession.id;
          if (
            matchedVueMsg?.sessionID !== undefined &&
            String(matchedVueMsg.sessionID) !== String(sessionID)
          ) {
            return { success: false };
          }
          const sesUUID = targetSession.sesUUID || targetSessionId;
          const msgID = matchedVueMsg?.id || matchedVueMsg?.msgID || Number(targetId) || targetId;
          const msgIdx = matchedVueMsg?.msgIdx || 0;

          const electron = window.require ? window.require('electron') : null;
          const ipc = window.ipcRenderer || electron?.ipcRenderer;
          if (!ipc || typeof ipc.send !== 'function' || typeof ipc.once !== 'function') {
            return { success: false };
          }

          const key = '__kkbot_rpc_id';
          const currentId = typeof window[key] === 'number' ? window[key] : 800000;
          window[key] = currentId + 1;
          const reqId = currentId + 1;
          const replyChannel = 'data-' + reqId;
          const res = await new Promise(resolve => {
            const onReply = (_event, payload) => {
              clearTimeout(timer);
              try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
              resolve(payload);
            };
            const timer = setTimeout(() => {
              try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
              resolve({ code: -2 });
            }, 4000);
            ipc.once(replyChannel, onReply);
            try {
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
            } catch (sendErr) {
              clearTimeout(timer);
              try { ipc.removeListener(replyChannel, onReply); } catch (e) {}
              resolve({ code: -3 });
            }
          });

          if (!res || res.code !== 0) {
            return { success: false };
          }

          if (bus && sesUUID) {
            try {
              bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
            } catch (eventErr) {}
          }
          return { success: true };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean }>(script, 6000);
      return Boolean(res?.success);
    } catch (err) {
      log.warn({ messageId, err: String(err) }, 'Bridge 撤回消息失败');
      return false;
    }
  }
}
