import { randomUUID } from 'node:crypto';
import { FakeKK9Driver } from '@kairo/driver';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLogger } from '../../src/modules/operability/logger.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import { PostgresSendOperationStore } from '../../src/modules/im-transport/postgres-send-operation-store.js';
import { PostgresSendDispatchStore } from '../../src/modules/im-transport/postgres-send-dispatch-store.js';
import {
  createSendService,
  type SendService,
} from '../../src/modules/im-transport/send-service.js';
import { createSendIntent, type SendRequest } from '../../src/modules/im-transport/send-policy.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

let database: TaskTestDatabase;
let chat: PostgresPrivateChatStore;
let tasks: PostgresTaskStore;
const services: SendService[] = [];

beforeAll(async () => {
  database = await createTaskTestDatabase();
  chat = new PostgresPrivateChatStore(database.poolA);
  tasks = new PostgresTaskStore(database.poolA);
});
afterEach(() => {
  for (const service of services.splice(0)) service.close();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await database?.close();
});

async function fixture() {
  const now = Date.now();
  const employeeId = randomUUID();
  const scope = { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
  const context = await chat.createContext(scope, now - 1000);
  const message = { sessionId: scope.sessionId, messageId: randomUUID() };
  await chat.insertRawMessage({
    ...message,
    direction: 'inbound',
    observedAt: now - 500,
    text: '等待交付问题',
    messageType: 'text',
    attachments: {},
  });
  await chat.associateEmployee(message, scope.employeeId);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage: message,
    quietDeadline: now,
    maxDeadline: now + 60_000,
  });
  await chat.setBatchStatus(batch.batchId, 'ready');
  const taskId = randomUUID();
  await tasks.createTask({
    taskId,
    batchId: batch.batchId,
    configDigest: '测试配置',
    now,
    queueDeadline: now + 600_000,
  });
  await tasks.claimTask({ taskId, inputVersion: 1, now, executionMs: 240_000 });
  const attemptId = randomUUID();
  await tasks.startAttempt({
    taskId,
    inputVersion: 1,
    now,
    attemptId,
    runId: randomUUID(),
    configDigest: '测试配置',
    expectedAttemptId: null,
  });
  await tasks.finishAttempt({ attemptId, finishedAt: now, errorType: null });
  const waitId = randomUUID();
  const enterWait = () =>
    tasks.waitForUser({
      taskId,
      inputVersion: 1,
      attemptId,
      now: Date.now(),
      waitId,
      question: '是否继续？',
      allowedQuestionIds: ['当前问题'],
    });
  const request: SendRequest = {
    subject: { kind: 'task', taskId, inputVersion: 1 },
    purpose: `notice:user_wait:${waitId}`,
    text: '是否继续？',
  };
  const dispatches = new PostgresSendDispatchStore(database.poolA);
  const peer = new PostgresTaskStore(database.poolB);
  const answer = async () => {
    const key = { sessionId: scope.sessionId, messageId: randomUUID() };
    await chat.insertRawMessage({
      ...key,
      direction: 'inbound',
      observedAt: Date.now(),
      text: '同意',
      messageType: 'text',
      attachments: {},
    });
    await chat.associateEmployee(key, scope.employeeId);
    return key;
  };
  return {
    taskId,
    attemptId,
    waitId,
    scope,
    context,
    enterWait,
    answer,
    request,
    dispatches,
    peer,
  };
}

function service(
  f: { dispatches: PostgresSendDispatchStore; request: SendRequest; scope: { sessionId: string } },
  beforeHandoff?: () => Promise<void>
) {
  const sender = createSendService({
    createDriver: store => new FakeKK9Driver(store),
    driverStore: new PostgresSendOperationStore(database.poolA),
    dispatches: f.dispatches,
    contexts: chat,
    tasks: {
      getTask: tasks.getTask.bind(tasks),
      transitionTask: tasks.transitionTask.bind(tasks),
      withTaskOutput: async (input, output) => {
        if (beforeHandoff) {
          const dispatch = await f.dispatches.ensure(
            createSendIntent(f.request, f.scope.sessionId)
          );
          if (dispatch.sendCalls > 0) {
            const change = beforeHandoff;
            beforeHandoff = undefined;
            await change();
          }
        }
        return tasks.withTaskOutput(input, output);
      },
    },
    logger: createLogger({ write(): void {} }),
  });
  services.push(sender);
  return {
    sender,
    sends: vi.spyOn(sender.driver, 'sendText'),
    queries: vi.spyOn(sender.driver, 'getSendStatus'),
  };
}

