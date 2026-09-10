import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type { ContextScope } from '../../src/modules/private-chat-core/types.js';
import { createTaskTestContext, now, type TaskTestContext } from '../helpers/task-fixtures.js';
import {
  contextMessage,
  createContextTestRuntime,
  type ContextTestRuntime,
} from '../helpers/context-runtime.js';

let fixtures: TaskTestContext;
let sequence = 200000;
const runtimes: ContextTestRuntime[] = [];
const idleMs = 7200000;
function scope(): ContextScope {
  const employeeId = String(sequence++);
  return { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
}
function runtime(owner: ContextScope, allowed = true) {
  const value = createContextTestRuntime(fixtures.database.poolA, owner, allowed);
  runtimes.push(value);
  return value;
}
beforeAll(async () => {
  fixtures = await createTaskTestContext();
});
afterAll(async () => {
  await fixtures?.database.close();
});
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(now + 500);
});
afterEach(() => {
  for (const current of runtimes.splice(0)) current.sender.close();
  vi.restoreAllMocks();
});

describe('T22 可信入口到控制消息', () => {
  it('无任务精确命令新建唯一 thread，命令不建批、不建任务，普通句子仍沿用', async () => {
    const owner = scope();
    const r = runtime(owner);
    const ordinary = await r.receive(contextMessage(owner, { content: '请解释 /new' }));
    expect(ordinary.status).toBe('message');
    const old = await r.chat.getCurrentContext(owner);
    const input = contextMessage(owner, { content: ' \t/new\n' });
    const reset = await r.receive(input);
    expect(reset.status).toBe('new_context');
    const current = await r.chat.getCurrentContext(owner);
    expect(current?.threadId).not.toBe(old?.threadId);
    expect(current?.threadId).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(current?.version).toBe(2);
    expect((await r.chat.getContext(old!.threadId))?.invalidatedAt).toBe(now + 500);
    expect(r.driver.recordedCalls.map(call => call.payload)).toEqual(['已开始新对话。']);
    expect(await r.receive(input)).toEqual({ status: 'duplicate' });
    expect((await r.chat.getCurrentContext(owner))?.threadId).toBe(current?.threadId);
    expect(r.driver.recordedCalls).toHaveLength(1);
    const counts = await fixtures.database.poolA.query<{ batches: string; tasks: string }>(
      `SELECT (SELECT COUNT(*) FROM kairo.message_batches WHERE bot_id = $1)::text AS batches,
       (SELECT COUNT(*) FROM kairo.tasks WHERE bot_id = $1)::text AS tasks`,
      [owner.botId]
    );
    expect(counts.rows).toEqual([{ batches: '0', tasks: '0' }]);
  });
  it('非入站、未知身份和未开放员工均不能用 /new 创建 context', async () => {
    const owner = scope();
    const r = runtime(owner, false);
    expect(await r.receive(contextMessage(owner, { direction: 'outbound' }))).toEqual({
      status: 'outbound',
    });
    expect(await r.receive(contextMessage(owner, { direction: 'unknown' }))).toEqual({
      status: 'unknown',
    });
    expect(await r.receive(contextMessage(owner))).toEqual({ status: 'not_allowed' });
    expect(await r.chat.getCurrentContext(owner)).toBeNull();
    r.driver.setEmployees([]);
    expect(await r.receive(contextMessage(owner))).toEqual({ status: 'identity_failed' });
    expect(await r.chat.getCurrentContext(owner)).toBeNull();
    expect(
      r.driver.recordedCalls.some(
        call => typeof call.payload === 'string' && call.payload.includes('已开始新对话')
      )
    ).toBe(false);
  });
  it('参数、附件和非纯文本不切换，且不提前拒绝或聚合这些输入', async () => {
    const owner = scope();
    const r = runtime(owner);
    const context = await r.chat.createContext(owner, now);
    const inputs = [
      contextMessage(owner, { content: '/new 参数' }),
      contextMessage(owner, { content: '/clear' }),
      contextMessage(owner, { content: '/cancel' }),
      contextMessage(owner, { messageType: 'rich-text' }),
      contextMessage(owner, { fileInfo: { fileName: '附件' } }),
      contextMessage(owner, { images: [{ url: 'test://图片' }] }),
    ];
    for (const input of inputs) {
      expect(await r.receive(input)).toMatchObject({
        status: 'message',
        context: { threadId: context.threadId },
      });
    }
    expect(r.driver.recordedCalls).toEqual([]);
    expect(await r.chat.listCollectingBatches(owner)).toEqual([]);
  });
});

