import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import type { KK9Driver, DriverHealthSnapshot, KK9Message } from '@kkbot/driver';
import { UnifiedBootstrapper } from '../../src/bootstrapper.js';

class FakeDriver extends EventEmitter {
  public readonly generationId: string;
  public lastScanFrom: number | null = null;
  public readonly identity = {
    targetId: 'target-test',
    webSocketDebuggerUrl: 'ws://test/devtools/page/target-test',
    connectionId: 'connection-test',
    connectedAt: Date.now(),
  };

  constructor(generationId: string) {
    super();
    this.generationId = generationId;
  }

  public connect(): void {
    process.stdout.write(`${JSON.stringify({ event: 'driver_connected', generationId: this.generationId })}\n`);
  }

  public disconnect(): void {
    process.stdout.write(`${JSON.stringify({ event: 'driver_disconnected', generationId: this.generationId })}\n`);
  }

  public getHealthSnapshot(): DriverHealthSnapshot {
    const identity = {
      ...this.identity,
      startupGenerationId: this.generationId,
    };
    return {
      startupGenerationId: this.generationId,
      cdpStatus: 'connected',
      cdpConnectionIdentity: identity,
      eventBridgeAttached: true,
      eventBridgeConnectionIdentity: identity,
    };
  }

  public scanCompensationWindow(options: {
    fromTimestamp: number;
    toTimestamp?: number;
  }): KK9Message[] {
    this.lastScanFrom = options.fromTimestamp;
    process.stdout.write(
      `${JSON.stringify({ event: 'compensation_scan', generationId: this.generationId, fromTimestamp: options.fromTimestamp, toTimestamp: options.toTimestamp })}\n`
    );
    return [];
  }

  public startPolling(): void {
    process.stdout.write(`${JSON.stringify({ event: 'polling_started', generationId: this.generationId })}\n`);
  }
}

const configPath = process.argv[2];
if (!configPath) {
  throw new Error('缺少 configPath');
}

let fakeDriver: FakeDriver | null = null;
const bootstrapper = new UnifiedBootstrapper({
  configPath,
  driverFactory: (_config, generationId) => {
    fakeDriver = new FakeDriver(generationId);
    return fakeDriver as unknown as KK9Driver;
  },
});

await bootstrapper.start();
process.stdout.write(
  `${JSON.stringify({ event: 'ready', generationId: bootstrapper.startupGenerationId, compensationFrom: fakeDriver?.lastScanFrom })}\n`
);

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  if (!String(chunk).includes('shutdown')) {
    return;
  }
  void (async () => {
    const result = await bootstrapper.shutdown('child_test_shutdown');
    process.stdout.write(
      `${JSON.stringify({ event: 'shutdown', generationId: bootstrapper.startupGenerationId, successful: result.successful })}\n`
    );
    await fs.stat(configPath);
    process.exitCode = result.successful ? 0 : 1;
  })();
});
