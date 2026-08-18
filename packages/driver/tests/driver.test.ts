import { describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import type { KK9Message, KK9Session } from '../src/types/index.js';

interface DriverInternal {
  messageOps: {
    getRecentMessages: (limit: number, session?: KK9Session) => Promise<KK9Message[]>;
  };
  collectAndEmitMessages: (session: KK9Session, limit: number) => Promise<void>;
}

describe('KK9Driver 端到端事件驱动测试', () => {
  it('初始化时状态应为 disconnected', () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    expect(driver.getStatus()).toBe('disconnected');
  });

  it('startPolling 与 stopPolling 应正确切换轮询状态', () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
      polling: {
        intervalMs: 100,
      },
    });

    driver.startPolling();
    // 重复调用不应抛错
    driver.startPolling();

    driver.stopPolling();
    expect(driver.getStatus()).toBe('disconnected');
  });

  it('collectAndEmitMessages 应过滤自身发出的消息并触发 message 事件', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    const receivedMessages: string[] = [];
    driver.on('message', (msg) => {
      receivedMessages.push(msg.content);
    });

    // 模拟底层 messageOps.getRecentMessages
    const mockMessages: KK9Message[] = [
      {
        id: 'fp_1',
        sessionId: 'ses_1',
        sessionName: '客户A',
        sessionType: 'private',
        sender: '客户A',
        content: '你们产品多少钱？',
        time: '12:01',
        isMe: false,
        timestamp: Date.now(),
      },
      {
        id: 'fp_2',
        sessionId: 'ses_1',
        sessionName: '客户A',
        sessionType: 'private',
        sender: '我',
        content: '您好，基础版免费',
        time: '12:02',
        isMe: true, // 自身消息应被过滤
        timestamp: Date.now(),
      },
    ];

    const internal = driver as unknown as DriverInternal;
    internal.messageOps.getRecentMessages = vi.fn().mockResolvedValue(mockMessages);

    await internal.collectAndEmitMessages({ id: 'ses_1', name: '客户A', type: 'private', unread: true }, 10);

    expect(receivedMessages).toHaveLength(1);
    expect(receivedMessages[0]).toBe('你们产品多少钱？');

    // 第二次调用相同消息，由于指纹已存在，不应重复触发
    await internal.collectAndEmitMessages({ id: 'ses_1', name: '客户A', type: 'private', unread: true }, 10);
    expect(receivedMessages).toHaveLength(1);
  });
});
