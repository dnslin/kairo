import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KK9Driver, KK9Message, KK9RecalledEvent, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import { SessionCoordinator } from '../src/coordinator.js';

class MockDriver extends EventEmitter {
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi.fn().mockResolvedValue({
    success: true,
    messageId: 'bot_reply_001',
  } as SendResult);

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
  }
}

function createMsg(overrides: Partial<KK9Message> = {}): KK9Message {
  const id = overrides.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    sessionId: 'session_e2e',
    sessionName: '业务协同用户',
    sessionType: 'private',
    sender: '李四',
    senderId: 'user_lisi',
    content: '你好，需要咨询一下退款进度。',
    time: '14:30',
    isMe: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('SessionCoordinator 集成与端到端协同测试', () => {
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

  it('全链路正常闭环：收消息 -> 1.5s 防抖合并 -> 生成回复 -> 成功发送 -> 消除红点 -> Store 状态更新', async () => {
    let coordinator: SessionCoordinator | null = null;

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      config: {
        debounceMs: 1500,
        onConsolidatedMessage: async consolidated => {
          // 模拟下游 LLM Agent 处理并调用 coordinator.dispatchReply
          const replyText = `您好，已收到关于「${consolidated.content}」的咨询，退款将在 1~3 个工作日内原路返回。`;
          await coordinator!.dispatchReply(consolidated.sessionId, replyText);
        },
      },
    });
    coordinator.start();

    // 1. 用户连发 2 条消息
    mockDriver.emitMessage(createMsg({ id: 'm1', content: '您好，在吗？' }));
    vi.advanceTimersByTime(500);
    mockDriver.emitMessage(createMsg({ id: 'm2', content: '我想问下昨天订单退款到哪里了？' }));

    // 2. 1.5 秒后防抖合并触发
    await vi.advanceTimersByTimeAsync(1500);

    // 3. 校验 Driver 发送动作与消除红点
    expect(mockDriver.sendText).toHaveBeenCalledOnce();
    expect(mockDriver.sendText).toHaveBeenCalledWith(
      expect.stringContaining('您好，已收到关于「您好，在吗？\n我想问下昨天订单退款到哪里了？」'),
      { targetSessionId: 'session_e2e' }
    );
    expect(mockDriver.markSessionRead).toHaveBeenCalledWith('session_e2e');

    // 4. 校验 Store 中的会话与消息历史记录
    const session = await store.sessions.getSession('session_e2e');
    expect(session).not.toBeNull();
    expect(session?.lastMessageAt).toBeGreaterThan(0);
    expect(session?.lastReplyAt).toBeGreaterThan(0);

    const history = await store.messages.getSessionHistory('session_e2e');
    expect(history.length).toBeGreaterThanOrEqual(3); // 2 条入站 + 1 条回复

    coordinator.stop();
  });

  it('全链路撤回熔断：入站消息 -> 防抖期撤回 -> 队列清空 -> 静默熔断 -> 无 LLM 消耗与零发送', async () => {
    const handleConsolidated = vi.fn();

    const coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      config: {
        debounceMs: 1500,
        onConsolidatedMessage: handleConsolidated,
      },
    });
    coordinator.start();

    // 1. 用户发了一条错发消息
    mockDriver.emitMessage(createMsg({ id: 'wrong_msg_1', content: '发错了别看' }));

    // 2. 800ms 内用户撤回
    vi.advanceTimersByTime(800);
    mockDriver.emitRecalled({
      messageId: 'wrong_msg_1',
      sessionId: 'session_e2e',
      sender: '李四',
      time: '14:31',
    });

    // 3. 等待防抖计时结束
    await vi.advanceTimersByTimeAsync(2000);

    // 4. 验证下游绝无触发
    expect(handleConsolidated).not.toHaveBeenCalled();
    expect(mockDriver.sendText).not.toHaveBeenCalled();
    expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

    // 5. 验证 store 中消息被标记为已撤回且 getSessionHistory 自动过滤
    const cleanHistory = await store.messages.getSessionHistory('session_e2e');
    expect(cleanHistory).toHaveLength(0);

    coordinator.stop();
  });

  it('全链路人机协同：人类介入 -> 触发 10 分钟退避 -> 后续消息自动静默且坚决保留红点', async () => {
    let coordinator: SessionCoordinator | null = null;
    const handledMessages: string[] = [];

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      config: {
        debounceMs: 1500,
        takeoverDurationMs: 600000,
        onConsolidatedMessage: async consolidated => {
          handledMessages.push(consolidated.content);
          await coordinator!.dispatchReply(consolidated.sessionId, '自动回复');
        },
      },
    });
    coordinator.start();

    // 1. 人类操作员在客户端回复客户
    await coordinator.handleInboundMessage(
      createMsg({
        id: 'human_001',
        isMe: true,
        sender: '我',
        content: '您好，我是业务员小张，正在为您核实退款单号。',
      })
    );

    expect(await coordinator.isTakeoverActive('session_e2e')).toBe(true);

    // 2. 客户紧接着发送新消息
    await coordinator.handleInboundMessage(createMsg({ id: 'user_reply_1', content: '好的麻烦尽快' }));

    // 3. 等待防抖窗口
    await vi.advanceTimersByTimeAsync(3000);

    // 4. 验证处于人工接管退避中，未触发自动回复，未调用 markSessionRead
    expect(handledMessages).toHaveLength(0);
    expect(mockDriver.sendText).not.toHaveBeenCalled();
    expect(mockDriver.markSessionRead).not.toHaveBeenCalled();

    coordinator.stop();
  });
});
