import { randomUUID } from 'node:crypto';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectorBatches,
  collectorNotices,
  collectorNow,
  collectorScope,
  collectorTasks,
  createCollectorTestRuntime,
  deferredSignal,
  type CollectorTestRuntime,
} from '../helpers/collector-runtime.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

let database: TaskTestDatabase;
let clock = collectorNow;
const runtimes: CollectorTestRuntime[] = [];
function runtime(owner = collectorScope(), allowed = true) {
  const value = createCollectorTestRuntime(database, owner, { allowed });
  runtimes.push(value);
  return value;
}
beforeAll(async () => {
  database = await createTaskTestDatabase();
});
beforeEach(() => {
  clock = collectorNow;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
});
afterEach(async () => {
  try {
    await Promise.all(runtimes.splice(0).map(value => value.close()));
  } finally {
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
afterAll(async () => {
  await database?.close();
});

describe('T22 门禁和阶段一输入边界的真实账本结果', () => {
  it('未放行、非入站和未知员工不进入聚合；可信重复消息不能覆盖原始记录或延长静默', async () => {
    const denied = runtime(undefined, false);
    expect(await denied.receive()).toEqual({ status: 'not_allowed' });
    expect(await denied.receive({ direction: 'outbound' })).toEqual({ status: 'outbound' });
    expect(await denied.receive({ direction: 'unknown' })).toEqual({ status: 'unknown' });
    denied.driver.setEmployees([]);
    expect(await denied.receive()).toEqual({ status: 'identity_failed' });
    expect(await collectorBatches(denied)).toEqual([]);
    expect(await collectorTasks(denied)).toEqual([]);

    const current = runtime();
    const id = randomUUID();
    await current.receive({ id, content: '  原始正文\n', timestamp: 1 });
    const key = { sessionId: current.owner.sessionId, messageId: id };
    const raw = await current.chat.getRawMessage(key);
    const [batch] = await collectorBatches(current);
    clock += 2000;
    expect(await current.receive({ id, content: '重复不能覆盖', messageType: 'image' })).toEqual({
      status: 'duplicate',
    });
    expect(await current.chat.getRawMessage(key)).toEqual(raw);
    expect(raw).toMatchObject({
      text: '  原始正文\n',
      observedAt: collectorNow,
      processingResult: 'accepted',
    });
    const blankId = randomUUID();
    expect(await current.receive({ id: blankId, content: ' \n\t' })).toEqual({ status: 'empty' });
    expect(
      await current.chat.getRawMessage({ sessionId: current.owner.sessionId, messageId: blankId })
    ).toMatchObject({ text: ' \n\t', observedAt: clock });
    expect(await current.chat.getCollectedBatch(batch!.batchId)).toEqual(batch);
    expect(
      (await current.chat.getBatchMessages(batch!.batchId)).map(message => message.messageId)
    ).toEqual([id]);
    expect(await collectorNotices(current)).toEqual([]);
  });

  it.each([
    { name: '10条允许', count: 10, text: '中', rejected: false },
    { name: '11条整批拒绝', count: 11, text: '中', rejected: true },
    { name: '30000码点允许', count: 1, text: '😀'.repeat(30000), rejected: false },
    { name: '30001码点整批拒绝', count: 1, text: '😀'.repeat(30000) + '中', rejected: true },
  ])('$name：数据库保留完整原文，不截断，拒绝批不建任务', async scenario => {
    const original = runtime();
    for (let index = 0; index < scenario.count; index++)
      await original.receive({ content: scenario.text });
    const [saved] = await collectorBatches(original);
    expect(saved?.status).toBe(scenario.rejected ? 'rejected' : 'collecting');
    expect(
      (await original.chat.getBatchMessages(saved!.batchId)).map(message => message.text)
    ).toEqual(Array.from({ length: scenario.count }, () => scenario.text));
    await original.close();
    clock += 5000;
    const recovered = runtime(original.owner);
    await recovered.collector.recover();
    expect(await collectorTasks(recovered)).toHaveLength(scenario.rejected ? 0 : 1);
    expect(await recovered.chat.getCollectedBatch(saved!.batchId)).toMatchObject({
      status: scenario.rejected ? 'rejected' : 'ready',
      rejection: scenario.rejected ? 'too_long' : null,
    });
    const notices = await collectorNotices(recovered);
    expect(notices).toHaveLength(scenario.rejected ? 1 : 0);
    if (scenario.rejected) {
      expect(notices[0]).toMatchObject({
        purpose: 'notice:input_too_long',
        status: 'delivered',
        send_calls: 1,
      });
      await recovered.receive({ content: '拒绝后的新批' });
      expect(
        (await collectorBatches(recovered)).filter(batch => batch!.status === 'collecting')
      ).toHaveLength(1);
    }
  });

  it.each([true, false])('附件前有文字=%s：立即结束拒绝，附件后的文字另起批', async textFirst => {
    const current = runtime();
    if (textFirst) await current.receive({ content: '附件前文字' });
    clock += 100;
    const attachmentText = textFirst ? '中'.repeat(30001) : '';
    await current.receive({ content: attachmentText, messageType: 'voice' });
    clock += 100;
    await current.receive({ content: '附件后文字' });
    const batches = await collectorBatches(current);
    expect(batches).toHaveLength(2);
    const rejected = batches.find(batch => batch!.status === 'rejected')!;
    const collecting = batches.find(batch => batch!.status === 'collecting')!;
    expect(rejected).toMatchObject({ rejection: 'attachment', finishedAt: collectorNow + 100 });
    expect(
      (await current.chat.getBatchMessages(rejected.batchId)).map(message => message.text)
    ).toEqual(textFirst ? ['附件前文字', attachmentText] : ['']);
    expect(
      (await current.chat.getBatchMessages(collecting.batchId)).map(message => message.text)
    ).toEqual(['附件后文字']);
    expect(await collectorTasks(current)).toEqual([]);
    expect(await collectorNotices(current)).toEqual([
      {
        operation_id: expect.any(String),
        purpose: 'notice:input_attachment',
        status: 'delivered',
        send_calls: 1,
      },
    ]);
  });

  it('同 Bot 不同员工、同员工不同 Bot 的批次和恢复范围互不混入', async () => {
    const first = runtime();
    const second = runtime({ ...collectorScope(), botId: first.owner.botId });
    const third = runtime({ ...first.owner, botId: randomUUID() });
    await Promise.all([
      first.receive({ content: '员工甲 Bot甲' }),
      second.receive({ content: '员工乙 Bot甲' }),
      third.receive({ content: '员工甲 Bot乙' }),
    ]);
    clock += 100;
    await second.receive({ content: '员工乙 Bot甲补充' });
    clock += 100;
    await first.receive({ content: '员工甲 Bot甲补充' });
    clock += 100;
    await third.receive({ content: '员工甲 Bot乙补充' });
    const originals = await Promise.all(
      [first, second, third].map(value => collectorBatches(value))
    );
    expect(new Set(originals.map(batches => batches[0]!.threadId)).size).toBe(3);
    await Promise.all([first.close(), second.close(), third.close()]);
    clock += 5000;
    const recoveredThird = runtime(third.owner);
    await recoveredThird.collector.recover();
    expect(await collectorTasks(recoveredThird)).toHaveLength(1);
    const recoveredFirst = runtime(first.owner);
    const recoveredSecond = runtime(second.owner);
    expect(await collectorTasks(recoveredFirst)).toEqual([]);
    expect(await collectorTasks(recoveredSecond)).toEqual([]);
    await recoveredFirst.collector.recover();
    for (const [current, text] of [
      [recoveredFirst, '员工甲 Bot甲'],
      [recoveredSecond, '员工乙 Bot甲'],
      [recoveredThird, '员工甲 Bot乙'],
    ] as const) {
      const tasks = await collectorTasks(current);
      expect(tasks).toHaveLength(1);
      expect(
        (await current.chat.getBatchMessages(tasks[0]!.batchId)).map(message => message.text)
      ).toEqual([text, `${text}补充`]);
    }
  });
});

describe('双业务连接聚合与绝对截止竞争', () => {
  it('不同消息同 thread 并发只建一个批；同刻到期竞争只结束旧批一次', async () => {
    const first = runtime();
    const second = runtime(first.owner);
    const identities = await Promise.all(
      [first, second].map(value =>
        value.pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      )
    );
    expect(identities[0]!.rows[0]!.pid).not.toBe(identities[1]!.rows[0]!.pid);
    await Promise.all([first.receive({ content: '甲' }), second.receive({ content: '乙' })]);
    const batches = await collectorBatches(first);
    expect(batches).toHaveLength(1);
    expect(
      (await first.chat.getBatchMessages(batches[0]!.batchId)).map(message => message.text).sort()
    ).toEqual(['乙', '甲']);
    clock += 5000;
    await Promise.all([first.receive({ content: '新甲' }), second.receive({ content: '新乙' })]);
    const after = await collectorBatches(first);
    expect(after.filter(batch => batch!.status === 'ready')).toHaveLength(1);
    const pending = after.filter(batch => batch!.status === 'collecting');
    expect(pending).toHaveLength(1);
    expect(await collectorTasks(first)).toHaveLength(1);
    expect(await first.chat.getCollectedBatch(batches[0]!.batchId)).toMatchObject({
      finishedAt: collectorNow + 5000,
      quietDeadline: collectorNow + 5000,
    });
    expect(
      (await second.chat.getBatchMessages(pending[0]!.batchId)).map(message => message.text).sort()
    ).toEqual(['新乙', '新甲']);
  });

  it('前序收尾失败不跳过已落盘附件的独立提示，原异常仍交给原调用', async () => {
    const current = runtime();
    const entered = deferredSignal();
    const release = deferredSignal();
    const appended = deferredSignal();
    const predecessorError = new Error('前序收尾受控异常');
    vi.spyOn(current.chat, 'finishBatch').mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      throw predecessorError;
    });
    const collect = current.chat.collectMessage.bind(current.chat);
    vi.spyOn(current.chat, 'collectMessage').mockImplementation(async (...args) => {
      const batches = await collect(...args);
      if (batches.some(batch => batch.status === 'rejected')) appended.resolve();
      return batches;
    });
    const first = current.receive({ content: '原始文字' }).catch((error: unknown) => error);
    await entered.promise;
    const second = current.receive({ content: '', messageType: 'file' });
    try {
      await appended.promise;
      await nextTurn();
    } finally {
      release.resolve();
    }
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(predecessorError);
    expect(secondResult.status).toBe('collected');
    const [batch] = await collectorBatches(current);
    expect(batch).toMatchObject({ status: 'rejected', rejection: 'attachment', settledAt: clock });
    expect(
      (await current.chat.getBatchMessages(batch!.batchId)).map(message => message.text)
    ).toEqual(['原始文字', '']);
    expect(await collectorTasks(current)).toEqual([]);
    const notices = await collectorNotices(current);
    expect(notices).toEqual([
      {
        operation_id: expect.any(String),
        purpose: 'notice:input_attachment',
        status: 'delivered',
        send_calls: 1,
      },
    ]);
    await current.collector.recover();
    expect(await collectorNotices(current)).toEqual(notices);
    expect(current.driver.recordedCalls).toHaveLength(1);
  });

  it('新消息先提交后迟到 timer 再读旧批，不能吞掉新批或建立重复任务', async () => {
    vi.restoreAllMocks();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: collectorNow });
    const current = runtime();
    await current.receive({ content: '旧批' });
    const [old] = await collectorBatches(current);
    const incoming = runtime(current.owner);
    const entered = deferredSignal();
    const release = deferredSignal();
    const finish = current.chat.finishBatch.bind(current.chat);
    vi.spyOn(current.chat, 'finishBatch').mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      return finish(...args);
    });
    await vi.advanceTimersByTimeAsync(5000);
    await entered.promise;
    try {
      await incoming.receive({ content: '已经到期后的新批' });
    } finally {
      release.resolve();
    }
    await current.collector.settled();
    const batches = await collectorBatches(current);
    expect(await collectorTasks(current)).toHaveLength(1);
    expect(await current.chat.getCollectedBatch(old!.batchId)).toMatchObject({
      status: 'ready',
      finishedAt: collectorNow + 5000,
    });
    const next = batches.find(batch => batch!.status === 'collecting');
    expect(next).toMatchObject({
      firstObservedAt: collectorNow + 5000,
      quietDeadline: collectorNow + 10000,
    });
    expect(
      (await current.chat.getBatchMessages(next!.batchId)).map(message => message.text)
    ).toEqual(['已经到期后的新批']);
  });
});

