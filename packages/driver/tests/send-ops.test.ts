import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SendOps } from '../src/dom/send-ops.js';

describe('SendOps 消息发送、富文本、引用与文件发送测试', () => {
  describe('sendText', () => {
    it('sendText 空内容应直接拦截返回错误', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendText('   ');
      expect(res.success).toBe(false);
      expect(res.error).toContain('不能为空');
      expect(mockCdp.evaluate).not.toHaveBeenCalled();
    });

    it('sendText 在前置校验未通过时应中止发送', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({
          canSend: false,
          reason: 'session_switched',
        }),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendText('你好', { targetSessionId: 'expected_id' });

      expect(res.success).toBe(false);
      expect(res.error).toContain('发送前检查未通过');
    });

    it('sendText 携带 replyTo 时应调用 sendReply 并完成发送', async () => {
      const mockCdp = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ success: true, method: 'vue_native_reply' }) // native reply send
          .mockResolvedValueOnce(true), // verifyTextSent
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendText('好的，收到', {
        replyTo: { messageId: 'msg-1001', sender: '张三', content: '开会通知' },
      });

      expect(res.success).toBe(true);
      expect(mockCdp.bringToFront).toHaveBeenCalled();
    });
  });

  describe('sendRichText', () => {
    it('空富文本内容应直接拦截', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendRichText('');
      expect(res.success).toBe(false);
      expect(res.error).toContain('不能为空');
    });

    it('支持发送 FormattedText 片段并触发富文本发送', async () => {
      const mockCdp = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ success: true, method: 'vue_native_pictext' }) // native pictext
          .mockResolvedValueOnce(true), // verifyTextSent
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendRichText([
        { text: '系统提醒: ', style: { bold: true } },
        { text: '任务已完成', style: { color: '#52c41a' } },
      ]);

      expect(res.success).toBe(true);
      expect(mockCdp.bringToFront).toHaveBeenCalled();
    });
  });

  describe('sendReply', () => {
    it('sendReply 应透传 replyTo 并调用 native reply', async () => {
      const mockCdp = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({ success: true, method: 'vue_native_reply' }) // native reply
          .mockResolvedValueOnce(true), // verify
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendReply('原消息内容', '这是我的回复');
      expect(res.success).toBe(true);
    });
  });

  describe('sendFile', () => {
    it('不存在的文件应返回错误', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendFile('./non_existent_file_xyz.pdf');
      expect(res.success).toBe(false);
      expect(res.error).toContain('文件不存在');
    });

    it('目录路径应拒绝发送', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendFile('.');
      expect(res.success).toBe(false);
      expect(res.error).toContain('不能发送目录');
    });

    it('合法存在的文件应执行原生文件发送与回读确认', async () => {
      const tempFilePath = path.resolve('tmp_test_file.txt');
      fs.writeFileSync(tempFilePath, '测试文件内容');

      try {
        const mockCdp = {
          evaluate: vi
            .fn()
            .mockResolvedValueOnce({ success: true, method: 'vue_native_file_send' })
            .mockResolvedValueOnce(true), // verifyFileSent
          bringToFront: vi.fn().mockResolvedValue(undefined),
        } as unknown as CdpClient;

        const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
        const res = await ops.sendFile(tempFilePath);
        expect(res.success).toBe(true);
      } finally {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      }
    });
  });

  describe('sendImage', () => {
    it('sendImage 不存在的文件应返回错误', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendImage('./non_existent_image_12345.png');
      expect(res.success).toBe(false);
      expect(res.error).toContain('文件不存在');
    });
  });
});
