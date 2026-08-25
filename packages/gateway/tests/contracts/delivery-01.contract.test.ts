import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KK9Driver, KK9Message, KK9RecalledEvent, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import type { AgentReplyResult, KkbotAgentRuntime } from '@kkbot/agent';
import { SessionCoordinator } from '../../src/coordinator.js';

class MockDriver extends EventEmitter {
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'mock_bot_send_id',
  } as SendResult);
  public sendRichText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'mock_bot_send_id',
  } as SendResult);

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
  }
}

describe('DELIVERY-01 Contract: 入站身份收敛、群聊短路与数据库级幂等写入', () => {
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
        debounceMs: 50,
        maxWaitMs: 150,
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

  describe('DELIVERY-01.1: 群聊消息强制短路并沉淀为 KK Raw Store 唯一事实', () => {
    it('群聊普通消息、@我、@全体、引用、附件、操作员发言和系统消息均只写入 Raw Store 并立即终止', async () => {
      const groupSessionId = 'group_delivery_01_room';

      const scenarios: Array<{ name: string; msg: Partial<KK9Message> }> = [
        {
          name: '普通群消息',
          msg: { content: '普通讨论', messageType: 'text', origin: 'external' },
        },
        {
          name: '群聊 @我',
          msg: { content: '@机器人 帮我查个东西', atMe: true, origin: 'external' },
        },
        {
          name: '群聊 @全体',
          msg: { content: '@全体 稍后开会', atAll: true, origin: 'external' },
        },
        {
          name: '群聊引用回复',
          msg: {
            content: '好的收到',
            messageType: 'quote',
            replyTo: { replyToSender: '主管', replyToContent: '请跟进' },
            origin: 'external',
          },
        },
        {
          name: '群聊文件附件',
          msg: {
            content: '[文件: report.pdf]',
            messageType: 'file',
            fileInfo: { fileName: 'report.pdf', fileSize: '2MB' },
            origin: 'external',
          },
        },
        {
          name: '群聊操作员发言',
          msg: { content: '我在群里回复', isMe: true, origin: 'operator' },
        },
        {
          name: '群聊系统通知',
          msg: { content: '张三 加入了群聊', messageType: 'system', origin: 'system' },
        },
      ];

      for (let i = 0; i < scenarios.length; i++) {
        const item = scenarios[i];
        const msgId = `delivery01_group_msg_${i + 1}`;
        const groupMsg: KK9Message = {
          id: msgId,
          messageId: msgId,
          sessionId: groupSessionId,
          sessionName: 'DELIVERY-01 验证群',
          sessionType: 'group',
          origin: item.msg.origin || 'external',
          sender: '测试成员',
          senderId: 'user_tester',
          content: item.msg.content || '测试消息',
          time: '12:00',
          isMe: item.msg.isMe ?? false,
          timestamp: Date.now() + i * 100,
          messageType: item.msg.messageType || 'text',
          atMe: item.msg.atMe,
          atAll: item.msg.atAll,
          replyTo: item.msg.replyTo,
          fileInfo: item.msg.fileInfo,
        };

        await coordinator.handleInboundMessage(groupMsg);

        // 验证数据库中有且仅有该条 Raw Store 记录
        const saved = await store.messages.getMessageBySessionAndMessageId(groupSessionId, msgId);
        expect(saved).not.toBeNull();
        expect(saved?.messageId).toBe(msgId);
        expect(saved?.sessionId).toBe(groupSessionId);
        expect(saved?.origin).toBe(item.msg.origin || 'external');

        if (item.msg.atMe) {
          expect(saved?.rawPayload?.mentions?.isAtMe).toBe(true);
        }
        if (item.msg.atAll) {
          expect(saved?.rawPayload?.mentions?.isAtAll).toBe(true);
        }
        if (item.msg.replyTo) {
          expect(saved?.rawPayload?.replyTo?.replyToSender).toBe('主管');
        }
        if (item.msg.fileInfo) {
          expect(saved?.rawPayload?.fileInfo?.fileName).toBe('report.pdf');
        }
      }

      // 验证全部群聊消息均未触发任何下游发送或防抖
      expect(mockDriver.sendText).not.toHaveBeenCalled();
      expect(mockDriver.sendRichText).not.toHaveBeenCalled();
      expect(mockDriver.markSessionRead).not.toHaveBeenCalled();
      expect(coordinator.pendingSessionCount).toBe(0);

      // 验证会话消息总数刚好等于发送的场景数
      const count = await store.messages.countMessages({ sessionId: groupSessionId });
      expect(count).toBe(scenarios.length);
    });
  });

  describe('DELIVERY-01.2: 数据库级 (session_id, message_id) 幂等写入与重放保护', () => {
    it('相同 (session_id, message_id) 并发与串行重放均只形成一条事实', async () => {
      const sessionId = 'group_replay_test';
      const messageId = 'msg_strict_idempotent_001';

      const msg: KK9Message = {
        id: messageId,
        messageId,
        sessionId,
        sessionName: '重放测试群',
        sessionType: 'group',
        origin: 'external',
        sender: '李四',
        content: '幂等写入证据',
        time: '12:30',
        isMe: false,
        timestamp: Date.now(),
      };

      // 1. 并发 10 次写入
      await Promise.all(Array.from({ length: 10 }, () => coordinator.handleInboundMessage(msg)));

      // 2. 串行 5 次写入
      for (let i = 0; i < 5; i++) {
        await coordinator.handleInboundMessage(msg);
      }

      // 3. 数据库事实总数精确为 1
      const count = await store.messages.countMessages({ sessionId });
      expect(count).toBe(1);

      const history = await store.messages.getSessionHistory(sessionId);
      expect(history).toHaveLength(1);
      expect(history[0].messageId).toBe(messageId);
    });
  });

  describe('DELIVERY-01.3: 会话类型分流与 PrivateSession 独立后续入口', () => {
    it('PrivateSession 消息不走 GroupSession 短路，正常进入防抖聚合队列', async () => {
      const privateMsg: KK9Message = {
        id: 'msg_private_entry_001',
        messageId: 'msg_private_entry_001',
        sessionId: 'session_private_user_1',
        sessionName: '私聊用户',
        sessionType: 'private',
        origin: 'external',
        sender: '私聊员工',
        content: '私聊消息，需要智能协助',
        time: '13:00',
        isMe: false,
        timestamp: Date.now(),
      };

      const { promise: consolidatedPromise, resolve: resolveConsolidated } =
        Promise.withResolvers<void>();
      const onConsolidated = vi.fn().mockImplementation(() => {
        resolveConsolidated();
      });
      coordinator.on('consolidated', onConsolidated);

      await coordinator.handleInboundMessage(privateMsg);

      // 1. PrivateSession 消息进入防抖队列
      expect(coordinator.pendingSessionCount).toBe(1);
      expect(coordinator.getPendingQueue(privateMsg.sessionId)).toHaveLength(1);

      // 2. 等待防抖事件触发
      await consolidatedPromise;
      expect(onConsolidated).toHaveBeenCalledTimes(1);
      expect(onConsolidated).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: privateMsg.sessionId,
          sessionType: 'private',
        })
      );
    });
  });

  describe('DELIVERY-01.4: 群聊消息不中断已有在途 Agent Run', () => {
    it('同 sessionId 的在途私聊 Agent Run 不会被后续群聊消息打断', async () => {
      const targetSessionId = 'session_delivery_01_concurrent';
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

      // 1. 发起私聊在途任务
      const privateMsg: KK9Message = {
        id: 'delivery01_priv_1',
        messageId: 'delivery01_priv_1',
        sessionId: targetSessionId,
        sessionName: '私聊在途目标',
        sessionType: 'private',
        origin: 'external',
        sender: '员工',
        content: '私聊发起耗时任务',
        time: '14:00',
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

      expect(testCoordinator.hasInFlightSession(targetSessionId)).toBe(true);
      expect(capturedSignal).not.toBeNull();
      expect(capturedSignal!.aborted).toBe(false);

      // 2. 发送具有相同 sessionId 的群聊消息
      const groupMsg: KK9Message = {
        id: 'delivery01_grp_1',
        messageId: 'delivery01_grp_1',
        sessionId: targetSessionId,
        sessionName: '群聊插入消息',
        sessionType: 'group',
        origin: 'external',
        sender: '群成员',
        content: '群消息到达，不应打断在途私聊',
        time: '14:01',
        isMe: false,
        timestamp: Date.now(),
      };
      await testCoordinator.handleInboundMessage(groupMsg);

      // 3. 断言在途 Run 未被中断
      expect(capturedSignal!.aborted).toBe(false);
      expect(inFlightAbortedSpy).not.toHaveBeenCalled();
      expect(testCoordinator.hasInFlightSession(targetSessionId)).toBe(true);

      resolveAgentRun({ content: '完成', finishReason: 'stop' });
      await flushPromise;
      await testCoordinator.stop();
    });
  });
});
