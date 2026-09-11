export function encodeRendererPayload(data: unknown): string {
  return JSON.stringify(encodeURIComponent(JSON.stringify(data)));
}

export const RENDERER_SESSION_RESOLVER_SCRIPT = `
  function resolveRendererSession(sessions, target) {
    if (!Array.isArray(sessions) || !target) return null;
    const idMatch = sessions.find(
      session => session && (session.sesUUID === target || String(session.id) === target)
    );
    if (idMatch) return idMatch;

    const nameMatches = sessions.filter(
      session => session && (session.typeName === target || session.name === target)
    );
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }

  function resolveRendererSessionIdentity(sessions, targetId, targetName) {
    if (!Array.isArray(sessions)) return null;
    if (targetId) {
      const idMatch = sessions.find(
        session => session && (
          session.sesUUID === targetId ||
          String(session.id) === String(targetId)
        )
      );
      if (idMatch) return idMatch;
    }
    if (!targetName) return null;

    const nameMatches = sessions.filter(
      session => session && (
        session.typeName === targetName ||
        session.name === targetName
      )
    );
    return nameMatches.length === 1 ? nameMatches[0] : null;
  }
`;

export const RENDERER_IPC_HELPERS_SCRIPT = `
  function nextKairoRequestId() {
    const key = '__kairo_rpc_id';
    const currentId = typeof window[key] === 'number' ? window[key] : 800000;
    window[key] = currentId + 1;
    return currentId + 1;
  }

  function callKairoIpcWithTimeout(timeoutMs, channel, ...args) {
    return new Promise(resolve => {
      if (!ipc || typeof ipc.send !== 'function' || typeof ipc.once !== 'function') {
        resolve({ code: -1, error: '当前环境未找到有效的 ipcRenderer 对象' });
        return;
      }

      const requestId = nextKairoRequestId();
      const replyChannel = 'data-' + requestId;
      let settled = false;
      let timer;

      const cleanup = () => {
        if (typeof ipc.removeListener === 'function') {
          try { ipc.removeListener(replyChannel, onReply); } catch (error) {}
        }
      };
      const finish = payload => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cleanup();
        resolve(payload);
      };
      const onReply = (_event, payload) => {
        finish(payload || { code: 0 });
      };

      timer = setTimeout(() => {
        finish({ code: -2, error: 'IPC 请求超时' });
      }, timeoutMs);
      ipc.once(replyChannel, onReply);

      try {
        ipc.send('data', {
          id: requestId,
          args: [channel, ...args],
          progress: false
        });
      } catch (sendError) {
        finish({ code: -3, error: 'ipc.send 失败: ' + String(sendError) });
      }
    });
  }

  function callKairoIpc(channel, ...args) {
    return callKairoIpcWithTimeout(4000, channel, ...args);
  }
`;

export const CONFIRM_SENT_MESSAGE_SCRIPT = `
  async function waitForPersistedMessage(sessionID, msgFlag, targetSession) {
    const targetSessionIds = [String(sessionID), String(targetSession?.id), String(targetSession?.sesUUID)];
    for (let attempt = 0; attempt < 12; attempt++) {
      const messagesRes = await callIpc('getMessages', {
        sessionID, count: 100, endIdx: 2147483647, sendTime: 0
      });
      if (messagesRes?.code === 0 && Array.isArray(messagesRes.data)) {
        const found = messagesRes.data.find(message => {
          if (!message || message.msgFlag !== msgFlag || !/^[1-9]\\d*$/.test(String(message.id))) return false;
          const rawSessionId = message.sessionId ?? message.sessionID ?? message.sesUUID;
          return rawSessionId === undefined || rawSessionId === null ||
            String(rawSessionId).trim() === '' || targetSessionIds.includes(String(rawSessionId));
        });
        if (found) return found;
      }
      if (attempt < 11) await new Promise(resolve => setTimeout(resolve, 200));
    }
    return null;
  }
`;

// 内容准备、操作登记与UI通知由调用方负责；这里执行原生提交并观察已确认的本次发送。
export const SUBMIT_NATIVE_MESSAGE_SCRIPT = `
  // 在脚本开始时捕获，早于图片预处理等await，旧发送不能借用新Hook发布回显。
  const observeNativeSend = window.__kairo_native_send_observer;
  async function submitNativeMessage(msgObj, targetSession) {
    const insertRes = await callIpc('insertSendBefoeMsg', msgObj);
    if (!insertRes || insertRes.code !== 0 || !insertRes.data) {
      return {
        insertFailed: true,
        failure: {
          success: false,
          error: insertRes?.error || 'insertSendBefoeMsg 写入失败',
          isPreTrigger: Boolean(insertRes && insertRes.code !== 0 && insertRes.code !== -2)
        }
      };
    }

    msgObj.id = insertRes.data.id;
    msgObj.msgIdx = insertRes.data.msgIdx;
    const sendRes = await callIpc('sendMessageNew', {
      id: msgObj.id,
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
        failure: {
          success: false,
          error: sendRes?.error || 'sendMessageNew 未返回成功 ack',
          isPreTrigger: false
        }
      };
    }

    const confirmedMessage = await waitForPersistedMessage(msgObj.sessionID, msgObj.msgFlag, targetSession);
    if (!confirmedMessage) {
      return {
        failure: {
          success: false,
          error: 'sendMessageNew 已确认，但未解析到落库后的真实消息 ID',
          isPreTrigger: false
        }
      };
    }
    if (typeof observeNativeSend === 'function') {
      observeNativeSend({
        sessionId: targetSession?.sesUUID,
        session: targetSession,
        message: [confirmedMessage]
      });
    }
    return { confirmedMessage };
  }
`;
