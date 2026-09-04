import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SendOps } from '../src/dom/send-ops.js';
import { runRendererScript } from './helpers/renderer-runtime.js';

describe('SendOps 消息发送、富文本、引用与文件发送测试', () => {
  describe('checkPreSendState 会话身份校验', () => {
    const runCheck = async (
      target: string,
      activeId: string,
      activeTitle: string,
      scrollerItems: Array<Record<string, unknown>>
    ) => {
      const activeItem = {
        querySelector: () => ({ textContent: activeTitle }),
        getAttribute: (name: string) =>
          name === 'data-sesuuid' || name === 'data-session-id' || name === 'id'
            ? activeId
            : null,
      };
      const document = {
        querySelector(selector: string): unknown {
          if (selector.includes('.chat-item.chat-selected')) return activeItem;
          if (selector.includes('.vue-recycle-scroller')) {
            return { __vue__: { items: scrollerItems } };
          }
          if (selector.includes('.chat-header') || selector.includes('.head-title')) {
            return { textContent: activeTitle };
          }
          return null;
        },
      };
      const mockCdp = {
        evaluate: vi.fn((script: string) => runRendererScript(script, { document })),
      } as unknown as CdpClient;

      return new SendOps(mockCdp, DEFAULT_SELECTORS).checkPreSendState(target);
    };

    it('重名会话无法唯一解析时必须 Fail-Closed', async () => {
      const result = await runCheck('重复会话', '7', '重复会话', [
        { id: 7, sesUUID: 'first', typeName: '重复会话', name: '重复会话' },
        { id: 8, sesUUID: 'second', typeName: '重复会话', name: '重复会话' },
      ]);

      expect(result.canSend).toBe(false);
    });

    it('真实 ID 被更早会话名称遮蔽时不得放行错误 active 会话', async () => {
      const result = await runCheck('1-29467', '7', '1-29467', [
        { id: 7, sesUUID: 'shadow', typeName: '1-29467', name: '1-29467' },
        { id: 8, sesUUID: '1-29467', typeName: '真实目标', name: '真实目标' },
      ]);

      expect(result.canSend).toBe(false);
    });

    it('唯一 ID 命中且 active ID 一致时允许发送', async () => {
      const result = await runCheck('1-29467', '1-29467', '真实目标', [
        { id: 8, sesUUID: '1-29467', typeName: '真实目标', name: '真实目标' },
      ]);

      expect(result.canSend).toBe(true);
    });
  });

  describe('sendText', () => {
    it('sendText 空内容应直接拦截返回错误', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendText('   ');
      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
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
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('发送前检查未通过');
    });

    it('sendText 在前置校验脚本执行异常时应 Fail-Closed 拦截并标记 isPreTrigger = true', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockRejectedValue(new Error('CDP evaluate connection lost')),
        bringToFront: vi.fn(),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendText('你好', { targetSessionId: 'expected_id' });

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('发送前检查未通过');
      expect(res.error).toContain('Fail-Closed');
      expect(mockCdp.bringToFront).not.toHaveBeenCalled();
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

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
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

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
      expect(mockCdp.bringToFront).toHaveBeenCalled();
    });
    it('发送动作触发后 CDP 响应丢失进入 unknown 且不回读 DOM', async () => {
      const evaluate = vi.fn().mockRejectedValue(new Error('response lost'));
      const mockCdp = {
        evaluate,
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendRichText('发送后连接断开');

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
      expect(evaluate).toHaveBeenCalledOnce();
    });
    it('DOM 触发发送后未收到 native 回执时返回未知', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({ success: true, method: 'vue_native_pictext' }),
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendRichText('等待 native 回执');

      expect(res).toMatchObject({
        success: false,
        status: 'unknown',
        isPreTrigger: false,
      });
      expect(res.messageId).toBeUndefined();
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
      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
    });
  });

  describe('sendFile', () => {
    it('不存在的文件应返回错误', async () => {
      const mockCdp = { evaluate: vi.fn() } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendFile('./non_existent_file_12345.txt');
      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
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
        expect(res.success).toBe(false);
        expect(res.isPreTrigger).toBe(false);
        expect(res.messageId).toBeUndefined();
      } finally {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      }
    });
    it('文件发送后回读超时未确认文件卡片时应返回失败', async () => {
      const tempFilePath = path.resolve('tmp_timeout_file.txt');
      fs.writeFileSync(tempFilePath, '测试超时内容');

      try {
        const mockCdp = {
          evaluate: vi
            .fn()
            .mockResolvedValueOnce({ success: true, method: 'vue_native_file_send' })
            .mockResolvedValueOnce(false), // verifyFileSent times out
          bringToFront: vi.fn().mockResolvedValue(undefined),
        } as unknown as CdpClient;

        const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
        const res = await ops.sendFile(tempFilePath, { verifyTimeoutMs: 50 });
        expect(res.success).toBe(false);
        expect(res.isPreTrigger).toBe(false);
        expect(res.messageId).toBeUndefined();
        expect(res.error).toContain('权威 native ack');
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
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('文件不存在');
    });
    it('operation-aware 图片无法保证稳定关联时明确拒绝且不触发 DOM', async () => {
      const mockCdp = {
        evaluate: vi.fn(),
        bringToFront: vi.fn(),
      } as unknown as CdpClient;
      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      const res = await ops.sendImage('image.png', { operationId: 'op-dom-image' });

      expect(res).toMatchObject({
        success: false,
        operationId: 'op-dom-image',
        status: 'failed',
        isPreTrigger: true,
      });
      expect(res.error).toContain('稳定 native 关联键');
      expect(mockCdp.evaluate).not.toHaveBeenCalled();
      expect(mockCdp.bringToFront).not.toHaveBeenCalled();
    });
  });
  describe('bringToFront 激活窗口失败 (pre-trigger) 测试', () => {
    const rejectingCdp = {
      bringToFront: vi
        .fn()
        .mockRejectedValue(new Error('CDP Target.bringToFront connection closed')),
      evaluate: vi.fn(),
    } as unknown as CdpClient;

    it('sendRichText 在 bringToFront 失败时应返回 isPreTrigger: true', async () => {
      const ops = new SendOps(rejectingCdp, DEFAULT_SELECTORS);
      const res = await ops.sendRichText('测试富文本');
      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('激活窗口失败');
    });
    it('sendReply 在 bringToFront 失败时应返回 isPreTrigger: true', async () => {
      const ops = new SendOps(rejectingCdp, DEFAULT_SELECTORS);
      const res = await ops.sendReply('msg_123', '回复内容');
      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(true);
      expect(res.error).toContain('激活回复窗口失败');
    });

    it('sendFile 在 bringToFront 失败时应返回 isPreTrigger: true', async () => {
      const tempFilePath = path.join(os.tmpdir(), `kairo_test_btf_${Date.now()}.txt`);
      fs.writeFileSync(tempFilePath, '测试内容');
      try {
        const ops = new SendOps(rejectingCdp, DEFAULT_SELECTORS);
        const res = await ops.sendFile(tempFilePath);
        expect(res.success).toBe(false);
        expect(res.isPreTrigger).toBe(true);
        expect(res.error).toContain('激活文件发送窗口失败');
      } finally {
        if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      }
    });

    it('sendImage 在 bringToFront 失败时应返回 isPreTrigger: true', async () => {
      const tempImgPath = path.join(os.tmpdir(), `kairo_test_btf_${Date.now()}.png`);
      fs.writeFileSync(tempImgPath, 'fake_png_data');
      try {
        const ops = new SendOps(rejectingCdp, DEFAULT_SELECTORS);
        const res = await ops.sendImage(tempImgPath);
        expect(res.success).toBe(false);
        expect(res.isPreTrigger).toBe(true);
        expect(res.error).toContain('激活图片发送窗口失败');
      } finally {
        if (fs.existsSync(tempImgPath)) fs.unlinkSync(tempImgPath);
      }
    });
  });
});
