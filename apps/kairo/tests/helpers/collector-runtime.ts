import { randomUUID } from 'node:crypto';
import type { KK9Message } from '@kairo/driver';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../src/db/pool.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import {
  createCollector,
  type Collector,
  type CollectorResult,
} from '../../src/modules/private-chat-core/collector.js';
import type { BatchingSettings } from '../../src/modules/private-chat-core/collector-types.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import {
  contextMessage,
  createContextTestRuntime,
  type ContextTestRuntime,
} from './context-runtime.js';
import type { TaskTestDatabase } from './task-database.js';

export const collectorNow = Date.UTC(2026, 8, 9, 10, 0, 0);
export const collectorBatching: BatchingSettings = {
  quietMs: 5000,
  maxWaitMs: 60000,
  maxMessages: 10,
  maxChars: 30000,
};
export const collectorQueueMs = 600000;
export const collectorDigest = 'T23 集成配置摘要';
let employeeSequence = 400000;

export function collectorScope(): ContextScope {
  const employeeId = String(employeeSequence++);
  return { employeeId, sessionId: `0-${employeeId}`, botId: randomUUID() };
}

export interface CollectorTestRuntime extends Omit<ContextTestRuntime, 'receive'> {
  pool: Pool;
  owner: ContextScope;
  collector: Collector;
  receive(overrides?: Partial<KK9Message>): Promise<CollectorResult>;
  close(): Promise<void>;
}

/** 每个实例拥有自己的业务连接；只有出站 Driver 为 FakeKK9Driver，不创建 Agent。 */
export function createCollectorTestRuntime(
  database: TaskTestDatabase,
  owner = collectorScope(),
  options: { batching?: BatchingSettings; allowed?: boolean } = {}
): CollectorTestRuntime {
  const pool = createPostgresPool(database.databaseUrl, { max: 1, idleTimeoutMillis: 0 });
  const base = createContextTestRuntime(pool, owner, options.allowed ?? true);
  const collector = createCollector({
    botId: owner.botId,
    store: base.chat,
    contexts: base.contexts,
    sender: base.sender,
    tasks: base.tasks,
    batching: options.batching ?? collectorBatching,
    configDigest: collectorDigest,
    queueMs: collectorQueueMs,
    logger: createLogger({ write(): void {} }),
  });
  let closing: Promise<void> | undefined;
  return {
    ...base,
    pool,
    owner,
    collector,
    receive: async (overrides: Partial<KK9Message> = {}) =>
      collector.accept(
        await base.ingress(contextMessage(owner, { content: '测试正文', ...overrides }))
      ),
    close(): Promise<void> {
      closing ??= (async () => {
        try {
          await collector.close();
        } finally {
          base.sender.close();
          await pool.end();
        }
      })();
      return closing;
    },
  };
}

export async function collectorBatches(runtime: CollectorTestRuntime) {
  const result = await runtime.pool.query<{ batch_id: string }>(
    `SELECT batch_id FROM kairo.message_batches
     WHERE bot_id = $1 AND employee_id = $2 AND session_id = $3
     ORDER BY first_observed_at, batch_id`,
    [runtime.owner.botId, runtime.owner.employeeId, runtime.owner.sessionId]
  );
  return Promise.all(result.rows.map(row => runtime.chat.getCollectedBatch(row.batch_id)));
}

export async function collectorTasks(runtime: CollectorTestRuntime) {
  const result = await runtime.pool.query<{ task_id: string }>(
    `SELECT task_id FROM kairo.tasks
     WHERE bot_id = $1 AND employee_id = $2 AND session_id = $3
     ORDER BY created_at, task_id`,
    [runtime.owner.botId, runtime.owner.employeeId, runtime.owner.sessionId]
  );
  return Promise.all(result.rows.map(row => runtime.tasks.getTask(row.task_id)));
}

export async function collectorNotices(runtime: CollectorTestRuntime) {
  const result = await runtime.pool.query<{
    operation_id: string;
    purpose: string;
    status: string;
    send_calls: number;
  }>(
    `SELECT operation_id, purpose, status, send_calls FROM kairo.send_dispatches
     WHERE session_id = $1 AND purpose IN ('notice:input_attachment', 'notice:input_too_long')
     ORDER BY operation_id`,
    [runtime.owner.sessionId]
  );
  return result.rows;
}

/** 在真实数据库操作边界暂停，避免用真实睡眠猜测竞争顺序。 */
export function deferredSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}
