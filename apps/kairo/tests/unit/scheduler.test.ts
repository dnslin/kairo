import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScheduler, type Scheduler } from '../../src/modules/task-lifecycle/scheduler.js';
import type { Task, TaskStore } from '../../src/modules/task-lifecycle/types.js';
import type { TaskRunnerOptions } from '../../src/modules/task-lifecycle/task-runner.js';
import type { ContextService } from '../../src/modules/private-chat-core/context-service.js';
import type { PrivateChatStore } from '../../src/modules/private-chat-core/types.js';
import type { SendService } from '../../src/modules/im-transport/send-service.js';
import { createLogger } from '../../src/modules/operability/logger.js';

const execution = vi.hoisted(() => ({
  starts: [] as string[],
  releases: new Map<string, () => void>(),
  settleWake: false,
}));
vi.mock('../../src/modules/task-lifecycle/task-runner.js', () => ({
  createTaskRunner: (options: TaskRunnerOptions) => ({
    run: (task: Task) => {
      execution.starts.push(task.taskId);
      return new Promise<void>(resolve => {
        execution.releases.set(task.taskId, () => {
          resolve();
          options.onTaskChange();
        });
      });
    },
    settled: () => {
      if (execution.settleWake) {
        execution.settleWake = false;
        options.onTaskChange();
      }
      return Promise.resolve();
    },
    close: () => {
      for (const release of execution.releases.values()) release();
      return Promise.resolve();
    },
  }),
}));

const START = 1800000000000;
const schedulers: Scheduler[] = [];
function task(id: string, sessionId = id, status: Task['status'] = 'queued'): Task {
  return {
    taskId: id,
    batchId: id,
    botId: 'bot',
    sessionId,
    employeeId: sessionId,
    threadId: sessionId,
    inputVersion: 1,
    configDigest: '配置',
    status,
    createdAt: START,
    updatedAt: START,
    queueDeadline: START + 600000,
    executionStartedAt: null,
    executionDeadline: null,
    executionBudgetMs: null,
    currentWaitId: null,
    queueNoticeRequired: false,
    currentAttemptId: null,
    endedAt: null,
  };
}
function fixture(rows: Task[]) {
  const store = {
    listActiveTasks: vi.fn(() =>
      Promise.resolve(
        rows
          .filter(row =>
            ['queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending'].includes(
              row.status
            )
          )
          .map(row => ({ ...row }))
      )
    ),
    getTaskWait: vi.fn(() => Promise.resolve(null)),
    claimTask: vi.fn((input: Parameters<TaskStore['claimTask']>[0]) => {
      const row = rows.find(item => item.taskId === input.taskId)!;
      if (row.status !== 'queued') return Promise.resolve(null);
      row.status = 'running';
      row.executionDeadline = Date.now() + input.executionMs;
      return Promise.resolve({ ...row });
    }),
    getTask: vi.fn((id: string) => Promise.resolve(rows.find(row => row.taskId === id) ?? null)),
    transitionTask: vi.fn((input: Parameters<TaskStore['transitionTask']>[0]) => {
      const row = rows.find(item => item.taskId === input.taskId)!;
      if (row.status !== input.from) return Promise.resolve(false);
      row.status = input.to;
      row.endedAt = input.now;
      return Promise.resolve(true);
    }),
    resolveUserWait: vi.fn(() => Promise.resolve(true)),
  };
  const sends: string[] = [];
  const sender = {
    send: vi.fn((request: Parameters<SendService['send']>[0]) => {
      sends.push(request.text);
      return Promise.resolve({ status: 'delivered' });
    }),
  };
  const scheduler = createScheduler({
    tasks: store as unknown as TaskStore,
    contexts: {} as ContextService,
    chat: {} as PrivateChatStore,
    sender: sender as unknown as SendService,
    execute: () => Promise.reject(new Error('调度单元不装配 Agent')),
    configDigest: '配置',
    progressMs: 10000,
    queueMs: 600000,
    executionMs: 240000,
    concurrency: { global: 3, perSessionQueue: 3 },
    logger: createLogger({ write(): void {} }),
  });
  schedulers.push(scheduler);
  return { scheduler, store, sends };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  execution.starts.length = 0;
  execution.releases.clear();
  execution.settleWake = false;
});
afterEach(async () => {
  await Promise.all(schedulers.splice(0).map(scheduler => scheduler.close()));
  vi.useRealTimers();
});

