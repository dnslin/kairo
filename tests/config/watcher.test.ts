import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { AppConfig, OperationMode, SelectorsConfig } from '../../src/config/schema.js';

// --- mock 声明（vi.hoisted 保证提升） ---
const { mockLoadConfig, mockWatchers } = vi.hoisted(() => ({
  mockLoadConfig: vi.fn<(path?: string) => AppConfig>(),
  mockWatchers: [] as EventEmitter[],
}));

vi.mock('chokidar', () => ({
  watch: vi.fn((): EventEmitter => {
    const w = new EventEmitter();
    (w as EventEmitter & { close: () => Promise<void> }).close =
      vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    mockWatchers.push(w);
    return w;
  }),
}));

vi.mock('../../src/config/loader.js', () => ({
  loadConfig: (...args: [string?]): AppConfig => mockLoadConfig(...args),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: (): Record<string, (...args: unknown[]) => void> => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
  }),
}));

import { watchConfig } from '../../src/config/watcher.js';

function makeConfig(mode: OperationMode = 'draft_only'): AppConfig {
  return {
    mode,
    selectors: { sessionList: '.list-' + mode } as unknown as SelectorsConfig,
  } as unknown as AppConfig;
}

describe('watchConfig', () => {
  let onModeChange: ReturnType<typeof vi.fn<(m: OperationMode) => void>>;
  let onSelectorsChange: ReturnType<typeof vi.fn<(s: SelectorsConfig) => void>>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWatchers.length = 0;
    onModeChange = vi.fn<(m: OperationMode) => void>();
    onSelectorsChange = vi.fn<(s: SelectorsConfig) => void>();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('mode 变更时触发 onModeChange 回调', () => {
    mockLoadConfig.mockReturnValue(makeConfig('auto_send'));

    watchConfig('/tmp/config.yaml', 'draft_only', {
      onModeChange,
      onSelectorsChange,
    });

    mockWatchers[0]!.emit('change');

    expect(onModeChange).toHaveBeenCalledWith('auto_send');
    expect(onSelectorsChange).toHaveBeenCalledWith(
      expect.objectContaining({ sessionList: '.list-auto_send' })
    );
  });

  it('mode 未变更时不触发 onModeChange 回调', () => {
    mockLoadConfig.mockReturnValue(makeConfig('draft_only'));

    watchConfig('/tmp/config.yaml', 'draft_only', {
      onModeChange,
      onSelectorsChange,
    });

    mockWatchers[0]!.emit('change');

    expect(onModeChange).not.toHaveBeenCalled();
    expect(onSelectorsChange).toHaveBeenCalledTimes(1);
  });

  it('连续多次变更正确追踪 mode', () => {
    watchConfig('/tmp/config.yaml', 'draft_only', {
      onModeChange,
      onSelectorsChange,
    });

    // draft_only → auto_send
    mockLoadConfig.mockReturnValue(makeConfig('auto_send'));
    mockWatchers[0]!.emit('change');
    expect(onModeChange).toHaveBeenCalledWith('auto_send');

    // auto_send → auto_send (无变化)
    mockLoadConfig.mockReturnValue(makeConfig('auto_send'));
    mockWatchers[0]!.emit('change');
    expect(onModeChange).toHaveBeenCalledTimes(1);

    // auto_send → draft_only
    mockLoadConfig.mockReturnValue(makeConfig('draft_only'));
    mockWatchers[0]!.emit('change');
    expect(onModeChange).toHaveBeenCalledTimes(2);
    expect(onModeChange).toHaveBeenLastCalledWith('draft_only');
  });

  it('config 加载失败时不崩溃也不触发回调', () => {
    mockLoadConfig.mockImplementation(() => {
      throw new Error('YAML 解析失败');
    });

    watchConfig('/tmp/config.yaml', 'draft_only', {
      onModeChange,
      onSelectorsChange,
    });

    mockWatchers[0]!.emit('change');

    expect(onModeChange).not.toHaveBeenCalled();
    expect(onSelectorsChange).not.toHaveBeenCalled();
  });

  it('返回的 stop 函数关闭 watcher', () => {
    mockLoadConfig.mockReturnValue(makeConfig('draft_only'));

    const stop = watchConfig('/tmp/config.yaml', 'draft_only', {
      onModeChange,
      onSelectorsChange,
    });

    stop();

    const watcher = mockWatchers[0] as EventEmitter & { close: () => Promise<void> };
    expect(watcher.close).toHaveBeenCalledTimes(1);
  });
});
