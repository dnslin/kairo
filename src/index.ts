import { getConfig } from './config/index.js';
import { CdpConnector } from './cdp/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('main');

async function main(): Promise<void> {
  log.info('KKBot starting...');

  const config = getConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  connector.on('connected', () => {
    log.info('CDP connection established');
  });

  connector.on('disconnected', reason => {
    log.warn({ reason }, 'CDP connection lost');
  });

  connector.on('heartbeat', uptimeMs => {
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    log.info({ uptimeMs, uptimeMin, uptimeSec: uptimeSec % 60 }, 'Connection alive');
  });

  const shutdown = (): void => {
    log.info('Shutting down...');
    connector.disconnect();
    process.exit(0);
  };

  try {
    const { pageUrl } = await connector.connect();
    log.info({ url: pageUrl }, 'Successfully connected to renderer page');

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    log.error({ err: error }, 'Failed to start KKBot');
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
