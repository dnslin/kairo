import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { preSendCheck } from '../../src/send/pre-send-check.js';
import type { DomLocator } from '../../src/dom/locator.js';
import type { MessageContext, SendCheckResult } from '../../src/send/pre-send-check.js';

const createMockLocator = (overrides: {
  activeSessionId?: string | null;
  messageExists?: boolean;
  hasNewMessages?: boolean;
} = {}) => ({
  checkPreSendState: vi.fn().mockResolvedValue({
    activeSessionId: 'activeSessionId' in overrides ? overrides.activeSessionId : 'session-001',
    messageExists: overrides.messageExists ?? true,
    hasNewMessages: overrides.hasNewMessages ?? false,
  }),
});

describe('preSendCheck', () => {
  const target: MessageContext = {
    sessionId: 'session-001',
    content: '你好，请问有什么可以帮你？',
    sender: '客户A',
  };

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('全部校验通过时返回 safe=true', async () => {
    const mockLocator = createMockLocator();

    const result: SendCheckResult = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(mockLocator.checkPreSendState).toHaveBeenCalledWith(
      target.content, target.sender, true
    );
  });

  it('会话已切换时返回 session_switched', async () => {
    const mockLocator = createMockLocator({ activeSessionId: 'session-999' });

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('session_switched');
    expect(result.detail).toContain('session-999');
  });

  it('获取会话 ID 失败时返回 session_switched', async () => {
    const mockLocator = createMockLocator({ activeSessionId: null });

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('session_switched');
  });

  it('消息已消失时返回 message_gone', async () => {
    const mockLocator = createMockLocator({ messageExists: false });

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('message_gone');
  });

  it('有新消息且 abortOnNewMessages=true 时返回 new_messages', async () => {
    const mockLocator = createMockLocator({ hasNewMessages: true });

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target,
      true
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('new_messages');
  });

  it('有新消息但 abortOnNewMessages=false 时返回 safe=true', async () => {
    const mockLocator = createMockLocator({ hasNewMessages: true });

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target,
      false
    );

    expect(result.safe).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('abortOnNewMessages 默认为 true', async () => {
    const mockLocator = createMockLocator({ hasNewMessages: true });

    const result = await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(result.safe).toBe(false);
    expect(result.reason).toBe('new_messages');
  });

  it('abortOnNewMessages=false 时传递给 checkPreSendState', async () => {
    const mockLocator = createMockLocator();

    await preSendCheck(
      mockLocator as unknown as DomLocator,
      target,
      false
    );

    expect(mockLocator.checkPreSendState).toHaveBeenCalledWith(
      target.content, target.sender, false
    );
  });

  it('单次 CDP 调用（checkPreSendState 仅被调用一次）', async () => {
    const mockLocator = createMockLocator();

    await preSendCheck(
      mockLocator as unknown as DomLocator,
      target
    );

    expect(mockLocator.checkPreSendState).toHaveBeenCalledTimes(1);
  });
});