describe('T25 真实 PostgreSQL 等待通知交付门禁', () => {
  for (const boundary of ['预检查前', '预算占用后的交付前'] as const) {
    it.each(['timed_out', 'accepted', '新一轮等待', '恰好截止'] as const)(
      `${boundary}变为 %s，旧等待通知不能调用 Driver`,
      async outcome => {
        const f = await fixture();
        expect(await f.enterWait()).toBe(true);
        const change = async () => {
          if (outcome === 'timed_out') {
            const wait = await f.peer.getUserWait(f.waitId);
            expect(
              await f.peer.transitionTask({
                taskId: f.taskId,
                inputVersion: 1,
                now: wait!.deadline,
                from: 'waiting_for_user',
                to: 'timed_out',
              })
            ).toBe(true);
          } else if (outcome === '恰好截止') {
            const wait = await f.peer.getUserWait(f.waitId);
            vi.spyOn(Date, 'now').mockReturnValue(wait!.deadline);
          } else {
            const answerMessage = await f.answer();
            expect(
              await f.peer.resolveUserWait({
                taskId: f.taskId,
                inputVersion: 1,
                now: Date.now(),
                waitId: f.waitId,
                answerMessage,
                decision: 'accepted',
              })
            ).toBe(true);
            if (outcome === '新一轮等待') {
              expect(
                await f.peer.resumeTask({ taskId: f.taskId, inputVersion: 1, now: Date.now() })
              ).not.toBeNull();
              const current = await f.peer.getTask(f.taskId);
              const attemptId = randomUUID();
              await f.peer.startAttempt({
                taskId: f.taskId,
                inputVersion: 1,
                now: Date.now(),
                attemptId,
                runId: randomUUID(),
                configDigest: '测试配置',
                expectedAttemptId: current!.currentAttemptId,
              });
              await f.peer.finishAttempt({ attemptId, finishedAt: Date.now(), errorType: null });
              expect(
                await f.peer.waitForUser({
                  taskId: f.taskId,
                  inputVersion: 1,
                  now: Date.now(),
                  attemptId,
                  waitId: randomUUID(),
                  question: '下一轮问题',
                  allowedQuestionIds: ['下一轮'],
                })
              ).toBe(true);
            }
          }
        };
        if (boundary === '预检查前') await change();
        const { sender, sends, queries } = service(f, boundary === '预检查前' ? undefined : change);
        const result = await sender.send(f.request);
        expect(result.status).toBe('cancelled');
        expect(await sender.send(f.request)).toEqual(result);
        expect(sends).not.toHaveBeenCalled();
        expect(queries).not.toHaveBeenCalled();
      }
    );
  }

  it('当前未关闭且未过期的等待通知只发送一次，其他超时提示仍允许终态发送', async () => {
    const f = await fixture();
    expect(await f.enterWait()).toBe(true);
    const { sender, sends, queries } = service(f);
    const result = await sender.send(f.request);
    expect(result).toMatchObject({ status: 'delivered', sendCalls: 1 });
    expect(await sender.send(f.request)).toEqual(result);
    const wait = await f.peer.getUserWait(f.waitId);
    expect(
      await f.peer.transitionTask({
        taskId: f.taskId,
        inputVersion: 1,
        now: wait!.deadline,
        from: 'waiting_for_user',
        to: 'timed_out',
      })
    ).toBe(true);
    expect(
      await sender.send({ ...f.request, purpose: 'notice:user_wait_timeout', text: '等待已超时' })
    ).toMatchObject({ status: 'delivered', sendCalls: 1 });
    expect(sends).toHaveBeenCalledTimes(2);
    expect(queries).not.toHaveBeenCalled();
  });

  it('真实交付门禁前进入等待，恢复后同一进度意图发送一次', async () => {
    const f = await fixture();
    f.request.purpose = 'progress';
    f.request.text = '仍在处理中';
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10_001);
    const prepared = await f.dispatches.ensure(createSendIntent(f.request, f.scope.sessionId));
    const { sender, sends, queries } = service(f, async () => {
      expect(await f.enterWait()).toBe(true);
    });
    const paused = await sender.send(f.request);
    expect(paused).toMatchObject({
      operationId: prepared.operationId,
      purpose: 'progress',
      status: 'prepared',
      sendCalls: 0,
      queryUsed: false,
      queryDueAt: null,
    });
    expect(sends).not.toHaveBeenCalled();
    const answerMessage = await f.answer();
    expect(
      await f.peer.resolveUserWait({
        taskId: f.taskId,
        inputVersion: 1,
        now: Date.now(),
        waitId: f.waitId,
        answerMessage,
        decision: 'accepted',
      })
    ).toBe(true);
    clock.mockReturnValue(Date.now() + 1000);
    expect(
      await f.peer.resumeTask({ taskId: f.taskId, inputVersion: 1, now: Date.now() })
    ).not.toBeNull();
    const result = await sender.send(f.request);
    expect(result).toMatchObject({
      operationId: prepared.operationId,
      purpose: 'progress',
      status: 'delivered',
      sendCalls: 1,
    });
    expect(await sender.send(f.request)).toEqual(result);
    expect(sends).toHaveBeenCalledTimes(1);
    expect(queries).not.toHaveBeenCalled();
  });
});
