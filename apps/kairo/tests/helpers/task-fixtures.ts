import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type {
  ChatContext,
  ContextScope,
  MessageBatch,
  MessageKey,
  RawMessageInput,
} from '../../src/modules/private-chat-core/types.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import type {
  CreateTaskInput,
  TaskTerminalStatus,
} from '../../src/modules/task-lifecycle/types.js';
import { createTaskTestDatabase } from './task-database.js';

export const now = Date.UTC(2026, 8, 8, 10, 0, 0, 123);
export const claimedAt = now + 100;
export const executionMs = 120_789;
export const executionDeadline = claimedAt + executionMs;
export const waitedAt = now + 400;
export const waitDeadline = waitedAt + 600_000;
export const remainingExecutionMs = executionDeadline - waitedAt;
export const question = '是否只处理当前缺失子问题？';
export const allowedQuestionIds = ['当前问题/缺失项甲', '当前问题/缺失项乙'];

export interface TaskFixture {
  scope: ContextScope;
  context: ChatContext;
  batch: MessageBatch;
  firstMessage: MessageKey;
  input: CreateTaskInput;
  taskId: string;
}

/** 每个合同文件使用自有随机库；夹具名称说明已完成的前置步骤，不接受任意目标状态。 */
export async function createTaskTestContext() {
  const database = await createTaskTestDatabase();
  const storeA = new PostgresTaskStore(database.poolA);
  const storeB = new PostgresTaskStore(database.poolB);
  const chat = new PostgresPrivateChatStore(database.poolA);

  function scopeFor(): ContextScope {
    const employeeId = randomUUID();
    return { employeeId, botId: `bot-${randomUUID()}`, sessionId: `0-${employeeId}` };
  }

  async function message(
    scope: ContextScope,
    observedAt: number,
    overrides: Partial<RawMessageInput> = {},
    associate = true
  ): Promise<MessageKey> {
    const input: RawMessageInput = {
      sessionId: scope.sessionId,
      messageId: randomUUID(),
      direction: 'inbound',
      observedAt,
      text: '集成测试合成消息',
      messageType: 'text',
      attachments: {},
      ...overrides,
    };
    expect((await chat.insertRawMessage(input)).inserted).toBe(true);
    if (associate) expect(await chat.associateEmployee(input, scope.employeeId)).toBe(true);
    return { sessionId: input.sessionId, messageId: input.messageId };
  }

  async function batchFixture(scope = scopeFor()) {
    const context = await chat.createContext(scope, now - 1_000);
    const firstMessage = await message(scope, now - 500);
    const batch = await chat.createBatch({
      batchId: randomUUID(),
      threadId: context.threadId,
      firstMessage,
      quietDeadline: now,
      maxDeadline: now + 30_000,
    });
    return { scope, context, batch, firstMessage };
  }

  async function queuedFixture(scope = scopeFor(), store = storeA): Promise<TaskFixture> {
    const fixture = await batchFixture(scope);
    expect(await chat.setBatchStatus(fixture.batch.batchId, 'ready')).toBe(true);
    const input = {
      taskId: randomUUID(),
      batchId: fixture.batch.batchId,
      configDigest: '建任务时配置摘要',
      now,
      queueDeadline: now + 60_321,
    };
    const task = await store.createTask(input);
    expect(task).not.toBeNull();
    return { ...fixture, input, taskId: input.taskId };
  }

  async function runningFixture(scope = scopeFor(), store = storeA) {
    const fixture = await queuedFixture(scope, store);
    expect(
      await store.claimTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: claimedAt,
        executionMs,
      })
    ).not.toBeNull();
    return fixture;
  }

  async function startAttempt(
    fixture: TaskFixture,
    store = storeA,
    options: { inputVersion?: number; expectedAttemptId?: string | null; startedAt?: number } = {}
  ) {
    const input = {
      taskId: fixture.taskId,
      inputVersion: options.inputVersion ?? 1,
      now: options.startedAt ?? now + 200,
      attemptId: randomUUID(),
      expectedAttemptId: options.expectedAttemptId ?? null,
      runId: randomUUID(),
      configDigest: '实际运行配置摘要',
    };
    const attempt = await store.startAttempt(input);
    expect(attempt).toEqual({
      attemptId: input.attemptId,
      taskId: fixture.taskId,
      inputVersion: input.inputVersion,
      runId: input.runId,
      configDigest: input.configDigest,
      startedAt: input.now,
      finishedAt: null,
      errorType: null,
      adopted: false,
    });
    return { input, attemptId: input.attemptId };
  }

  async function successfulAttempt(fixture: TaskFixture, store = storeA) {
    const attempt = await startAttempt(fixture, store);
    expect(
      await store.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: now + 300,
        errorType: null,
      })
    ).toBe(true);
    return attempt;
  }

  async function waitingFixture(scope = scopeFor(), store = storeA) {
    const fixture = await runningFixture(scope, store);
    const attempt = await successfulAttempt(fixture, store);
    const waitId = randomUUID();
    expect(
      await store.waitForUser({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: waitedAt,
        attemptId: attempt.attemptId,
        waitId,
        question,
        allowedQuestionIds,
      })
    ).toBe(true);
    return { ...fixture, attemptId: attempt.attemptId, waitId };
  }

  async function runningWithSuccessfulAttempt(scope = scopeFor(), store = storeA) {
    const fixture = await runningFixture(scope, store);
    const attempt = await successfulAttempt(fixture, store);
    return { ...fixture, attemptId: attempt.attemptId };
  }

  async function readyToSendFixture(scope = scopeFor(), store = storeA) {
    const fixture = await runningWithSuccessfulAttempt(scope, store);
    expect(
      await store.adoptAttempt({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 400,
        attemptId: fixture.attemptId,
      })
    ).toBe(true);
    return fixture;
  }

  async function sendingFixture(scope = scopeFor(), store = storeA) {
    const fixture = await readyToSendFixture(scope, store);
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        from: 'ready_to_send',
        to: 'sending',
      })
    ).toBe(true);
    return fixture;
  }

  async function finishedSendingFixture(
    status: Exclude<TaskTerminalStatus, 'timed_out'>,
    store = storeA
  ) {
    const fixture = await sendingFixture(scopeFor(), store);
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 600,
        from: 'sending',
        to: status,
      })
    ).toBe(true);
    return fixture;
  }

  async function cancelledFixture(store = storeA) {
    const fixture = await queuedFixture(scopeFor(), store);
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        from: 'queued',
        to: 'cancelled',
      })
    ).toBe(true);
    return fixture;
  }

  async function timedOutFixture(store = storeA) {
    const fixture = await queuedFixture(scopeFor(), store);
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: fixture.input.queueDeadline,
        from: 'queued',
        to: 'timed_out',
      })
    ).toBe(true);
    return fixture;
  }

  async function failedFixture(store = storeA) {
    const fixture = await runningWithSuccessfulAttempt(scopeFor(), store);
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        now: now + 500,
        from: 'running',
        to: 'failed',
        expectedAttemptId: fixture.attemptId,
      })
    ).toBe(true);
    return fixture;
  }

  return {
    database,
    storeA,
    storeB,
    chat,
    scopeFor,
    message,
    batchFixture,
    queuedFixture,
    runningFixture,
    startAttempt,
    successfulAttempt,
    waitingFixture,
    runningWithSuccessfulAttempt,
    readyToSendFixture,
    sendingFixture,
    finishedSendingFixture,
    cancelledFixture,
    timedOutFixture,
    failedFixture,
  };
}

export type TaskTestContext = Awaited<ReturnType<typeof createTaskTestContext>>;
