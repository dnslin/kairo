import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerInfoMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    info: loggerInfoMock,
    debug: loggerDebugMock,
  }),
}));

import { MessageAggregator } from '../../src/aggregator/index.js';
import type { Message } from '../../src/extract/extractor.js';
import type { AggregationConfig } from '../../src/config/schema.js';

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  sessionId: 'session-1',
  sender: 'Alice',
  time: '10:00',
  content: '你好',
  fingerprint: 'fp-' + Math.random().toString(36).slice(2, 8),
  isMe: false,
  ...overrides,
});

const createConfig = (overrides: Partial<AggregationConfig> = {}): AggregationConfig => ({
  enabled: true,
  windowMs: 5000,
  maxWaitMs: 15000,
  separator: '\n',
  ...overrides,
});

describe('MessageAggregator', () => {
  let config: AggregationConfig;
  let onFlush: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    config = createConfig();
    onFlush = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('enabled=true（聚合模式）', () => {
    it('单条消息 + 窗口到期 → 正常触发 flush', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg = createMessage({ content: '你好' });

      aggregator.push('session-1', msg);

      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(5000);

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith('session-1', [msg]);
    });

    it('多条消息在窗口内到达 → 合并为一次 flush', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg1 = createMessage({ content: '你好', fingerprint: 'fp-1' });
      const msg2 = createMessage({ content: '我想问下', fingerprint: 'fp-2' });
      const msg3 = createMessage({ content: '退款怎么处理', fingerprint: 'fp-3' });

      aggregator.push('session-1', msg1);
      vi.advanceTimersByTime(2000);
      aggregator.push('session-1', msg2);
      vi.advanceTimersByTime(3000);
      aggregator.push('session-1', msg3);

      // 窗口从最后一条消息算起，还没到期
      expect(onFlush).not.toHaveBeenCalled();

      // 最后一条消息后再等 5000ms
      vi.advanceTimersByTime(5000);

      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith('session-1', [msg1, msg2, msg3]);
    });

    it('滑动窗口重置：新消息到达时重置 windowMs 计时器', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg1 = createMessage({ content: 'A', fingerprint: 'fp-1' });
      const msg2 = createMessage({ content: 'B', fingerprint: 'fp-2' });

      aggregator.push('session-1', msg1);
      vi.advanceTimersByTime(4000); // 距离 windowMs 还有 1s
      aggregator.push('session-1', msg2); // 重置窗口

      vi.advanceTimersByTime(1000); // 原窗口本该到期，但已重置
      expect(onFlush).not.toHaveBeenCalled();

      vi.advanceTimersByTime(4000); // 新窗口到期 (4000+1000 = 5000)
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith('session-1', [msg1, msg2]);
    });

    it('maxWaitMs 到期 → 强制 flush（即使窗口内有新消息）', () => {
      const aggregator = new MessageAggregator(
        createConfig({ windowMs: 5000, maxWaitMs: 12000 }),
        onFlush
      );

      const msgs: Message[] = [];
      // 每 3 秒发一条，持续超过 maxWaitMs
      for (let i = 0; i < 5; i++) {
        const msg = createMessage({ content: `msg-${i}`, fingerprint: `fp-${i}` });
        msgs.push(msg);
        aggregator.push('session-1', msg);
        if (i < 4) vi.advanceTimersByTime(3000);
      }

      // 第一条 t=0, 第二条 t=3000, 第三条 t=6000, 第四条 t=9000
      // maxWaitMs=12000 在 t=12000 触发（第四条 t=9000 后 3000ms）
      // 但第四条已经在 t=9000 推入，此时已经过了 9000ms
      // 第五条在 t=12000 推入
      // maxTimer 在 t=12000 触发（从第一条 t=0 算起）
      expect(onFlush).toHaveBeenCalledTimes(1);
      // maxTimer 在第五条 push 之前就触发了
      expect(onFlush.mock.calls[0][1].length).toBeGreaterThanOrEqual(4);
    });

    it('不同会话的消息互不影响（独立桶）', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg1 = createMessage({ sessionId: 'session-1', content: 'A', fingerprint: 'fp-1' });
      const msg2 = createMessage({ sessionId: 'session-2', content: 'B', fingerprint: 'fp-2' });

      aggregator.push('session-1', msg1);
      vi.advanceTimersByTime(2000);
      aggregator.push('session-2', msg2);

      // session-1 窗口到期
      vi.advanceTimersByTime(3000);
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith('session-1', [msg1]);

      // session-2 窗口到期
      vi.advanceTimersByTime(2000);
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush).toHaveBeenCalledWith('session-2', [msg2]);
    });

    it('flushAll → 所有 pending 桶立即 flush', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg1 = createMessage({ sessionId: 'session-1', fingerprint: 'fp-1' });
      const msg2 = createMessage({ sessionId: 'session-2', fingerprint: 'fp-2' });
      const msg3 = createMessage({ sessionId: 'session-1', fingerprint: 'fp-3' });

      aggregator.push('session-1', msg1);
      aggregator.push('session-2', msg2);
      aggregator.push('session-1', msg3);

      expect(onFlush).not.toHaveBeenCalled();

      aggregator.flushAll();

      expect(onFlush).toHaveBeenCalledTimes(2);
      // 验证两个会话都被 flush
      const callArgs = onFlush.mock.calls.map((c: [string, Message[]]) => c[0]);
      expect(callArgs).toContain('session-1');
      expect(callArgs).toContain('session-2');
    });

    it('flushAll 后不再重复触发定时器 flush', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      aggregator.push('session-1', createMessage());

      aggregator.flushAll();
      expect(onFlush).toHaveBeenCalledTimes(1);

      // 原 windowMs 到期
      vi.advanceTimersByTime(5000);
      expect(onFlush).toHaveBeenCalledTimes(1); // 不重复触发
    });

    it('flush 后同一会话可以开始新的聚合', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg1 = createMessage({ content: '第一轮', fingerprint: 'fp-1' });

      aggregator.push('session-1', msg1);
      vi.advanceTimersByTime(5000); // 第一轮 flush
      expect(onFlush).toHaveBeenCalledTimes(1);

      const msg2 = createMessage({ content: '第二轮', fingerprint: 'fp-2' });
      aggregator.push('session-1', msg2);
      vi.advanceTimersByTime(5000); // 第二轮 flush
      expect(onFlush).toHaveBeenCalledTimes(2);
      expect(onFlush).toHaveBeenLastCalledWith('session-1', [msg2]);
    });

    it('空桶不触发 flush', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      aggregator.flushAll();
      expect(onFlush).not.toHaveBeenCalled();
    });

    it('消息按推入顺序保持（时间顺序）', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msgs = ['第一条', '第二条', '第三条'].map((content, i) =>
        createMessage({ content, fingerprint: `fp-${i}` })
      );

      for (const msg of msgs) {
        aggregator.push('session-1', msg);
      }

      vi.advanceTimersByTime(5000);

      const flushedMsgs = onFlush.mock.calls[0][1] as Message[];
      expect(flushedMsgs.map(m => m.content)).toEqual(['第一条', '第二条', '第三条']);
    });

    it('pendingCount 返回当前 pending 桶的数量', () => {
      const aggregator = new MessageAggregator(config, onFlush);

      expect(aggregator.pendingCount).toBe(0);

      aggregator.push('session-1', createMessage({ fingerprint: 'fp-1' }));
      expect(aggregator.pendingCount).toBe(1);

      aggregator.push('session-2', createMessage({ sessionId: 'session-2', fingerprint: 'fp-2' }));
      expect(aggregator.pendingCount).toBe(2);

      vi.advanceTimersByTime(5000);
      expect(aggregator.pendingCount).toBe(0);
    });
  });

  describe('enabled=false（透传模式）', () => {
    it('直接透传，不缓冲', () => {
      const aggregator = new MessageAggregator(
        createConfig({ enabled: false }),
        onFlush
      );
      const msg = createMessage();

      aggregator.push('session-1', msg);

      // 立即触发，无需等待
      expect(onFlush).toHaveBeenCalledTimes(1);
      expect(onFlush).toHaveBeenCalledWith('session-1', [msg]);
    });

    it('透传模式下 flushAll 是安全的空操作', () => {
      const aggregator = new MessageAggregator(
        createConfig({ enabled: false }),
        onFlush
      );

      aggregator.push('session-1', createMessage());
      expect(onFlush).toHaveBeenCalledTimes(1);

      aggregator.flushAll();
      expect(onFlush).toHaveBeenCalledTimes(1); // 不重复
    });
  });

  describe('drain（安全排空）', () => {
    it('排空所有 pending 桶并返回消息，不触发 onFlush', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const msg1 = createMessage({ sessionId: 'session-1', fingerprint: 'fp-1' });
      const msg2 = createMessage({ sessionId: 'session-2', fingerprint: 'fp-2' });
      const msg3 = createMessage({ sessionId: 'session-1', fingerprint: 'fp-3' });

      aggregator.push('session-1', msg1);
      aggregator.push('session-2', msg2);
      aggregator.push('session-1', msg3);

      const result = aggregator.drain();

      expect(onFlush).not.toHaveBeenCalled();
      expect(result.size).toBe(2);
      expect(result.get('session-1')).toEqual([msg1, msg3]);
      expect(result.get('session-2')).toEqual([msg2]);
      expect(aggregator.pendingCount).toBe(0);
    });

    it('drain 后定时器不再触发', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      aggregator.push('session-1', createMessage());

      aggregator.drain();
      vi.advanceTimersByTime(15000); // 超过 maxWaitMs

      expect(onFlush).not.toHaveBeenCalled();
    });

    it('空桶 drain 返回空 Map', () => {
      const aggregator = new MessageAggregator(config, onFlush);
      const result = aggregator.drain();
      expect(result.size).toBe(0);
    });
  });
});