describe('/new 终止旧工作而保留审计', () => {
  it('废弃 collecting batch 并保留原始消息', async () => {
    const owner = scope();
    const f = await fixtures.batchFixture(owner);
    const r = runtime(owner);
    await r.receive(contextMessage(owner));
    expect((await r.chat.getBatch(f.batch.batchId))?.status).toBe('discarded');
    expect(await r.chat.getBatchMessages(f.batch.batchId)).toHaveLength(1);
    expect(r.driver.recordedCalls.map(call => call.payload)).toEqual([
      '已开始新对话，之前未完成的任务已取消。',
    ]);
    expect(
      await fixtures.storeB.createTask({
        taskId: randomUUID(),
        batchId: f.batch.batchId,
        configDigest: '摘要',
        now: now + 600,
        queueDeadline: now + 10000,
      })
    ).toBeNull();
  });
  it('取消 queued，之后不能领取旧任务', async () => {
    const owner = scope();
    const f = await fixtures.queuedFixture(owner);
    const r = runtime(owner);
    await r.receive(contextMessage(owner));
    expect(await r.tasks.getTask(f.taskId)).toMatchObject({
      status: 'cancelled',
      endedAt: now + 500,
    });
    expect(
      await fixtures.storeB.claimTask({
        taskId: f.taskId,
        inputVersion: 1,
        now: now + 600,
        executionMs: 1000,
      })
    ).toBeNull();
  });
  it('running 的实际控制器被 abort，迟到成功仅能留审计不能采用或再次登记', async () => {
    const owner = scope();
    const f = await fixtures.runningFixture(owner);
    const attempt = await fixtures.startAttempt(f);
    const r = runtime(owner);
    const controller = new AbortController();
    const binding = {
      taskId: f.taskId,
      inputVersion: 1,
      contextVersion: f.context.version,
      attemptId: attempt.attemptId,
    };
    const release = await r.contexts.registerExecution(binding, controller);
    await r.receive(contextMessage(owner));
    expect(controller.signal.aborted).toBe(true);
    expect((await r.chat.getCurrentContext(owner))?.threadId).not.toBe(f.context.threadId);
    expect(
      await fixtures.storeB.finishAttempt({
        attemptId: attempt.attemptId,
        finishedAt: now + 700,
        errorType: null,
      })
    ).toBe(true);
    expect(
      await fixtures.storeB.adoptAttempt({
        answerText: '已检查答案：按当前资料处理问题。',
        taskId: f.taskId,
        inputVersion: 1,
        attemptId: attempt.attemptId,
        now: now + 800,
      })
    ).toBe(false);
    const delivered: string[] = [];
    expect(
      await fixtures.storeB.withTaskOutput(binding, () => delivered.push('旧输出'))
    ).toBeNull();
    expect(delivered).toEqual([]);
    expect(await r.tasks.getAttempt(attempt.attemptId)).toMatchObject({
      finishedAt: now + 700,
      adopted: false,
    });
    const late = new AbortController();
    await expect(r.contexts.registerExecution(binding, late)).rejects.toMatchObject({
      type: 'cancelled',
    });
    expect(late.signal.aborted).toBe(true);
    release();
  });
  it('关闭 waiting_for_user，旧回答不能恢复执行', async () => {
    const owner = scope();
    const f = await fixtures.waitingFixture(owner);
    const r = runtime(owner);
    await r.receive(contextMessage(owner));
    expect(await r.tasks.getUserWait(f.waitId)).toMatchObject({
      resolution: 'cancelled',
      closedAt: now + 500,
    });
    const answer = await fixtures.message(owner, now + 600);
    expect(
      await fixtures.storeB.resolveUserWait({
        taskId: f.taskId,
        inputVersion: 1,
        waitId: f.waitId,
        answerMessage: answer,
        decision: 'accepted',
        now: now + 700,
      })
    ).toBe(false);
  });
  it('ready_to_send 的旧答案不能交给 Driver', async () => {
    const owner = scope();
    const f = await fixtures.readyToSendFixture(owner);
    const r = runtime(owner);
    await r.receive(contextMessage(owner));
    const sent = await r.sender.send({
      subject: { kind: 'task', taskId: f.taskId, inputVersion: 1 },
      purpose: 'final',
      text: '不允许交付的旧答案',
    });
    expect(sent.status).toBe('cancelled');
    expect(r.driver.recordedCalls.map(call => call.payload)).toEqual([
      '已开始新对话，之前未完成的任务已取消。',
    ]);
  });
  it('ready batch 尚未建任务也被废弃，已完成任务保持原终态', async () => {
    const owner = scope();
    const f = await fixtures.batchFixture(owner);
    await fixtures.chat.setBatchStatus(f.batch.batchId, 'ready');
    const r = runtime(owner);
    await r.receive(contextMessage(owner));
    expect((await r.chat.getBatch(f.batch.batchId))?.status).toBe('discarded');
    const completed = await fixtures.finishedSendingFixture('completed');
    await r.chat.prepareContext(completed.scope, () => now + 1000, { reset: true, idleMs });
    expect((await r.tasks.getTask(completed.taskId))?.status).toBe('completed');
  });
});

