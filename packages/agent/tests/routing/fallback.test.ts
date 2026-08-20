import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FALLBACK_APOLOGY,
  FallbackHandler,
} from '../../src/routing/fallback.js';
import type { ConsolidatedMessage } from '../../src/types/index.js';

describe('FallbackHandler 全局宕机兜底测试', () => {
  const dummyMsg: ConsolidatedMessage = {
    sessionId: 'sess_fallback_1',
    sessionName: '生产告警群',
    sessionType: 'group',
    sender: '赵主管',
    content: '请协助处理紧急故障',
    messageCount: 1,
    messages: [],
    firstReceivedAt: 1787200000000,
    lastReceivedAt: 1787200000000,
    messageIds: ['m1'],
  };

  it('当所有模型宕机时，应返回默认安抚话术，保证流程闭环', async () => {
    const handler = new FallbackHandler();
    const error = new Error('503 Service Unavailable: All nodes down');

    const result = await handler.handle('thread_123', dummyMsg, error);

    expect(result.content).toBe(DEFAULT_FALLBACK_APOLOGY);
    expect(result.finishReason).toBe('stop');
    expect(result.aborted).toBe(false);
    expect(result.toolCalls).toEqual([]);
  });

  it('应支持自定义安抚兜底话术与自定义处理器', async () => {
    const customHandler = vi.fn(
      (_threadId: string, msg: ConsolidatedMessage) => {
        return Promise.resolve(`[系统提示] 尊敬的${msg.sender}，当前智能助手正在维护中，您的消息已转交人工客服。`);
      }
    );

    const handler = new FallbackHandler({
      customHandler,
    });

    const result = await handler.handle(
      'thread_456',
      dummyMsg,
      new Error('Timeout')
    );

    expect(customHandler).toHaveBeenCalledTimes(1);
    expect(result.content).toContain('尊敬的赵主管');
    expect(result.content).toContain('当前智能助手正在维护中');
  });

  it('当自定义处理器抛出异常时，应安全回退到默认安抚话术', async () => {
    const handler = new FallbackHandler({
      customHandler: () => {
        throw new Error('Custom handler failed');
      },
    });

    const result = await handler.handle(
      'thread_789',
      dummyMsg,
      new Error('Crash')
    );

    expect(result.content).toBe(DEFAULT_FALLBACK_APOLOGY);
  });
});
