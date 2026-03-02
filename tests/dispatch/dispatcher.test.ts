import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: (): Record<string, (...args: unknown[]) => void> => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { dispatchReply } from '../../src/dispatch/dispatcher.js';
import type { DispatchDeps, DispatchInput } from '../../src/dispatch/dispatcher.js';
import type { Store } from '../../src/store/index.js';
import type { Sender } from '../../src/send/index.js';
import type { DomLocator } from '../../src/dom/index.js';

function createMockStore(): Store {
  return {
    saveDraft: vi.fn().mockReturnValue(42),
    logEvent: vi.fn(),
    saveMessage: vi.fn(),
  } as unknown as Store;
}

function createMockSender(success = true, error?: string): Sender {
  return {
    send: vi.fn().mockResolvedValue({ success, error }),
  } as unknown as Sender;
}

function createMockLocator(overrides: {
  activeSessionId?: string | null;
  messageInDom?: boolean;
  hasNewMessages?: boolean;
} = {}): DomLocator {
  return {
    getActiveSessionId: vi.fn().mockResolvedValue(overrides.activeSessionId ?? 'session-1'),
    isMessageInDom: vi.fn().mockResolvedValue(overrides.messageInDom ?? true),
    hasNewMessagesSince: vi.fn().mockResolvedValue(overrides.hasNewMessages ?? false),
  } as unknown as DomLocator;
}

function createInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
  return {
    mode: 'auto_send',
    reply: '你好，有什么可以帮你的？',
    sessionId: 'session-1',
    sessionName: '测试会话',
    originalMessage: '你好',
    originalSender: 'Alice',
    ...overrides,
  };
}

describe('dispatchReply', () => {
  let store: Store;
  let sender: Sender;
  let deps: DispatchDeps;

  beforeEach(() => {
    store = createMockStore();
    sender = createMockSender();
    deps = { store, sender };
  });

  // ── auto_send 模式 ────────────────────────────────────────────

  describe('auto_send 模式', () => {
    it('调用 sender.send 发送回复', async () => {
      const input = createInput({ mode: 'auto_send' });
      await dispatchReply(deps, input);

      expect(sender.send).toHaveBeenCalledWith('你好，有什么可以帮你的？');
    });

    it('发送成功后保存消息并记录事件', async () => {
      const input = createInput({ mode: 'auto_send' });
      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('message_sent');
      expect(store.saveMessage).toHaveBeenCalledWith(
        'session-1',
        { sender: '自己', content: '你好，有什么可以帮你的？', isFromSelf: true },
        '测试会话'
      );
      expect(store.logEvent).toHaveBeenCalledWith('message_sent', {
        sessionId: 'session-1',
        sessionName: '测试会话',
      });
    });

    it('发送失败时记录错误日志并返回 send_failed', async () => {
      sender = createMockSender(false, '输入框未找到');
      deps = { store, sender };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('send_failed');
      expect(result.error).toBe('输入框未找到');
      expect(store.logEvent).toHaveBeenCalledWith('send_failed', {
        sessionId: 'session-1',
        error: '输入框未找到',
      });
      // 发送失败不保存消息
      expect(store.saveMessage).not.toHaveBeenCalled();
    });

    it('发送失败不抛出异常（不阻塞后续消息处理）', async () => {
      sender = createMockSender(false, 'DOM 操作失败');
      deps = { store, sender };
      const input = createInput({ mode: 'auto_send' });

      await expect(dispatchReply(deps, input)).resolves.not.toThrow();
    });
  });

  // ── draft_only 模式 ───────────────────────────────────────────

  describe('draft_only 模式', () => {
    it('不调用 sender.send', async () => {
      const input = createInput({ mode: 'draft_only' });
      await dispatchReply(deps, input);

      expect(sender.send).not.toHaveBeenCalled();
    });

    it('保存草稿并记录事件', async () => {
      const input = createInput({ mode: 'draft_only' });
      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('draft_created');
      expect(result.draftId).toBe(42);
      expect(store.saveDraft).toHaveBeenCalledWith({
        sessionId: 'session-1',
        sessionName: '测试会话',
        originalMessage: '你好',
        originalSender: 'Alice',
        draftContent: '你好，有什么可以帮你的？',
      });
      expect(store.logEvent).toHaveBeenCalledWith('draft_created', {
        draftId: 42,
        sessionId: 'session-1',
        sessionName: '测试会话',
      });
    });

    it('保存 bot 回复到会话历史', async () => {
      const input = createInput({ mode: 'draft_only' });
      await dispatchReply(deps, input);

      expect(store.saveMessage).toHaveBeenCalledWith(
        'session-1',
        { sender: '自己', content: '你好，有什么可以帮你的？', isFromSelf: true },
        '测试会话'
      );
    });

    it('draft_only 模式不执行发送前校验', async () => {
      const locator = createMockLocator({ activeSessionId: 'other-session' });
      deps = { store, sender, locator };
      const input = createInput({ mode: 'draft_only' });
      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('draft_created');
      expect(locator.getActiveSessionId).not.toHaveBeenCalled();
    });
  });

  // ── 发送前安全校验 ──────────────────────────────────────────────

  describe('发送前安全校验 (preSendCheck)', () => {
    it('校验通过后正常发送', async () => {
      const locator = createMockLocator();
      deps = { store, sender, locator };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('message_sent');
      expect(sender.send).toHaveBeenCalled();
    });

    it('会话已切换时返回 send_check_failed', async () => {
      const locator = createMockLocator({ activeSessionId: 'session-999' });
      deps = { store, sender, locator };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('send_check_failed');
      expect(result.error).toBe('session_switched');
      expect(sender.send).not.toHaveBeenCalled();
      expect(store.logEvent).toHaveBeenCalledWith('send_check_failed', expect.objectContaining({
        sessionId: 'session-1',
        reason: 'session_switched',
      }));
    });

    it('消息已消失时返回 send_check_failed', async () => {
      const locator = createMockLocator({ messageInDom: false });
      deps = { store, sender, locator };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('send_check_failed');
      expect(result.error).toBe('message_gone');
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('有新消息且 abortOnNewMessages=true 时中止发送', async () => {
      const locator = createMockLocator({ hasNewMessages: true });
      deps = { store, sender, locator, abortOnNewMessages: true };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('send_check_failed');
      expect(result.error).toBe('new_messages');
      expect(sender.send).not.toHaveBeenCalled();
    });

    it('有新消息但 abortOnNewMessages=false 时继续发送', async () => {
      const locator = createMockLocator({ hasNewMessages: true });
      deps = { store, sender, locator, abortOnNewMessages: false };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('message_sent');
      expect(sender.send).toHaveBeenCalled();
    });

    it('未提供 locator 时跳过校验直接发送', async () => {
      deps = { store, sender };
      const input = createInput({ mode: 'auto_send' });

      const result = await dispatchReply(deps, input);

      expect(result.action).toBe('message_sent');
    });
  });
});
