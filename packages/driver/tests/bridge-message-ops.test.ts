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
import {
  InMemorySendOperationStore,
  createSendOperationFingerprint,
} from '../src/send-operation.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';

describe('BridgeMessageOps 纯数据消息操作测试', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('原生发送键长度约束', () => {
    it('保留已有64字符合法键并压缩超长和中文操作ID', () => {
      const boundaryId = 'a'.repeat(64 - 'kairo:operation:'.length);
      expect(createNativeMessageKey('text', boundaryId)).toBe(`kairo:operation:${boundaryId}`);
      for (const operationId of [
        `${boundaryId}b`,
        't12-real-readonly-317612f3-37ca-49c6-bb46-703b9f7ca1b5',
        '中文任务/'.repeat(100),
      ]) {
        expect(
          Buffer.byteLength(createNativeMessageKey('text', operationId), 'utf8')
        ).toBeLessThanOrEqual(64);
      }
    });

    it('摘要键不包含会被原生历史过滤的C或c', () => {
      const operationId = `t12-flag-history-1788740170841-${'x'.repeat(50)}-6`;
      expect(createNativeMessageKey('text', operationId)).not.toMatch(/[Cc]/);
    });

    it('超长操作ID保持稳定且不丢弃尾部差异', () => {
      const prefix = '共同前缀'.repeat(100);
      const first = createNativeMessageKey('text', `${prefix}甲`);
      expect(createNativeMessageKey('text', ` ${prefix}甲 `)).toBe(first);
      expect(createNativeMessageKey('image', `${prefix}甲`)).toBe(first);
      expect(createNativeMessageKey('text', `${prefix}乙`)).not.toBe(first);
    });

    it('五类新消息的无 operationId 随机关联键均避开 C/c', () => {
      for (const kind of ['url-card', 'biz-message', 'app-message', 'chat-record', 'voice']) {
        const key = createNativeMessageKey(kind);
        expect(key).not.toMatch(/[Cc]/);
        expect(Buffer.byteLength(key)).toBeLessThanOrEqual(64);
        expect(createNativeMessageKey(kind)).not.toBe(key);
      }
    });

    it('新消息的短含 c 操作 ID 使用安全稳定键，不改变旧类型回查键', () => {
      const operationId = 'task-complete-001';
      for (const kind of ['url-card', 'biz-message', 'app-message', 'chat-record', 'voice']) {
        const key = createNativeMessageKey(kind, operationId);
        expect(key).not.toMatch(/[Cc]/);
        expect(Buffer.byteLength(key)).toBeLessThanOrEqual(64);
        expect(createNativeMessageKey(kind, ` ${operationId} `)).toBe(key);
        expect(createNativeMessageKey(kind, 'task-Complete-001')).not.toBe(key);
      }
      expect(createNativeMessageKey('text', operationId)).toBe('kairo:operation:task-complete-001');
    });
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
                  senderName: '张三',
                  atState: 2,
                  atMemberIDList: [5761],
                  contentType: 4,
                  content: {
                    content: [
                      { type: 2, replyMemberID: 5761, replyMemberName: '测试用户' },
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
      expect(messages[0]?.sender).toBe('张三');
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
      expect(res.status).toBe('unknown');
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
        { messageId: '2001', sender: '张三', content: '原始讨论' },
        '收到回复',
        { targetSessionId: '1-29467' }
      );

      expect(res.success).toBe(true);
    });

    it('发送本地图片应进行格式检查与尺寸解析，通过底层 IPC 成功发送', async () => {
      const tmpFile = path.resolve('tmp', 'test-bridge-img.png');
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M9QzwAEjDAGBhAFAFcaAQXw22J4AAAAAElFTkSuQmCC',
          'base64'
        )
      );

      let msgFlag = '';
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'sendingImgBeforeHandle') {
          return { code: 0, data: { thumbPath: 'C:\\thumb.png', artworkPath: 'C:\\art.png' } };
        }
        if (method === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          const rawMsgFlag = message['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...message, id: 1002, msgIdx: 20 } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000088, msgIdx: 20, msgFlag }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const ops = new BridgeMessageOps(mockCdp);
        const res = await ops.sendImage(tmpFile, { targetSessionId: '0-3585' });

        expect(res.success).toBe(true);
        expect(res.status).toBe('delivered');
        expect(res.messageId).toBe('135000088');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
    it('图片 legacy 成功缺少原生 ID 时保留成功语义', async () => {
      const tmpFile = path.resolve('tmp', 't07-legacy-image-no-id.png');
      if (!fs.existsSync(path.dirname(tmpFile)))
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({ success: true }),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile);

        expect(result).toMatchObject({ success: true, status: 'unknown' });
        expect(result.messageId).toBeUndefined();
        expect(result.isPreTrigger).toBeUndefined();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('图片 legacy 完整成功结果字段原样保留', async () => {
      const tmpFile = path.resolve('tmp', 't07-legacy-image-fields-success.png');
      if (!fs.existsSync(path.dirname(tmpFile)))
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      const legacyResult = {
        success: true,
        status: 'failed',
        messageId: 'legacy-success-message',
        error: 'legacy warning',
        isPreTrigger: true,
      };
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue(legacyResult),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile);

        expect(result).toMatchObject(legacyResult);
        expect(result.verifyLatencyMs).toBeDefined();
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('图片 legacy 完整失败结果字段原样保留', async () => {
      const tmpFile = path.resolve('tmp', 't07-legacy-image-fields-failure.png');
      if (!fs.existsSync(path.dirname(tmpFile)))
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      const legacyResult = {
        success: false,
        status: 'unknown',
        messageId: 'legacy-failure-message',
        error: 'legacy failure',
        isPreTrigger: true,
      };
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue(legacyResult),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile);

        expect(result).toMatchObject(legacyResult);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('图片 legacy 插入无 data 时保留触发前失败语义', async () => {
      const tmpFile = path.resolve('tmp', 't07-legacy-image-no-data.png');
      if (!fs.existsSync(path.dirname(tmpFile)))
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'sendingImgBeforeHandle') {
          return { code: 0, data: { thumbPath: 'C:\\thumb.png', artworkPath: 'C:\\art.png' } };
        }
        if (method === 'insertSendBefoeMsg') return { code: 0 };
        return { code: 1 };
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile, {
          targetSessionId: '0-3585',
        });

        expect(result).toMatchObject({
          success: false,
          status: 'failed',
          isPreTrigger: true,
        });
        expect(ipc.sent.map(request => request.args[0])).toEqual([
          'sendingImgBeforeHandle',
          'insertSendBefoeMsg',
        ]);
      } finally {
        fs.unlinkSync(tmpFile);
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
        if (request.args[0] === 'getMessages') {
          return {
            code: 0,
            data: [
              {
                id: 900,
                msgIdx: 9,
                sender: 3705,
                senderName: '员工',
                contentType: 4,
                content: { content: [{ type: 0, text: '原消息' }] },
              },
            ],
          };
        }
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: 1002, msgIdx: 11 } };
        }
        return NO_IPC_RESPONSE;
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, 'timeout');
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: 1003, msgIdx: 12 } };
        }
        return NO_IPC_RESPONSE;
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
      const persisted: Array<Record<string, unknown>> = [];
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          persisted.push({
            id: 135000100 + persisted.length,
            msgIdx: 100 + persisted.length,
            msgFlag: message['msgFlag'],
          });
          return { code: 0, data: { ...message, id: -22, msgIdx: '1.001' } };
        }
        if (request.args[0] === 'sendMessageNew') return { code: 0 };
        if (request.args[0] === 'getMessages') return { code: 0, data: persisted };
        return { code: 1 };
      });
      const deterministicMath = Object.assign(Object.create(Math) as Math, {
        random: () => 0,
      });
      const runtime = createRendererRuntime({
        ipc,
        math: deterministicMath,
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
      expect(requestIds).toHaveLength(6);
      expect(new Set(requestIds).size).toBe(requestIds.length);
    });

    it('图片目标会话不存在时必须 Fail-Closed', async () => {
      const tmpFile = path.resolve('tmp', 'test-bridge-invalid-target.png');
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [
          { id: 793803, sesUUID: '1-29467', typeName: '当前群聊', type: 1, typeID: 29467 },
        ],
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile, {
          targetSessionId: '0-3585',
        });

        expect(result.success).toBe(false);
        expect(result.isPreTrigger).toBe(true);
        expect(ipc.sent).toHaveLength(0);
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
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
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

  describe('真实 native 消息身份确认', () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      name: 'int2024',
      type: 0,
      typeID: 3585,
    };

    it('文本发送必须通过 msgFlag 返回落库后的真实正 ID', async () => {
      let msgFlag = '';
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          const rawMsgFlag = message['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...message, id: -22, msgIdx: '1.001' } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000001, msgIdx: 2, msgFlag }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('真实 ID', {
        targetSessionId: session.sesUUID,
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('135000001');
      expect(msgFlag).not.toBe('');
    });

    it('回复发送必须读取目标原始元数据并返回真实正 ID', async () => {
      let inserted = false;
      let msgFlag = '';
      let insertedMessage: Record<string, unknown> | undefined;
      const targetMessage = {
        id: 135000010,
        msgIdx: 9,
        sender: 3705,
        senderName: 'int2024',
        senderNameEN: 'int2024',
        senderNameTC: 'int2024',
        contentType: 4,
        content: { content: [{ type: 0, text: '原消息' }] },
      };
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'getMessages' && !inserted) return { code: 0, data: [targetMessage] };
        if (method === 'insertSendBefoeMsg') {
          inserted = true;
          insertedMessage = request.args[1] as Record<string, unknown>;
          const rawMsgFlag = insertedMessage['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...insertedMessage, id: -22, msgIdx: '10.001' } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000011, msgIdx: 11, msgFlag }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendReply(
        { messageId: String(targetMessage.id) },
        '真实回复',
        { targetSessionId: session.sesUUID }
      );
      const replyContent = insertedMessage?.['content'] as Record<string, unknown> | undefined;

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('135000011');
      expect(replyContent).toMatchObject({
        replyedID: 3705,
        replyedMsgId: 135000010,
        replyedMsgIndex: 9,
        replyedContentType: 4,
      });
    });

    it('回复带 msgIdx 时必须精确查询窗口外原消息', async () => {
      let inserted = false;
      let msgFlag = '';
      let exactQueryArgs: unknown[] | undefined;
      let insertedMessage: Record<string, unknown> | undefined;
      const targetMessage = {
        id: 123307983,
        msgIdx: 1,
        sender: 3705,
        senderName: 'int2024',
        contentType: 4,
        content: JSON.stringify({ content: [{ type: 0, text: '窗口外原消息' }] }),
      };
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'getMessageBySessionIDAndMsgIdx') {
          exactQueryArgs = request.args.slice(1);
          return { code: 0, data: [targetMessage] };
        }
        if (method === 'getMessages' && !inserted) return { code: 0, data: [] };
        if (method === 'insertSendBefoeMsg') {
          inserted = true;
          const message = request.args[1] as Record<string, unknown>;
          insertedMessage = message;
          const rawMsgFlag = message['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...message, id: -22, msgIdx: '2.001' } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000021, msgIdx: 2, msgFlag }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendReply(
        { messageId: String(targetMessage.id), msgIdx: targetMessage.msgIdx },
        '回复窗口外消息',
        { targetSessionId: session.sesUUID }
      );

      const insertedContent = insertedMessage?.['content'] as Record<string, unknown> | undefined;
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('135000021');
      expect(exactQueryArgs).toEqual([session.id, targetMessage.msgIdx]);
      expect(insertedContent?.['replyedContent']).toEqual({
        content: [{ type: 0, text: '窗口外原消息' }],
      });
    });

    it('回复仅有 messageId 时必须有界分页查找旧消息', async () => {
      let inserted = false;
      let historyPageCalls = 0;
      let msgFlag = '';
      const targetMessage = {
        id: 123307983,
        msgIdx: 1,
        sender: 3705,
        senderName: 'int2024',
        contentType: 4,
        content: { content: [{ type: 0, text: '第二页原消息' }] },
      };
      const firstPage = Array.from({ length: 200 }, (_, index) => ({
        id: 200000000 + index,
        msgIdx: 201 + index,
        contentType: 4,
        content: { content: [{ type: 0, text: `第一页${index}` }] },
      }));
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'getMessages' && !inserted) {
          historyPageCalls += 1;
          return historyPageCalls === 1
            ? { code: 0, data: firstPage }
            : { code: 0, data: [targetMessage] };
        }
        if (method === 'insertSendBefoeMsg') {
          inserted = true;
          const message = request.args[1] as Record<string, unknown>;
          const rawMsgFlag = message['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...message, id: -22, msgIdx: '2.001' } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000023, msgIdx: 2, msgFlag }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendReply(
        { messageId: String(targetMessage.id) },
        '分页回复旧消息',
        { targetSessionId: session.sesUUID }
      );

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('135000023');
      expect(historyPageCalls).toBe(2);
    });

    it('文件发送必须等待落库并返回真实正 ID', async () => {
      const tmpFile = path.resolve('tmp', 'test-confirmed-file-id.txt');
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, 'confirmed file id');
      let msgFlag = '';
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          const rawMsgFlag = message['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...message, id: -22, msgIdx: '12.001' } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000013, msgIdx: 13, msgFlag }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendFile(tmpFile, {
          targetSessionId: session.sesUUID,
        });

        expect(result.success).toBe(true);
        expect(result.messageId).toBe('135000013');
        expect(msgFlag).not.toBe('');
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });
  });

  describe('目标会话身份优先级', () => {
    const targetSessionId = '1-29467';
    const createShadowedSessions = () => [
      { id: 7, sesUUID: 'shadow', typeName: targetSessionId, name: targetSessionId, type: 1 },
      { id: 8, sesUUID: targetSessionId, typeName: '真实目标', name: '真实目标', type: 1 },
    ];
    const createSuccessfulIpc = () => {
      const persisted: Array<Record<string, unknown>> = [];
      return new FakeIpcRenderer(request => {
        if (request.args[0] === 'sendingImgBeforeHandle') {
          return { code: 0, data: { thumbPath: 'C:\\thumb.png', artworkPath: 'C:\\art.png' } };
        }
        if (request.args[0] === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          persisted.push({
            id: 135100000 + persisted.length,
            msgIdx: 100 + persisted.length,
            msgFlag: message['msgFlag'],
          });
          return { code: 0, data: { ...message, id: -22, msgIdx: '1.001' } };
        }
        if (request.args[0] === 'sendMessageNew') return { code: 0 };
        if (request.args[0] === 'getMessages') {
          return {
            code: 0,
            data: [
              {
                id: 900,
                msgIdx: 9,
                sender: 3705,
                senderName: '员工',
                contentType: 4,
                content: { content: [{ type: 0, text: '原消息' }] },
              },
              ...persisted,
            ],
          };
        }
        return { code: 1 };
      });
    };

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
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
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
      const tmpFile = path.resolve('tmp', 'test-image-id-priority.png');
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );
      const ipc = createSuccessfulIpc();
      const runtime = createRendererRuntime({ ipc, sessions: createShadowedSessions() });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile, { targetSessionId });
        const insertRequest = ipc.sent.find(request => request.args[0] === 'insertSendBefoeMsg');

        expect(result.success).toBe(true);
        expect(insertRequest?.args[1]).toMatchObject({ sessionID: 8 });
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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
        sessions: [{ id: 602475, sesUUID: '0-3585', typeName: 'int2024', type: 0, typeID: 3585 }],
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

  describe('发送者身份校验 Fail-Closed (无固定账号兜底)', () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      name: 'int2024',
      type: 0,
      typeID: 3585,
    };

    it('文本发送在无有效 userID 时必须明确失败 (isPreTrigger: true)，且不调用任何发送 IPC', async () => {
      const ipc = new FakeIpcRenderer(() => ({ code: 0, data: { id: 1001, msgIdx: 1 } }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [session],
        main: { userID: undefined, userName: undefined },
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('测试无身份发送', {
        targetSessionId: session.sesUUID,
      });

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(result.error).toContain('未获取到当前登录用户身份');
      expect(ipc.sent).toHaveLength(0);
    });

    it('引用回复在无有效 userID 时必须明确失败 (isPreTrigger: true)，且不执行消息插入和发送', async () => {
      const targetMessage = {
        id: 135000010,
        msgIdx: 9,
        sender: 3705,
        senderName: 'int2024',
        contentType: 4,
        content: { content: [{ type: 0, text: '原消息' }] },
      };
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMessages') return { code: 0, data: [targetMessage] };
        return { code: 0 };
      });
      const runtime = createRendererRuntime({
        ipc,
        sessions: [session],
        main: { userID: undefined, userName: undefined },
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendReply(
        { messageId: '135000010' },
        '测试无身份回复',
        { targetSessionId: session.sesUUID }
      );

      expect(result.success).toBe(false);
      expect(result.isPreTrigger).toBe(true);
      expect(result.error).toContain('未获取到当前登录用户身份');
      const insertOrSendCalls = ipc.sent.filter(
        req => req.args[0] === 'insertSendBefoeMsg' || req.args[0] === 'sendMessageNew'
      );
      expect(insertOrSendCalls).toHaveLength(0);
    });

    it('文件发送在无有效 userID 时必须明确失败 (isPreTrigger: true)，且不执行消息插入和发送', async () => {
      const tmpFile = path.resolve('tmp', 'test-no-user-id-file.txt');
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(tmpFile, 'no user id content');

      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [session],
        main: { userID: null, userName: null },
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendFile(tmpFile, {
          targetSessionId: session.sesUUID,
        });

        expect(result.success).toBe(false);
        expect(result.isPreTrigger).toBe(true);
        expect(result.error).toContain('未获取到当前登录用户身份');
        expect(ipc.sent).toHaveLength(0);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('图片发送在无有效 userID 时必须明确失败 (isPreTrigger: true)，且不调用 sendingImgBeforeHandle 及发送 RPC', async () => {
      const tmpFile = path.resolve('tmp', 'test-no-user-id-img.png');
      if (!fs.existsSync(path.resolve('tmp')))
        fs.mkdirSync(path.resolve('tmp'), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const ipc = new FakeIpcRenderer(() => ({ code: 0 }));
      const runtime = createRendererRuntime({
        ipc,
        sessions: [session],
        main: null,
      });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      try {
        const result = await new BridgeMessageOps(mockCdp).sendImage(tmpFile, {
          targetSessionId: session.sesUUID,
        });

        expect(result.success).toBe(false);
        expect(result.isPreTrigger).toBe(true);
        expect(result.error).toContain('未获取到当前登录用户身份');
        expect(ipc.sent).toHaveLength(0);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('有效身份来自 editor.userID 时应成功读取并作为 sender 构造消息', async () => {
      let insertedMessage: Record<string, unknown> | undefined;
      let msgFlag = '';
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          insertedMessage = request.args[1] as Record<string, unknown>;
          const rawMsgFlag = insertedMessage['msgFlag'];
          msgFlag = typeof rawMsgFlag === 'string' ? rawMsgFlag : '';
          return { code: 0, data: { ...insertedMessage, id: 1009, msgIdx: 2 } };
        }
        if (request.args[0] === 'sendMessageNew') return { code: 0 };
        if (request.args[0] === 'getMessages') {
          return { code: 0, data: [{ id: 135000099, msgIdx: 2, msgFlag }] };
        }
        return { code: 1 };
      });

      const runtime = createRendererRuntime({
        ipc,
        sessions: [session],
        main: null,
      });
      // 模拟主页面无 main，但 editor 挂载了当前用户 8888
      (runtime.editor as Record<string, unknown>)['userID'] = 8888;
      (runtime.editor as Record<string, unknown>)['userName'] = '客服代表';

      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp).sendText('来自 editor 身份测试', {
        targetSessionId: session.sesUUID,
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe('135000099');
      expect(insertedMessage?.['sender']).toBe(8888);
      expect(insertedMessage?.['senderName']).toBe('客服代表');
    });
  });
  describe('发送操作 ID 的三态与只读查询', () => {
    const session = {
      id: 602475,
      sesUUID: '0-3585',
      typeName: 'int2024',
      name: 'int2024',
      type: 0,
      typeID: 3585,
    };

    it('插入前失败写入确定失败状态且允许安全重试', async () => {
      const store = new InMemorySendOperationStore();
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 1, error: 'insert rejected' };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).sendText('插入前失败', {
        targetSessionId: session.sesUUID,
        operationId: 'op-insert-failed',
      });

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-insert-failed',
        status: 'failed',
        isPreTrigger: true,
      });
      expect(await store.get('op-insert-failed')).toMatchObject({
        status: 'failed',
        isPreTrigger: true,
      });
      expect(ipc.sent.map(request => request.args[0])).toEqual(['insertSendBefoeMsg']);
    });
    it('插入返回成功但缺少原生数据时保持未知状态', async () => {
      const store = new InMemorySendOperationStore();
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') return { code: 0 };
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).sendText('插入无数据', {
        targetSessionId: session.sesUUID,
        operationId: 'op-insert-no-data',
      });

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-insert-no-data',
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(ipc.sent.map(request => request.args[0])).toEqual(['insertSendBefoeMsg']);
    });
    it('空白发送操作 ID 必须在发送前拒绝且不产生查询', async () => {
      const store = new InMemorySendOperationStore();
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new BridgeMessageOps(mockCdp, store);

      await expect(
        ops.sendText('空白 operationId', {
          targetSessionId: session.sesUUID,
          operationId: '   ',
        })
      ).rejects.toThrow('operationId 不能为空');
      expect(mockCdp.evaluate).not.toHaveBeenCalled();
      expect(await store.get('')).toBeNull();
    });

    it('插入后响应丢失返回未知状态，查询可识别已存在的原生消息', async () => {
      vi.useFakeTimers();
      const store = new InMemorySendOperationStore();
      let insertedMessage: Record<string, unknown> | undefined;
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          insertedMessage = { id: 135000201, msgFlag: message['msgFlag'] };
          return NO_IPC_RESPONSE;
        }
        if (method === 'getMessages') {
          return { code: 0, data: insertedMessage ? [insertedMessage] : [] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const pending = new BridgeMessageOps(mockCdp, store).sendText('插入响应丢失', {
        operationId: 'op-insert-lost',
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-insert-lost',
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(await store.get('op-insert-lost')).toMatchObject({
        status: 'unknown',
        fingerprint: { targetSessionId: session.sesUUID },
      });

      const status = await new BridgeMessageOps(mockCdp, store).getSendStatus('op-insert-lost');
      expect(status).toMatchObject({
        success: true,
        operationId: 'op-insert-lost',
        status: 'delivered',
        messageId: '135000201',
      });
    });
    it('显式空白目标会话必须拒绝且不得改投当前会话', async () => {
      const store = new InMemorySendOperationStore();
      const ipc = new FakeIpcRenderer(() => {
        throw new Error('不应调用 native IPC');
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).sendText('空白目标', {
        targetSessionId: '   ',
        operationId: 'op-whitespace-target',
      });

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-whitespace-target',
        status: 'failed',
        isPreTrigger: true,
      });
      expect(await store.get('op-whitespace-target')).toBeNull();
      expect(ipc.sent).toHaveLength(0);
    });

    it('发送后超时返回未知状态且不伪报确定失败', async () => {
      vi.useFakeTimers();
      const store = new InMemorySendOperationStore();
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'insertSendBefoeMsg') {
          return { code: 0, data: { id: -22, msgIdx: 10 } };
        }
        return NO_IPC_RESPONSE;
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const pending = new BridgeMessageOps(mockCdp, store).sendText('发送后超时', {
        targetSessionId: session.sesUUID,
        operationId: 'op-send-timeout',
      });
      await Promise.resolve();
      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-send-timeout',
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(await store.get('op-send-timeout')).toMatchObject({ status: 'unknown' });
      expect(ipc.sent.map(request => request.args[0])).toEqual([
        'insertSendBefoeMsg',
        'sendMessageNew',
      ]);
    });

    it('CDP 断连时返回未知状态并保留发送操作记录', async () => {
      const store = new InMemorySendOperationStore();
      const mockCdp = {
        getStatus: vi.fn().mockReturnValue('connected'),
        evaluate: vi.fn().mockRejectedValue(new Error('CDP socket disconnected')),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).sendText('CDP 断连', {
        targetSessionId: session.sesUUID,
        operationId: 'op-cdp-disconnect',
      });

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-cdp-disconnect',
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(await store.get('op-cdp-disconnect')).toMatchObject({ status: 'unknown' });
    });

    it('原生消息存在且属于目标会话时返回已送达', async () => {
      const operationId = 't12-real-readonly-317612f3-37ca-49c6-bb46-703b9f7ca1b5';
      const store = new InMemorySendOperationStore();
      const fingerprint = createSendOperationFingerprint({
        targetSessionId: session.sesUUID,
        messageType: 'text',
        content: '历史查询',
      });
      await store.claim({ operationId, fingerprint });
      await store.update(operationId, { status: 'unknown' });
      const nativeKey = createNativeMessageKey('text', operationId);
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMessages') {
          return {
            code: 0,
            data: [{ id: 135000202, msgFlag: nativeKey, sessionID: session.sesUUID }],
          };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).getSendStatus(operationId);

      expect(result).toMatchObject({
        success: true,
        operationId,
        status: 'delivered',
        messageId: '135000202',
      });
    });

    it('只读查询次数增加时不增加发送调用次数', async () => {
      const operationId = 'op-read-only';
      const store = new InMemorySendOperationStore();
      const fingerprint = createSendOperationFingerprint({
        targetSessionId: session.sesUUID,
        messageType: 'text',
        content: '只读查询',
      });
      await store.claim({ operationId, fingerprint });
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMessages') return { code: 0, data: [] };
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;
      const ops = new BridgeMessageOps(mockCdp, store);

      const first = await ops.getSendStatus(operationId);
      const second = await ops.getSendStatus(operationId);
      const methods = ipc.sent.map(request => request.args[0]);

      expect(first.status).toBe('unknown');
      expect(second.status).toBe('unknown');
      expect(methods.filter(method => method === 'getMessages').length).toBe(2);
      expect(
        methods.filter(method => method === 'insertSendBefoeMsg' || method === 'sendMessageNew')
      ).toHaveLength(0);
    });

    it('同一发送操作 ID 重试时复用同一原生关联键', async () => {
      const store = new InMemorySendOperationStore();
      const flags: string[] = [];
      let insertCount = 0;
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'insertSendBefoeMsg') {
          insertCount += 1;
          const message = request.args[1] as Record<string, unknown>;
          flags.push(String(message['msgFlag']));
          if (insertCount === 1) return { code: 1, error: '第一次未插入' };
          return { code: 0, data: { ...message, id: -22, msgIdx: 20 } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000203, msgFlag: flags.at(-1) }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;
      const ops = new BridgeMessageOps(mockCdp, store);

      const first = await ops.sendText('稳定关联键', {
        targetSessionId: session.sesUUID,
        operationId: 'op-stable-key',
      });
      const second = await ops.sendText('稳定关联键', {
        targetSessionId: session.sesUUID,
        operationId: 'op-stable-key',
      });

      expect(first.status).toBe('failed');
      expect(second).toMatchObject({ status: 'delivered', messageId: '135000203' });
      expect(flags).toHaveLength(2);
      expect(flags[0]).toBe(flags[1]);
      expect(ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
    });

    it('原生消息属于其他会话时不得返回已送达', async () => {
      const operationId = 'op-wrong-session';
      const store = new InMemorySendOperationStore();
      const fingerprint = createSendOperationFingerprint({
        targetSessionId: session.sesUUID,
        messageType: 'text',
        content: '目标校验',
      });
      await store.claim({ operationId, fingerprint });
      const nativeKey = createNativeMessageKey('text', operationId);
      const ipc = new FakeIpcRenderer(request => {
        if (request.args[0] === 'getMessages') {
          return {
            code: 0,
            data: [{ id: 135000204, msgFlag: nativeKey, sessionID: '1-29467' }],
          };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).getSendStatus(operationId);

      expect(result).toMatchObject({
        success: false,
        operationId,
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(result.messageId).toBeUndefined();
    });

    it('查询无发送操作记录时返回未知且不访问发送接口', async () => {
      const store = new InMemorySendOperationStore();
      const ipc = new FakeIpcRenderer(() => {
        throw new Error('不应调用 native IPC');
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;

      const result = await new BridgeMessageOps(mockCdp, store).getSendStatus('op-missing');

      expect(result).toMatchObject({
        success: false,
        operationId: 'op-missing',
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(ipc.sent).toHaveLength(0);
    });

    it('文本、富文本、回复和文件的带操作 ID 路径均保持发送行为', async () => {
      const store = new InMemorySendOperationStore();
      const persisted: Array<Record<string, unknown>> = [
        {
          id: 900,
          msgIdx: 9,
          sender: 3705,
          senderName: '员工',
          contentType: 4,
          content: { content: [{ type: 0, text: '原消息' }] },
        },
      ];
      let nextId = 135000300;
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          persisted.push({ id: nextId, msgFlag: message['msgFlag'] });
          return { code: 0, data: { ...message, id: -22, msgIdx: nextId++ } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') return { code: 0, data: persisted };
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;
      const ops = new BridgeMessageOps(mockCdp, store);
      const filePath = path.resolve('tmp', 't06-operation-file.txt');
      if (!fs.existsSync(path.dirname(filePath)))
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, 'T06');

      try {
        const results = await Promise.all([
          ops.sendText('文本路径', {
            targetSessionId: session.sesUUID,
            operationId: 'op-path-text',
          }),
          ops.sendRichText('富文本路径', {
            targetSessionId: session.sesUUID,
            operationId: 'op-path-rich',
            mentions: ['all'],
          }),
          ops.sendReply({ messageId: '900' }, '回复路径', {
            targetSessionId: session.sesUUID,
            operationId: 'op-path-reply',
          }),
          ops.sendFile(filePath, { targetSessionId: session.sesUUID, operationId: 'op-path-file' }),
        ]);

        expect(results.map(result => result.status)).toEqual([
          'delivered',
          'delivered',
          'delivered',
          'delivered',
        ]);
        expect(results.every(result => result.success)).toBe(true);
        expect(ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')).toHaveLength(
          4
        );
        expect(ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(4);
      } finally {
        fs.unlinkSync(filePath);
      }
    });
    it('图片发送操作 ID 使用稳定原生关联键并确认真实消息 ID', async () => {
      const operationId = 'op-image-stable-key';
      const tmpFile = path.resolve('tmp', 't07-operation-image.png');
      if (!fs.existsSync(path.dirname(tmpFile)))
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      let insertCount = 0;
      const flags: string[] = [];
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'sendingImgBeforeHandle') {
          return { code: 0, data: { thumbPath: 'C:\\thumb.png', artworkPath: 'C:\\art.png' } };
        }
        if (method === 'insertSendBefoeMsg') {
          insertCount += 1;
          const message = request.args[1] as Record<string, unknown>;
          flags.push(String(message['msgFlag']));
          if (insertCount === 1) return { code: 1, error: '第一次插入失败' };
          return { code: 0, data: { ...message, id: -22, msgIdx: 20 } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000206, msgIdx: 20, msgFlag: flags.at(-1) }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;
      const store = new InMemorySendOperationStore();
      const ops = new BridgeMessageOps(mockCdp, store);

      try {
        const first = await ops.sendImage(tmpFile, {
          targetSessionId: session.sesUUID,
          operationId,
        });
        const second = await ops.sendImage(tmpFile, {
          targetSessionId: session.sesUUID,
          operationId,
        });
        const queried = await ops.getSendStatus(operationId);

        expect(first).toMatchObject({ status: 'failed', isPreTrigger: true });
        expect(second).toMatchObject({
          success: true,
          operationId,
          status: 'delivered',
          messageId: '135000206',
          isPreTrigger: false,
        });
        expect(queried).toMatchObject({
          success: true,
          operationId,
          status: 'delivered',
          messageId: '135000206',
        });
        expect(flags).toHaveLength(2);
        expect(flags[0]).toBe(flags[1]);
        expect(flags[0]).toBe(createNativeMessageKey('image', operationId));
        expect(ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
      } finally {
        fs.unlinkSync(tmpFile);
      }
    });

    it('图片 operation-aware 文件预检异常可安全重试', async () => {
      const operationId = 'op-image-preflight-retry';
      const tmpFile = path.resolve('tmp', 't07-operation-image-preflight.png');
      if (!fs.existsSync(path.dirname(tmpFile)))
        fs.mkdirSync(path.dirname(tmpFile), { recursive: true });
      fs.writeFileSync(
        tmpFile,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const flags: string[] = [];
      const ipc = new FakeIpcRenderer(request => {
        const method = request.args[0];
        if (method === 'sendingImgBeforeHandle') {
          return { code: 0, data: { thumbPath: 'C:\\thumb.png', artworkPath: 'C:\\art.png' } };
        }
        if (method === 'insertSendBefoeMsg') {
          const message = request.args[1] as Record<string, unknown>;
          flags.push(String(message['msgFlag']));
          return { code: 0, data: { ...message, id: -22, msgIdx: 20 } };
        }
        if (method === 'sendMessageNew') return { code: 0 };
        if (method === 'getMessages') {
          return { code: 0, data: [{ id: 135000207, msgIdx: 20, msgFlag: flags.at(-1) }] };
        }
        return { code: 1 };
      });
      const runtime = createRendererRuntime({ ipc, sessions: [session] });
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
      } as unknown as CdpClient;
      const statSpy = vi.spyOn(fs, 'statSync').mockImplementationOnce(() => {
        throw new Error('文件预检异常');
      });
      const ops = new BridgeMessageOps(mockCdp, new InMemorySendOperationStore());

      try {
        const first = await ops.sendImage(tmpFile, {
          targetSessionId: session.sesUUID,
          operationId,
        });
        const second = await ops.sendImage(tmpFile, {
          targetSessionId: session.sesUUID,
          operationId,
        });

        expect(first).toMatchObject({
          success: false,
          status: 'failed',
          isPreTrigger: true,
          error: expect.stringContaining('文件预检异常'),
        });
        expect(second).toMatchObject({
          success: true,
          status: 'delivered',
          messageId: '135000207',
        });
        expect(flags).toHaveLength(1);
        expect(ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
      } finally {
        statSpy.mockRestore();
        fs.unlinkSync(tmpFile);
      }
    });
  });
});
