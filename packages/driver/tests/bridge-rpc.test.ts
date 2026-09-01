import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { callIpcToData } from '../src/bridge/rpc.js';
import { DriverError } from '../src/utils/errors.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  NO_IPC_RESPONSE,
  runRendererScript,
} from './helpers/renderer-runtime.js';

describe('Bridge RPC 通信层测试 (callIpcToData)', () => {
  it('正常响应时应正确解析 code: 0 和 payload 数据', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({
        code: 0,
        data: { usersInfo: {}, sessionsInfo: {} },
      }),
    } as unknown as CdpClient;

    const res = await callIpcToData<{ usersInfo: unknown }>(mockCdp, 'getConversations');
    expect(res.code).toBe(0);
    expect(res.data).toBeDefined();
    expect(mockCdp.evaluate).toHaveBeenCalledOnce();
  });

  it('底层 CDP 评估异常时应包装为 DriverError 并标记 IPC_RPC_FAILED', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockRejectedValue(new Error('CDP socket disconnected')),
    } as unknown as CdpClient;

    await expect(callIpcToData(mockCdp, 'getConversations')).rejects.toThrow(DriverError);
    await expect(callIpcToData(mockCdp, 'getConversations')).rejects.toMatchObject({
      code: 'IPC_RPC_FAILED',
    });
  });

  it('未获得有效返回值时应抛出 IPC_NO_RESPONSE', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue(null),
    } as unknown as CdpClient;

    await expect(callIpcToData(mockCdp, 'getMessages')).rejects.toMatchObject({
      code: 'IPC_RPC_FAILED',
    });
  });

  it('IPC 返回业务错误码时应透传错误信息', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({
        code: 1,
        message: 'Internal Server Error',
      }),
    } as unknown as CdpClient;

    const res = await callIpcToData(mockCdp, 'unknownMethod');
    expect(res.code).toBe(1);
    expect(res.message).toBe('Internal Server Error');
  });

  it('真实 timeout 只能移除本次 listener，必须保留同 channel 的观察 listener', async () => {
    const ipc = new FakeIpcRenderer(() => NO_IPC_RESPONSE);
    const runtime = createRendererRuntime({ ipc });
    const observer = vi.fn();
    ipc.once('data-800001', observer);
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const res = await callIpcToData(mockCdp, 'getChildDeptsAndMembers', [], 5);

    expect(res.code).toBe(-2);
    expect(ipc.listenerCount('data-800001')).toBe(1);
    expect(observer).not.toHaveBeenCalled();
  });

  it('ipc.send 抛错后必须移除本次 reply listener', async () => {
    const ipc = new FakeIpcRenderer(() => {
      throw new Error('real send failed');
    });
    const runtime = createRendererRuntime({ ipc });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const res = await callIpcToData(mockCdp, 'getConversations', [], 5);
    const request = ipc.sent[0];

    expect(res.code).toBe(-3);
    expect(request).toBeDefined();
    expect(ipc.listenerCount(`data-${request?.id}`)).toBe(0);
  });
});
