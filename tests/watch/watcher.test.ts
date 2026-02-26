import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { loggerErrorMock, loggerInfoMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    error: loggerErrorMock,
    info: loggerInfoMock,
    debug: loggerDebugMock,
  }),
}));

import { MessageWatcher } from '../../src/watch/index.js';
import type { MessageExtractor, Message } from '../../src/extract/extractor.js';
import type { SessionInfo } from '../../src/extract/index.js';
import type { WatcherConfig } from '../../src/config/schema.js';

const createMockExtractor = () => ({
  getRecentMessages: vi.fn(),
  getAllSessions: vi.fn(),
  getMessagesFromSession: vi.fn(),
});

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  sessionId: 'session-1',
  sender: 'Alice',
  time: '10:00',
  content: '你好',
  fingerprint: 'fp-1',
  isMe: false,
  ...overrides,
});

const createSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'session-1',
  name: 'Test Session',
  type: 'private',
  lastMessage: '',
  time: '',
  unread: false,
  isSelected: false,
  ...overrides,
});

describe('MessageWatcher', () => {
  let extractor: ReturnType<typeof createMockExtractor>;
  let watcher: MessageWatcher;
  let config: WatcherConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    extractor = createMockExtractor();
    // 默认：无未读会话 → 回退到 getRecentMessages
    extractor.getAllSessions.mockResolvedValue([]);
    config = { intervalMs: 1000, maxMessages: 2, switchDelayMs: 100, maxSessionsPerCycle: 10 };
    watcher = new MessageWatcher(extractor as unknown as MessageExtractor, config);
  });

  afterEach(() => {
    watcher.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('start() 开始轮询，调用 extractor.getRecentMessages', async () => {
    const messages = [createMessage()];
    extractor.getRecentMessages.mockResolvedValue(messages);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(1);
    expect(extractor.getRecentMessages).toHaveBeenCalledWith(config.maxMessages);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(messages[0]);
  });

  it('stop() 停止轮询循环', async () => {
    extractor.getRecentMessages.mockResolvedValue([createMessage()]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);

    watcher.stop();
    await vi.advanceTimersByTimeAsync(config.intervalMs * 3);

    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(1);
  });

  it('多次调用 start() 是幂等的 (不启动多个轮询)', async () => {
    extractor.getRecentMessages.mockResolvedValue([createMessage()]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(config.intervalMs);
    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(2);
  });

  it('stop() 后可以重新 start()', async () => {
    extractor.getRecentMessages.mockResolvedValue([createMessage()]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);
    watcher.stop();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(2);
  });

  it('使用 setTimeout 链而非 setInterval', async () => {
    extractor.getRecentMessages.mockResolvedValue([createMessage()]);
    const onNewMessage = vi.fn();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).toHaveBeenCalled();
  });

  it('新消息触发 onNewMessage 回调', async () => {
    const message = createMessage({ fingerprint: 'fp-new' });
    extractor.getRecentMessages.mockResolvedValueOnce([message]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);

    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(message);
  });

  it('相同指纹的消息不重复触发', async () => {
    const firstMessage = createMessage({ fingerprint: 'fp-dup' });
    const duplicateMessage = createMessage({ fingerprint: 'fp-dup', content: '再次出现' });
    extractor.getRecentMessages
      .mockResolvedValueOnce([firstMessage])
      .mockResolvedValueOnce([duplicateMessage]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(config.intervalMs);

    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(firstMessage);
  });

  it('不同指纹的消息各触发一次', async () => {
    const firstMessage = createMessage({ fingerprint: 'fp-a' });
    const secondMessage = createMessage({ fingerprint: 'fp-b' });
    extractor.getRecentMessages
      .mockResolvedValueOnce([firstMessage])
      .mockResolvedValueOnce([secondMessage]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(config.intervalMs);

    expect(onNewMessage).toHaveBeenCalledTimes(2);
    expect(onNewMessage).toHaveBeenCalledWith(firstMessage);
    expect(onNewMessage).toHaveBeenCalledWith(secondMessage);
  });

  it('消息列表为空时继续轮询', async () => {
    const nextMessage = createMessage({ fingerprint: 'fp-empty-next' });
    extractor.getRecentMessages.mockResolvedValueOnce([]).mockResolvedValueOnce([nextMessage]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(config.intervalMs);

    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(2);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(nextMessage);
  });

  it('extractor 抛出异常时记录日志并继续', async () => {
    loggerErrorMock.mockClear();
    const error = new Error('提取失败');
    const nextMessage = createMessage({ fingerprint: 'fp-after-error' });
    extractor.getRecentMessages.mockRejectedValueOnce(error).mockResolvedValueOnce([nextMessage]);
    const onNewMessage = vi.fn();

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(config.intervalMs);

    expect(loggerErrorMock).toHaveBeenCalledWith({ err: error }, '提取消息失败');
    expect(extractor.getRecentMessages).toHaveBeenCalledTimes(2);
    expect(onNewMessage).toHaveBeenCalledTimes(1);
    expect(onNewMessage).toHaveBeenCalledWith(nextMessage);
  });

  it('onNewMessage 回调抛出异常时记录日志并继续', async () => {
    loggerErrorMock.mockClear();
    const error = new Error('回调失败');
    const firstMessage = createMessage({ fingerprint: 'fp-callback-err' });
    const secondMessage = createMessage({ fingerprint: 'fp-callback-next' });
    extractor.getRecentMessages
      .mockResolvedValueOnce([firstMessage])
      .mockResolvedValueOnce([secondMessage]);
    const onNewMessage = vi.fn().mockImplementationOnce(() => {
      throw error;
    });

    watcher.start(onNewMessage);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(config.intervalMs);

    expect(loggerErrorMock).toHaveBeenCalledWith(
      { err: error, fingerprint: firstMessage.fingerprint },
      '回调处理失败'
    );
    expect(onNewMessage).toHaveBeenCalledTimes(2);
    expect(onNewMessage).toHaveBeenCalledWith(firstMessage);
    expect(onNewMessage).toHaveBeenCalledWith(secondMessage);
  });

  it('快速 start/stop 调用不导致异常', async () => {
    extractor.getRecentMessages.mockResolvedValue([]);
    const onNewMessage = vi.fn();

    expect(() => watcher.start(onNewMessage)).not.toThrow();
    watcher.stop();
    expect(() => watcher.start(onNewMessage)).not.toThrow();
    watcher.stop();
    expect(() => watcher.start(onNewMessage)).not.toThrow();
    watcher.stop();
  });

  describe('多会话轮询', () => {
    it('无未读会话时，回退到当前会话轮询', async () => {
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-1', unread: false }),
      ]);
      const msg = createMessage({ fingerprint: 'fp-fallback' });
      extractor.getRecentMessages.mockResolvedValue([msg]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(extractor.getRecentMessages).toHaveBeenCalledTimes(1);
      expect(extractor.getMessagesFromSession).not.toHaveBeenCalled();
      expect(onNewMessage).toHaveBeenCalledWith(msg);
    });

    it('检测到未读会话时，自动切换并提取消息', async () => {
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-unread', unread: true }),
      ]);
      const msg = createMessage({ sessionId: 's-unread', fingerprint: 'fp-switch' });
      extractor.getMessagesFromSession.mockResolvedValue([msg]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(extractor.getMessagesFromSession).toHaveBeenCalledWith(
        's-unread', config.maxMessages, config.switchDelayMs
      );
      expect(extractor.getRecentMessages).not.toHaveBeenCalled();
      expect(onNewMessage).toHaveBeenCalledWith(msg);
    });

    it('一个周期内依次处理多个未读会话', async () => {
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-a', unread: true }),
        createSession({ id: 's-b', unread: true }),
      ]);
      const msgA = createMessage({ sessionId: 's-a', fingerprint: 'fp-a' });
      const msgB = createMessage({ sessionId: 's-b', fingerprint: 'fp-b' });
      extractor.getMessagesFromSession
        .mockResolvedValueOnce([msgA])
        .mockResolvedValueOnce([msgB]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(extractor.getMessagesFromSession).toHaveBeenCalledTimes(2);
      expect(onNewMessage).toHaveBeenCalledTimes(2);
      expect(onNewMessage).toHaveBeenCalledWith(msgA);
      expect(onNewMessage).toHaveBeenCalledWith(msgB);
    });

    it('处理完停留在最后会话（不切回）', async () => {
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-only', unread: true }),
      ]);
      extractor.getMessagesFromSession.mockResolvedValue([]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      // 只调用一次 getMessagesFromSession（内含 selectSession），不额外切回
      expect(extractor.getMessagesFromSession).toHaveBeenCalledTimes(1);
    });

    it('切换失败时跳过该会话并记录日志', async () => {
      loggerErrorMock.mockClear();
      const error = new Error('切换失败');
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-fail', unread: true }),
        createSession({ id: 's-ok', unread: true }),
      ]);
      const msgOk = createMessage({ sessionId: 's-ok', fingerprint: 'fp-ok' });
      extractor.getMessagesFromSession
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce([msgOk]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerErrorMock).toHaveBeenCalledWith(
        { err: error, sessionId: 's-fail' }, '处理未读会话失败，跳过'
      );
      expect(onNewMessage).toHaveBeenCalledTimes(1);
      expect(onNewMessage).toHaveBeenCalledWith(msgOk);
    });

    it('已无未读的会话不会被切换', async () => {
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-read', unread: false }),
        createSession({ id: 's-unread', unread: true }),
      ]);
      const msg = createMessage({ sessionId: 's-unread', fingerprint: 'fp-unread' });
      extractor.getMessagesFromSession.mockResolvedValue([msg]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(extractor.getMessagesFromSession).toHaveBeenCalledTimes(1);
      expect(extractor.getMessagesFromSession).toHaveBeenCalledWith(
        's-unread', config.maxMessages, config.switchDelayMs
      );
    });

    it('maxSessionsPerCycle 限制每轮处理数量', async () => {
      const limitedConfig: WatcherConfig = { ...config, maxSessionsPerCycle: 2 };
      const limitedWatcher = new MessageWatcher(
        extractor as unknown as MessageExtractor, limitedConfig
      );
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-1', unread: true }),
        createSession({ id: 's-2', unread: true }),
        createSession({ id: 's-3', unread: true }),
      ]);
      extractor.getMessagesFromSession.mockResolvedValue([]);
      const onNewMessage = vi.fn();

      limitedWatcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(extractor.getMessagesFromSession).toHaveBeenCalledTimes(2);
      limitedWatcher.stop();
    });

    it('getAllSessions 失败时记录日志并返回', async () => {
      loggerErrorMock.mockClear();
      const error = new Error('会话列表获取失败');
      extractor.getAllSessions.mockRejectedValue(error);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      await vi.advanceTimersByTimeAsync(0);

      expect(loggerErrorMock).toHaveBeenCalledWith(
        { err: error }, '获取会话列表失败'
      );
      expect(extractor.getRecentMessages).not.toHaveBeenCalled();
      expect(extractor.getMessagesFromSession).not.toHaveBeenCalled();
    });

    it('未读会话的消息正确触发去重和回调', async () => {
      extractor.getAllSessions.mockResolvedValue([
        createSession({ id: 's-dedup', unread: true }),
      ]);
      const msg = createMessage({ sessionId: 's-dedup', fingerprint: 'fp-dedup' });
      extractor.getMessagesFromSession.mockResolvedValue([msg]);
      const onNewMessage = vi.fn();

      watcher.start(onNewMessage);
      // 第一轮：消息触发回调
      await vi.advanceTimersByTimeAsync(0);
      expect(onNewMessage).toHaveBeenCalledTimes(1);

      // 第二轮：同指纹消息不再触发
      await vi.advanceTimersByTimeAsync(config.intervalMs);
      expect(onNewMessage).toHaveBeenCalledTimes(1);
    });
  });
});
