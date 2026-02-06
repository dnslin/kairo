import { loadConfig } from '../src/config/index.js';
import { CdpConnector } from '../src/cdp/index.js';
import { createChildLogger } from '../src/utils/logger.js';

const log = createChildLogger('stability-test');

const TEST_DURATION_MS = 10 * 60 * 1000;
const REPORT_INTERVAL_MS = 60 * 1000;

interface TestStats {
  startTime: number;
  heartbeatCount: number;
  disconnectCount: number;
  lastHeartbeat: number | null;
}

async function runStabilityTest(): Promise<void> {
  log.info({ durationMinutes: TEST_DURATION_MS / 60000 }, 'Starting stability test');

  const config = loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  const stats: TestStats = {
    startTime: Date.now(),
    heartbeatCount: 0,
    disconnectCount: 0,
    lastHeartbeat: null,
  };

  connector.on('heartbeat', uptimeMs => {
    stats.heartbeatCount++;
    stats.lastHeartbeat = Date.now();
    log.debug({ uptimeMs, heartbeatCount: stats.heartbeatCount }, 'Heartbeat received');
  });

  connector.on('disconnected', reason => {
    stats.disconnectCount++;
    log.error({ reason, disconnectCount: stats.disconnectCount }, 'Connection lost during test');
  });

  const reportInterval = setInterval(() => {
    const elapsedMs = Date.now() - stats.startTime;
    const elapsedMin = Math.floor(elapsedMs / 60000);
    const remainingMin = Math.ceil((TEST_DURATION_MS - elapsedMs) / 60000);
    log.info(
      {
        elapsedMin,
        remainingMin,
        heartbeatCount: stats.heartbeatCount,
        disconnectCount: stats.disconnectCount,
        isConnected: connector.isActive(),
      },
      'Progress report'
    );
  }, REPORT_INTERVAL_MS);

  try {
    const { pageUrl } = await connector.connect();
    log.info({ url: pageUrl }, 'Connected, starting 10-minute stability test');

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        resolve();
      }, TEST_DURATION_MS);

      connector.on('disconnected', () => {
        clearTimeout(timeout);
        reject(new Error('Connection lost during stability test'));
      });
    });

    log.info('Stability test completed successfully!');
  } catch (error) {
    log.error({ err: error }, 'Stability test failed');
    process.exitCode = 1;
  } finally {
    clearInterval(reportInterval);
    connector.disconnect();

    const totalMs = Date.now() - stats.startTime;
    log.info(
      {
        totalMinutes: (totalMs / 60000).toFixed(2),
        heartbeatCount: stats.heartbeatCount,
        disconnectCount: stats.disconnectCount,
        passed: stats.disconnectCount === 0 && totalMs >= TEST_DURATION_MS,
      },
      'Test summary'
    );
  }
}

runStabilityTest().catch((err: unknown) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
