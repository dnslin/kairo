import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { FakeKK9Driver, type KK9Message } from '@kairo/driver';
import { PostgresSendDispatchStore } from '../../src/modules/im-transport/postgres-send-dispatch-store.js';
import { PostgresSendOperationStore } from '../../src/modules/im-transport/postgres-send-operation-store.js';
import {
  createSendService,
  type SendService,
} from '../../src/modules/im-transport/send-service.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import {
  createControlMessageHandler,
  type ContextMessageResult,
} from '../../src/modules/private-chat-core/control-message.js';
import {
  createContextService,
  type ContextService,
} from '../../src/modules/private-chat-core/context-service.js';
import { createIngress, type IngressResult } from '../../src/modules/private-chat-core/ingress.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';

export interface ContextTestRuntime {
  chat: PostgresPrivateChatStore;
  tasks: PostgresTaskStore;
  dispatches: PostgresSendDispatchStore;
  driver: FakeKK9Driver;
  sender: SendService;
  contexts: ContextService;
  ingress(message: KK9Message): Promise<IngressResult>;
  control(input: IngressResult): Promise<ContextMessageResult>;
  receive(message: KK9Message): Promise<ContextMessageResult>;
}

/** Driver 是明确的测试替身；门禁、协调、上下文与任务均执行正式实现。 */
export function createContextTestRuntime(
  pool: Pool,
  scope: ContextScope,
  allowed = true
): ContextTestRuntime {
  const chat = new PostgresPrivateChatStore(pool);
  const tasks = new PostgresTaskStore(pool);
  const dispatches = new PostgresSendDispatchStore(pool);
  const logger = createLogger({ write(): void {} });
  let driver!: FakeKK9Driver;
  const sender = createSendService({
    createDriver: store => {
      driver = new FakeKK9Driver(store);
      driver.setEmployees([
        { id: scope.employeeId, name: '可信员工', loginName: '测试工号', updatedAt: Date.now() },
      ]);
      return driver;
    },
    driverStore: new PostgresSendOperationStore(pool),
    dispatches,
    tasks,
    contexts: chat,
    logger,
  });
  const contexts = createContextService({ store: chat, tasks, idleMs: 7200000 });
  const ingress = createIngress({
    botId: scope.botId,
    employeeAllowlist: allowed ? [scope.employeeId] : [],
    driver,
    store: chat,
    sender,
    logger,
  });
  const control = createControlMessageHandler({ contexts, sender });
  return {
    chat,
    tasks,
    dispatches,
    driver,
    sender,
    contexts,
    ingress,
    control,
    receive: async (message: KK9Message) => control(await ingress(message)),
  };
}

export function contextMessage(
  scope: ContextScope,
  overrides: Partial<KK9Message> = {}
): KK9Message {
  return {
    id: randomUUID(),
    sessionId: scope.sessionId,
    sessionName: '测试私聊',
    sessionType: 'private',
    direction: 'inbound',
    origin: 'external',
    sender: '员工',
    content: '/new',
    time: '历史时刻',
    timestamp: Date.now(),
    isMe: false,
    messageType: 'text',
    ...overrides,
  };
}
