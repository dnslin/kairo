import type { CdpClient } from '../cdp/client.js';
import { createChildLogger } from '../utils/logger.js';
import {
  encodeRendererPayload,
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
} from './renderer-script.js';

const log = createChildLogger('bridge-recall-ops');

export async function recallNativeMessage(
  cdp: CdpClient,
  messageId: string,
  sessionId?: string
): Promise<boolean> {
  if (!messageId) return false;

  const encoded = encodeRendererPayload({
    targetId: messageId,
    targetSessionId: sessionId || '',
  });

  try {
    const result = await cdp.evaluate<{ success: boolean }>(`
      (async () => {
        const data = JSON.parse(decodeURIComponent(${encoded}));
        const targetId = data.targetId;
        const targetSessionId = data.targetSessionId;
        ${RENDERER_SESSION_RESOLVER_SCRIPT}
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        const main = document.querySelector('.main-page')?.__vue__;
        const bus = main?.$bus;
        const electron = window.require ? window.require('electron') : null;
        const ipc = window.ipcRenderer || electron?.ipcRenderer;
        ${RENDERER_IPC_HELPERS_SCRIPT}

        let targetSession = editor?.activedSes || null;
        if (targetSessionId) {
          targetSession = resolveRendererSession(editor?.sortedSessions, targetSessionId);
        }
        if (!targetSession) return { success: false };

        let matchedVueMessage = null;
        const items = document.querySelectorAll('.rcd-item, .message-item, .msg-item');
        for (let index = items.length - 1; index >= 0; index--) {
          const item = items[index];
          const vueMessage = item.__vue__?.msgitem || item.__vue__?.message;
          const rawId = vueMessage?.id || vueMessage?.msgID ||
            item.getAttribute('id') || item.getAttribute('data-msg-id');
          if (rawId && String(rawId) === String(targetId)) {
            matchedVueMessage = vueMessage;
            break;
          }
        }

        const sessionID = targetSession.id;
        if (
          matchedVueMessage?.sessionID !== undefined &&
          String(matchedVueMessage.sessionID) !== String(sessionID)
        ) {
          return { success: false };
        }

        const sesUUID = targetSession.sesUUID || targetSessionId;
        const msgID = matchedVueMessage?.id || matchedVueMessage?.msgID ||
          Number(targetId) || targetId;
        const msgIdx = matchedVueMessage?.msgIdx || 0;
        const response = await callKkbotIpc('cancelMessage', {
          type: 'own',
          sessionID,
          msgID,
          msgIdx
        });
        if (response?.code !== 0) return { success: false };

        if (bus && sesUUID) {
          try {
            bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
          } catch (error) {}
        }
        return { success: true };
      })()
    `, 6000);
    return Boolean(result?.success);
  } catch (error) {
    log.warn({ messageId, err: String(error) }, 'Bridge 撤回消息失败');
    return false;
  }
}
