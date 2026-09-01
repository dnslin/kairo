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
