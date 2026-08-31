import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  NO_IPC_RESPONSE,
  runRendererScript,
} from './helpers/renderer-runtime.js';

describe('BridgeMessageOps 纯数据消息操作测试', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getRecentMessages 消息历史拉取', () => {
    it('应在私聊会话 int2024 中通过 IPC getMessages 提取并标准化历史消息', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('targetSession')) {
            return Promise.resolve({
              sessionID: 602475,
              maxMsgIdx: 10,
              sesUUID: '0-3585',
              name: 'int2024',
              type: 0,
            });
          }
          if (script.includes('getMessages')) {
            return Promise.resolve({
              code: 0,
              data: [
                {
                  id: 1001,
                  msgIdx: 9,
                  sender: 3705,
                  senderName: 'int2024',
                  contentType: 4,
                  content: { content: [{ type: 0, text: '私聊问题咨询' }] },
                  sendTime: 1788142780,
                },
                {
                  id: 1002,
                  msgIdx: 10,
                  sender: 5761,
                  senderName: '我',
                  isFromSelf: true,
                  contentType: 4,
                  content: { content: [{ type: 0, text: '收到，正在核实' }] },
                  sendTime: 1788142800,
                },
              ],
            });
          }
          return Promise.resolve(null);
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const messages = await ops.getRecentMessages(
        10,
        {
          id: '0-3585',
          name: 'int2024',
          type: 'private',
          unread: false,
        },
        undefined,
        5761
      );

      expect(messages).toHaveLength(2);
      expect(messages[0]?.sender).toBe('int2024');
      expect(messages[0]?.content).toBe('私聊问题咨询');
      expect(messages[0]?.sessionName).toBe('int2024');
      expect(messages[0]?.sessionType).toBe('private');

      expect(messages[1]?.isMe).toBe(true);
      expect(messages[1]?.content).toBe('收到，正在核实');
    });

    it('应在群聊会话 测试123 中提取包含 @提及 与 图片附件的消息', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('targetSession')) {
            return Promise.resolve({
              sessionID: 793803,
              maxMsgIdx: 55,
              sesUUID: '1-29467',
              name: '测试123',
              type: 1,
            });
          }
          if (script.includes('getMessages')) {
            return Promise.resolve({
              code: 0,
              data: [
                {
                  id: 2001,
                  msgIdx: 55,
                  sender: 7783,
                  senderName: '陈鹏',
                  atState: 2,
                  atMemberIDList: [5761],
                  contentType: 4,
                  content: {
                    content: [
                      { type: 2, replyMemberID: 5761, replyMemberName: '董仕林' },
                      { type: 0, text: '请查看当前附件图片' },
                      { type: 1, filepath: 'C:\\cache\\img1.png', mimetype: 'image/png' },
                    ],
                  },
                  sendTime: 1788143000,
                },
              ],
            });
          }
          return Promise.resolve(null);
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const messages = await ops.getRecentMessages(
        10,
        { id: '1-29467', name: '测试123', type: 'group', unread: false },
        undefined,
        5761
      );

      expect(messages).toHaveLength(1);
      expect(messages[0]?.sender).toBe('陈鹏');
      expect(messages[0]?.sessionType).toBe('group');
      expect(messages[0]?.atMe).toBe(true);
      expect(messages[0]?.images).toHaveLength(1);
      expect(messages[0]?.images?.[0]?.filePath).toBe('C:\\cache\\img1.png');
    });
  });

  describe('消息发送与防串线校验', () => {
    it('向私聊 int2024 发送纯文本', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('checkPreSendState') || script.includes('expected')) {
            return Promise.resolve({ canSend: true });
          }
          return Promise.resolve({ success: true });
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendText('测试私聊文本发送', { targetSessionId: '0-3585' });

      expect(res.success).toBe(true);
      expect(res.verifyLatencyMs).toBeDefined();
    });

    it('向群聊 测试123 发送富文本并携带 @全体成员', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('expected')) {
            return Promise.resolve({ canSend: true });
          }
          return Promise.resolve({ success: true });
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendRichText('**群聊公告通知**', {
        targetSessionId: '1-29467',
        mentions: ['all'],
      });

      expect(res.success).toBe(true);
    });

    it('当指定目标会话不存在时应被防串线安全拦截 (Fail-Closed)', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({
          success: false,
          error: '未在会话列表中找到目标会话 [0-3585]',
          isPreTrigger: true,
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendText('绝密消息', { targetSessionId: '0-3585' });

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('未在会话列表中找到目标会话');
    });

    it('向群聊 测试123 发送引用回复 (Reply)', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('expected')) return Promise.resolve({ canSend: true });
          return Promise.resolve({ success: true, method: 'vue_native_reply' });
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendReply(
        { messageId: '2001', sender: '陈鹏', content: '原始讨论' },
        '收到回复',
        { targetSessionId: '1-29467' }
      );

      expect(res.success).toBe(true);
    });

    it('发送文件时校验不存在的路径应立即返回 pre-trigger 失败', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendFile('D:\\non_existent_file.pdf');

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('文件不存在');
    });

    it('发送本地图片应进行格式检查与剪贴板模拟', async () => {
      const tmpFile = path.resolve('tmp', 'test-bridge-img.png');
      if (!fs.existsSync(path.resolve('tmp'))) fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));

      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockResolvedValue({ success: true }),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendImage(tmpFile);

      expect(res.success).toBe(true);
      expect(mockCdp.bringToFront).toHaveBeenCalledOnce();
      expect(mockCdp.dispatchKeyEvent).toHaveBeenCalledTimes(2);

      try {
        fs.unlinkSync(tmpFile);
      } catch {
        // 忽略清理错误
      }
    });
  });

  describe('发送事务失败边界', () => {
    it('sendMessageNew 超时后不得把未知结果报告为成功', async () => {
      vi.useFakeTimers();
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: 1001, msgIdx: 10 } };
        }
        return NO_IPC_RESPONSE;
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const pending = new BridgeMessageOps(mockCdp).sendText('超时测试', {
        targetSessionId: '0-3585',
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(false);
    });

    it('ipc.send 抛错后必须移除本次 reply listener', async () => {
      const ipc = new FakeIpcRenderer(() => {
        throw new Error('ipc send failed');
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('发送异常', {
        targetSessionId: '0-3585',
      });
      const request = ipc.sent[0];

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(request).toBeDefined();
      expect(ipc.listenerCount(`data-${request?.id}`)).toBe(0);
    });

    it('IPC timeout 只移除本次 listener，不清空同 channel 的其他监听器', async () => {
      vi.useFakeTimers();
      const ipc = new FakeIpcRenderer(() => NO_IPC_RESPONSE);
      const unrelatedListener = vi.fn();
      ipc.once('data-800001', unrelatedListener);
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const pending = new BridgeMessageOps(mockCdp).sendText('超时监听器清理', {
        targetSessionId: '0-3585',
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(false);
      expect(ipc.listenerCount('data-800001')).toBe(1);
      expect(unrelatedListener).not.toHaveBeenCalled();
    });

    it('引用回复的 sendMessageNew 超时不得报告成功', async () => {
      vi.useFakeTimers();
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: 1002, msgIdx: 11 } };
        }
        return NO_IPC_RESPONSE;
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const pending = new BridgeMessageOps(mockCdp).sendReply(
        { messageId: '900', sender: '员工', content: '原消息' },
        '回复内容',
        { targetSessionId: '0-3585' }
      );
      await Promise.resolve();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(false);
    });

    it('文件的 sendMessageNew 超时不得报告成功', async () => {
      vi.useFakeTimers();
      const tmpFile = path.resolve('tmp', 'test-native-send-timeout.txt');
      if (!fs.existsSync(path.resolve('tmp'))) fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, 'timeout');
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: 1003, msgIdx: 12 } };
        }
        return NO_IPC_RESPONSE;
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const pending = new BridgeMessageOps(mockCdp).sendFile(tmpFile, {
          targetSessionId: '0-3585',
        });
        await Promise.resolve();
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.success).toBe(false);
        expect(result.isPreTrigger).toBe(false);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('CDP evaluate 结果未知时不得声明尚未触发', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockRejectedValue(new Error('Runtime.evaluate timeout')),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('未知状态测试');

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(false);
    });

    it('并发发送的 IPC 请求 ID 必须全局唯一', async () => {
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: request.id, msgIdx: request.id } };
        }
        return { code: 0 };
      });
      const deterministicMath = Object.assign(Object.create(Math) as Math, {
        random: () => 0,
      });
      const runtime = createRendererRuntime({
        ipc,
        math: deterministicMath,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;
      const ops = new BridgeMessageOps(mockCdp);

      const results = await Promise.all([
        ops.sendText('并发消息 A', { targetSessionId: '0-3585' }),
        ops.sendText('并发消息 B', { targetSessionId: '0-3585' }),
      ]);
      const requestIds = ipc.sent.map(request => request.id);

      expect(results.every(result => result.success)).toBe(true);
      expect(requestIds).toHaveLength(4);
      expect(new Set(requestIds).size).toBe(requestIds.length);
    });

    it('图片目标会话不存在时不得操作剪贴板、键盘或发送按钮', async () => {
      vi.useFakeTimers();
      const tmpFile = path.resolve('tmp', 'test-bridge-invalid-target.png');
      if (!fs.existsSync(path.resolve('tmp'))) fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const clipboardWrite = vi.fn().mockResolvedValue(undefined);
      const onSendClick = vi.fn();
      const runtime = createRendererRuntime({
        sessions: [
          { id: 793803, sesUUID: '1-29467', typeName: '当前群聊', type: 1, typeID: 29467 },
        ],
        clipboardWrite,
        onSendClick,
      });
      const dispatchKeyEvent = vi.fn().mockResolvedValue(undefined);
      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
        dispatchKeyEvent,
      } as unknown as CdpClient;

      try {
        const pending = new BridgeMessageOps(mockCdp).sendImage(tmpFile, {
          targetSessionId: '0-3585',
        });
        await Promise.resolve();
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.success).toBe(false);
        expect(result.isPreTrigger).toBe(true);
        expect(clipboardWrite).not.toHaveBeenCalled();
        expect(dispatchKeyEvent).not.toHaveBeenCalled();
        expect(onSendClick).not.toHaveBeenCalled();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('文本指定目标但会话列表不可用时必须 Fail-Closed', async () => {
      const ipc = new FakeIpcRenderer(() => ({ code: 0, data: { id: 1004, msgIdx: 13 } }));
      const activeSession = {
        id: 793803,
        sesUUID: '1-29467',
        typeName: '当前会话',
        type: 1,
        typeID: 29467,
      };
      const runtime = createRendererRuntime({ ipc, sessions: [activeSession], activeSession });
      (runtime.editor as { sortedSessions?: unknown }).sortedSessions = undefined;
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('不得串线', {
        targetSessionId: '0-3585',
      });

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(ipc.sent).toHaveLength(0);
    });

    it('回复指定目标但会话列表不可用时必须 Fail-Closed', async () => {
      const ipc = new FakeIpcRenderer(() => ({ code: 0, data: { id: 1005, msgIdx: 14 } }));
      const activeSession = {
        id: 793803,
        sesUUID: '1-29467',
        typeName: '当前会话',
        type: 1,
        typeID: 29467,
      };
      const runtime = createRendererRuntime({ ipc, sessions: [activeSession], activeSession });
      (runtime.editor as { sortedSessions?: unknown }).sortedSessions = undefined;
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendReply(
        { messageId: '900', sender: '员工', content: '原消息' },
        '不得串线',
        { targetSessionId: '0-3585' }
      );

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(ipc.sent).toHaveLength(0);
    });

    it('文件指定目标但会话列表不可用时必须 Fail-Closed', async () => {
      const tmpFile = path.resolve('tmp', 'test-missing-session-list.txt');
      if (!fs.existsSync(path.resolve('tmp'))) fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, 'target guard');
      const ipc = new FakeIpcRenderer(() => ({ code: 0, data: { id: 1006, msgIdx: 15 } }));
      const activeSession = {
        id: 793803,
        sesUUID: '1-29467',
        typeName: '当前会话',
        type: 1,
        typeID: 29467,
      };
      const runtime = createRendererRuntime({ ipc, sessions: [activeSession], activeSession });
      (runtime.editor as { sortedSessions?: unknown }).sortedSessions = undefined;
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendFile(tmpFile, {
          targetSessionId: '0-3585',
        });

        expect(result.success).toBe(false);
        expect(result.isPreTrigger).toBe(true);
        expect(ipc.sent).toHaveLength(0);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('发送目标名称只部分匹配会话时必须拒绝', async () => {
      const ipc = new FakeIpcRenderer(() => ({ code: 0, data: { id: 1007, msgIdx: 16 } }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 793803, sesUUID: '1-29467', typeName: '项目群一', name: '项目群一', type: 1 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('精确目标测试', {
        targetSessionId: '项目群',
      });

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(ipc.sent).toHaveLength(0);
    });
  });

  describe('目标会话身份优先级', () => {
    const targetSessionId = '1-29467';
    const createShadowedSessions = () => [
      { id: 7, sesUUID: 'shadow', typeName: targetSessionId, name: targetSessionId, type: 1 },
      { id: 8, sesUUID: targetSessionId, typeName: '真实目标', name: '真实目标', type: 1 },
    ];
    const createSuccessfulIpc = () =>
      new FakeIpcRenderer(request =>
        request.args[0] === 'insertSendBefoeMsg'
          ? { code: 0, data: { id: request.id, msgIdx: request.id } }
          : { code: 0 }
      );

    it('文本发送必须让 sesUUID/id 命中优先于更早出现的同名会话', async () => {
      const ipc = createSuccessfulIpc();
      const runtime = createRendererRuntime({ ipc, sessions: createShadowedSessions() });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('ID 优先', { targetSessionId });
      const insertRequest = ipc.sent.find(request => request.args[0] === 'insertSendBefoeMsg');

      expect(result.success).toBe(true);
      expect(insertRequest?.args[1]).toMatchObject({ sessionID: 8 });
    });

    it('回复发送必须让 sesUUID/id 命中优先于更早出现的同名会话', async () => {
      const ipc = createSuccessfulIpc();
      const runtime = createRendererRuntime({ ipc, sessions: createShadowedSessions() });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendReply(
        { messageId: '900', sender: '员工', content: '原消息' },
        'ID 优先',
        { targetSessionId }
      );
      const insertRequest = ipc.sent.find(request => request.args[0] === 'insertSendBefoeMsg');

      expect(result.success).toBe(true);
      expect(insertRequest?.args[1]).toMatchObject({ sessionID: 8 });
    });

    it('文件发送必须让 sesUUID/id 命中优先于更早出现的同名会话', async () => {
      const tmpFile = path.resolve('tmp', 'test-id-priority.txt');
      if (!fs.existsSync(path.resolve('tmp'))) fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, 'id priority');
      const ipc = createSuccessfulIpc();
      const runtime = createRendererRuntime({ ipc, sessions: createShadowedSessions() });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendFile(tmpFile, { targetSessionId });
        const insertRequest = ipc.sent.find(request => request.args[0] === 'insertSendBefoeMsg');

        expect(result.success).toBe(true);
        expect(insertRequest?.args[1]).toMatchObject({ sessionID: 8 });
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('图片发送必须让 sesUUID/id 命中优先于更早出现的同名会话', async () => {
      vi.useFakeTimers();
      const tmpFile = path.resolve('tmp', 'test-image-id-priority.png');
      if (!fs.existsSync(path.resolve('tmp'))) fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      const runtime = createRendererRuntime({ sessions: createShadowedSessions() });
      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      try {
        const pending = new BridgeMessageOps(mockCdp).sendImage(tmpFile, { targetSessionId });
        await Promise.resolve();
        await vi.runAllTimersAsync();
        const result = await pending;

        expect(result.success).toBe(true);
        expect(runtime.editor.activedSes?.id).toBe(8);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('名称匹配不唯一且没有 ID 命中时必须 Fail-Closed', async () => {
      const ipc = createSuccessfulIpc();
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 7, sesUUID: 'first', typeName: '重复会话', name: '重复会话', type: 1 },
          { id: 8, sesUUID: 'second', typeName: '重复会话', name: '重复会话', type: 1 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('名称歧义', {
        targetSessionId: '重复会话',
      });

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(ipc.sent).toHaveLength(0);
    });
  });

  describe('recallMessage 消息撤回', () => {
    it('通过 IPC cancelMessage 撤回目标消息并派发 revokeMsg', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const ok = await ops.recallMessage('1002', '0-3585');

      expect(ok).toBe(true);
      expect(mockCdp.evaluate).toHaveBeenCalledOnce();
    });

    it('撤回目标会话必须让 sesUUID/id 命中优先于更早出现的同名会话', async () => {
      const targetSessionId = '1-29467';
      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 7, sesUUID: 'shadow', typeName: targetSessionId, name: targetSessionId, type: 1 },
          { id: 8, sesUUID: targetSessionId, typeName: '真实目标', name: '真实目标', type: 1 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 8 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', targetSessionId);
      const cancelRequest = ipc.sent.find(request => request.args[0] === 'cancelMessage');

      expect(ok).toBe(true);
      expect(cancelRequest?.args[1]).toMatchObject({ sessionID: 8, msgID: 123 });
    });

    it('目标 123 不得被可见消息 23 子串劫持', async () => {
      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
        messages: [{ id: 23, msgIdx: 7, sessionID: 602475 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-3585');
      const cancelRequest = ipc.sent.find(request => request.args[0] === 'cancelMessage');

      expect(ok).toBe(true);
      expect(cancelRequest?.args[1]).toMatchObject({
        sessionID: 602475,
        msgID: 123,
      });
    });

    it('native 撤回未返回成功 ack 时不得仅靠本地事件宣称成功', async () => {
      const ipc = new FakeIpcRenderer(() => ({}));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 602475 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-3585');

      expect(ok).toBe(false);
      expect(runtime.events).toHaveLength(0);
    });

    it('Bridge 撤回 ipc.send 抛错后必须移除本次 listener', async () => {
      const ipc = new FakeIpcRenderer(() => {
        throw new Error('recall send failed');
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 602475 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-3585');
      const request = ipc.sent[0];

      expect(ok).toBe(false);
      expect(request).toBeDefined();
      expect(ipc.listenerCount(`data-${request?.id}`)).toBe(0);
    });

    it('缺少 ipcRenderer 时不得以 bus-only 撤回作为成功', async () => {
      const runtime = createRendererRuntime({
        sessions: [
          { id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 },
        ],
        messages: [{ id: 123, msgIdx: 8, sessionID: 602475 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const ok = await new BridgeMessageOps(mockCdp).recallMessage('123', '0-3585');

      expect(ok).toBe(false);
      expect(runtime.events).toHaveLength(0);
    });
  });
});
