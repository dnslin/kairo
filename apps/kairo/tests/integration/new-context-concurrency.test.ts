import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import { createTaskTestContext, now, type TaskTestContext } from '../helpers/task-fixtures.js';
import {
  contextMessage,
  createContextTestRuntime,
  type ContextTestRuntime,
} from '../helpers/context-runtime.js';
import { runKnowledgeProbe } from '../helpers/knowledge-verification.js';

let fixtures: TaskTestContext;
const runtimes: ContextTestRuntime[] = [];
const idleMs = 7200000;
let sequence = 300000;
function scope(): ContextScope {
  const employeeId = String(sequence++);
  return { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
}
function runtime(owner: ContextScope): ContextTestRuntime {
  const value = createContextTestRuntime(fixtures.database.poolA, owner);
  runtimes.push(value);
  return value;
}
beforeAll(async () => {
  fixtures = await createTaskTestContext();
});
afterAll(async () => {
  await fixtures?.database.close();
});
afterEach(() => {
  for (const current of runtimes.splice(0)) current.sender.close();
  vi.restoreAllMocks();
});

describe('双连接上下文事务竞争', () => {
  it('/new 等锁期间刚进入员工等待仍可成功切换', async () => {
    const owner = scope();
    const f = await fixtures.runningWithSuccessfulAttempt(owner);
    const r = runtime(owner);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 350);
    const reserved = await fixtures.database.poolA.connect();
    const pending = r.contexts.resolve(owner, true);
    const waitId = randomUUID();
    try {
      expect(
        await fixtures.storeB.waitForUser({
          taskId: f.taskId,
          inputVersion: 1,
          attemptId: f.attemptId,
          now: now + 400,
          waitId,
          question: '是否继续',
          allowedQuestionIds: ['问题'],
        })
      ).toBe(true);
      clock.mockReturnValue(now + 500);
    } finally {
      reserved.release();
    }
    const changed = await pending;
    expect(changed.context.threadId).not.toBe(f.context.threadId);
    expect(await r.tasks.getUserWait(waitId)).toMatchObject({
      closedAt: now + 500,
      resolution: 'cancelled',
    });
    expect(await r.tasks.getTask(f.taskId)).toMatchObject({
      endedAt: now + 500,
      status: 'cancelled',
    });
  });
  it('两个首次创建只有一个当前 thread；并发 /new 各分配唯一递增版本', async () => {
    const owner = scope();
    const other = new PostgresPrivateChatStore(fixtures.database.poolB);
    const [a, b] = await Promise.all([
      fixtures.chat.createContext(owner, now),
      other.createContext(owner, now),
    ]);
    expect(a.threadId).toBe(b.threadId);
    const switched = await Promise.all([
      fixtures.chat.prepareContext(owner, () => now + 500, { reset: true, idleMs }),
      other.prepareContext(owner, () => now + 500, { reset: true, idleMs }),
    ]);
    expect(new Set(switched.map(item => item.context.threadId)).size).toBe(2);
    expect(switched.map(item => item.context.version).sort()).toEqual([2, 3]);
    expect((await other.getCurrentContext(owner))?.version).toBe(3);
  });
  it('切换与领取竞争后旧任务始终取消，不能保留可运行任务', async () => {
    const f = await fixtures.queuedFixture();
    await Promise.all([
      fixtures.chat.prepareContext(f.scope, () => now + 500, { reset: true, idleMs }),
      fixtures.storeB.claimTask({
        taskId: f.taskId,
        inputVersion: 1,
        now: now + 500,
        executionMs: 1000,
      }),
    ]);
    expect((await fixtures.storeB.getTask(f.taskId))?.status).toBe('cancelled');
    expect(
      await fixtures.storeB.startAttempt({
        taskId: f.taskId,
        inputVersion: 1,
        now: now + 600,
        attemptId: randomUUID(),
        runId: randomUUID(),
        configDigest: '摘要',
        expectedAttemptId: null,
      })
    ).toBeNull();
  });
  it('切换与采用结果竞争后旧答案无法交付', async () => {
    const f = await fixtures.runningWithSuccessfulAttempt();
    await Promise.all([
      fixtures.chat.prepareContext(f.scope, () => now + 500, { reset: true, idleMs }),
      fixtures.storeB.adoptAttempt({
        answerText: '已检查答案：按当前资料处理问题。',
        taskId: f.taskId,
        inputVersion: 1,
        attemptId: f.attemptId,
        now: now + 500,
      }),
    ]);
    expect((await fixtures.storeB.getTask(f.taskId))?.status).toBe('cancelled');
    const output: string[] = [];
    expect(
      await fixtures.storeB.withTaskOutput({ taskId: f.taskId, inputVersion: 1 }, () =>
        output.push('旧答案')
      )
    ).toBeNull();
    expect(output).toEqual([]);
  });
  it('切换与员工回答恢复竞争不留下开放等待或 running', async () => {
    const f = await fixtures.waitingFixture();
    const answer = await fixtures.message(f.scope, now + 500);
    await Promise.all([
      fixtures.chat.prepareContext(f.scope, () => now + 600, { reset: true, idleMs }),
      fixtures.storeB.resolveUserWait({
        taskId: f.taskId,
        inputVersion: 1,
        waitId: f.waitId,
        answerMessage: answer,
        decision: 'accepted',
        now: now + 600,
      }),
    ]);
    expect((await fixtures.storeB.getTask(f.taskId))?.status).toBe('cancelled');
    expect((await fixtures.storeB.getUserWait(f.waitId))?.closedAt).not.toBeNull();
  });
  it('切换与 ready batch 建任务竞争不留下旧 queued', async () => {
    const f = await fixtures.batchFixture();
    await fixtures.chat.setBatchStatus(f.batch.batchId, 'ready');
    const taskId = randomUUID();
    await Promise.all([
      fixtures.chat.prepareContext(f.scope, () => now + 500, { reset: true, idleMs }),
      fixtures.storeB.createTask({
        taskId,
        batchId: f.batch.batchId,
        configDigest: '摘要',
        now,
        queueDeadline: now + 10000,
      }),
    ]);
    const task = await fixtures.storeB.getTask(taskId);
    expect(task === null || task.status === 'cancelled').toBe(true);
  });
  it('切换与建批竞争不留下 collecting，之后不能追加旧批次', async () => {
    const owner = scope();
    const context = await fixtures.chat.createContext(owner, now);
    const first = await fixtures.message(owner, now);
    const other = new PostgresPrivateChatStore(fixtures.database.poolB);
    const batchId = randomUUID();
    const results = await Promise.allSettled([
      fixtures.chat.prepareContext(owner, () => now + 500, { reset: true, idleMs }),
      other.createBatch({
        batchId,
        threadId: context.threadId,
        firstMessage: first,
        quietDeadline: now + 5000,
        maxDeadline: now + 60000,
      }),
    ]);
    expect(results[0]?.status).toBe('fulfilled');
    const batch = await other.getBatch(batchId);
    if (batch) expect(batch.status).toBe('discarded');
    else expect(results[1]?.status).toBe('rejected');
    const next = await fixtures.message(owner, now + 600);
    expect(await other.appendBatchMessage(batchId, next, now + 5600)).toBe(false);
  });
  it('新 thread 的最后写入失败时整个切换回滚，旧任务和等待不变', async () => {
    const f = await fixtures.waitingFixture();
    // 约束只作用于本文件随机库的精确员工，新版本插入失败发生在取消写入之后。
    await fixtures.database.poolA.query(
      `ALTER TABLE kairo.contexts ADD CONSTRAINT t24_reject_new_version CHECK
       (employee_id <> '${f.scope.employeeId}' OR version = 1)`
    );
    try {
      await expect(
        fixtures.chat.prepareContext(f.scope, () => now + 500, { reset: true, idleMs })
      ).rejects.toMatchObject({ code: '23514' });
      expect((await fixtures.chat.getCurrentContext(f.scope))?.threadId).toBe(f.context.threadId);
      expect((await fixtures.storeA.getTask(f.taskId))?.status).toBe('waiting_for_user');
      expect((await fixtures.storeA.getUserWait(f.waitId))?.closedAt).toBeNull();
      expect((await fixtures.chat.getBatch(f.batch.batchId))?.status).toBe('ready');
    } finally {
      await fixtures.database.poolA.query(
        'ALTER TABLE kairo.contexts DROP CONSTRAINT t24_reject_new_version'
      );
    }
  });
  it('持锁同步交付先发生则不能撤回，但 /new 不等待旧结果，迟到回执不能完成任务', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(now + 500);
    const owner = scope();
    const f = await fixtures.readyToSendFixture(owner);
    const r = runtime(owner);
    let markStarted!: () => void;
    const started = new Promise<void>(resolve => {
      markStarted = resolve;
    });
    let finish!: () => void;
    const held = new Promise<void>(resolve => {
      finish = resolve;
    });
    const send = r.driver.sendText.bind(r.driver);
    vi.spyOn(r.driver, 'sendText').mockImplementation(async (text, options) => {
      if (text === '已交给Driver的旧答案') {
        markStarted();
        await held;
      }
      return send(text, options);
    });
    const pending = r.sender.send({
      subject: { kind: 'task', taskId: f.taskId, inputVersion: 1 },
      purpose: 'final',
      text: '已交给Driver的旧答案',
    });
    try {
      await started;
      const reset = await r.receive(contextMessage(owner));
      expect(reset.status).toBe('new_context');
      expect((await r.tasks.getTask(f.taskId))?.status).toBe('cancelled');
      expect((await r.chat.getCurrentContext(owner))?.threadId).not.toBe(f.context.threadId);
    } finally {
      finish();
    }
    expect((await pending).status).toBe('cancelled');
    expect((await r.tasks.getTask(f.taskId))?.status).toBe('cancelled');
  });
});

