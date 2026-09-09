import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  collectorBatching,
  collectorBatches,
  collectorDigest,
  collectorNotices,
  collectorNow,
  collectorQueueMs,
  collectorTasks,
  createCollectorTestRuntime,
  type CollectorTestRuntime,
} from '../helpers/collector-runtime.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

let database: TaskTestDatabase;
const runtimes: CollectorTestRuntime[] = [];
let clock = collectorNow;
function runtime(owner?: CollectorTestRuntime['owner'], maxWaitMs = 60000) {
  const value = createCollectorTestRuntime(database, owner, {
    batching: { ...collectorBatching, maxWaitMs },
  });
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

describe('T23 真实 PostgreSQL 绝对截止恢复', () => {
  it.each([
    { name: '静默剩余', last: 1000, restart: 3000, deadline: 6000 },
    { name: '最长剩余', last: 4000, restart: 6000, deadline: 8000 },
    { name: '仅静默过期', last: 0, restart: 6000, deadline: 5000 },
    { name: '仅最长过期', last: 4000, restart: 8500, deadline: 8000 },
    { name: '两种全部过期', last: 4000, restart: 10000, deadline: 8000 },
  ])('$name：关闭旧实例和业务连接后沿用原始截止，重复恢复只建一个任务', async scenario => {
    vi.restoreAllMocks();
    // 保留 nextTick、setImmediate、网络与 PostgreSQL I/O 的真实调度。
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'], now: collectorNow });
    const original = runtime(undefined, 8000);
    await original.receive({ content: '第一段' });
    if (scenario.last > 0) {
      vi.setSystemTime(collectorNow + scenario.last);
      await original.receive({ content: '最后一段' });
    }
    const [saved] = await collectorBatches(original);
    expect(saved).toMatchObject({
      status: 'collecting',
      firstObservedAt: collectorNow,
      quietDeadline: collectorNow + scenario.last + 5000,
      maxDeadline: collectorNow + 8000,
      finishedAt: null,
    });
    expect(await collectorTasks(original)).toEqual([]);
    const oldIdentity = await original.pool.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid'
    );
    await original.close();
    await expect(original.pool.query('SELECT 1')).rejects.toThrow(
      'Cannot use a pool after calling end'
    );

    vi.setSystemTime(collectorNow + scenario.restart);
    const recovered = runtime(original.owner, 8000);
    const newIdentity = await recovered.pool.query<{ pid: number }>(
      'SELECT pg_backend_pid() AS pid'
    );
    expect(newIdentity.rows[0]!.pid).not.toBe(oldIdentity.rows[0]!.pid);
    await Promise.all([recovered.collector.recover(), recovered.collector.recover()]);
    const remaining = scenario.deadline - scenario.restart;
    if (remaining > 0) {
      expect(await collectorTasks(recovered)).toEqual([]);
      expect(await recovered.chat.getCollectedBatch(saved!.batchId)).toEqual(saved);
      await vi.advanceTimersByTimeAsync(remaining - 1);
      await recovered.collector.settled();
      expect(await collectorTasks(recovered)).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      await recovered.collector.settled();
    }
    await recovered.collector.recover();
    const tasks = await collectorTasks(recovered);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      batchId: saved!.batchId,
      status: 'queued',
      configDigest: collectorDigest,
      createdAt: collectorNow + scenario.deadline,
      queueDeadline: collectorNow + scenario.deadline + collectorQueueMs,
    });
    expect(await recovered.chat.getCollectedBatch(saved!.batchId)).toMatchObject({
      status: 'ready',
      quietDeadline: saved!.quietDeadline,
      maxDeadline: saved!.maxDeadline,
      finishedAt: collectorNow + scenario.deadline,
      settledAt: expect.any(Number),
    });
    expect(
      (await recovered.chat.getBatchMessages(saved!.batchId)).map(message => message.text)
    ).toEqual(scenario.last > 0 ? ['第一段', '最后一段'] : ['第一段']);
    expect(await collectorNotices(recovered)).toEqual([]);
    expect(recovered.driver.recordedCalls).toEqual([]);
  });
});

