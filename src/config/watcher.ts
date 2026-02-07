import { watch, type FSWatcher } from 'chokidar';
import { loadConfig } from './loader.js';
import type { SelectorsConfig } from './schema.js';
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