it('真实 Mastra→T27→Python 在途检索收到 /new 后回收，旧证据只留审计', async () => {
  const owner = scope();
  const r = runtime(owner);
  let received!: () => void;
  const requestArrived = new Promise<void>(resolve => {
    received = resolve;
  });
  const server = createServer(request => {
    request.resume();
    received();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('本地检索服务没有端口');
  const cancel = new AbortController();
  const work = runKnowledgeProbe(
    fixtures.database,
    {
      apiUrl: `http://127.0.0.1:${address.port}`,
      apiKey: 'kairo-t24-test-key',
      datasetId: '本地测试资料',
    },
    ['用于验证上下文取消的检索'],
    { scope: owner, contextService: r.contexts, signal: cancel.signal }
  );
  let deadline: NodeJS.Timeout | undefined;
  // 等待真实 Python 的 HTTP 事件；此计时器仅保证故障时清理进程，不制造固定等待。
  try {
    await Promise.race([
      requestArrived,
      work.then(() => {
        throw new Error('检索尚未在途就提前结束');
      }),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('未观察到实际 Python 请求')), 15000);
      }),
    ]);
    clearTimeout(deadline);
    const old = await r.chat.getCurrentContext(owner);
    const changed = await r.receive(contextMessage(owner));
    expect(changed.status).toBe('new_context');
    expect((await r.chat.getCurrentContext(owner))?.threadId).not.toBe(old?.threadId);
    const result = await work;
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]?.resultCategory).toBe('cancelled');
    const raw = result.queries[0]?.rawResult as {
      attempts: { pid: number; exitCode: number | null }[];
    };
    expect(raw.attempts).toHaveLength(1);
    for (const attempt of raw.attempts) {
      expect(attempt.pid).toBeGreaterThan(0);
      expect(() => process.kill(attempt.pid, 0)).toThrow();
    }
    expect(result.evidence).toEqual([]);
    expect(r.driver.recordedCalls.map(call => call.payload)).toEqual([
      '已开始新对话，之前未完成的任务已取消。',
    ]);
  } finally {
    clearTimeout(deadline);
    cancel.abort();
    try {
      await work;
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close(error => (error ? reject(error) : resolve()))
      );
    }
  }
}, 30000);
