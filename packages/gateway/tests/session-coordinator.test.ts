import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KK9Driver, KK9Message, KK9RecalledEvent, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import { SessionCoordinator } from '../src/coordinator.js';
import type { ConsolidatedMessage } from '../src/types/index.js';

/**
 * 模拟 KK9Driver 行为的测试桩
 */
class MockDriver extends EventEmitter {
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'bot_msg_001',
  } as SendResult);
  public sendRichText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'bot_msg_002',
  } as SendResult);

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
  }
}

function createSampleMessage(overrides: Partial<KK9Message> = {}): KK9Message {
  const id = overrides.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    sessionId: 'session_001',
    sessionName: '张三',
    sessionType: 'private',
    sender: '张三',
    senderId: 'user_001',
    content: '你好，请问在吗？',
    time: '12:00',
    isMe: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('SessionCoordinator 业务编排器测试', () => {
  let mockDriver: MockDriver;
  let store: KKBotStore;

  beforeEach(async () => {
    vi.useFakeTimers();
    mockDriver = new MockDriver();
    store = await createKKBotStore({ path: ':memory:' });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    store.close();
  });

  describe('1. 短消息防抖合并队列 (Debounce Queue)', () => {
    it('1.5 秒窗口内连续收到多条短消息应合并为单条多行上下文', async () => {
      const consolidatedList: ConsolidatedMessage[] = [];
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: msg => {
            consolidatedList.push(msg);
          },
        },
      });
      await coordinator.start();

      const msg1 = createSampleMessage({ id: 'm1', content: '第一句话' });
      const msg2 = createSampleMessage({ id: 'm2', content: '第二句话' });
      const msg3 = createSampleMessage({ id: 'm3', content: '第三句话' });

      // t = 0ms 发送第一条
      mockDriver.emitMessage(msg1);
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(1);

      // t = 500ms 发送第二条
      vi.advanceTimersByTime(500);
      mockDriver.emitMessage(msg2);
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(2);

      // t = 1000ms 发送第三条 (重新计时 1500ms)
      vi.advanceTimersByTime(500);
      mockDriver.emitMessage(msg3);
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(3);

      // t = 2000ms (自 msg3 起仅过去 1000ms，未到 1500ms)
      vi.advanceTimersByTime(1000);
      expect(consolidatedList).toHaveLength(0);

      // t = 2500ms (自 msg3 起满 1500ms，触发 flush)
      await vi.advanceTimersByTimeAsync(500);

      expect(consolidatedList).toHaveLength(1);
      const batch = consolidatedList[0]!;
      expect(batch.sessionId).toBe('session_001');
      expect(batch.messageCount).toBe(3);
      expect(batch.content).toBe('第一句话\n第二句话\n第三句话');
      expect(batch.messageIds).toEqual(['m1', 'm2', 'm3']);
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(0);

      // 验证 store 中的数据落盘
      const history = await store.messages.getSessionHistory('session_001', { limit: 10 });
      expect(history).toHaveLength(3);
      const sessionRecord = await store.sessions.getSession('session_001');
      expect(sessionRecord).not.toBeNull();
      expect(sessionRecord?.lastMessageAt).toBeGreaterThan(0);

      await coordinator.stop();
    });

    it('多会话防抖队列应完全物理隔离，互不干扰', async () => {
      const consolidatedMap = new Map<string, ConsolidatedMessage>();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: msg => {
            consolidatedMap.set(msg.sessionId, msg);
          },
        },
      });
      await coordinator.start();

      mockDriver.emitMessage(
        createSampleMessage({ sessionId: 'session_A', id: 'mA1', content: 'A-1' })
      );

      vi.advanceTimersByTime(500);
      mockDriver.emitMessage(
        createSampleMessage({ sessionId: 'session_B', id: 'mB1', content: 'B-1' })
      );

      // t = 1500ms (A 会话达到 1500ms 触发，B 会话才经过 1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      expect(consolidatedMap.has('session_A')).toBe(true);
      expect(consolidatedMap.has('session_B')).toBe(false);

      // t = 2000ms (B 会话达到 1500ms 触发)
      await vi.advanceTimersByTimeAsync(500);
      expect(consolidatedMap.has('session_B')).toBe(true);

      await coordinator.stop();
    });

    it('maxWaitMs 超时保护：持续发送短消息时应在最大等待时间强制触发合并', async () => {
      const consolidatedList: ConsolidatedMessage[] = [];
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          maxWaitMs: 3000,
          onConsolidatedMessage: msg => {
            consolidatedList.push(msg);
          },
        },
      });
      await coordinator.start();

      // 每隔 800ms 发送一条消息，滑动窗口不断重置，但总时间达到 3000ms 时强制 flush
      mockDriver.emitMessage(createSampleMessage({ id: 'm1', content: '1' }));
      vi.advanceTimersByTime(800);
      mockDriver.emitMessage(createSampleMessage({ id: 'm2', content: '2' }));
      vi.advanceTimersByTime(800);
      mockDriver.emitMessage(createSampleMessage({ id: 'm3', content: '3' }));
      vi.advanceTimersByTime(800);
      mockDriver.emitMessage(createSampleMessage({ id: 'm4', content: '4' }));

      // 当前经过 2400ms，尚未达到 maxWait 3000ms
      expect(consolidatedList).toHaveLength(0);

      // 推进至 3000ms，触发 maxWait 强制 flush
      await vi.advanceTimersByTimeAsync(600);
      expect(consolidatedList).toHaveLength(1);
      expect(consolidatedList[0]?.content).toBe('1\n2\n3\n4');

      await coordinator.stop();
    });

    it('应正确透传群聊 @ 机器人与 @ 全体 标记', async () => {
      let capturedBatch: ConsolidatedMessage | null = null;
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: msg => {
            capturedBatch = msg;
          },
        },
      });
      await coordinator.start();

      mockDriver.emitMessage(
        createSampleMessage({
          sessionId: 'group_001',
          sessionType: 'group',
          id: 'g1',
          content: '@KKBot 帮我查下报表',
          atMe: true,
        })
      );

      await vi.advanceTimersByTimeAsync(1500);

      expect(capturedBatch).not.toBeNull();
      expect(capturedBatch?.atMe).toBe(true);
      expect(capturedBatch?.sessionType).toBe('group');

      await coordinator.stop();
    });
  });

  describe('2. 撤回即时熔断 (Recall Fusion)', () => {
    it('在防抖期内若某条消息被撤回，应从队列中精确剔除', async () => {
      let capturedBatch: ConsolidatedMessage | null = null;
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: msg => {
            capturedBatch = msg;
          },
        },
      });
      await coordinator.start();

      await coordinator.handleInboundMessage(createSampleMessage({ id: 'm1', content: '正常消息 1' }));
      await coordinator.handleInboundMessage(createSampleMessage({ id: 'm2', content: '手误发送的敏感信息' }));
      await coordinator.handleInboundMessage(createSampleMessage({ id: 'm3', content: '正常消息 2' }));

      expect(coordinator.getPendingQueue('session_001')).toHaveLength(3);

      // 用户撤回 m2
      await coordinator.handleRecalled({
        messageId: 'm2',
        sessionId: 'session_001',
        sender: '张三',
        time: '12:01',
      });

      // 队列中应只剩 2 条
      const queue = coordinator.getPendingQueue('session_001');
      expect(queue).toHaveLength(2);
      expect(queue.map(m => m.id)).toEqual(['m1', 'm3']);

      // 验证 store 中已标记 is_recalled = 1
      const history = await store.messages.getSessionHistory('session_001');
      expect(history.map(m => m.messageId)).toEqual(['m1', 'm3']);
      // 等待防抖到期
      await vi.advanceTimersByTimeAsync(1500);

      expect(capturedBatch).not.toBeNull();
      expect(capturedBatch?.messageCount).toBe(2);
      expect(capturedBatch?.content).toBe('正常消息 1\n正常消息 2');
      expect(capturedBatch?.messageIds).toEqual(['m1', 'm3']);

      await coordinator.stop();
    });

    it('若防抖队列中全部消息被撤回，应静默熔断取消后续流程', async () => {
      const onConsolidated = vi.fn();
      const onRecallFused = vi.fn();
      const onSuppressed = vi.fn();

      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: onConsolidated,
        },
      });
      coordinator.on('recall_fused', onRecallFused);
      coordinator.on('suppressed', onSuppressed);
      await coordinator.start();

      mockDriver.emitMessage(createSampleMessage({ id: 'msg_single', content: '发错了' }));
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(1);

      // 撤回该唯一消息
      mockDriver.emitRecalled({
        messageId: 'msg_single',
        sessionId: 'session_001',
        sender: '张三',
        time: '12:02',
      });

      expect(coordinator.getPendingQueue('session_001')).toHaveLength(0);
      expect(onRecallFused).toHaveBeenCalledWith('session_001', 'msg_single', 0);
      expect(onSuppressed).toHaveBeenCalledWith('session_001', 'recalled');
      // 时间经过 2000ms
      await vi.advanceTimersByTimeAsync(2000);

      // 确认从未触发合并回调
      expect(onConsolidated).not.toHaveBeenCalled();

      await coordinator.stop();
    });
  });

  describe('3. 人机协同退避 (Human Takeover)', () => {
    it('检测到人类操作员发消息 (isMe: true 且非 Bot 发送) 时自动设置 10 分钟退避', async () => {
      const onTakeover = vi.fn();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          takeoverDurationMs: 600000, // 10分钟
        },
      });
      coordinator.on('takeover', onTakeover);
      await coordinator.start();

      // 用户先发了一条消息进入防抖
      mockDriver.emitMessage(createSampleMessage({ id: 'u1', content: '客服您好' }));
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(1);

      // 人类操作员在客户端打字回复 (isMe: true)
      const humanMsg = createSampleMessage({
        id: 'h1',
        isMe: true,
        sender: '我',
        content: '您好，我是人工客服小李，请问有什么可以帮您？',
      });
      await coordinator.handleInboundMessage(humanMsg);

      // 1. 应立即清空之前的防抖队列 (避免人类介入后 Bot 仍抢答)
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(0);

      // 2. 应在 store 中持久化 10 分钟退避
      expect(await coordinator.isTakeoverActive('session_001')).toBe(true);
      expect(await store.sessions.isTakeoverActive('session_001')).toBe(true);
      expect(onTakeover).toHaveBeenCalled();

      await coordinator.stop();
    });

    it('在退避期内 Bot 应保持完全静默，新消息不放入防抖队列且不触发自动回复', async () => {
      const onConsolidated = vi.fn();
      const onSuppressed = vi.fn();

      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          takeoverDurationMs: 600000,
          onConsolidatedMessage: onConsolidated,
        },
      });
      coordinator.on('suppressed', onSuppressed);
      await coordinator.start();

      // 主动开启人工退避
      await coordinator.setTakeover('session_001', 600000);
      expect(await coordinator.isTakeoverActive('session_001')).toBe(true);

      // 客户发送新消息
      await coordinator.handleInboundMessage(createSampleMessage({ id: 'u2', content: '还在吗？' }));

      // 防抖队列应为空，且触发 suppressed 事件
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(0);
      expect(onSuppressed).toHaveBeenCalledWith('session_001', 'human_takeover', expect.anything());

      // 消息依然正常持久化记录到 store
      const history = await store.messages.getSessionHistory('session_001');
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toBe('还在吗？');

      // 时间经过 3000ms
      await vi.advanceTimersByTimeAsync(3000);
      expect(onConsolidated).not.toHaveBeenCalled();

      // 时间经过 11 分钟 (超过 10 分钟退避期)
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000);
      expect(await coordinator.isTakeoverActive('session_001')).toBe(false);

      // 客户再发新消息，此时应恢复正常防抖处理
      mockDriver.emitMessage(createSampleMessage({ id: 'u3', content: '恢复正常了' }));
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(onConsolidated).toHaveBeenCalledOnce();

      await coordinator.stop();
    });

    it('Bot 自身通过 coordinator.dispatchReply 发送的消息不应误触发人工退避', async () => {
      const onTakeover = vi.fn();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
        },
      });
      coordinator.on('takeover', onTakeover);
      await coordinator.start();

      // Bot 发送消息
      const res = await coordinator.dispatchReply('session_001', '这是 Bot 的自动回复');
      expect(res.success).toBe(true);

      // 模拟 driver 回显该 Bot 消息 (isMe: true)
      await coordinator.handleInboundMessage(
        createSampleMessage({
          id: res.messageId || 'bot_msg_001',
          isMe: true,
          content: '这是 Bot 的自动回复',
        })
      );

      // 不应触发退避
      expect(onTakeover).not.toHaveBeenCalled();
      expect(await coordinator.isTakeoverActive('session_001')).toBe(false);

      await coordinator.stop();
    });
  });

  describe('4. 视觉红点守卫 (Red Dot Guard)', () => {
    it('自动回复成功发送后显式调用 driver.markSessionRead(sessionId) 消除红点', async () => {
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          autoMarkRead: true,
        },
      });
      await coordinator.start();

      const result = await coordinator.dispatchReply('session_001', '自动回复测试');

      expect(result.success).toBe(true);
      expect(result.action).toBe('message_sent');
      expect(result.redDotCleared).toBe(true);
      expect(mockDriver.sendText).toHaveBeenCalledWith('自动回复测试', {
        targetSessionId: 'session_001',
      });
      expect(mockDriver.markSessionRead).toHaveBeenCalledWith('session_001');

      // 验证更新了 store 中的 last_reply_at
      const session = await store.sessions.getSession('session_001');
      expect(session?.lastReplyAt).toBeGreaterThan(0);

      await coordinator.stop();
    });

    it('草稿模式 (mode: draft) 坚决保留红点，不调用 markSessionRead', async () => {
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      // 初始化会话为 draft 模式
      await store.sessions.upsertSession({
        id: 'session_draft',
        name: '草稿会话',
        type: 'private',
        mode: 'draft',
      });

      const result = await coordinator.dispatchReply('session_draft', '待审核草稿内容');

      expect(result.success).toBe(true);
      expect(result.action).toBe('draft_created');
      expect(result.redDotCleared).toBe(false);

      // 绝不能调用 sendText 发送给对方，也不能调用 markSessionRead
      expect(mockDriver.sendText).not.toHaveBeenCalled();
      expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

      await coordinator.stop();
    });

    it('人工退避期内坚决保留红点，阻止自动发送', async () => {
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      await coordinator.setTakeover('session_001', 600000);

      const result = await coordinator.dispatchReply('session_001', '退避期尝试发送');

      expect(result.success).toBe(false);
      expect(result.action).toBe('suppressed');
      expect(result.redDotCleared).toBe(false);
      expect(mockDriver.sendText).not.toHaveBeenCalled();
      expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

      await coordinator.stop();
    });

    it('发送失败时坚决保留红点，绝不清除红点', async () => {
      mockDriver.sendText.mockResolvedValueOnce({
        success: false,
        error: '网络超时或目标元素未就绪',
      });

      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      const result = await coordinator.dispatchReply('session_001', '发送失败测试');

      expect(result.success).toBe(false);
      expect(result.action).toBe('send_failed');
      expect(result.redDotCleared).toBe(false);
      expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

      await coordinator.stop();
    });

    it('配置 autoMarkRead: false 时自动回复成功后不应消除红点', async () => {
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          autoMarkRead: false,
        },
      });
      await coordinator.start();

      const result = await coordinator.dispatchReply('session_001', '不消红点回复');
      expect(result.success).toBe(true);
      expect(result.redDotCleared).toBe(false);
      expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

      await coordinator.stop();
    });

    it('支持发送富文本 FormattedText 内容并正常消除红点', async () => {
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      const result = await coordinator.dispatchReply('session_001', [
        { text: '加粗标题', bold: true },
        { text: ' 普通正文' },
      ]);
      expect(result.success).toBe(true);
      expect(result.action).toBe('message_sent');
      expect(result.redDotCleared).toBe(true);
      expect(mockDriver.sendRichText).toHaveBeenCalledOnce();
      expect(mockDriver.markSessionRead).toHaveBeenCalledWith('session_001');

      await coordinator.stop();
    });

    it('会话处于 disabled 模式时抑制入站消息与出站回复', async () => {
      const onConsolidated = vi.fn();
      const onSuppressed = vi.fn();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          onConsolidatedMessage: onConsolidated,
        },
      });
      coordinator.on('suppressed', onSuppressed);
      await coordinator.start();

      await coordinator.setSessionMode('session_disabled', 'disabled');
      await store.sessions.upsertSession({
        id: 'session_disabled',
        name: '已禁用会话',
        type: 'private',
        mode: 'disabled',
      });

      // 入站消息
      await coordinator.handleInboundMessage(
        createSampleMessage({ sessionId: 'session_disabled', id: 'dis_1', content: '测试' })
      );
      expect(coordinator.getPendingQueue('session_disabled')).toHaveLength(0);
      expect(onSuppressed).toHaveBeenCalledWith(
        'session_disabled',
        'session_disabled',
        expect.anything()
      );

      // 出站回复
      const result = await coordinator.dispatchReply('session_disabled', '尝试回复禁用会话');
      expect(result.success).toBe(false);
      expect(result.action).toBe('suppressed');

      await coordinator.stop();
    });

    it('clearTakeover 应能手动解除退避状态并恢复正常防抖处理', async () => {
      const onConsolidated = vi.fn();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: onConsolidated,
        },
      });
      await coordinator.start();

      await coordinator.setTakeover('session_001', 600000);
      expect(await coordinator.isTakeoverActive('session_001')).toBe(true);

      await coordinator.clearTakeover('session_001');
      expect(await coordinator.isTakeoverActive('session_001')).toBe(false);

      mockDriver.emitMessage(createSampleMessage({ id: 'after_clear', content: '恢复后消息' }));
      expect(coordinator.getPendingQueue('session_001')).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1500);
      expect(onConsolidated).toHaveBeenCalledOnce();

      await coordinator.stop();
    });

    it('onConsolidatedMessage 回调异常时应捕获并派发 error 事件', async () => {
      const onError = vi.fn();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 1500,
          onConsolidatedMessage: () => {
            throw new Error('LLM 接口调用异常');
          },
        },
      });
      coordinator.on('error', onError);
      await coordinator.start();

      mockDriver.emitMessage(createSampleMessage({ id: 'err_test', content: '测试报错' }));
      await vi.advanceTimersByTimeAsync(1500);

      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0]?.[0]?.message).toBe('LLM 接口调用异常');

      await coordinator.stop();
    });

    it('start 与 stop 重复调用应保持幂等性', async () => {
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });

      await coordinator.start();
      await coordinator.start(); // 重复 start 不应重复绑定

      await coordinator.stop();
      await coordinator.stop(); // 重复 stop 不应抛错
    });
  });

  describe('5. 会话生命周期与队列控制', () => {
    it('flushSession 与 flushAll 应安全排空队列并触发回调', async () => {
      const consolidatedList: ConsolidatedMessage[] = [];
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 5000,
          onConsolidatedMessage: msg => {
            consolidatedList.push(msg);
          },
        },
      });
      await coordinator.start();

      mockDriver.emitMessage(createSampleMessage({ sessionId: 's1', id: 'm1', content: '1' }));
      mockDriver.emitMessage(createSampleMessage({ sessionId: 's2', id: 'm2', content: '2' }));

      expect(coordinator.pendingSessionCount).toBe(2);

      // 单独 flush s1
      await coordinator.flushSession('s1');
      expect(consolidatedList).toHaveLength(1);
      expect(consolidatedList[0]?.sessionId).toBe('s1');
      expect(coordinator.pendingSessionCount).toBe(1);

      // flushAll s2
      await coordinator.flushAll();
      expect(consolidatedList).toHaveLength(2);
      expect(consolidatedList[1]?.sessionId).toBe('s2');
      expect(coordinator.pendingSessionCount).toBe(0);

      await coordinator.stop();
    });

    it('drain 应安全清空所有队列并返回消息，不触发 onConsolidatedMessage', async () => {
      const onConsolidated = vi.fn();
      const coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        config: {
          debounceMs: 5000,
          onConsolidatedMessage: onConsolidated,
        },
      });
      await coordinator.start();

      mockDriver.emitMessage(createSampleMessage({ sessionId: 's1', id: 'm1', content: '1' }));
      mockDriver.emitMessage(createSampleMessage({ sessionId: 's2', id: 'm2', content: '2' }));

      const drained = coordinator.drain();
      expect(drained.size).toBe(2);
      expect(drained.get('s1')?.[0]?.content).toBe('1');
      expect(drained.get('s2')?.[0]?.content).toBe('2');
      expect(coordinator.pendingSessionCount).toBe(0);
      expect(onConsolidated).not.toHaveBeenCalled();

      await coordinator.stop();
    });
  });
});
