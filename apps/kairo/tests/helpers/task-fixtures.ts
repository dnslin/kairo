import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type {
  ChatContext,
  ContextScope,
  MessageBatch,
  MessageKey,
  PrivateChatStore,
  RawMessageInput,
} from '../../src/modules/private-chat-core/types.js';
import type {
  CreateTaskInput,
  StartAttemptInput,
  TaskStatus,
  TaskStore,
} from '../../src/modules/task-lifecycle/types.js';

export const now = Date.UTC(2026, 8, 8, 10, 0, 0, 123);
export const claimedAt = now + 100;
export const executionMs = 120_789;
export const executionDeadline = claimedAt + executionMs;
export const waitedAt = now + 400;
export const waitDeadline = waitedAt + 600_000;
export const remainingExecutionMs = executionDeadline - waitedAt;
export const question = '是否只处理当前缺失子问题？';
export const allowedQuestionIds = ['当前问题/缺失项甲', '当前问题/缺失项乙'];

export interface BatchFixture {
  scope: ContextScope;
  context: ChatContext;
  batch: MessageBatch;
  firstMessage: MessageKey;
}

export interface TaskFixture extends BatchFixture {
  input: CreateTaskInput;
  taskId: string;
}

export interface AttemptFixture {
  input: StartAttemptInput;
  attemptId: string;
}

export interface RunningFixture extends TaskFixture {
  attemptId: string;
}

export interface WaitingFixture extends RunningFixture {
  waitId: string;
}

/** 仅状态矩阵和恢复遍历需要同时表示无 attempt/wait 的状态。 */
export interface StateFixture extends TaskFixture {
  attemptId: string | null;
  waitId: string | null;
}

export function scopeFor(): ContextScope {
  const employeeId = randomUUID();
  return { employeeId, botId: `bot-${randomUUID()}`, sessionId: `0-${employeeId}` };
}

export async function message(
  chat: PrivateChatStore,
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

export async function batchFixture(
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<BatchFixture> {
  const context = await chat.createContext(scope, now - 1_000);
  const firstMessage = await message(chat, scope, now - 500);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage,
    quietDeadline: now,
    maxDeadline: now + 30_000,
  });
  return { scope, context, batch, firstMessage };
}

export async function queuedFixture(
  store: TaskStore,
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<TaskFixture> {
  const fixture = await batchFixture(chat, scope);
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

export async function claimedFixture(
  store: TaskStore,
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<TaskFixture> {
  const fixture = await queuedFixture(store, chat, scope);
  expect(
    await store.claimTask({ taskId: fixture.taskId, inputVersion: 1, now: claimedAt, executionMs })
  ).toBe(true);
  return fixture;
}

export async function startAttempt(
  store: TaskStore,
  fixture: TaskFixture,
  options: { inputVersion?: number; expectedAttemptId?: string | null; startedAt?: number } = {}
): Promise<AttemptFixture> {
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

export async function successfulAttempt(
  store: TaskStore,
  fixture: TaskFixture
): Promise<AttemptFixture> {
  const attempt = await startAttempt(store, fixture);
  expect(
    await store.finishAttempt({
      attemptId: attempt.attemptId,
      finishedAt: now + 300,
      errorType: null,
    })
  ).toBe(true);
  return attempt;
}

export async function waitingFixture(
  store: TaskStore,
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<WaitingFixture> {
  const fixture = await claimedFixture(store, chat, scope);
  const attempt = await successfulAttempt(store, fixture);
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

export async function runningFixture(
  store: TaskStore,
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<RunningFixture> {
  const fixture = await claimedFixture(store, chat, scope);
  const attempt = await successfulAttempt(store, fixture);
  return { ...fixture, attemptId: attempt.attemptId };
}

export async function readyFixture(
  store: TaskStore,
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<RunningFixture> {
  const fixture = await runningFixture(store, chat, scope);
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

export async function sendingFixture(
  store: TaskStore,
  chat: PrivateChatStore,
  scope = scopeFor()
): Promise<RunningFixture> {
  const fixture = await readyFixture(store, chat, scope);
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

/** 正向用例直接选择具名 fixture；这里只为状态矩阵与恢复遍历建立边界状态。 */
export async function fixtureAt(
  store: TaskStore,
  chat: PrivateChatStore,
  status: TaskStatus
): Promise<StateFixture> {
  if (status === 'waiting_for_user') return waitingFixture(store, chat);
  if (status === 'queued' || status === 'cancelled' || status === 'timed_out') {
    const fixture = await queuedFixture(store, chat);
    if (status !== 'queued') {
      expect(
        await store.transitionTask({
          taskId: fixture.taskId,
          inputVersion: 1,
          from: 'queued',
          to: status,
          now: status === 'timed_out' ? fixture.input.queueDeadline : now + 500,
        })
      ).toBe(true);
    }
    return { ...fixture, attemptId: null, waitId: null };
  }
  if (status === 'running' || status === 'failed') {
    const fixture = await runningFixture(store, chat);
    if (status === 'failed') {
      expect(
        await store.transitionTask({
          taskId: fixture.taskId,
          inputVersion: 1,
          from: 'running',
          to: 'failed',
          expectedAttemptId: fixture.attemptId,
          now: now + 500,
        })
      ).toBe(true);
    }
    return { ...fixture, waitId: null };
  }
  if (status === 'ready_to_send') return { ...(await readyFixture(store, chat)), waitId: null };
  const fixture = await sendingFixture(store, chat);
  if (status !== 'sending') {
    expect(
      await store.transitionTask({
        taskId: fixture.taskId,
        inputVersion: 1,
        from: 'sending',
        to: status,
        now: now + 600,
      })
    ).toBe(true);
  }
  return { ...fixture, waitId: null };
}
