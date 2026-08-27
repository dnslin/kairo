import type EventEmitter from 'node:events';
import { describe, expect, it } from 'vitest';
import { KK9Driver } from '../src/driver.js';
import type {
  CdpConnectionIdentity,
  CdpConnectionLostEvent,
  DriverHealthEvent,
} from '../src/types/index.js';

interface DriverInternals {
  cdp: EventEmitter;
  eventBridge: EventEmitter;
}

function createDriver(): KK9Driver {
  return new KK9Driver({
    startupGenerationId: 'gen-health-01',
    currentUserId: 'bot-01',
    cdp: {
      url: 'http://127.0.0.1:9222',
      pageMatch: 'renderer.html',
    },
  });
}

const connectionIdentity: CdpConnectionIdentity = {
  startupGenerationId: 'gen-health-01',
  connectionId: 'connection-01',
  targetId: 'target-01',
  webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/target-01',
  connectedAt: 1_700_000_000_000,
};

describe('KK9Driver 结构化健康事实合同', () => {
  it('报告 CDP 失效时保留启动代次、连接身份、时间和原始 cause', () => {
    const driver = createDriver();
    const events: DriverHealthEvent[] = [];
    driver.on('health', event => events.push(event));
    const cause = new Error('WebSocket closed by KK9');
    const lost: CdpConnectionLostEvent = {
      startupGenerationId: 'gen-health-01',
      connectionIdentity,
      observedAt: 1_700_000_000_123,
      cause,
    };

    const internals = driver as unknown as DriverInternals;
    internals.cdp.emit('connection_lost', lost);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'cdp_invalidated',
      startupGenerationId: 'gen-health-01',
      connectionIdentity,
      observedAt: 1_700_000_000_123,
      cause,
    });
  });
  it('关键健康事实失效后拒绝同一 Driver 原地重连', async () => {
    const driver = createDriver();
    const internals = driver as unknown as DriverInternals;
    internals.cdp.emit('connection_lost', {
      startupGenerationId: 'gen-health-01',
      connectionIdentity,
      observedAt: 1_700_000_000_789,
      cause: new Error('CDP closed'),
    } satisfies CdpConnectionLostEvent);

    await expect(driver.connect()).rejects.toThrow('禁止原地重连');
  });

  it('转发 EventBridge 身份失效而不依赖日志文本解析', () => {
    const driver = createDriver();
    const events: DriverHealthEvent[] = [];
    driver.on('health', event => events.push(event));
    const cause = new Error('旧代 EventBridge payload');
    const event: DriverHealthEvent = {
      kind: 'connection_identity_mismatch',
      startupGenerationId: 'gen-health-01',
      connectionIdentity,
      expectedConnectionIdentity: {
        ...connectionIdentity,
        connectionId: 'connection-02',
      },
      observedAt: 1_700_000_000_456,
      cause,
    };

    const internals = driver as unknown as DriverInternals;
    internals.eventBridge.emit('health', event);

    expect(events).toEqual([event]);
  });

  it('健康快照绑定当前 startup generation 且初始 EventBridge 未注入', () => {
    const driver = createDriver();

    expect(driver.getHealthSnapshot()).toEqual({
      startupGenerationId: 'gen-health-01',
      cdpStatus: 'disconnected',
      cdpConnectionIdentity: null,
      eventBridgeAttached: false,
      eventBridgeConnectionIdentity: null,
    });
  });

  it('单次业务调用失败不自动报告关键 Driver 事实失效', async () => {
    const driver = createDriver();
    const events: DriverHealthEvent[] = [];
    driver.on('health', event => events.push(event));

    const result = await driver.sendText('offline probe');
    expect(result.success).toBe(false);
    expect(result.isPreTrigger).toBe(true);
    expect(events).toHaveLength(0);
  });
});
