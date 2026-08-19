import { describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import type { KK9Employee, KK9Message, KK9Session, SendResult } from '../src/types/index.js';

interface DriverInternal {
  sessionOps: {
    markSessionRead: (sessionId: string) => Promise<boolean>;
  };
  messageOps: {
    getRecentMessages: (limit: number, session?: KK9Session) => Promise<KK9Message[]>;
  };
  sendOps: {
    sendText: (text: string, options?: unknown) => Promise<SendResult>;
    sendRichText: (content: unknown, options?: unknown) => Promise<SendResult>;
    sendReply: (replyTo: unknown, content: unknown, options?: unknown) => Promise<SendResult>;
    sendFile: (filePath: string, options?: unknown) => Promise<SendResult>;
    sendImage: (imagePath: string, options?: unknown) => Promise<SendResult>;
  };
  orgOps: {
    getEmployees: () => Promise<KK9Employee[]>;
    getUserProfile: (userId: number | string) => Promise<KK9Employee | null>;
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

  it('collectAndEmitMessages 应触发 message 与专用的 at 事件', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    const receivedMessages: KK9Message[] = [];
    const receivedAtMessages: KK9Message[] = [];

    driver.on('message', msg => {
      receivedMessages.push(msg);
    });

    driver.on('at', msg => {
      receivedAtMessages.push(msg);
    });

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
        atMe: false,
        timestamp: Date.now(),
      },
      {
        id: 'fp_2',
        sessionId: 'group_1',
        sessionName: '测试123',
        sessionType: 'group',
        sender: '群员B',
        content: '@机器人 请查一下数据',
        time: '12:02',
        isMe: false,
        atMe: true,
        mentions: {
          isAtMe: true,
          isAtAll: false,
          mentionedUsers: ['机器人'],
        },
        timestamp: Date.now(),
      },
      {
        id: 'fp_3',
        sessionId: 'ses_1',
        sessionName: '客户A',
        sessionType: 'private',
        sender: '我',
        content: '您好，基础版免费',
        time: '12:03',
        isMe: true, // 自身消息应被过滤
        timestamp: Date.now(),
      },
    ];

    const internal = driver as unknown as DriverInternal;
    internal.messageOps.getRecentMessages = vi.fn().mockResolvedValue(mockMessages);

    await internal.collectAndEmitMessages(
      { id: 'group_1', name: '测试123', type: 'group', unread: true },
      10
    );

    expect(receivedMessages).toHaveLength(2);
    expect(receivedAtMessages).toHaveLength(1);
    expect(receivedAtMessages[0]?.content).toBe('@机器人 请查一下数据');
    expect(receivedAtMessages[0]?.atMe).toBe(true);

    // 第二次调用相同消息，由于指纹已存在，不应重复触发
    await internal.collectAndEmitMessages(
      { id: 'group_1', name: '测试123', type: 'group', unread: true },
      10
    );
    expect(receivedMessages).toHaveLength(2);
    expect(receivedAtMessages).toHaveLength(1);
  });

  it('转发调用 sendRichText, sendReply, sendFile', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    const internal = driver as unknown as DriverInternal;
    internal.sendOps.sendRichText = vi.fn().mockResolvedValue({ success: true });
    internal.sendOps.sendReply = vi.fn().mockResolvedValue({ success: true });
    internal.sendOps.sendFile = vi.fn().mockResolvedValue({ success: true });

    const resRich = await driver.sendRichText('**加粗测试**');
    expect(resRich.success).toBe(true);
    expect(internal.sendOps.sendRichText).toHaveBeenCalled();

    const resReply = await driver.sendReply('目标消息', '回复内容');
    expect(resReply.success).toBe(true);
    expect(internal.sendOps.sendReply).toHaveBeenCalled();

    const resFile = await driver.sendFile('./test.pdf');
    expect(resFile.success).toBe(true);
    expect(internal.sendOps.sendFile).toHaveBeenCalled();
  });

  it('转发调用 getOrgEmployees 与 getUserProfile', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    const mockEmployee: KK9Employee = {
      id: 'emp_001',
      loginName: 'E001',
      name: '张三',
      position: '工程师',
      updatedAt: Date.now(),
    };

    const internal = driver as unknown as DriverInternal;
    internal.orgOps.getEmployees = vi.fn().mockResolvedValue([mockEmployee]);
    internal.orgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

    const employees = await driver.getOrgEmployees();
    expect(employees).toHaveLength(1);
    expect(employees[0]?.name).toBe('张三');
    expect(internal.orgOps.getEmployees).toHaveBeenCalled();

    const profile = await driver.getUserProfile('emp_001');
    expect(profile).not.toBeNull();
    expect(profile?.loginName).toBe('E001');
    expect(internal.orgOps.getUserProfile).toHaveBeenCalledWith('emp_001');
  });

  it('markSessionRead 应转发调用 sessionOps.markSessionRead', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internal = driver as unknown as DriverInternal;

    const mockSessionOps = {
      markSessionRead: vi.fn().mockResolvedValue(true),
    };
    internal.sessionOps = mockSessionOps;

    const res = await driver.markSessionRead('ses_123');
    expect(res).toBe(true);
    expect(mockSessionOps.markSessionRead).toHaveBeenCalledWith('ses_123');
  });
});
