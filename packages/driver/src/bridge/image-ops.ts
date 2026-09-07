import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import type { CdpClient } from '../cdp/client.js';
import type { SendOptions, SendResult } from '../types/index.js';
import {
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
  SUBMIT_NATIVE_MESSAGE_SCRIPT,
} from './renderer-script.js';
import {
  createNativeMessageKey,
  isCdpUnavailableBeforeSend,
  sendResultToOperationUpdate,
} from './send-status.js';

const MAX_IMAGE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB
function imagePreflightFailure(operationAware: boolean, error: unknown): SendResult {
  if (!operationAware) throw error;
  const message = error instanceof Error ? error.message : String(error);
  return {
    success: false,
    status: 'failed',
    error: `图片文件预检失败: ${message}`,
    isPreTrigger: true,
  };
}

function getImageDimensions(buffer: Buffer): { width: number; height: number } {
  // PNG: bytes 16-24 hold width (16..19) and height (20..23) big-endian
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  ) {
    return {
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }

  // GIF: bytes 6-10 hold width (6..7) and height (8..9) little-endian
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return {
      width: buffer.readUInt16LE(6),
      height: buffer.readUInt16LE(8),
    };
  }

  // BMP: bytes 18-26 hold width (18..21) and height (22..25) little-endian
  if (buffer.length >= 26 && buffer[0] === 0x42 && buffer[1] === 0x4d) {
    return {
      width: Math.abs(buffer.readInt32LE(18)),
      height: Math.abs(buffer.readInt32LE(22)),
    };
  }

  // JPEG / JPG parse SOF markers (SOF0 = 0xC0, SOF2 = 0xC2, etc.)
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = buffer[offset + 1];
      // SOF0 (0xC0), SOF1 (0xC1), SOF2 (0xC2)
      if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
        if (offset + 9 <= buffer.length) {
          const height = buffer.readUInt16BE(offset + 5);
          const width = buffer.readUInt16BE(offset + 7);
          return { width, height };
        }
      }
      if (marker === 0xd9 || marker === 0xda) {
        break;
      }
      if (offset + 4 <= buffer.length) {
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      } else {
        break;
      }
    }
  }

  return { width: 300, height: 300 };
}

const CONFIRM_SENT_MESSAGE_SCRIPT = `
  async function waitForPersistedMessage(sessionID, msgFlag) {
    for (let attempt = 0; attempt < 15; attempt++) {
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
      if (attempt < 14) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    return null;
  }
`;

