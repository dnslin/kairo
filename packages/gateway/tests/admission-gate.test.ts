import EventEmitter from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import type { KK9Driver, KK9Message } from '@kkbot/driver';
import { createKKBotStore, runKKBotMigrations, type KKBotStore } from '@kkbot/store';
import { SessionCoordinator } from '../src/coordinator.js';
import type { InFlightSession, WorkAdmission } from '../src/types/index.js';

function createMessage(sessionType: 'private' | 'group'): KK9Message {
  return {
    id: `native-${sessionType}`,
    messageId: `native-${sessionType}`,
    sessionId: `session-${sessionType}`,
    sessionName: '测试会话',
    sessionType,
    origin: 'external',
    sender: '员工',
    senderId: 'employee-01',
    content: '测试消息',
    time: '12:00:00',
    isMe: false,
    timestamp: Date.now(),
  };
}

describe('SessionCoordinator Work Admission Gate 合同', () => {
  let store: KKBotStore | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
  });

  it('Gate 关闭时在 Store 前拒绝新的 PrivateSession 与 GroupSession 工作', async () => {
    store = await createKKBotStore({ path: ':memory:' });
    await runKKBotMigrations(store.db);
    const gate: WorkAdmission = {
      startupGenerationId: 'gen-gate-01',
      isOpen: () => false,
      assertOpen: () => {
        throw new Error('gate closed');
      },
    };
    const coordinator = new SessionCoordinator({
      driver: new EventEmitter() as unknown as KK9Driver,
      store,
      admissionGate: gate,
    });

    await expect(coordinator.handleInboundMessage(createMessage('private'))).rejects.toThrow(
      'gate closed'
    );
    await expect(coordinator.handleInboundMessage(createMessage('group'))).rejects.toThrow(
      'gate closed'
    );
    expect(await store.messages.countMessages()).toBe(0);
  });

  it('Gate 开放后 GroupSession 仍只进入 Raw Store', async () => {
    store = await createKKBotStore({ path: ':memory:' });
    await runKKBotMigrations(store.db);
    const gate: WorkAdmission = {
      startupGenerationId: 'gen-gate-02',
      isOpen: () => true,
      assertOpen: () => undefined,
    };
    const coordinator = new SessionCoordinator({
      driver: new EventEmitter() as unknown as KK9Driver,
      store,
      admissionGate: gate,
    });

    await coordinator.handleInboundMessage(createMessage('group'));

    expect(await store.messages.countMessages({ sessionId: 'session-group' })).toBe(1);
    expect(await store.deliveries.getDeliveriesBySession('session-group')).toHaveLength(0);
  });
  it('相同 PrivateSession native messageId 重放不重复进入下游', async () => {
    store = await createKKBotStore({ path: ':memory:' });
    await runKKBotMigrations(store.db);
    const gate: WorkAdmission = {
      startupGenerationId: 'gen-gate-03',
      isOpen: () => true,
      assertOpen: () => undefined,
    };
    let consolidatedCount = 0;
    const coordinator = new SessionCoordinator({
      driver: new EventEmitter() as unknown as KK9Driver,
      store,
      admissionGate: gate,
      config: {
        debounceMs: 0,
        maxWaitMs: 1000,
        onConsolidatedMessage: () => {
          consolidatedCount += 1;
        },
      },
    });
    const message = createMessage('private');

    await coordinator.handleInboundMessage(message);
    await coordinator.handleInboundMessage(message);
    await coordinator.flushSession(message.sessionId);

    expect(await store.messages.countMessages({ sessionId: message.sessionId })).toBe(1);
    expect(consolidatedCount).toBe(1);
  });
  it('补偿重放同一 native messageId 不 abort 既有 Run 或重复 takeover', async () => {
    store = await createKKBotStore({ path: ':memory:' });
    await runKKBotMigrations(store.db);
    const gate: WorkAdmission = {
      startupGenerationId: 'gen-gate-04',
      isOpen: () => true,
      assertOpen: () => undefined,
    };
    const coordinator = new SessionCoordinator({
      driver: new EventEmitter() as unknown as KK9Driver,
      store,
      admissionGate: gate,
      config: { debounceMs: 0, maxWaitMs: 1000 },
    });
    let takeoverCount = 0;
    coordinator.on('takeover', () => {
      takeoverCount += 1;
    });

    const operatorMessage: KK9Message = {
      ...createMessage('private'),
      id: 'native-operator-replay',
      messageId: 'native-operator-replay',
      origin: 'operator',
      isMe: true,
    };
    await coordinator.handleInboundMessage(operatorMessage);
    await coordinator.handleInboundMessage(operatorMessage);
    expect(takeoverCount).toBe(1);

    const replayMessage: KK9Message = {
      ...createMessage('private'),
      id: 'native-inflight-replay',
      messageId: 'native-inflight-replay',
      sessionId: 'session-inflight-replay',
      origin: 'external',
      isMe: false,
    };
    await coordinator.handleInboundMessage(replayMessage);
    coordinator.drain();

    const compensationCoordinator = new SessionCoordinator({
      driver: new EventEmitter() as unknown as KK9Driver,
      store,
      admissionGate: gate,
      config: { debounceMs: 0, maxWaitMs: 1000 },
    });
    const abortController = new AbortController();
    const inFlight = {
      sessionId: replayMessage.sessionId,
      runId: 'run-existing',
      inputMessageIds: [replayMessage.messageId],
      abortController,
      startedAt: Date.now(),
      message: { sessionId: replayMessage.sessionId, messages: [replayMessage] },
    } as unknown as InFlightSession;
    const internals = compensationCoordinator as unknown as {
      inFlightSessions: Map<string, InFlightSession>;
    };
    internals.inFlightSessions.set(replayMessage.sessionId, inFlight);

    await compensationCoordinator.handleCompensationMessage(replayMessage);

    expect(abortController.signal.aborted).toBe(false);
    expect(internals.inFlightSessions.get(replayMessage.sessionId)).toBe(inFlight);
    compensationCoordinator.drain();
  });
});
