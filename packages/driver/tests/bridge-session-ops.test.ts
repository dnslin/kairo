import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeSessionOps } from '../src/bridge/session-ops.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  runRendererScript,
} from './helpers/renderer-runtime.js';

describe('BridgeSessionOps 纯数据会话管理测试', () => {
  it('getSessions 应通过 IPC getConversations 解析私聊(int2024)与群聊(测试123)会话列表与未读数', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('sortedSessions')) {
          return Promise.resolve({
            activeUuid: '0-3585',
            activeId: 602475,
            sortedSessions: [
              { id: 602475, sesUUID: '0-3585', name: 'int2024', type: 0 },
              { id: 793803, sesUUID: '1-29467', name: '测试123', type: 1 },
            ],
          });
        }
        if (script.includes('getConversations')) {
          return Promise.resolve({
            code: 0,
            data: {
              sessionsInfo: {
                '602475': {
                  id: 602475,
                  type: 0,
                  creater: 3705,
                  createrName: 'int2024',
                  typeID: 3585,
                  typeName: 'int2024',
                  maxMessageIndex: 10,
                  userReadIndex: 8,
                  lastMessage: JSON.stringify({ content: [{ type: 0, text: '你好，私聊测试' }] }),
                  lastMsgTime: 1788142783,
                  atState: 0,
                },
                '793803': {
                  id: 793803,
                  type: 1,
                  creater: 29467,
                  createrName: '群管理员',
                  typeID: 29467,
                  typeName: '测试123',
                  maxMessageIndex: 55,
                  userReadIndex: 50,
                  lastMessage: JSON.stringify({ content: [{ type: 0, text: '群聊讨论' }] }),
                  lastMsgTime: 1788142900,
                  atState: 2, // 未读 @ 我
                },
              },
            },
          });
        }
        return Promise.resolve(null);
      }),
    } as unknown as CdpClient;

    const ops = new BridgeSessionOps(mockCdp);
    const sessions = await ops.getSessions();

    expect(sessions).toHaveLength(2);

    // 私聊会话 int2024
    const privateSes = sessions.find(s => s.name === 'int2024');
    expect(privateSes).toBeDefined();
    expect(privateSes?.type).toBe('private');
    expect(privateSes?.unread).toBe(true);
    expect(privateSes?.unreadCount).toBe(2); // 10 - 8
    expect(privateSes?.active).toBe(true);
    expect(privateSes?.lastMessage).toBe('你好，私聊测试');

    // 群聊会话 测试123
    const groupSes = sessions.find(s => s.name === '测试123');
    expect(groupSes).toBeDefined();
    expect(groupSes?.type).toBe('group');
    expect(groupSes?.unread).toBe(true);
    expect(groupSes?.unreadCount).toBe(5); // 55 - 50
    expect(groupSes?.unreadAt).toBe(true); // atState = 2
  });

  it('getCurrentSession 应从 Vue editor 提取当前活跃会话', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockResolvedValue({
        id: '1-29467',
        name: '测试123',
        type: 'group',
        unread: false,
        active: true,
      }),
    } as unknown as CdpClient;

    const ops = new BridgeSessionOps(mockCdp);
    const current = await ops.getCurrentSession();

    expect(current).not.toBeNull();
    expect(current?.name).toBe('测试123');
    expect(current?.type).toBe('group');
    expect(current?.active).toBe(true);
  });

  it('selectSession 应支持切换到私聊会话 int2024 与群聊会话 测试123', async () => {
    const mockCdp = {
      evaluate: vi.fn().mockImplementation((script: string) => {
        if (script.includes('int2024') || script.includes('测试123')) {
          return Promise.resolve({ success: true, method: 'vue_session_switch' });
        }
        return Promise.resolve({ success: false });
      }),
    } as unknown as CdpClient;

    const ops = new BridgeSessionOps(mockCdp);

    const privateSwitch = await ops.selectSession('int2024');
    expect(privateSwitch).toBe(true);

    const groupSwitch = await ops.selectSession('测试123');
    expect(groupSwitch).toBe(true);

    const unknownSwitch = await ops.selectSession('不存在的会话');
    expect(unknownSwitch).toBe(false);
  });

  it('markSessionRead 仅在 native ack 成功后更新本地未读状态', async () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
    const runtime = createRendererRuntime({ ipc, sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-3585');

    expect(result).toBe(true);
    expect(session.userReadIndex).toBe(10);
    expect(session.atState).toBe(0);
  });

  it('markSessionRead 缺少 ipcRenderer 时不得伪造本地已读成功', async () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const runtime = createRendererRuntime({ sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-3585');

    expect(result).toBe(false);
    expect(session.userReadIndex).toBe(4);
    expect(session.atState).toBe(2);
    expect(runtime.events).toHaveLength(0);
  });

  it('markSessionRead 收到业务失败 ack 时不得更新本地状态', async () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => ({ code: 1, message: 'read rejected' }));
    const runtime = createRendererRuntime({ ipc, sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-3585');

    expect(result).toBe(false);
    expect(session.userReadIndex).toBe(4);
    expect(session.atState).toBe(2);
    expect(runtime.events).toHaveLength(0);
  });

  it('markSessionRead 的 ipc.send 抛错后必须移除本次 listener', async () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      type: 0,
      maxMessageIndex: 10,
      userReadIndex: 4,
      atState: 2,
    };
    const ipc = new FakeIpcRenderer(() => {
      throw new Error('read send failed');
    });
    const runtime = createRendererRuntime({ ipc, sessions: [session], activeSession: session });
    const mockCdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;

    const result = await new BridgeSessionOps(mockCdp).markSessionRead('0-3585');
    const request = ipc.sent[0];

    expect(result).toBe(false);
    expect(request).toBeDefined();
    expect(ipc.listenerCount(`data-${request?.id}`)).toBe(0);
  });
});
