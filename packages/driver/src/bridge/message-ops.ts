import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import type { CdpClient } from '../cdp/client.js';
import {
  normalizeNativeMessage,
  type InboundNormalizationDiagnostic,
} from './converter.js';
import { callIpcToData } from './rpc.js';
import {
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
} from './renderer-script.js';
import { recallNativeMessage } from './recall-ops.js';
import { sendNativeImage } from './image-ops.js';
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

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function isCdpUnavailableBeforeSend(cdp: CdpClient): boolean {
  const getStatus = (cdp as Partial<CdpClient>).getStatus;
  return typeof getStatus === 'function' && getStatus.call(cdp) !== 'connected';
}

const FIND_REPLY_TARGET_SCRIPT = `
  function normalizeReplyTargetMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const normalized = { ...message };
    if (typeof normalized.content === 'string') {
      try {
        normalized.content = JSON.parse(normalized.content);
      } catch (error) {}
    }
    return normalized;
  }

  async function findReplyTargetMessage(sessionID, targetRef) {
    const targetMessageId = String(targetRef.messageId);
    const targetMsgIdx = Number(targetRef.msgIdx);
    if (Number.isFinite(targetMsgIdx) && targetMsgIdx > 0) {
      const exactResponse = await callIpc(
        'getMessageBySessionIDAndMsgIdx',
        sessionID,
        targetMsgIdx
      );
      const exactMessages = Array.isArray(exactResponse?.data)
        ? exactResponse.data
        : exactResponse?.data
          ? [exactResponse.data]
          : [];
      const exactMatch = exactMessages.find(
        message => String(message?.id) === targetMessageId
      );
      if (exactMatch) return normalizeReplyTargetMessage(exactMatch);
    }

    let endIdx = 2147483647;
    for (let page = 0; page < 10; page++) {
      const response = await callIpc('getMessages', {
        sessionID,
        count: 200,
        endIdx,
        sendTime: 0
      });
      if (response?.code !== 0 || !Array.isArray(response.data)) return null;

      const match = response.data.find(
        message => String(message?.id) === targetMessageId
      );
      if (match) return normalizeReplyTargetMessage(match);
      if (response.data.length < 200) return null;

      const indices = response.data
        .map(message => Number(message?.msgIdx))
        .filter(index => Number.isFinite(index) && index > 0);
      if (indices.length === 0) return null;
      const nextEndIdx = Math.min(...indices) - 1;
      if (nextEndIdx >= endIdx) return null;
      endIdx = nextEndIdx;
    }
    return null;
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
  return `kairo:${kind}:${randomUUID()}`;
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

export type BridgeMessageReadResult =
  | { kind: 'ok'; value: KK9Message[] }
  | { kind: 'unavailable'; error: string };

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
    const result = await this.getRecentMessagesResult(
      limit,
      session,
      knownBotSentMessageKeys,
      currentUserId
    );
    return result.kind === 'ok' ? result.value : [];
  }

  public async getRecentMessagesResult(
    limit = 20,
    session?: KK9Session,
    knownBotSentMessageKeys?: Set<string>,
    currentUserId?: string | number
  ): Promise<BridgeMessageReadResult> {
    try {
      const encodedSession = encodeRendererPayload(session || null);
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
          ${RENDERER_SESSION_RESOLVER_SCRIPT}
          const matched = targetSession
            ? resolveRendererSessionIdentity(
                editor?.sortedSessions,
                targetSession.id,
                targetSession.name
              )
            : editor?.activedSes;

          if (!matched) return null;
          return {
            sessionID: matched.id,
            maxMsgIdx: matched.maxMessageIndex ?? 2147483647,
            sesUUID: matched.sesUUID || String(matched.id),
            name: matched.typeName || matched.name || matched.createrName || '未知会话',
            type: matched.type || 0
          };
        })()
      `);

      if (!sessionContext) {
        return {
          kind: 'unavailable',
          error: session ? `目标会话无法唯一解析 [${session.id}]` : '当前无激活会话',
        };
      }

      const response = await callIpcToData<unknown[]>(this.cdp, 'getMessages', [
        {
          sessionID: sessionContext.sessionID,
          count: Math.max(1, limit),
          endIdx: sessionContext.maxMsgIdx,
          sendTime: 0,
        },
      ]);

      if (response.code !== 0 || !Array.isArray(response.data)) {
        return {
          kind: 'unavailable',
          error: response.error || response.message || 'getMessages 未返回有效数组',
        };
      }

      const isGroup = sessionContext.type === 1 || sessionContext.type === 2;
      const messages = normalizeNativeMessage(
        {
          messages: response.data,
          session: {
            id: sessionContext.sesUUID,
            name: sessionContext.name,
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
      return { kind: 'ok', value: messages };
    } catch (err) {
      const error = String(err);
      log.warn({ err: error }, 'Bridge 获取历史消息异常');
      return { kind: 'unavailable', error };
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

    const encoded = encodeRendererPayload(payloadData);

    const script = `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        ${RENDERER_SESSION_RESOLVER_SCRIPT}
        ${RENDERER_IPC_HELPERS_SCRIPT}
        const callIpc = callKairoIpc;
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

    const encoded = encodeRendererPayload(payloadData);

    const script = `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        ${RENDERER_SESSION_RESOLVER_SCRIPT}
        ${RENDERER_IPC_HELPERS_SCRIPT}
        const callIpc = callKairoIpc;
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
        ${FIND_REPLY_TARGET_SCRIPT}
        const targetMessage = await findReplyTargetMessage(targetSes.id, targetRef);
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

    const encoded = encodeRendererPayload(payloadData);

    const script = `
      (async () => {
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        const app = document.querySelector('#app')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
        const bus = main?.$bus || app?.$bus || window.vueBus;
        const store = app?.$store || window.$store;
        ${RENDERER_SESSION_RESOLVER_SCRIPT}
        ${RENDERER_IPC_HELPERS_SCRIPT}
        const callIpc = callKairoIpc;
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
   * 通过纯底层 IPC 发送本地图片
   */
  public sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
    return sendNativeImage(this.cdp, imagePath, options);
  }

  /**
   * 优先通过原生 IPC toData('cancelMessage') 撤回消息
   */
  public recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    return recallNativeMessage(this.cdp, messageId, sessionId);
  }
}
