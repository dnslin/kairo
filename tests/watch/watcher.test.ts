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
import type { WatcherConfig } from '../../src/config/schema.js';

const createMockExtractor = () => ({
  getRecentMessages: vi.fn(),
});

const createMessage = (overrides: Partial<Message> = {}): Message => ({
  sessionId: 'session-1',
  sender: 'Alice',
  time: '10:00',
  content: '你好',
  fingerprint: 'fp-1',
  ...overrides,
});

describe('MessageWatcher', () => {
  let extractor: ReturnType<typeof createMockExtractor>;
  let watcher: MessageWatcher;
  let config: WatcherConfig;

  beforeEach(() => {
    vi.useFakeTimers();
    extractor = createMockExtractor();
    config = { intervalMs: 1000, maxMessages: 2 };
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

    await watcher.start(onNewMessage);
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
});
