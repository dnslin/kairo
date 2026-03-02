import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preSendCheck } from '../../src/send/pre-send-check.js';
import type { DomLocator } from '../../src/dom/locator.js';
import type { MessageContext, SendCheckResult } from '../../src/send/pre-send-check.js';

const createMockLocator = () => ({
  getActiveSessionId: vi.fn(),
  isMessageInDom: vi.fn(),
  hasNewMessagesSince: vi.fn(),
});

describe('preSendCheck', () => {
  let mockLocator: ReturnType<typeof createMockLocator>;
  const target: MessageContext = {
    sessionId: 'session-001',
    content: '你好，请问有什么可以帮你？',
    sender: '客户A',
  };

  beforeEach(() => {
    mockLocator = createMockLocator();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('全部校验通过时返回 safe=true', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-001');
    mockLocator.isMessageInDom.mockResolvedValue(true);
    mockLocator.hasNewMessagesSince.mockResolvedValue(false);

    const result: SendCheckResult = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('会话已切换时返回 session_switched', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-999');

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('session_switched');
    expect(result.detail).toContain('session-999');
    // 短路：后续检查不执行
    expect(mockLocator.isMessageInDom).not.toHaveBeenCalled();
  });

  it('获取会话 ID 失败时返回 session_switched', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue(null);

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('session_switched');
  });

  it('消息已消失时返回 message_gone', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-001');
    mockLocator.isMessageInDom.mockResolvedValue(false);

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('message_gone');
    // 短路：不检查新消息
    expect(mockLocator.hasNewMessagesSince).not.toHaveBeenCalled();
  });

  it('有新消息且 abortOnNewMessages=true 时返回 new_messages', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-001');
    mockLocator.isMessageInDom.mockResolvedValue(true);
    mockLocator.hasNewMessagesSince.mockResolvedValue(true);

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target,
      true
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('new_messages');
  });

  it('有新消息但 abortOnNewMessages=false 时返回 safe=true', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-001');
    mockLocator.isMessageInDom.mockResolvedValue(true);
    mockLocator.hasNewMessagesSince.mockResolvedValue(true);

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target,
      false
    );

    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('abortOnNewMessages 默认为 true', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-001');
    mockLocator.isMessageInDom.mockResolvedValue(true);
    mockLocator.hasNewMessagesSince.mockResolvedValue(true);

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('new_messages');
  });

  it('abortOnNewMessages=false 时跳过新消息检查', async () => {
    mockLocator.getActiveSessionId.mockResolvedValue('session-001');
    mockLocator.isMessageInDom.mockResolvedValue(true);

    await preSendCheck(
      mockLocator as unknown as DomLocator,
      target,
      false
    );

    expect(mockLocator.hasNewMessagesSince).not.toHaveBeenCalled();
  });
});
