import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SendOps } from '../src/dom/send-ops.js';
import { KK9Driver } from '../src/driver.js';
import type { KK9RecalledEvent, KK9Session } from '../src/types/index.js';

describe('消息撤回双轨 API 与安全守卫测试 (Issue #67)', () => {
  describe('SendResult.recall 快捷链式撤回', () => {
    it('发送动作无权威 native ack 时不返回 messageId 或 recall()', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue({ success: true, method: 'vue_native_pictext' }),
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendText('测试发送并准备撤回');

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
      expect(res.recall).toBeUndefined();
    });
  });

  describe('KK9Driver.recallMessage 全局撤回方法', () => {
    it('driver.recallMessage 撤回自己发送的有效消息应返回 true', async () => {
      const driver = new KK9Driver({
        cdp: {
          url: 'http://127.0.0.1:9222',
          pageMatch: 'renderer.html',
        },
      });

      const mockSendOps = {
        recallMessage: vi.fn().mockResolvedValue(true),
      };
      (driver as unknown as { sendOps: typeof mockSendOps }).sendOps = mockSendOps;

      const result = await driver.recallMessage('msg_001', 'ses_test');
      expect(result).toBe(true);
      expect(mockSendOps.recallMessage).toHaveBeenCalledWith('msg_001', 'ses_test');
    });

    it('driver.recallMessage 接受 KK9Session 对象并传递正确 sessionId', async () => {
      const driver = new KK9Driver({
        cdp: {
          url: 'http://127.0.0.1:9222',
          pageMatch: 'renderer.html',
        },
      });

      const mockSendOps = {
        recallMessage: vi.fn().mockResolvedValue(true),
      };
      (driver as unknown as { sendOps: typeof mockSendOps }).sendOps = mockSendOps;

      const session: KK9Session = {
        id: 'session_xyz',
        name: '测试会话',
        type: 'private',
        unread: false,
      };

      const result = await driver.recallMessage('msg_002', session);
      expect(result).toBe(true);
      expect(mockSendOps.recallMessage).toHaveBeenCalledWith('msg_002', 'session_xyz');
    });
  });

  describe('安全拦截与时效守卫', () => {
    it('所有权校验：尝试撤回他人发出的消息 (isMe: false) 时应直接拦截并返回 false', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValueOnce({
          // 消息属于他人
          isMe: false,
          sender: '张三',
          timestamp: Date.now() - 10000,
        }),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.recallMessage('other_user_msg_id');

      expect(res).toBe(false);
      // 底层撤回指令不应被执行（仅调用了消息检查）
      expect(mockCdp.evaluate).toHaveBeenCalledTimes(1);
    });

    it('时效防护：超过 120 秒（2 分钟）的消息应拒绝撤回并返回 false', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValueOnce({
          isMe: true,
          sender: '我',
          // 已经过去 150 秒（超过 120 秒）
          timestamp: Date.now() - 150 * 1000,
        }),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.recallMessage('expired_msg_id');

      expect(res).toBe(false);
      expect(mockCdp.evaluate).toHaveBeenCalledTimes(1);
    });

    it('120 秒边界内（例如 115 秒）的消息允许正常撤回', async () => {
      const mockCdp = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            isMe: true,
            sender: '我',
            timestamp: Date.now() - 115 * 1000, // 115s 内
          })
          .mockResolvedValueOnce({ success: true }), // 执行底层撤回
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.recallMessage('valid_time_msg_id');

      expect(res).toBe(true);
      expect(mockCdp.evaluate).toHaveBeenCalledTimes(2);
    });

    it('支持 10 位 UNIX 秒级时间戳自动归一化且在 120 秒内允许撤回', async () => {
      const mockCdp = {
        evaluate: vi
          .fn()
          .mockResolvedValueOnce({
            isMe: true,
            sender: '我',
            timestamp: Math.floor(Date.now() / 1000) - 5, // 5秒前 (秒级时间戳)
          })
          .mockResolvedValueOnce({ success: true }),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.recallMessage('seconds_timestamp_msg_id');

      expect(res).toBe(true);
      expect(mockCdp.evaluate).toHaveBeenCalledTimes(2);
    });

    it('未找到消息时应安全返回 false', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockResolvedValueOnce(null),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.recallMessage('not_found_msg_id');

      expect(res).toBe(false);
    });
  });

  describe('原生 CancelMessage 事件捕获与 recalled 事件派发', () => {
    it('捕获到原生 CancelMessage 广播时应派发 recalled 事件', () => {
      const driver = new KK9Driver({
        cdp: {
          url: 'http://127.0.0.1:9222',
          pageMatch: 'renderer.html',
        },
      });

      const recalledEvents: KK9RecalledEvent[] = [];
      driver.on('recalled', event => {
        recalledEvents.push(event);
      });

      const rawCancelPayload = {
        messageId: 'recalled_msg_999',
        sessionId: 'session_123',
        sender: '李四',
        time: '14:30:00',
      };

      // 模拟内部事件桥或轮询器捕获到撤回
      (
        driver as unknown as {
          handleRecalledEvent: (evt: KK9RecalledEvent) => void;
        }
      ).handleRecalledEvent(rawCancelPayload);

      expect(recalledEvents).toHaveLength(1);
      expect(recalledEvents[0]).toMatchObject({
        messageId: 'recalled_msg_999',
        sessionId: 'session_123',
        sender: '李四',
        time: '14:30:00',
      });
    });

    it('重复接收相同 messageId 的撤回事件不应重复派发 (去重)', () => {
      const driver = new KK9Driver({
        cdp: {
          url: 'http://127.0.0.1:9222',
          pageMatch: 'renderer.html',
        },
      });

      const recalledEvents: KK9RecalledEvent[] = [];
      driver.on('recalled', event => {
        recalledEvents.push(event);
      });

      const rawCancelPayload = {
        messageId: 'recalled_msg_dup',
        sessionId: 'session_123',
        sender: '王五',
        time: '14:31:00',
      };

      const handler = (
        driver as unknown as {
          handleRecalledEvent: (evt: KK9RecalledEvent) => void;
        }
      ).handleRecalledEvent.bind(driver);

      handler(rawCancelPayload);
      handler(rawCancelPayload);

      expect(recalledEvents).toHaveLength(1);
    });
  });
});
