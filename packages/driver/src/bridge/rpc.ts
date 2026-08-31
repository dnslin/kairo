import type { CdpClient } from '../cdp/client.js';
import { DriverError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('bridge-rpc');

export interface IpcResponse<T = unknown> {
  code: number;
  data?: T;
  message?: string;
  error?: string;
}

/**
 * 在 KK9 渲染进程中执行底层 IPC toData RPC 调用
 *
 * @param cdp CdpClient 实例
 * @param method RPC 方法名 (如 'getConversations', 'getChildDeptsAndMembers', 'getMemberDetail')
 * @param args 方法入参
 * @param timeoutMs 超时时间 (毫秒)
 */
export async function callIpcToData<T = unknown>(
  cdp: CdpClient,
  method: string,
  args: unknown[] = [],
  timeoutMs = 10000
): Promise<IpcResponse<T>> {
  const script = `
    (async () => {
      const electron = window.require ? window.require('electron') : null;
      const ipc = window.ipcRenderer || electron?.ipcRenderer;
      if (!ipc || typeof ipc.send !== 'function') {
        return { code: -1, error: '当前环境未找到有效的 ipcRenderer 对象' };
      }

      const key = '__kkbot_rpc_id';
      const currentId = typeof window[key] === 'number' ? window[key] : 800000;
      window[key] = currentId + 1;
      const reqId = currentId + 1;
      const replyChannel = 'data-' + reqId;

      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { ipc.removeAllListeners(replyChannel); } catch (e) {}
          resolve({ code: -2, error: 'IPC toData [${method}] 请求超时 (${timeoutMs}ms)' });
        }, ${timeoutMs});

        ipc.once(replyChannel, (_event, payload) => {
          clearTimeout(timer);
          resolve(payload || { code: 0 });
        });

        try {
          ipc.send('data', {
            id: reqId,
            args: [${JSON.stringify(method)}, ...${JSON.stringify(args)}],
            progress: false
          });
        } catch (sendErr) {
          clearTimeout(timer);
          resolve({ code: -3, error: 'ipc.send 失败: ' + String(sendErr) });
        }
      });
    })()
  `;

  try {
    const res = await cdp.evaluate<IpcResponse<T>>(script, timeoutMs + 1000);
    if (!res) {
      throw new DriverError(`IPC toData [${method}] 未获得返回值`, 'IPC_NO_RESPONSE');
    }
    return res;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    log.warn({ method, err: errorMsg }, '执行 IPC toData RPC 异常');
    throw new DriverError(
      `执行 IPC toData [${method}] 异常: ${errorMsg}`,
      'IPC_RPC_FAILED',
      err instanceof Error ? err : undefined
    );
  }
}
