import type { CdpClient } from '../cdp/client.js';
import type { SendOptions, SendResult } from '../types/index.js';
import { createNativeMessageKey, isCdpUnavailableBeforeSend } from './send-status.js';
import {
  CONFIRM_SENT_MESSAGE_SCRIPT,
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
} from './renderer-script.js';

type NativeStructuredMessage =
  | { kind: 'voice'; contentType: 2; content: unknown }
  | { kind: 'app-message'; contentType: 8; content: unknown }
  | { kind: 'url-card'; contentType: 10; content: unknown }
  | { kind: 'chat-record'; contentType: 15; content: unknown }
  | { kind: 'biz-message'; contentType: 17; content: unknown };

function unsupportedOptionsResult(options: SendOptions): SendResult | null {
  const unsupported: string[] = [];
  if (options.replyTo !== undefined) unsupported.push('replyTo');
  if (options.mentions !== undefined) unsupported.push('mentions');
  if (unsupported.length === 0) return null;

  return {
    success: false,
    status: 'failed',
    error: `原生卡片与语音消息不支持参数: ${unsupported.join(', ')}`,
    isPreTrigger: true,
  };
}

/**
 * 卡片与语音共用的原生结构化消息发送路径。
 * 只负责一次 native 发送；operationId 的声明、状态写入与重放由 BridgeMessageOps 统一管理。
 */
export async function sendNativeStructuredMessage(
  cdp: CdpClient,
  message: NativeStructuredMessage,
  options: SendOptions,
  nativeKey?: string
): Promise<SendResult> {
  const unsupported = unsupportedOptionsResult(options);
  if (unsupported) return unsupported;

  const startTime = Date.now();
  const cdpWasUnavailable = isCdpUnavailableBeforeSend(cdp);
  const payloadData = {
    target: options.targetSessionId || '',
    msgFlag: nativeKey ?? createNativeMessageKey(message.kind),
    contentType: message.contentType,
    content: message.content,
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
      ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
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
      if (!targetSes) {
        return { success: false, error: '当前无目标会话', isPreTrigger: true };
      }

      const myUid = main?.userID || editor?.userID;
      if (!myUid) {
        return { success: false, error: '未获取到当前登录用户身份 (userID)', isPreTrigger: true };
      }
      const myName = main?.userName || editor?.userName || '我';
      const sendTime = Math.floor(Date.now() / 1000);
      let messageContent = data.content;

      // chatRecord.vue 预览与详情弹窗除 msgArray 外还直接读取会话、发送者和成员字段；
      // 简报输入保持精简，在进入 native IPC 前补成渲染器实际消费的消息结构。
      if (data.contentType === 15) {
        const record = data.content || {};
        const sourceMessages = Array.isArray(record.msgArray) ? record.msgArray : [];
        messageContent = {
          title: record.title,
          msgArray: sourceMessages.map((item, index) => ({
            ...item,
            // 详情组件对字符串执行 JSON.parse；公开的 0 型纯文本须转为原生 PicText。
            contentType: item.contentType === 0 ? 4 : item.contentType,
            content: item.contentType === 0 && typeof item.content === 'string'
              ? { content: [{ type: 0, text: item.content }] }
              : item.content,
            id: item?.id ?? index + 1,
            msgIdx: item?.msgIdx ?? index + 1,
            senderID: item?.senderID ?? item?.sender ?? 0,
            senderName: item?.senderName || '未知用户',
            senderNameEN: item?.senderNameEN || item?.senderName || '未知用户',
            senderNameTC: item?.senderNameTC || item?.senderName || '未知用户',
            sessionType: item?.sessionType ?? targetSes.type,
            sessionID: item?.sessionID ?? targetSes.id,
            sendTime: item?.sendTime ?? sendTime,
            status: item?.status ?? 2,
            type: item?.type ?? 0
          })),
          sessionType: targetSes.type,
          sessionID: targetSes.id,
          senderID: myUid,
          senderName: myName,
          senderNameEN: myName,
          senderNameTC: myName,
          typeID: targetSes.typeID || targetSes.sesTypeID,
          typeName: record.title || targetSes.typeName || targetSes.name || ''
        };
      }

      const msgObj = {
        contentType: data.contentType,
        content: messageContent,
        sender: myUid,
        senderName: myName,
        senderNameEN: myName,
        senderNameTC: myName,
        receiver: targetSes.typeID || targetSes.sesTypeID,
        sendTime,
        sessionType: targetSes.type,
        sessionID: targetSes.id,
        atState: 1,
        atMemberIDList: [],
        status: 1,
        type: 0,
        msgFlag: data.msgFlag,
        deviceID: main?.deviceID || editor?.deviceID || ''
      };

      const submission = await submitNativeMessage(msgObj, targetSes);
      if (submission.failure) return submission.failure;
      const confirmedMessage = submission.confirmedMessage;

      const sessionEventId = targetSes.sesUUID || String(targetSes.id);
      try {
        if (store) store.commit('updateSesLastMsg', { sesUUID: sessionEventId, message: confirmedMessage });
      } catch {
        console.warn('[KairoDriver] 会话摘要更新失败');
      }
      try {
        if (bus) bus.$emit(sessionEventId + '-msg', [confirmedMessage]);
      } catch {
        console.warn('[KairoDriver] 聊天窗口推送失败');
      }

      return { success: true, messageId: String(confirmedMessage.id) };
    })()
  `;

  try {
    const result = await cdp.evaluate<{
      success: boolean;
      messageId?: string;
      error?: string;
      isPreTrigger?: boolean;
    }>(script, options.verifyTimeoutMs ?? 15000);
    if (!result?.success) {
      return {
        success: false,
        status: result?.isPreTrigger === true ? 'failed' : 'unknown',
        error: result?.error || '原生结构化消息发送失败',
        isPreTrigger: result?.isPreTrigger ?? false,
        verifyLatencyMs: Date.now() - startTime,
      };
    }
    return {
      success: true,
      status: result.messageId ? 'delivered' : 'unknown',
      messageId: result.messageId,
      isPreTrigger: false,
      verifyLatencyMs: Date.now() - startTime,
    };
  } catch (error) {
    return {
      success: false,
      status: cdpWasUnavailable ? 'failed' : 'unknown',
      error: `原生结构化消息发送异常: ${error instanceof Error ? error.message : String(error)}`,
      isPreTrigger: cdpWasUnavailable,
      verifyLatencyMs: Date.now() - startTime,
    };
  }
}