export async function sendNativeImage(
  cdp: CdpClient,
  imagePath: string,
  options: SendOptions = {},
  nativeKey?: string
): Promise<SendResult> {
  const fullPath = path.resolve(imagePath);
  const operationAware = nativeKey !== undefined || options.operationId !== undefined;
  if (!fs.existsSync(fullPath)) {
    return {
      success: false,
      status: 'failed',
      error: `图片文件不存在: ${fullPath}`,
      isPreTrigger: true,
    };
  }

  let stats: fs.Stats;
  try {
    stats = fs.statSync(fullPath);
  } catch (error) {
    return imagePreflightFailure(operationAware, error);
  }
  if (stats.isDirectory()) {
    return {
      success: false,
      status: 'failed',
      error: `不能发送目录作为图片: ${fullPath}`,
      isPreTrigger: true,
    };
  }
  if (stats.size > MAX_IMAGE_SIZE_BYTES) {
    return {
      success: false,
      status: 'failed',
      error: `图片大小超出限制 (20MB): ${stats.size} bytes`,
      isPreTrigger: true,
    };
  }

  const mimeType = mime.lookup(fullPath) || 'image/png';
  if (!mimeType.startsWith('image/')) {
    return {
      success: false,
      status: 'failed',
      error: `不支持的图片格式: ${mimeType}`,
      isPreTrigger: true,
    };
  }

  let buffer: Buffer;
  try {
    buffer = fs.readFileSync(fullPath);
  } catch (error) {
    return imagePreflightFailure(operationAware, error);
  }
  const { width, height } = getImageDimensions(buffer);
  const base64Thumb = buffer.toString('base64');
  const startTime = Date.now();
  const cdpWasUnavailable = isCdpUnavailableBeforeSend(cdp);

  const payloadData = {
    target: options.targetSessionId || '',
    msgFlag: nativeKey ?? createNativeMessageKey('image', options.operationId),
    fullPath,
    base64Thumb,
    mimeType,
    width,
    height,
    operationAware,
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
          return { success: false, error: '未在会话列表中找到目标会话 [' + target + ']', isPreTrigger: true };
        }
        targetSes = found;
      }

      if (!targetSes) {
        return { success: false, error: '未指定目标会话且当前无激活会话', isPreTrigger: true };
      }

      const myUid = main?.userID || editor?.userID;
      if (!myUid) {
        return { success: false, error: '未获取到当前登录用户身份 (userID)', isPreTrigger: true };
      }
      const myName = main?.userName || editor?.userName || '我';

      // 1. 调用 Native 预处理图片与缩略图
      const handleRes = await callIpc('sendingImgBeforeHandle', data.base64Thumb, data.fullPath);
      if (!handleRes || handleRes.code !== 0 || !handleRes.data) {
        return {
          success: false,
          error: 'sendingImgBeforeHandle 失败: ' + (handleRes?.message || JSON.stringify(handleRes)),
          isPreTrigger: true
        };
      }

      const thumbPath = handleRes.data.thumbPath;
      const artworkPath = handleRes.data.artworkPath;

      // 2. 构造 PicText 图片消息对象
      const imgNode = {
        type: 1,
        height: data.height,
        width: data.width,
        isValid: true,
        filepath: thumbPath,
        filepath_h: artworkPath,
        mimetype: data.mimeType
      };

      const msgObj = {
        contentType: 4, // PicText
        content: {
          content: [imgNode],
          font: {
            fontFamily: 'Microsoft YaHei',
            fontSize: 14,
            fontColor: '#000000',
            fontBold: false,
            fontItalic: false,
            fontUnderline: false
          }
        },
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
        filepath: artworkPath,
        deviceID: main?.deviceID || editor?.deviceID || ''
      };

      const submission = await submitNativeMessage(msgObj);
      if (submission.failure) {
        // 旧图片入口的预插入失败分类保持不变，操作登记入口使用实际触发证据。
        if (submission.insertFailed && !data.operationAware) submission.failure.isPreTrigger = true;
        return submission.failure;
      }
      const confirmedMessage = submission.confirmedMessage;

      try {
        if (store) {
          store.commit('updateSesLastMsg', { sesUUID: targetSes.sesUUID, message: confirmedMessage });
        }
        if (bus) {
          bus.$emit(targetSes.sesUUID + '-msg', [confirmedMessage]);
        }
      } catch (updateErr) {}

      return { success: true, messageId: String(confirmedMessage.id) };
    })()
  `;

  try {
    const res = await cdp.evaluate<{
      success: boolean;
      messageId?: string;
      error?: string;
      isPreTrigger?: boolean;
      status?: SendResult['status'];
    }>(script, 15000);

    if (!operationAware) {
      const legacyResult: SendResult = res
        ? {
            ...res,
            ...(!res.success && res.error === undefined ? { error: '底层图片 IPC 发送失败' } : {}),
            ...(!res.success && res.isPreTrigger === undefined ? { isPreTrigger: false } : {}),
            ...(res.success ? { verifyLatencyMs: Date.now() - startTime } : {}),
          }
        : {
            success: false,
            error: '底层图片 IPC 发送失败',
            isPreTrigger: false,
          };
      return {
        ...legacyResult,
        status: legacyResult.status ?? sendResultToOperationUpdate(legacyResult).status,
      };
    }

    const isPreTrigger = res?.isPreTrigger ?? false;
    if (!res?.success) {
      const result: SendResult = {
        success: false,
        error: res?.error || '底层图片 IPC 发送失败',
        isPreTrigger,
      };
      return {
        ...result,
        status: sendResultToOperationUpdate(result).status,
      };
    }

    const messageId = typeof res.messageId === 'string' ? res.messageId.trim() : '';
    if (!messageId || !Number.isFinite(Number(messageId)) || Number(messageId) <= 0) {
      return {
        success: false,
        status: 'unknown',
        error: '底层图片 IPC 已触发，但未确认有效 native 消息 ID',
        isPreTrigger: false,
        verifyLatencyMs: Date.now() - startTime,
      };
    }

    return {
      success: true,
      status: 'delivered',
      messageId,
      verifyLatencyMs: Date.now() - startTime,
    };
  } catch (err) {
    const isPreTrigger = cdpWasUnavailable;
    return {
      success: false,
      status: isPreTrigger ? 'failed' : 'unknown',
      error: `底层图片 IPC 发送异常: ${err instanceof Error ? err.message : String(err)}`,
      isPreTrigger,
      verifyLatencyMs: Date.now() - startTime,
    };
  }
}
