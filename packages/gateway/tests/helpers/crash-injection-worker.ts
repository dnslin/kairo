import fs from 'node:fs';
import { createKKBotStore } from '@kkbot/store';
import { LibSQLStore } from '@mastra/libsql';
import {
  KKBotAgent,
  MastraModelFactory,
  createFakeModel,
  Memory,
  deriveAssistantMessageId,
  ensureMastraThread,
} from '@kkbot/agent';
import { FakeKK9Driver, type KK9Driver } from '@kkbot/driver';
import { SessionCoordinator } from '../../src/coordinator.js';
import type { CoordinatorFaultHooks } from '../../src/types/index.js';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string): string => {
    const idx = args.indexOf(`--${name}`);
    if (idx === -1 || idx + 1 >= args.length) {
      throw new Error(`缺少命令行参数: --${name}`);
    }
    return args[idx + 1];
  };

  const scenario = getArg('scenario');
  const dbUrl = getArg('db-url');
  const sessionId = getArg('session-id');
  const deliveryId = getArg('delivery-id');
  const resourceId = getArg('resource-id');
  const store = await createKKBotStore({ url: dbUrl });
  const libSqlStore = new LibSQLStore({ id: 'mastra-worker-store', url: dbUrl });
  await libSqlStore.init();
  const mastraMemory = new Memory({ storage: libSqlStore });
  const fakeDriver = new FakeKK9Driver();

  const replyContent = `真实编排回复内容 [${scenario}]`;
  const fakeModel = createFakeModel({
    responses: [{ text: replyContent, finishReason: 'stop' }],
  });
  const modelFactory = new MastraModelFactory({
    tiers: {
      FAST: { models: [{ model: fakeModel }] },
      DEEP: { models: [{ model: fakeModel }] },
      VISION: { models: [{ model: fakeModel }] },
    },
  });
  // 确保会话档案与 Thread 存在 (模拟 user 消息已进入会话)
  await store.sessions.upsertSession({ id: sessionId, employeeId: resourceId });
  await ensureMastraThread(mastraMemory, sessionId, resourceId);

  const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

  const triggerKill = (name: string) => {
    fs.writeSync(1, `CRASH_POINT_REACHED:${name}\n`);
    process.kill(process.pid, 'SIGKILL');
  };

  const hooks: CoordinatorFaultHooks = {};

  switch (scenario) {
    case 'crash_before_create_delivery':
      hooks.afterAgentBeforeDeliveryCreate = () => triggerKill('crash_before_create_delivery');
      break;

    case 'crash_after_generated_before_sending':
      hooks.afterDeliveryGeneratedBeforeSending = () =>
        triggerKill('crash_after_generated_before_sending');
      break;

    case 'crash_after_sending_before_driver':
      hooks.afterSendingBeforeDriver = () => triggerKill('crash_after_sending_before_driver');
      break;

    case 'crash_after_driver_send_before_sent':
      hooks.afterDriverSendBeforeResultPersist = () =>
        triggerKill('crash_after_driver_send_before_sent');
      break;

    case 'crash_after_sent_before_memory':
      hooks.afterSentPersistBeforeMemorySave = () =>
        triggerKill('crash_after_sent_before_memory');
      break;

    case 'crash_after_memory_before_mark_committed':
      hooks.afterMemorySaveBeforeMarkCommitted = () =>
        triggerKill('crash_after_memory_before_mark_committed');
      break;

    case 'crash_after_adjudication_before_memory':
      // 场景 7: 人工裁定为 sent 持久化成功，但在后续 assistant Memory 补交前强杀
      hooks.afterAdjudicationPersistBeforeMemorySave = () =>
        triggerKill('crash_after_adjudication_before_memory');
      break;
    default:
      throw new Error(`未知的测试强杀场景: ${scenario}`);
  }

  const coordinator = new SessionCoordinator({
    driver: fakeDriver as unknown as KK9Driver,
    store,
    agent,
    mastraMemory,
    hooks,
    config: { debounceMs: 50, maxWaitMs: 150 },
  });
  await coordinator.start();

  if (scenario === 'crash_after_adjudication_before_memory') {
    // 预先建立处于 unknown 的 Delivery，然后在 adjudicateDelivery 期间强杀
    const mastraMessageId = deriveAssistantMessageId(deliveryId);
    await store.sessions.upsertSession({ id: sessionId, employeeId: resourceId });
    await store.deliveries.createDelivery({
      id: deliveryId,
      runId: `run_${deliveryId}`,
      sessionId,
      mastraMessageId,
      content: replyContent,
      contentHash: `hash_${deliveryId}`,
      status: 'generated',
    });
    await store.deliveries.updateStatus(deliveryId, 'sending');
    await store.deliveries.updateStatus(deliveryId, 'unknown', { errorCode: 'NET_TIMEOUT' });
    await coordinator.adjudicateDelivery({
      deliveryId,
      operator: 'op_crash_worker',
      decision: 'sent',
      evidenceSummary: '裁定证据',
    });
    return;
  }

  // 触发真实的 PrivateSession 消息进入 Coordinator 流水线
  await coordinator.handleInboundMessage({
    id: `msg_in_${deliveryId}`,
    messageId: `msg_in_${deliveryId}`,
    sessionId,
    sessionName: '用户',
    sessionType: 'private',
    sender: '用户',
    senderId: resourceId,
    content: '触发真实编排流水线',
    messageType: 'text',
    isMe: false,
    timestamp: Date.now(),
  });

  await coordinator.flushSession(sessionId);
}

main().catch((err) => {
  process.stderr.write(`WORKER_ERROR: ${err.message}\n`);
  process.exit(1);
});
