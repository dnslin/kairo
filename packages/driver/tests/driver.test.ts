import { describe, expect, it, vi } from 'vitest';
import { FakeKK9Driver } from '../src/fake-driver.js';
import { KK9Driver } from '../src/driver.js';
import type {
  IKK9Driver,
  KK9Employee,
  KK9Message,
  KK9Session,
  SendResult,
} from '../src/types/index.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';

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
    const internals = getDriverTestInternals(driver);

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
        direction: 'inbound',
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
        direction: 'inbound',
        atMe: true,
        mentions: {
          isAtMe: true,
          isAtAll: false,
          mentionedUsers: ['机器人'],
        },
        timestamp: Date.now() + 1000,
      },
    ];

    Object.assign(internals.bridgeMessageOps, {
      getRecentMessagesResult: vi.fn().mockResolvedValue({ kind: 'ok', value: mockMessages }),
    });

    await internals.collectAndEmitMessages(
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
    const internals = getDriverTestInternals(driver);

    const mockSendResult: SendResult = {
      success: true,
      messageId: 'msg_ack_1001',
      verifyLatencyMs: 12,
    };

    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendRichText = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendReply = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendFile = vi.fn().mockResolvedValue(mockSendResult);
    internals.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(mockSendResult);
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
    const internals = getDriverTestInternals(driver);
    const bridgeResult = vi.fn().mockResolvedValue({ kind: 'ok', value: [] });
    Object.assign(internals.bridgeMessageOps, { getRecentMessagesResult: bridgeResult });
    internals.bridgeMessageOps.getRecentMessages = vi.fn().mockResolvedValue([]);
    internals.domMessageOps.getRecentMessages = vi.fn().mockResolvedValue([
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
    expect(internals.domMessageOps.getRecentMessages).not.toHaveBeenCalled();
  });

  it('Bridge 不可用且显式目标不是当前 DOM 会话时必须 Fail-Closed', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    const bridgeResult = vi.fn().mockResolvedValue({ kind: 'unavailable', error: 'IPC failed' });
    Object.assign(internals.bridgeMessageOps, { getRecentMessagesResult: bridgeResult });
    internals.bridgeMessageOps.getRecentMessages = vi.fn().mockResolvedValue([]);
    const getActiveSessionId = vi.fn().mockResolvedValue('1-29467');
    Object.assign(internals.domSessionOps, { getActiveSessionId });
    internals.domMessageOps.getRecentMessages = vi.fn().mockResolvedValue([
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
    expect(internals.domMessageOps.getRecentMessages).not.toHaveBeenCalled();
  });

  it('Bridge 不可用时仅允许对当前精确 DOM 会话执行 fallback', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    const bridgeResult = vi.fn().mockResolvedValue({ kind: 'unavailable', error: 'IPC failed' });
    Object.assign(internals.bridgeMessageOps, { getRecentMessagesResult: bridgeResult });
    internals.bridgeMessageOps.getRecentMessages = vi.fn().mockResolvedValue([]);
    Object.assign(internals.domSessionOps, {
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
      direction: 'inbound',
      timestamp: Date.now(),
    };
    internals.domMessageOps.getRecentMessages = vi.fn().mockResolvedValue([domMessage]);

    const result = await driver.getRecentMessages(20, {
      id: '0-3585',
      name: 'int2024',
      type: 'private',
      unread: false,
    });

    expect(result).toEqual([domMessage]);
    expect(internals.domMessageOps.getRecentMessages).toHaveBeenCalledOnce();
  });

  it('指定目标的 Bridge pre-trigger 拒绝不得被 DOM fallback 绕过', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    const bridgeFailure: SendResult = {
      success: false,
      error: '目标会话不唯一',
      isPreTrigger: true,
    };
    const domSuccess: SendResult = { success: true, messageId: 'wrong-session' };
    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendRichText = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendReply = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendFile = vi.fn().mockResolvedValue(bridgeFailure);
    internals.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(bridgeFailure);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: 'first', name: '重复会话', type: 'group', unread: false },
      { id: 'second', name: '重复会话', type: 'group', unread: false },
    ]);
    internals.domSendOps.sendText = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendRichText = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendReply = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendFile = vi.fn().mockResolvedValue(domSuccess);
    internals.domSendOps.sendImage = vi.fn().mockResolvedValue(domSuccess);

    const results = await Promise.all([
      driver.sendText('文本', { targetSessionId: '重复会话' }),
      driver.sendRichText('富文本', { targetSessionId: '重复会话' }),
      driver.sendReply('msg-1', '回复', { targetSessionId: '重复会话' }),
      driver.sendFile('file.txt', { targetSessionId: '重复会话' }),
      driver.sendImage('image.png', { targetSessionId: '重复会话' }),
    ]);

    expect(results.every(result => result.success === false)).toBe(true);
    expect(internals.domSendOps.sendText).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendRichText).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendReply).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendFile).not.toHaveBeenCalled();
    expect(internals.domSendOps.sendImage).not.toHaveBeenCalled();
  });

  it('未指定目标的 pre-trigger 失败仍可回退当前 DOM 会话', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue({
      success: false,
      isPreTrigger: true,
    });
    internals.domSendOps.sendText = vi.fn().mockResolvedValue({ success: true });

    const result = await driver.sendText('当前会话文本');

    expect(result.success).toBe(true);
    expect(internals.domSendOps.sendText).toHaveBeenCalledOnce();
  });

  it('向指定会话发送图片时应直接通过 Bridge IPC 发送 (无需切换 UI 会话)', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    driver.getSessions = vi
      .fn()
      .mockResolvedValue([{ id: '0-3585', name: 'int2024', type: 'private', unread: false }]);
    driver.selectSession = vi.fn().mockResolvedValue(true);
    driver.getCurrentSession = vi.fn().mockResolvedValue({
      id: '0-3585',
      name: 'int2024',
      type: 'private',
      unread: false,
      active: true,
    });
    internals.bridgeMessageOps.sendImage = vi
      .fn()
      .mockResolvedValue({ success: true, messageId: '1001' });

    const result = await driver.sendImage('image.png', { targetSessionId: '0-3585' });

    expect(result.success).toBe(true);
    expect(driver.selectSession).not.toHaveBeenCalled();
    expect(internals.bridgeMessageOps.sendImage).toHaveBeenCalledWith('image.png', {
      targetSessionId: '0-3585',
    });
  });

  it('Driver 顶层必须拒绝全局重名会话的 select 与 markRead', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);
    driver.getSessions = vi.fn().mockResolvedValue([
      { id: '1-29467', name: '测试123', type: 'group', unread: false },
      { id: '1-26519', name: '测试123', type: 'group', unread: false },
    ]);
    internals.bridgeSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    internals.domSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    internals.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    expect(await driver.selectSession('测试123')).toBe(false);
    expect(await driver.markSessionRead('测试123')).toBe(false);
    expect(internals.bridgeSessionOps.selectSession).not.toHaveBeenCalled();
    expect(internals.domSessionOps.selectSession).not.toHaveBeenCalled();
    expect(internals.bridgeSessionOps.markSessionRead).not.toHaveBeenCalled();
  });

  it('会话管理应优先调用 Bridge 会话服务', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);

    const mockSessions: KK9Session[] = [
      { id: '0-3585', name: 'int2024', type: 'private', unread: false },
      { id: '1-29467', name: '测试123', type: 'group', unread: true, unreadCount: 3 },
    ];

    internals.bridgeSessionOps.getSessions = vi.fn().mockResolvedValue(mockSessions);
    internals.bridgeSessionOps.getCurrentSession = vi.fn().mockResolvedValue(mockSessions[0]);
    internals.bridgeSessionOps.selectSession = vi.fn().mockResolvedValue(true);
    internals.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    const sessions = await driver.getSessions();
    expect(sessions).toHaveLength(2);

    const current = await driver.getCurrentSession();
    expect(current?.name).toBe('int2024');

    const switched = await driver.selectSession('测试123');
    expect(switched).toBe(true);
    expect(internals.bridgeSessionOps.selectSession).toHaveBeenCalledWith('1-29467');

    const markRes = await driver.markSessionRead('测试123');
    expect(markRes).toBe(true);
  });

  it('Bridge 已读失败时不得通过 DOM 隐藏红点并伪报成功', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);
    driver.getSessions = vi
      .fn()
      .mockResolvedValue([{ id: '0-3585', name: 'int2024', type: 'private', unread: false }]);
    internals.bridgeSessionOps.markSessionRead = vi.fn().mockResolvedValue(false);
    internals.domSessionOps.markSessionRead = vi.fn().mockResolvedValue(true);

    const result = await driver.markSessionRead('0-3585');

    expect(result).toBe(false);
    expect(internals.domSessionOps.markSessionRead).not.toHaveBeenCalled();
  });

  it('组织架构查询应优先调用 Bridge 组织架构服务', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
    });
    const internals = getDriverTestInternals(driver);

    const mockEmployee: KK9Employee = {
      id: 5761,
      loginName: '0123040139',
      name: '董仕林',
      position: 'IT开发工程师',
      deptPaths: [
        { id: 15, name: '联合光电' },
        { id: 29, name: 'IT组' },
      ],
      updatedAt: Date.now(),
    };

    internals.bridgeOrgOps.getOrgEmployees = vi.fn().mockResolvedValue([mockEmployee]);
    internals.bridgeOrgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

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
    const internals = getDriverTestInternals(driver);

    driver.getSessions = vi
      .fn()
      .mockResolvedValue([{ id: '0-3585', name: 'int2024', type: 'private', unread: false }]);
    internals.bridgeMessageOps.recallMessage = vi.fn().mockResolvedValue(true);

    const ok = await driver.recallMessage('msg_1001', 'int2024');
    expect(ok).toBe(true);
    expect(internals.bridgeMessageOps.recallMessage).toHaveBeenCalledWith('msg_1001', '0-3585');

    const recalledEvents: unknown[] = [];
    driver.on('recalled', evt => recalledEvents.push(evt));

    internals.handleRecalledEvent({
      messageId: 'msg_1001',
      sessionId: 'int2024',
      sender: '我',
      time: '12:00',
    });

    // 重复相同 messageKey 自动去重
    internals.handleRecalledEvent({
      messageId: 'msg_1001',
      sessionId: 'int2024',
      sender: '我',
      time: '12:00',
    });

    expect(recalledEvents).toHaveLength(1);
  });

  describe('getEmployeeBySession 会话员工档案查询', () => {
    it('应支持通过私聊会话 ID 字符串 (0-xxxx) 直接查询员工档案', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
      });
      const internals = getDriverTestInternals(driver);
      const mockEmployee: KK9Employee = {
        id: 9529,
        loginName: '0125090014',
        name: '杨晓君',
        position: '采购助理工程师',
        updatedAt: Date.now(),
      };
      internals.bridgeOrgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

      const profile = await driver.getEmployeeBySession('0-9529');
      expect(profile).not.toBeNull();
      expect(profile?.name).toBe('杨晓君');
      expect(profile?.loginName).toBe('0125090014');
      expect(internals.bridgeOrgOps.getUserProfile).toHaveBeenCalledWith('9529');
    });

    it('应支持通过 KK9Session 私聊实体查询员工档案', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
      });
      const internals = getDriverTestInternals(driver);
      const mockEmployee: KK9Employee = {
        id: 7783,
        loginName: '0124070224',
        name: '陈鹏',
        position: 'IT应用系统工程师',
        updatedAt: Date.now(),
      };
      internals.bridgeOrgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

      const session: KK9Session = {
        id: '0-7783',
        name: '陈鹏',
        type: 'private',
        unread: false,
      };
      const profile = await driver.getEmployeeBySession(session);
      expect(profile).not.toBeNull();
      expect(profile?.name).toBe('陈鹏');
      expect(profile?.loginName).toBe('0124070224');
    });

    it('群聊会话 ID (1-xxxx) 或群聊实体必须直接返回 null', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
      });
      const internals = getDriverTestInternals(driver);
      internals.bridgeOrgOps.getUserProfile = vi.fn();

      const byString = await driver.getEmployeeBySession('1-16733');
      expect(byString).toBeNull();

      const groupSession: KK9Session = {
        id: '1-16733',
        name: '财务大家庭',
        type: 'group',
        unread: false,
      };
      const byEntity = await driver.getEmployeeBySession(groupSession);
      expect(byEntity).toBeNull();
      expect(internals.bridgeOrgOps.getUserProfile).not.toHaveBeenCalled();
    });

    it('传入私聊会话名称时应自动解析目标并返回档案', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
      });
      const internals = getDriverTestInternals(driver);
      driver.getSessions = vi
        .fn()
        .mockResolvedValue([{ id: '0-11403', name: '沈文林', type: 'private', unread: false }]);
      const mockEmployee: KK9Employee = {
        id: 11403,
        loginName: '0126080260',
        name: '沈文林',
        position: 'IT桌网工程师',
        updatedAt: Date.now(),
      };
      internals.bridgeOrgOps.getUserProfile = vi.fn().mockResolvedValue(mockEmployee);

      const profile = await driver.getEmployeeBySession('沈文林');
      expect(profile).not.toBeNull();
      expect(profile?.name).toBe('沈文林');
      expect(profile?.loginName).toBe('0126080260');
    });

    it('无效空输入应直接返回 null', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://localhost:9222', pageMatch: 'test' },
      });
      expect(await driver.getEmployeeBySession('')).toBeNull();
      expect(await driver.getEmployeeBySession('   ')).toBeNull();
    });
  });
  it('带发送操作 ID 的发送前置失败不会退回无法关联的 DOM 双发路径', async () => {
    const store = new InMemorySendOperationStore();
    const driver = new KK9Driver(
      { cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' } },
      store
    );
    const internals = getDriverTestInternals(driver);
    const bridgeFailure: SendResult = {
      success: false,
      operationId: 'op-no-dom-fallback',
      status: 'failed',
      isPreTrigger: true,
    };
    internals.bridgeMessageOps.sendText = vi.fn().mockResolvedValue(bridgeFailure);
    internals.domSendOps.sendText = vi
      .fn()
      .mockResolvedValue({ success: true, messageId: 'dom-duplicate' });

    const result = await driver.sendText('禁止 DOM 双发', { operationId: 'op-no-dom-fallback' });

    expect(result).toEqual(bridgeFailure);
    expect(internals.bridgeMessageOps.sendText).toHaveBeenCalledWith('禁止 DOM 双发', {
      operationId: 'op-no-dom-fallback',
    });
    expect(internals.domSendOps.sendText).not.toHaveBeenCalled();
  });
  it('带发送操作 ID 的图片前置失败不会退回无法关联的 DOM 双发路径', async () => {
    const store = new InMemorySendOperationStore();
    const driver = new KK9Driver(
      { cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' } },
      store
    );
    const internals = getDriverTestInternals(driver);
    const bridgeFailure: SendResult = {
      success: false,
      operationId: 'op-image-no-dom-fallback',
      status: 'failed',
      isPreTrigger: true,
    };
    internals.bridgeMessageOps.sendImage = vi.fn().mockResolvedValue(bridgeFailure);
    internals.domSendOps.sendImage = vi
      .fn()
      .mockResolvedValue({ success: false, status: 'unknown', isPreTrigger: false });

    const result = await driver.sendImage('image.png', { operationId: 'op-image-no-dom-fallback' });

    expect(result).toEqual(bridgeFailure);
    expect(internals.bridgeMessageOps.sendImage).toHaveBeenCalledWith('image.png', {
      operationId: 'op-image-no-dom-fallback',
    });
    expect(internals.domSendOps.sendImage).not.toHaveBeenCalled();
  });

  it('Driver 抽象与模拟 Driver 都支持无记录状态查询', async () => {
    const driver: IKK9Driver = new FakeKK9Driver();

    await expect(driver.getSendStatus('missing-operation')).resolves.toEqual({
      success: false,
      operationId: 'missing-operation',
      status: 'unknown',
      isPreTrigger: false,
    });
  });
});