describe('T24 切换与 T19 运行中补充', () => {
  it.each(['collecting', 'ready'] as const)(
    '/new 与旧 %s 恢复交错，旧批不复活且命令不入批',
    async state => {
      const original = runtime();
      await original.receive({ content: '旧对话正文' });
      const [old] = await collectorBatches(original);
      if (state === 'ready') {
        clock += 5000;
        await original.chat.finishBatch(old!.batchId, () => clock);
      }
      await original.close();
      const recovering = runtime(original.owner);
      const resetting = runtime(original.owner);
      const scanned = deferredSignal();
      const resume = deferredSignal();
      const list = recovering.chat.listPendingBatches.bind(recovering.chat);
      vi.spyOn(recovering.chat, 'listPendingBatches').mockImplementationOnce(async botId => {
        const snapshot = await list(botId);
        scanned.resolve();
        await resume.promise;
        return snapshot;
      });
      const recovery = recovering.collector.recover();
      await scanned.promise;
      const commandId = randomUUID();
      try {
        expect((await resetting.receive({ id: commandId, content: '/new' })).status).toBe(
          'new_context'
        );
      } finally {
        resume.resolve();
      }
      await recovery;
      clock += 60000;
      await recovering.collector.recover();
      expect(await recovering.chat.getBatch(old!.batchId)).toMatchObject({ status: 'discarded' });
      expect(await collectorTasks(recovering)).toEqual([]);
      expect(
        (await recovering.chat.getBatchMessages(old!.batchId)).map(message => message.text)
      ).toEqual(['旧对话正文']);
      expect(
        await recovering.chat.getRawMessage({
          sessionId: original.owner.sessionId,
          messageId: commandId,
        })
      ).toMatchObject({ text: '/new' });
      expect(await collectorNotices(recovering)).toEqual([]);
      expect((await recovering.chat.getCurrentContext(original.owner))?.threadId).not.toBe(
        old!.threadId
      );
      const audit = await recovering.pool.query<{ batch_id: string }>(
        'SELECT batch_id FROM kairo.message_batches WHERE bot_id = $1 AND session_id = $2',
        [original.owner.botId, original.owner.sessionId]
      );
      expect(audit.rows).toEqual([{ batch_id: old!.batchId }]);
      await recovering.receive({ content: '新对话中的普通消息' });
      const next = (await collectorBatches(recovering)).find(
        batch => batch?.status === 'collecting'
      );
      expect(next?.threadId).toBe(
        (await recovering.chat.getCurrentContext(original.owner))?.threadId
      );
      expect(next?.threadId).not.toBe(old!.threadId);
      expect(
        (await recovering.chat.getBatchMessages(next!.batchId)).map(message => message.text)
      ).toEqual(['新对话中的普通消息']);
      expect((await recovering.chat.getBatch(old!.batchId))?.status).toBe('discarded');
    }
  );

  it('/new 后不补发旧 thread 已拒绝但发送前中断的提示', async () => {
    const original = runtime();
    vi.spyOn(original.sender, 'send').mockRejectedValueOnce(new Error('模拟发送前中断'));
    await expect(original.receive({ messageType: 'image', content: '' })).rejects.toThrow(
      '模拟发送前中断'
    );
    const [old] = await collectorBatches(original);
    await original.close();
    const current = runtime(original.owner);
    expect((await current.receive({ content: '/new' })).status).toBe('new_context');
    await current.collector.recover();
    await current.collector.recover();
    expect(await collectorNotices(current)).toEqual([]);
    expect(current.driver.recordedCalls).toHaveLength(1);
    expect(await collectorTasks(current)).toEqual([]);
    expect((await current.chat.getContext(old!.threadId))?.invalidatedAt).not.toBeNull();
  });

  it('运行中任务登记真实 AbortController 后补充消息只聚合下一批，不改变 task、attempt 或中止信号', async () => {
    const current = runtime();
    await current.receive({ content: '形成首个任务' });
    clock += 5000;
    await current.collector.recover();
    const [task] = await collectorTasks(current);
    expect(
      await current.tasks.claimTask({
        taskId: task!.taskId,
        inputVersion: 1,
        now: clock,
        executionMs: 240000,
      })
    ).not.toBeNull();
    const attempt = await current.tasks.startAttempt({
      taskId: task!.taskId,
      inputVersion: 1,
      now: clock,
      attemptId: randomUUID(),
      runId: randomUUID(),
      configDigest: '运行中的配置摘要',
      expectedAttemptId: null,
    });
    expect(attempt).not.toBeNull();
    const controller = new AbortController();
    const release = await current.contexts.registerExecution(
      {
        taskId: task!.taskId,
        inputVersion: 1,
        contextVersion: 1,
        attemptId: attempt!.attemptId,
      },
      controller
    );
    const running = await current.tasks.getTask(task!.taskId);
    try {
      clock += 1000;
      await current.receive({ content: '下一批第一段' });
      clock += 1000;
      await current.receive({ content: '运行中补充第二段' });
      expect(await current.tasks.getTask(task!.taskId)).toEqual(running);
      expect(await current.tasks.getAttempt(attempt!.attemptId)).toEqual(attempt);
      expect(controller.signal.aborted).toBe(false);
      const batches = await collectorBatches(current);
      const next = batches.find(batch => batch!.status === 'collecting');
      expect(
        (await current.chat.getBatchMessages(next!.batchId)).map(message => message.text)
      ).toEqual(['下一批第一段', '运行中补充第二段']);
      expect(await collectorTasks(current)).toHaveLength(1);
      clock = next!.quietDeadline;
      await current.collector.recover();
      const allTasks = await collectorTasks(current);
      expect(allTasks).toHaveLength(2);
      expect(allTasks.find(value => value!.batchId === next!.batchId)).toMatchObject({
        status: 'queued',
      });
      expect(await current.tasks.getTask(task!.taskId)).toEqual(running);
      expect(await current.tasks.getAttempt(attempt!.attemptId)).toEqual(attempt);
      expect(controller.signal.aborted).toBe(false);
      expect(current.driver.recordedCalls).toEqual([]);
    } finally {
      release();
    }
  });
});
