import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KK9Driver, KK9Message, KK9RecalledEvent, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import type { AgentReplyResult, KkbotAgentRuntime } from '@kkbot/agent';
import { SessionCoordinator } from '../src/coordinator.js';

class MockDriver extends EventEmitter {
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'mock_reply_id',
  } as SendResult);
  public sendRichText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'mock_reply_id',
  } as SendResult);

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
  }
}

function createGroupMessage(overrides: Partial<KK9Message> = {}): KK9Message {
  const id = overrides.id || `group_msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    messageId: overrides.messageId || id,
    sessionId: overrides.sessionId || 'group_tech_discuss',
    sessionName: '技术研讨群',
    sessionType: 'group',
    origin: overrides.origin || 'external',
    sender: overrides.sender || '张三',
    senderId: overrides.senderId || 'user_zhang',
    content: overrides.content || '大家看一下这个架构方案。',
    time: '11:00',
    isMe: overrides.isMe ?? false,
    timestamp: overrides.timestamp || Date.now(),
    messageType: overrides.messageType || 'text',
    ...overrides,
  };
}

describe('Gateway GroupSession 强制短路与 Raw Store-only 分流测试 (TDD Red -> Green)', () => {
  let mockDriver: MockDriver;
  let store: KKBotStore;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    mockDriver = new MockDriver();
    store = await createKKBotStore({ path: ':memory:' });
    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      config: {
        debounceMs: 100,
        maxWaitMs: 300,
      },
    });
    await coordinator.start();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
    if (store) {
      store.close();
    }
  });

  describe('1. 群聊各类型消息 Raw Store-only 短路', () => {
    it('普通群聊文本消息应只写入 Raw Store 并立即结束，零下游调用', async () => {
      const groupMsg = createGroupMessage({ content: '普通群消息' });

      const onConsolidated = vi.fn();
      coordinator.on('consolidated', onConsolidated);
      const onGroupSaved = vi.fn();
      coordinator.on('group_message_saved', onGroupSaved);

      const sessionUpsertSpy = vi.spyOn(store.sessions, 'upsertSession');
      const sessionTouchSpy = vi.spyOn(store.sessions, 'touchMessageTime');

      await coordinator.handleInboundMessage(groupMsg);

      // 1. 验证 Raw Store 持久化成功
      const saved = await store.messages.getMessageBySessionAndMessageId(
        groupMsg.sessionId,
        groupMsg.messageId || groupMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.content).toBe('普通群消息');
      expect(saved?.sessionId).toBe(groupMsg.sessionId);
      expect(onGroupSaved).toHaveBeenCalledTimes(1);

      // 2. 验证零防抖、零发送、零合并
      expect(coordinator.pendingSessionCount).toBe(0);
      expect(coordinator.getPendingQueue(groupMsg.sessionId)).toHaveLength(0);
      expect(onConsolidated).not.toHaveBeenCalled();
      expect(mockDriver.sendText).not.toHaveBeenCalled();
      expect(mockDriver.sendRichText).not.toHaveBeenCalled();
      expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

      // 3. 验证无额外 session 状态写入 (唯一副作用仅为 store.messages.saveMessage)
      expect(sessionUpsertSpy).not.toHaveBeenCalled();
      expect(sessionTouchSpy).not.toHaveBeenCalled();
    });

    it('群聊中 @我 消息应只写入 Raw Store，不得触发自动回复', async () => {
      const atMeMsg = createGroupMessage({
        content: '@智能助手 请问明天的会议时间？',
        atMe: true,
        mentions: {
          isAtMe: true,
          isAtAll: false,
          mentionedUsers: ['bot_uid'],
        },
      });

      await coordinator.handleInboundMessage(atMeMsg);

      const saved = await store.messages.getMessageBySessionAndMessageId(
        atMeMsg.sessionId,
        atMeMsg.messageId || atMeMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.rawPayload?.mentions?.isAtMe).toBe(true);
      expect(saved?.rawPayload?.mentions?.mentionedUsers).toContain('bot_uid');
      expect(coordinator.pendingSessionCount).toBe(0);
      expect(mockDriver.sendText).not.toHaveBeenCalled();
    });

    it('群聊中 @全体 消息应只写入 Raw Store', async () => {
      const atAllMsg = createGroupMessage({
        content: '@全体成员 请大家准时参加晚会',
        atAll: true,
        mentions: {
          isAtMe: false,
          isAtAll: true,
          mentionedUsers: ['all'],
        },
      });

      await coordinator.handleInboundMessage(atAllMsg);

      const saved = await store.messages.getMessageBySessionAndMessageId(
        atAllMsg.sessionId,
        atAllMsg.messageId || atAllMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.rawPayload?.mentions?.isAtAll).toBe(true);
      expect(saved?.rawPayload?.mentions?.mentionedUsers).toContain('all');
      expect(coordinator.pendingSessionCount).toBe(0);
      expect(mockDriver.sendText).not.toHaveBeenCalled();
    });

    it('群聊引用回复消息应只写入 Raw Store', async () => {
      const quoteMsg = createGroupMessage({
        content: '赞同这个方案',
        messageType: 'quote',
        replyTo: {
          replyToId: 'quote_orig_1',
          replyToSender: '李工',
          replyToContent: '建议采用模块化架构',
        },
      });

      await coordinator.handleInboundMessage(quoteMsg);

      const saved = await store.messages.getMessageBySessionAndMessageId(
        quoteMsg.sessionId,
        quoteMsg.messageId || quoteMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.messageType).toBe('quote');
      expect(saved?.replyTargetId).toBe('quote_orig_1');
      expect(saved?.rawPayload?.replyTo?.replyToSender).toBe('李工');
      expect(saved?.rawPayload?.replyTo?.replyToContent).toBe('建议采用模块化架构');
      expect(mockDriver.sendText).not.toHaveBeenCalled();
    });

    it('群聊带文件和图片附件消息应只写入 Raw Store', async () => {
      const fileMsg = createGroupMessage({
        content: '[文件: 设计稿.fig]',
        messageType: 'file',
        fileInfo: {
          fileName: '设计稿.fig',
          fileSize: '12MB',
          filePath: 'C:\\cache\\设计稿.fig',
        },
      });

      await coordinator.handleInboundMessage(fileMsg);

      const saved = await store.messages.getMessageBySessionAndMessageId(
        fileMsg.sessionId,
        fileMsg.messageId || fileMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.messageType).toBe('file');
      expect(saved?.rawPayload?.fileInfo?.fileName).toBe('设计稿.fig');
      expect(saved?.rawPayload?.fileInfo?.fileSize).toBe('12MB');
      expect(mockDriver.sendText).not.toHaveBeenCalled();
    });

    it('群聊中当前账号发言 (operator / bot_echo) 应只写入 Raw Store，且不触发 HumanTakeover', async () => {
      const operatorGroupMsg = createGroupMessage({
        content: '我在群里说一句',
        isMe: true,
        origin: 'operator',
        sender: '我',
      });

      const onTakeover = vi.fn();
      coordinator.on('takeover', onTakeover);

      await coordinator.handleInboundMessage(operatorGroupMsg);

      const saved = await store.messages.getMessageBySessionAndMessageId(
        operatorGroupMsg.sessionId,
        operatorGroupMsg.messageId || operatorGroupMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.isFromSelf).toBe(true);

      // 群聊中的操作员发言不触发 HumanTakeover（因为 HumanTakeover 仅针对私聊）
      expect(onTakeover).not.toHaveBeenCalled();
      const isTakeover = await coordinator.isTakeoverActive(operatorGroupMsg.sessionId);
      expect(isTakeover).toBe(false);
    });

    it('群聊 system 系统提示消息应只写入 Raw Store', async () => {
      const systemMsg = createGroupMessage({
        content: '赵六 已经加入群聊',
        messageType: 'system',
        origin: 'system',
        sender: '系统通知',
      });

      await coordinator.handleInboundMessage(systemMsg);

      const saved = await store.messages.getMessageBySessionAndMessageId(
        systemMsg.sessionId,
        systemMsg.messageId || systemMsg.id
      );
      expect(saved).not.toBeNull();
      expect(saved?.origin).toBe('system');
      expect(mockDriver.sendText).not.toHaveBeenCalled();
    });
  });

  describe('2. 防抖队列与会话隔离保护', () => {
    it('群聊消息绝不进入 PendingBucket，pendingSessionCount 保持为 0', async () => {
      const groupMsg = createGroupMessage();
      await coordinator.handleInboundMessage(groupMsg);

      expect(coordinator.pendingSessionCount).toBe(0);
      expect(coordinator.getPendingQueue(groupMsg.sessionId)).toEqual([]);
    });

    it('通过公开入口启动同 sessionId 的 PrivateSession 在途 Run，群聊消息绝不会 Abort 该在途 Run', async () => {
      const targetSessionId = 'session_concurrent_same_id';
      const { promise: waitingAgentPromise, resolve: resolveAgentRun } =
        Promise.withResolvers<AgentReplyResult>();
      let capturedSignal: AbortSignal | null = null;

      const fakeAgentRuntime = {
        execute: vi
          .fn()
          .mockImplementation(
            (
              _sid: string,
              _msg: unknown,
              opts?: { signal?: AbortSignal }
            ): Promise<AgentReplyResult> => {
              capturedSignal = opts?.signal ?? null;
              return waitingAgentPromise;
            }
          ),
      } as unknown as KkbotAgentRuntime;

      const testCoordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime: fakeAgentRuntime,
        config: {
          debounceMs: 10,
          maxWaitMs: 50,
        },
      });
      await testCoordinator.start();

      const inFlightAbortedSpy = vi.fn();
      testCoordinator.on('in_flight_aborted', inFlightAbortedSpy);

      // 1. 通过公开入站入口发送 PrivateSession 消息
      const privateMsg: KK9Message = {
        id: 'priv_msg_1',
        messageId: 'priv_msg_1',
        sessionId: targetSessionId,
        sessionName: '私聊并发目标',
        sessionType: 'private',
        origin: 'external',
        sender: '员工',
        content: '发起耗时生成任务',
        time: '12:00',
        isMe: false,
        timestamp: Date.now(),
      };
      const { promise: startedPromise, resolve: resolveStarted } = Promise.withResolvers<void>();
      testCoordinator.once('agent_started', () => {
        resolveStarted();
      });
      await testCoordinator.handleInboundMessage(privateMsg);
      const flushPromise = testCoordinator.flushSession(targetSessionId);
      await startedPromise;

      // 验证在途会话已建立
      expect(testCoordinator.hasInFlightSession(targetSessionId)).toBe(true);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      // 2. 发送具有【相同 sessionId】的群聊消息
      const sameIdGroupMsg: KK9Message = {
        id: 'grp_same_id_msg',
        messageId: 'grp_same_id_msg',
        sessionId: targetSessionId,
        sessionName: '相同ID的群消息',
        sessionType: 'group',
        origin: 'external',
        sender: '群成员',
        content: '同 ID 群聊消息到达，不应打断在途私聊',
        time: '12:01',
        isMe: false,
        timestamp: Date.now(),
      };

      await testCoordinator.handleInboundMessage(sameIdGroupMsg);

      // 3. 严格断言：私聊在途 Run 未被 abort，未触发 in_flight_aborted
      expect(capturedSignal!.aborted).toBe(false);
      expect(inFlightAbortedSpy).not.toHaveBeenCalled();
      expect(testCoordinator.hasInFlightSession(targetSessionId)).toBe(true);

      // 4. 对照验证：发送同 sessionId 的 PrivateSession 消息时，必须触发打断
      const secondPrivateMsg: KK9Message = {
        id: 'priv_msg_2',
        messageId: 'priv_msg_2',
        sessionId: targetSessionId,
        sessionName: '私聊并发目标',
        sessionType: 'private',
        origin: 'external',
        sender: '员工',
        content: '第二条私聊消息，应当打断在途生成',
        time: '12:02',
        isMe: false,
        timestamp: Date.now(),
      };
      await testCoordinator.handleInboundMessage(secondPrivateMsg);

      expect(capturedSignal!.aborted).toBe(true);
      expect(inFlightAbortedSpy).toHaveBeenCalledWith(
        targetSessionId,
        expect.any(Number),
        'new_inbound_message'
      );

      resolveAgentRun({ content: '完成', finishReason: 'stop' });
      await flushPromise;
      await testCoordinator.stop();
    });
  });

  describe('3. Raw Store 写入失败保护与诊断', () => {
    it('Raw Store 写入失败时记录诊断错误并立即终止，绝不进入下游或升级为 PrivateSession', async () => {
      // 模拟 Store 抛出持久化异常
      const saveError = new Error('Disk IO write failure');
      vi.spyOn(store.messages, 'saveMessage').mockRejectedValueOnce(saveError);

      const groupMsg = createGroupMessage({ content: '写入失败测试群消息' });

      const onSaveFailed = vi.fn();
      coordinator.on('group_message_save_failed', onSaveFailed);
      const onConsolidated = vi.fn();
      coordinator.on('consolidated', onConsolidated);

      await coordinator.handleInboundMessage(groupMsg);

      expect(onSaveFailed).toHaveBeenCalledWith(groupMsg.sessionId, groupMsg, expect.any(Error));
      expect(onConsolidated).not.toHaveBeenCalled();
      expect(mockDriver.sendText).not.toHaveBeenCalled();
      expect(coordinator.pendingSessionCount).toBe(0);
    });
  });
});