describe('T23 已落盘批次的副作用中断', () => {
  it.each(['创建任务之前', '任务已提交之后'] as const)(
    '%s中断：ready 保留，重启不刷新排队期限或重复任务',
    async checkpoint => {
      const original = runtime();
      await original.receive({ content: '需要形成任务' });
      const [saved] = await collectorBatches(original);
      const createTask = original.tasks.createTask.bind(original.tasks);
      vi.spyOn(original.tasks, 'createTask').mockImplementationOnce(async input => {
        if (checkpoint === '任务已提交之后') await createTask(input);
        throw new Error('模拟批次建任务中断');
      });
      clock += 5000;
      await expect(original.receive({ content: '截止后的下一批' })).rejects.toThrow(
        '模拟批次建任务中断'
      );
      expect(await original.chat.getCollectedBatch(saved!.batchId)).toMatchObject({
        status: 'ready',
        finishedAt: collectorNow + 5000,
        settledAt: null,
      });
      const before = (await collectorTasks(original)).filter(
        task => task!.batchId === saved!.batchId
      );
      expect(before).toHaveLength(checkpoint === '创建任务之前' ? 0 : 1);
      await original.close();

      clock += 1000;
      const recovered = runtime(original.owner);
      await Promise.all([recovered.collector.recover(), recovered.collector.recover()]);
      await recovered.collector.recover();
      const after = (await collectorTasks(recovered)).filter(
        task => task!.batchId === saved!.batchId
      );
      expect(after).toHaveLength(1);
      expect(after[0]).toMatchObject({
        createdAt: collectorNow + 5000,
        queueDeadline: collectorNow + 5000 + collectorQueueMs,
        status: 'queued',
      });
      if (before.length > 0) expect(after).toEqual(before);
      expect(await recovered.chat.getCollectedBatch(saved!.batchId)).toMatchObject({
        status: 'ready',
        finishedAt: collectorNow + 5000,
        settledAt: expect.any(Number),
      });
    }
  );

  it.each(['发送之前', '发送完成收尾之前'] as const)(
    '%s中断：恢复同一个拒绝提示一次且始终不建任务',
    async checkpoint => {
      const original = runtime();
      await original.receive({ content: '附件前的文字' });
      const [saved] = await collectorBatches(original);
      if (checkpoint === '发送之前') {
        vi.spyOn(original.sender, 'send').mockRejectedValueOnce(new Error('模拟拒绝提示中断'));
      } else {
        vi.spyOn(original.chat, 'settleBatch').mockRejectedValueOnce(new Error('模拟拒绝提示中断'));
      }
      clock += 100;
      await expect(
        original.receive({ content: '', messageType: 'file', fileInfo: { fileName: '测试附件' } })
      ).rejects.toThrow('模拟拒绝提示中断');
      expect(await original.chat.getCollectedBatch(saved!.batchId)).toMatchObject({
        status: 'rejected',
        rejection: 'attachment',
        finishedAt: collectorNow + 100,
        settledAt: null,
      });
      const before = await collectorNotices(original);
      expect(before).toHaveLength(checkpoint === '发送之前' ? 0 : 1);
      expect(original.driver.recordedCalls).toHaveLength(checkpoint === '发送之前' ? 0 : 1);
      await original.close();

      clock += 1000;
      const recovered = runtime(original.owner);
      await Promise.all([recovered.collector.recover(), recovered.collector.recover()]);
      await recovered.collector.recover();
      const after = await collectorNotices(recovered);
      expect(after).toEqual([
        {
          operation_id: before[0]?.operation_id ?? expect.any(String),
          purpose: 'notice:input_attachment',
          status: 'delivered',
          send_calls: 1,
        },
      ]);
      expect(original.driver.recordedCalls.length + recovered.driver.recordedCalls.length).toBe(1);
      expect(await collectorTasks(recovered)).toEqual([]);
      expect(await recovered.chat.getCollectedBatch(saved!.batchId)).toMatchObject({
        rejection: 'attachment',
        finishedAt: collectorNow + 100,
        settledAt: expect.any(Number),
      });
      expect(
        (await recovered.chat.getBatchMessages(saved!.batchId)).map(message => message.text)
      ).toEqual(['附件前的文字', '']);
    }
  );
});
