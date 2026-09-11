import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { loadBotConfig } from '../../src/config/load.js';
import type { BotConfig } from '../../src/config/schema.js';
import { loadBotCustomization } from '../../src/modules/bot-customization/instructions.js';
import type { BotCustomization } from '../../src/modules/bot-customization/instructions.js';
import { PostgresKnowledgeRecordStore } from '../../src/modules/knowledge-qa/knowledge-record-store.js';
import { createLogger } from '../../src/modules/operability/logger.js';
import type { AppLogger } from '../../src/modules/operability/logger.js';
import { PostgresRuntimeBootStore } from '../../src/modules/operability/runtime-boot-store.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type { TaskExecutor } from '../../src/modules/task-lifecycle/task-runner.js';
import { knowledgeTools } from '../../src/modules/tool-integration/knowledge-tool.js';
import type { TaskTestDatabase } from './task-database.js';

export interface AgentTaskFixture {
  input: Parameters<TaskExecutor>[0];
  dependencies: {
    config: BotConfig;
    bootId: string;
    chat: PostgresPrivateChatStore;
    knowledge: PostgresKnowledgeRecordStore;
    tasks: PostgresTaskStore;
    logger: AppLogger;
  };
  customization: BotCustomization;
  logs(): string;
}

/** 只建立真实任务前置账本；不装配模型、不关闭调用方数据库、不输出员工正文。 */
export async function createAgentTask(
  database: TaskTestDatabase,
  question: string,
  options: { executionMs?: number; scope?: ContextScope } = {}
): Promise<AgentTaskFixture> {
  const { config, configDigest } = await loadBotConfig(undefined, Object.keys(knowledgeTools));
  const customization = await loadBotCustomization(config);
  const chat = new PostgresPrivateChatStore(database.poolA);
  const tasks = new PostgresTaskStore(database.poolA);
  const knowledge = new PostgresKnowledgeRecordStore(database.poolA);
  const boots = new PostgresRuntimeBootStore(database.poolA);
  const now = Date.now();
  const employeeId = options.scope?.employeeId ?? randomUUID();
  const scope = options.scope ?? { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
  const message = { sessionId: scope.sessionId, messageId: randomUUID() };
  assert.equal(
    (
      await chat.insertRawMessage({
        ...message,
        direction: 'inbound',
        observedAt: now,
        text: question,
        messageType: 'text',
        attachments: {},
      })
    ).inserted,
    true
  );
  assert.equal(await chat.associateEmployee(message, employeeId), true);
  const context = await chat.createContext(scope, now);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage: message,
    quietDeadline: now,
    maxDeadline: now + 1000,
  });
  assert.equal(await chat.setBatchStatus(batch.batchId, 'ready'), true);
  const taskId = randomUUID();
  const queued = await tasks.createTask({
    taskId,
    batchId: batch.batchId,
    configDigest,
    now,
    queueDeadline: now + config.timeouts.queueMs,
  });
  assert.ok(queued);
  assert.ok(
    await tasks.claimTask({
      taskId,
      inputVersion: queued.inputVersion,
      now,
      executionMs: options.executionMs ?? config.timeouts.executionMs,
    })
  );
  const attemptId = randomUUID();
  const attempt = await tasks.startAttempt({
    taskId,
    attemptId,
    runId: randomUUID(),
    inputVersion: queued.inputVersion,
    configDigest,
    now,
    expectedAttemptId: null,
  });
  assert.ok(attempt);
  const task = await tasks.getTask(taskId);
  assert.ok(task?.executionDeadline);
  assert.equal(task.status, 'running');
  const bootId = randomUUID();
  await boots.startBoot({ bootId, gitCommit: '0'.repeat(40), configDigest, startedAt: now });
  let capturedLogs = '';
  const logger = createLogger({
    write(text: string): void {
      capturedLogs += text;
    },
  });
  const input: Parameters<TaskExecutor>[0] = {
    task,
    attempt,
    context,
    signal: new AbortController().signal,
  };
  return {
    input,
    dependencies: { config, bootId, chat, knowledge, tasks, logger },
    customization,
    logs: () => capturedLogs,
  };
}
