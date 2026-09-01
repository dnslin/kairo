import { describe, expect, it, vi } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import type { KK9Employee, KK9Message, KK9Session, SendResult } from '../src/types/index.js';

describe('KK9Driver 顶层契约离线测试 (IKK9Driver)', () => {
  it('初始化时状态应为 disconnected 且生成唯一 startupGenerationId', () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    expect(driver.getStatus()).toBe('disconnected');
    expect(driver.getStartupGenerationId()).toBeDefined();
    const health = driver.getHealthSnapshot();
    expect(health.cdpStatus).toBe('disconnected');
    expect(health.eventBridgeAttached).toBe(false);
  });

  it('connect 只能由 EventBridge 拥有 binding 与注入生命周期', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = driver as unknown as {
      eventBridge: { connect: () => Promise<void> };
      cdp: {
        sendCommand: ReturnType<typeof vi.fn>;
        on: ReturnType<typeof vi.fn>;
        evaluate: ReturnType<typeof vi.fn>;
      };
    };
    const eventBridgeConnect = vi.fn().mockResolvedValue(undefined);
    internals.eventBridge.connect = eventBridgeConnect;
    internals.cdp.sendCommand = vi.fn().mockResolvedValue(undefined);
    internals.cdp.on = vi.fn();
    internals.cdp.evaluate = vi.fn().mockResolvedValue(undefined);

    await driver.connect();

    expect(eventBridgeConnect).toHaveBeenCalledOnce();
    expect(internals.cdp.sendCommand).not.toHaveBeenCalled();
    expect(internals.cdp.on).not.toHaveBeenCalled();
    expect(internals.cdp.evaluate).not.toHaveBeenCalled();
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
        sessionId: '0-3585',
        sessionName: 'int2024',
        sessionType: 'private',
        sender: 'int2024',
        content: '私聊咨询',
        time: '12:01',
        isMe: false,
        atMe: false,
        timestamp: Date.now(),
      },
      {
        id: 'fp_2',
        sessionId: '1-29467',
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
        timestamp: Date.now() + 1000,
      },
    ];

    Object.assign(driver.bridgeMessageOps, {
      getRecentMessagesResult: vi.fn().mockResolvedValue({ kind: 'ok', value: mockMessages }),
    });

    // @ts-expect-error 访问私有方法 collectAndEmitMessages 测试
    await driver.collectAndEmitMessages(
      { id: '1-29467', name: '测试123', type: 'group', unread: true },
      10
    );

    expect(receivedMessages).toHaveLength(2);
    expect(receivedAtMessages).toHaveLength(1);
    expect(receivedAtMessages[0]?.content).toContain('@机器人');
    expect(receivedAtMessages[0]?.sessionName).toBe('测试123');
  });

  it('私聊场景(int2024)与群聊场景(测试123)的消息发送转发与 Bot 消息标记', async () => {
    const driver = new KK9Driver({
      cdp: {
        url: 'http://127.0.0.1:9222',
        pageMatch: 'renderer.html',
      },
    });

    const mockSendResult: SendResult = {
      success: true,
      messageId: 'msg_ack_1001',
      verifyLatencyMs: 12,
    };

    driver.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(mockSendResult);
    driver.bridgeMessageOps.sendRichText = vi.fn().mockResolvedValue(mockSendResult);
    driver.bridgeMessageOps.sendReply = vi.fn().mockResolvedValue(mockSendResult);
    driver.bridgeMessageOps.sendFile = vi.fn().mockResolvedValue(mockSendResult);
    driver.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(mockSendResult);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: 'int2024', name: 'int2024', type: 'private', unread: false },
      { id: '1-29467', name: '测试123', type: 'group', unread: false },
    ]);
    driver.selectSession = vi.fn().mockResolvedValue(true);
    driver.getCurrentSession = vi.fn().mockResolvedValue({
      id: 'int2024',
      name: 'int2024',
      type: 'private',
      unread: false,
      active: true,
    });

    // 1. 私聊发送文本
    const resText = await driver.sendText('私聊测试', { targetSessionId: 'int2024' });
    expect(resText.success).toBe(true);
    expect(driver.isBotSentMessageId('int2024', 'msg_ack_1001')).toBe(true);

    // 2. 群聊发送富文本与 @提及
    const resRich = await driver.sendRichText('**群聊公告**', {
      targetSessionId: '测试123',
      mentions: ['all'],
    });
    expect(resRich.success).toBe(true);

    // 3. 群聊发送引用回复
    const resReply = await driver.sendReply('orig_msg_1', '回复内容', {
      targetSessionId: '测试123',
    });
    expect(resReply.success).toBe(true);

    // 4. 发送文件
    const resFile = await driver.sendFile('test.pdf', { targetSessionId: 'int2024' });
    expect(resFile.success).toBe(true);

    // 5. 发送图片
    const resImg = await driver.sendImage('test.png', { targetSessionId: 'int2024' });
    expect(resImg.success).toBe(true);
  });

  it('Bridge 成功返回空历史时不得触发 DOM fallback', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const bridgeResult = vi.fn().mockResolvedValue({ kind: 'ok', value: [] });
    Object.assign(driver.bridgeMessageOps, { getRecentMessagesResult: bridgeResult });
    driver.bridgeMessageOps.getRecentMessages = vi.fn().mockResolvedValue([]);
    driver.domMessageOps.getRecentMessages = vi.fn().mockResolvedValue([
      {
        id: 'wrong-dom-message',
        sessionId: '0-3585',
        sessionName: 'int2024',
        sessionType: 'private',
        sender: '错误会话',
        content: '不应返回',
        time: '12:00',
        isMe: false,
        timestamp: Date.now(),
      },
    ]);

    const result = await driver.getRecentMessages(20, {
      id: '0-3585',
      name: 'int2024',
      type: 'private',
      unread: false,
    });

    expect(result).toEqual([]);
    expect(driver.domMessageOps.getRecentMessages).not.toHaveBeenCalled();
  });

  it('Bridge 不可用且显式目标不是当前 DOM 会话时必须 Fail-Closed', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const bridgeResult = vi.fn().mockResolvedValue({ kind: 'unavailable', error: 'IPC failed' });
    Object.assign(driver.bridgeMessageOps, { getRecentMessagesResult: bridgeResult });
    driver.bridgeMessageOps.getRecentMessages = vi.fn().mockResolvedValue([]);
    const getActiveSessionId = vi.fn().mockResolvedValue('1-29467');
    Object.assign(driver.domSessionOps, { getActiveSessionId });
    driver.domMessageOps.getRecentMessages = vi.fn().mockResolvedValue([
      {
        id: 'group-message',
        sessionId: '0-3585',
        sessionName: 'int2024',
        sessionType: 'private',
        sender: '群成员',
        content: '当前群消息',
        time: '12:00',
        isMe: false,
        timestamp: Date.now(),
      },
    ]);

    const result = await driver.getRecentMessages(20, {
      id: '0-3585',
      name: 'int2024',
      type: 'private',
      unread: false,
    });

    expect(result).toEqual([]);
    expect(driver.domMessageOps.getRecentMessages).not.toHaveBeenCalled();
  });

  it('Bridge 不可用时仅允许对当前精确 DOM 会话执行 fallback', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const bridgeResult = vi.fn().mockResolvedValue({ kind: 'unavailable', error: 'IPC failed' });
    Object.assign(driver.bridgeMessageOps, { getRecentMessagesResult: bridgeResult });
    driver.bridgeMessageOps.getRecentMessages = vi.fn().mockResolvedValue([]);
    Object.assign(driver.domSessionOps, {
      getActiveSessionId: vi.fn().mockResolvedValue('0-3585'),
    });
    const domMessage: KK9Message = {
      id: 'current-dom-message',
      sessionId: '0-3585',
      sessionName: 'int2024',
      sessionType: 'private',
      sender: 'int2024',
      content: '当前会话消息',
      time: '12:00',
      isMe: false,
      timestamp: Date.now(),
    };
    driver.domMessageOps.getRecentMessages = vi.fn().mockResolvedValue([domMessage]);

    const result = await driver.getRecentMessages(20, {
      id: '0-3585',
      name: 'int2024',
      type: 'private',
      unread: false,
    });

    expect(result).toEqual([domMessage]);
    expect(driver.domMessageOps.getRecentMessages).toHaveBeenCalledOnce();
  });

  it('指定目标的 Bridge pre-trigger 拒绝不得被 DOM fallback 绕过', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const bridgeFailure: SendResult = {
      success: false,
      error: '目标会话不唯一',
      isPreTrigger: true,
    };
    const domSuccess: SendResult = { success: true, messageId: 'wrong-session' };
    driver.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(bridgeFailure);
    driver.bridgeMessageOps.sendRichText = vi.fn().mockResolvedValue(bridgeFailure);
    driver.bridgeMessageOps.sendReply = vi.fn().mockResolvedValue(bridgeFailure);
    driver.bridgeMessageOps.sendFile = vi.fn().mockResolvedValue(bridgeFailure);
    driver.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(bridgeFailure);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: 'first', name: '重复会话', type: 'group', unread: false },
      { id: 'second', name: '重复会话', type: 'group', unread: false },
    ]);
    driver.domSendOps.sendText = vi.fn().mockResolvedValue(domSuccess);
    driver.domSendOps.sendRichText = vi.fn().mockResolvedValue(domSuccess);
    driver.domSendOps.sendReply = vi.fn().mockResolvedValue(domSuccess);
    driver.domSendOps.sendFile = vi.fn().mockResolvedValue(domSuccess);
    driver.domSendOps.sendImage = vi.fn().mockResolvedValue(domSuccess);

    const results = await Promise.all([
      driver.sendText('文本', { targetSessionId: '重复会话' }),
      driver.sendRichText('富文本', { targetSessionId: '重复会话' }),
      driver.sendReply('msg-1', '回复', { targetSessionId: '重复会话' }),
      driver.sendFile('file.txt', { targetSessionId: '重复会话' }),
      driver.sendImage('image.png', { targetSessionId: '重复会话' }),
    ]);

    expect(results.every(result => result.success === false)).toBe(true);
    expect(driver.domSendOps.sendText).not.toHaveBeenCalled();
    expect(driver.domSendOps.sendRichText).not.toHaveBeenCalled();
    expect(driver.domSendOps.sendReply).not.toHaveBeenCalled();
    expect(driver.domSendOps.sendFile).not.toHaveBeenCalled();
    expect(driver.domSendOps.sendImage).not.toHaveBeenCalled();
  });

  it('未指定目标的 pre-trigger 失败仍可回退当前 DOM 会话', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    driver.bridgeMessageOps.sendText = vi.fn().mockResolvedValue({
      success: false,
      isPreTrigger: true,
    });
    driver.domSendOps.sendText = vi.fn().mockResolvedValue({ success: true });

    const result = await driver.sendText('当前会话文本');

    expect(result.success).toBe(true);
    expect(driver.domSendOps.sendText).toHaveBeenCalledOnce();
  });

  it('向指定会话发送图片时应直接通过 Bridge IPC 发送 (无需切换 UI 会话)', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: '0-3585', name: 'int2024', type: 'private', unread: false },
    ]);
    driver.selectSession = vi.fn().mockResolvedValue(true);
    driver.getCurrentSession = vi.fn().mockResolvedValue({
      id: '0-3585',
      name: 'int2024',
      type: 'private',
      unread: false,
      active: true,
    });
    driver.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue({ success: true, messageId: '1001' });

    const result = await driver.sendImage('image.png', { targetSessionId: '0-3585' });

    expect(result.success).toBe(true);
    expect(driver.selectSession).not.toHaveBeenCalled();
    expect(driver.bridgeMessageOps.sendImage).toHaveBeenCalledWith('image.png', {
      targetSessionId: '0-3585',
    });
  });

  it('Driver 顶层必须拒绝全局重名会话的 select 与 markRead', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: '1-29467', name: '测试123', type: 'group', unread: false },
      { id: '1-26519', name: '测试123', type: 'group', unread: false },
    ]);
    driver.bridgeSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    driver.domSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    driver.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    expect(await driver.selectSession('测试123')).toBe(false);
    expect(await driver.markSessionRead('测试123')).toBe(false);
    expect(driver.bridgeSessionOps.selectSession).not.toHaveBeenCalled();
    expect(driver.domSessionOps.selectSession).not.toHaveBeenCalled();
    expect(driver.bridgeSessionOps.markSessionRead).not.toHaveBeenCalled();
  });

  it('会话管理应优先调用 Bridge 会话服务', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });

    const mockSessions: KK9Session[] = [
      { id: '0-3585', name: 'int2024', type: 'private', unread: false },
      { id: '1-29467', name: '测试123', type: 'group', unread: true, unreadCount: 3 },
    ];

    driver.bridgeSessionOps.getSessions = vi.fn().mockResolvedValue(mockSessions);
    driver.bridgeSessionOps.getCurrentSession = vi.fn().mockResolvedValue(mockSessions[0]);
    driver.bridgeSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    driver.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);

    const current = await driver.getCurrentSession();
    expect(current?.name).toBe('int2024');

    const switched = await driver.selectSession('测试123');
    expect(switched).toBe(true);
    expect(driver.bridgeSessionOps.selectSession).toHaveBeenCalledWith('1-29467');

    const markRes = await driver.markSessionRead('测试123');
    expect(markRes).toBe(true);
  });

  it('Bridge 已读失败时不得通过 DOM 隐藏红点并伪报成功', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: '0-3585', name: 'int2024', type: 'private', unread: false },
    ]);
    driver.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(false);
    driver.domSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    const result = await driver.markSessionRead('0-3585');

    expect(result).toBe(false);
    expect(driver.domSessionOps.markSessionRead).not.toHaveBeenCalled();
  });

  it('组织架构查询应优先调用 Bridge 组织架构服务', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });

    const mockEmployee: KK9Employee = {
      id: 5761,
      loginName: '0123040139',
      name: '董仕林',
      position: 'IT开发工程师',
      deptPaths: [{ id: 15, name: '联合光电' }, { id: 29, name: 'IT组' }],
      updatedAt: Date.now(),
    };

    driver.bridgeOrgOps.getOrgEmployees = vi.fn().mockResolvedValue([mockEmployee]);
    driver.bridgeOrgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

    const employees = await driver.getOrgEmployees(5000);
    expect(employees).toHaveLength(1);
    expect(employees[0]?.name).toBe('董仕林');

    const profile = await driver.getUserProfile(5761);
    expect(profile).not.toBeNull();
    expect(profile?.loginName).toBe('0123040139');
  });

  it('消息撤回与撤回事件监听', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });

    driver.getSessions = vi.fn().mockResolvedValue([
      { id: '0-3585', name: 'int2024', type: 'private', unread: false },
    ]);
    driver.bridgeMessageOps.recallMessage = vi.fn().mockResolvedValue(true);

    const ok = await driver.recallMessage('msg_1001', 'int2024');
    expect(ok).toBe(true);
    expect(driver.bridgeMessageOps.recallMessage).toHaveBeenCalledWith('msg_1001', '0-3585');

    const recalledEvents: unknown[] = [];
    driver.on('recalled', evt => recalledEvents.push(evt));

    driver.handleRecalledEvent({
      messageId: 'msg_1001',
      sessionId: 'int2024',
      sender: '我',
      time: '12:00',
    });

    // 重复相同 messageKey 自动去重
    driver.handleRecalledEvent({
      messageId: 'msg_1001',
      sessionId: 'int2024',
      sender: '我',
      time: '12:00',
    });

    expect(recalledEvents).toHaveLength(1);
  });
});
