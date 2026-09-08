import { randomUUID } from 'node:crypto';
import { FakeKK9Driver } from '@kairo/driver';
import type { ConnectionStatus, DriverHealthSnapshot } from '@kairo/driver';

// 应用装配测试需要真实的生命周期和一致身份，不改变 SDK Fake 的默认发送合同。
export class ApplicationTestDriver extends FakeKK9Driver {
  private readonly generationId = randomUUID();
  private connected = false;
  private connectionId = '';

  override connect(): Promise<void> {
    this.connectionId = randomUUID();
    this.connected = true;
    return Promise.resolve();
  }

  override disconnect(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }

  override getStatus(): ConnectionStatus {
    return this.connected ? 'connected' : 'disconnected';
  }

  override getStartupGenerationId(): string {
    return this.generationId;
  }

  override getHealthSnapshot(): DriverHealthSnapshot {
    const identity = this.connected
      ? {
          startupGenerationId: this.generationId,
          connectionId: this.connectionId,
          targetId: '应用测试页面',
          webSocketDebuggerUrl: 'ws://127.0.0.1/应用测试连接',
          connectedAt: 0,
        }
      : null;
    return {
      startupGenerationId: this.generationId,
      cdpStatus: this.getStatus(),
      cdpConnectionIdentity: identity,
      eventBridgeAttached: this.connected,
      eventBridgeConnectionIdentity: identity,
    };
  }
}
