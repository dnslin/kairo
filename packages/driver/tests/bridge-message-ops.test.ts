import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';

describe('BridgeMessageOps 纯数据消息操作测试', () => {
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

    it('当会话发生切换时应被防串线安全拦截 (Fail-Closed)', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({
          canSend: false,
          reason: 'session_switched',
          details: '会话已切离',
        }),
      } as unknown as CdpClient;

      const ops = new BridgeMessageOps(mockCdp);
      const res = await ops.sendText('绝密消息', { targetSessionId: '0-3585' });

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('发送前检查未通过');
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
  });
});