describe('进程内调度的顺序与实际名额', () => {
  it('三个会话并行，第四个等真实执行退出后才启动', async () => {
    const rows = ['a', 'b', 'c', 'd'].map(id => task(id));
    const { scheduler } = fixture(rows);
    await scheduler.tick();
    expect(execution.starts).toEqual(['a', 'b', 'c']);
    rows[0]!.status = 'completed';
    await scheduler.tick();
    expect(execution.starts).toEqual(['a', 'b', 'c']);
    execution.releases.get('a')!();
    await Promise.resolve();
    await scheduler.tick();
    expect(execution.starts).toEqual(['a', 'b', 'c', 'd']);
  });

  it.each(['waiting_for_user', 'ready_to_send', 'sending'] as const)(
    '%s 阻塞本会话，但不占其他会话的 Agent 名额',
    async status => {
      const rows = [task('a', '甲', status), task('b', '甲'), task('c', '乙')];
      const { scheduler } = fixture(rows);
      await scheduler.tick();
      expect(execution.starts).toEqual(['c']);
      rows[0]!.status = 'send_unconfirmed';
      await scheduler.tick();
      expect(execution.starts).toEqual(['c', 'b']);
    }
  );

  it('同会话前项取消但尚未退出，新 thread 也不能突破实际串行', async () => {
    const rows = [task('a', '甲'), task('b', '甲')];
    const { scheduler } = fixture(rows);
    await scheduler.tick();
    rows[0]!.status = 'cancelled';
    rows[1]!.threadId = '新thread';
    await scheduler.tick();
    expect(execution.starts).toEqual(['a']);
    execution.releases.get('a')!();
    await Promise.resolve();
    await scheduler.tick();
    expect(execution.starts).toEqual(['a', 'b']);
  });

  it('排队截止前一毫秒继续等待，恰好截止通知一次且永不启动', async () => {
    const rows = [task('a', '甲', 'sending'), task('b', '甲')];
    const { scheduler, sends } = fixture(rows);
    await scheduler.tick();
    await vi.advanceTimersByTimeAsync(599999);
    expect(rows[1]!.status).toBe('queued');
    await vi.advanceTimersByTimeAsync(1);
    await scheduler.tick();
    expect(rows[1]!.status).toBe('timed_out');
    expect(sends).toEqual(['该请求等待时间过长，已取消，请重新发送']);
    expect(execution.starts).toEqual([]);
  });

  it('数据库故障原样返回，不伪装成空队列或成功', async () => {
    const { scheduler, store } = fixture([]);
    const error = new Error('受控数据库故障');
    store.listActiveTasks.mockRejectedValueOnce(error);
    await expect(scheduler.tick()).rejects.toBe(error);
    expect(execution.starts).toEqual([]);
  });
  it('settled 等待发送回调唤醒的新数据库调度，不提前完成', async () => {
    const { scheduler, store } = fixture([]);
    let release!: (rows: Task[]) => void;
    store.listActiveTasks.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    execution.settleWake = true;
    let done = false;
    const settling = scheduler.settled().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const premature = done;
    release([]);
    await settling;
    expect(premature).toBe(false);
  });

  it('close 等待已开始的回答事务，提交后不再启动执行', async () => {
    const { scheduler, store } = fixture([]);
    let release!: (accepted: boolean) => void;
    store.resolveUserWait.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = resolve;
        })
    );
    const answer = scheduler.resolveUserWait({
      taskId: 'a',
      inputVersion: 1,
      now: START,
      waitId: 'wait',
      answerMessage: { sessionId: 'a', messageId: 'answer' },
      decision: 'accepted',
    });
    const observed = answer.catch((error: unknown) => error);
    let done = false;
    const closing = scheduler.close().then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    const premature = done;
    release(true);
    const result = await observed;
    await closing;
    expect(premature).toBe(false);
    expect(result).toBe(true);
    expect(execution.starts).toEqual([]);
  });
});
