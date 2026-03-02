import { watch, type FSWatcher } from 'chokidar';
import { loadConfig } from './loader.js';
import type { OperationMode, SelectorsConfig } from './schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('config-watcher');

export function watchSelectors(
  configPath: string,
  callback: (selectors: SelectorsConfig) => void
): () => void {
  log.info({ configPath }, 'Starting config watcher');

  const watcher: FSWatcher = watch(configPath, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', () => {
    log.info({ configPath }, 'Config file changed, reloading selectors');
    try {
      const config = loadConfig(configPath);
      callback(config.selectors);
      log.info('Selectors reloaded successfully');
    } catch (error) {
      log.error({ err: error }, 'Failed to reload config');
    }
  });

  return () => {
    log.info('Stopping config watcher');
    void watcher.close();
  };
}

/** watchConfig 回调接口 */
export interface WatchConfigCallbacks {
  onModeChange: (mode: OperationMode) => void;
  onSelectorsChange: (selectors: SelectorsConfig) => void;
}

/**
 * 监听配置文件变更，检测 mode 和 selectors 变化并触发对应回调
 */
export function watchConfig(
  configPath: string,
  initialMode: OperationMode,
  callbacks: WatchConfigCallbacks
): () => void {
  let currentMode: OperationMode = initialMode;

  log.info({ configPath, initialMode }, '启动配置监听（mode + selectors）');

  const watcher: FSWatcher = watch(configPath, {
    persistent: true,
    ignoreInitial: true,
  });

  watcher.on('change', () => {
    log.info({ configPath }, '配置文件变更，重新加载');
    try {
      const config = loadConfig(configPath);

      callbacks.onSelectorsChange(config.selectors);

      if (config.mode !== currentMode) {
        log.info({ from: currentMode, to: config.mode }, '运行模式已切换');
        currentMode = config.mode;
        callbacks.onModeChange(config.mode);
      }

      log.info('配置重载成功');
    } catch (error) {
      log.error({ err: error }, '配置重载失败');
    }
  });

  return () => {
    log.info('停止配置监听');
    void watcher.close();
  };
}