describe('最终结果空闲起点', () => {
  it.each([idleMs - 1, idleMs, idleMs + 1])(
    '空闲 %i 毫秒仅严格超过时切换，历史不删',
    async elapsed => {
      const f = await fixtures.cancelledFixture();
      const old = await fixtures.chat.getCurrentContext(f.scope);
      expect(old?.idleSince).toBe(now + 500);
      const result = await fixtures.chat.prepareContext(f.scope, () => now + 500 + elapsed, {
        reset: false,
        idleMs,
      });
      expect(result.context.threadId === f.context.threadId).toBe(elapsed <= idleMs);
      expect(await fixtures.chat.getContext(f.context.threadId)).not.toBeNull();
      expect(await fixtures.chat.getBatchMessages(f.batch.batchId)).toHaveLength(1);
      expect((await fixtures.storeA.getTask(f.taskId))?.status).toBe('cancelled');
    }
  );
  it('失败与超时使用各自任务结束时刻，而不是原始消息或尝试结束时刻', async () => {
    const failed = await fixtures.failedFixture();
    const timed = await fixtures.timedOutFixture();
    expect((await fixtures.chat.getCurrentContext(failed.scope))?.idleSince).toBe(now + 500);
    expect((await fixtures.chat.getCurrentContext(timed.scope))?.idleSince).toBe(
      timed.input.queueDeadline
    );
    expect(
      await fixtures.storeA.transitionTask({
        taskId: failed.taskId,
        inputVersion: 1,
        from: 'running',
        to: 'failed',
        expectedAttemptId: failed.attemptId,
        now: now + idleMs,
      })
    ).toBe(false);
    expect((await fixtures.chat.getCurrentContext(failed.scope))?.idleSince).toBe(now + 500);
  });
  it('拒绝员工等待从拒绝结束时刻计时', async () => {
    const f = await fixtures.waitingFixture();
    const answer = await fixtures.message(f.scope, now + 600);
    expect(
      await fixtures.storeA.resolveUserWait({
        taskId: f.taskId,
        inputVersion: 1,
        waitId: f.waitId,
        answerMessage: answer,
        decision: 'declined',
        now: now + 700,
      })
    ).toBe(true);
    expect((await fixtures.chat.getCurrentContext(f.scope))?.idleSince).toBe(now + 700);
  });
  it('collecting、queued、running、等待、待发送和 sending 阻止空闲切换', async () => {
    const cases = [
      await fixtures.batchFixture(),
      await fixtures.queuedFixture(),
      await fixtures.runningFixture(),
      await fixtures.waitingFixture(),
      await fixtures.readyToSendFixture(),
      await fixtures.sendingFixture(),
    ];
    for (const f of cases) {
      await fixtures.chat.setContextIdleSince(f.scope, f.context.version, now - idleMs - 1);
      const result = await fixtures.chat.prepareContext(f.scope, () => now, {
        reset: false,
        idleMs,
      });
      expect(result.context.threadId).toBe(f.context.threadId);
      expect(result.context.idleSince).toBe(now - idleMs - 1);
    }
  });
  it('普通新请求和进度提示不重置上次最终结果起点', async () => {
    const owner = scope();
    const f = await fixtures.runningFixture(owner);
    const r = runtime(owner);
    await r.chat.setContextIdleSince(owner, f.context.version, now - 1000);
    await r.receive(contextMessage(owner, { content: '继续查询' }));
    await r.sender.send({
      subject: { kind: 'task', taskId: f.taskId, inputVersion: 1 },
      purpose: 'progress',
      text: '正在查询企业知识，请稍候',
    });
    expect((await r.chat.getCurrentContext(owner))?.idleSince).toBe(now - 1000);
    expect((await r.tasks.getTask(f.taskId))?.status).toBe('running');
  });
  it('失效版本不能写入新 context 的空闲时间', async () => {
    const f = await fixtures.cancelledFixture();
    const other = new PostgresPrivateChatStore(fixtures.database.poolB);
    const reset = await other.prepareContext(f.scope, () => now + 600, { reset: true, idleMs });
    expect(await fixtures.chat.setContextIdleSince(f.scope, f.context.version, now + 100000)).toBe(
      false
    );
    expect((await other.getContext(reset.context.threadId))?.idleSince).toBeNull();
  });
});
