import { randomUUID } from 'node:crypto';
import type { SendService } from '../im-transport/send-service.js';
import { isDispatchTerminal, type SendRequest } from '../im-transport/send-policy.js';
import { AppError, getErrorType } from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import type { CollectedBatch } from '../private-chat-core/collector-types.js';
import type { ContextService } from '../private-chat-core/context-service.js';
import type { PrivateChatStore } from '../private-chat-core/types.js';
import { createTaskRunner, type TaskExecutor } from './task-runner.js';
import type { ResolveUserWaitInput, Task, TaskStore, UserWait } from './types.js';

export interface SchedulerOptions {
  tasks: TaskStore;
  contexts: ContextService;
  chat: Pick<PrivateChatStore, 'getContext' | 'getBatchMessages'>;
  sender: Pick<SendService, 'send' | 'recover'>;
  execute: TaskExecutor;
  configDigest: string;
  concurrency: { global: number; perSessionQueue: number };
  queueMs: number;
  executionMs: number;
  progressMs: number;
  logger: AppLogger;
}

/** 一个应用进程只装配一个实例，所有 Bot/会话共用实际执行名额。 */
export interface Scheduler {
  enqueue(batch: CollectedBatch, recovery?: boolean): Promise<boolean>;
  /** 读取持久状态并推进可领取工作；不等待 Agent 或发送回执。 */
  tick(): Promise<void>;
  /** 旧 running 恢复仍由同一个调度器分配实际名额。 */
  recover(running: Task[], signal: AbortSignal): Promise<void>;
  pause(): Promise<void>;
  resume(signal: AbortSignal): Promise<void>;
  /** 决定来自上层语义处理；只消费原始回答，不在这里判断自然语言。 */
  resolveUserWait(input: ResolveUserWaitInput): Promise<boolean>;
  /** 等待已开始的执行与通知，报告后台错误；不等待尚未到期的队列。 */
  settled(): Promise<void>;
  close(): Promise<void>;
}

const notices = {
  queued: '已收到，将在当前任务完成后处理',
  full: '请稍后再试，或使用 /new',
  queueTimeout: '该请求等待时间过长，已取消，请重新发送',
};

function sessionKey(task: Pick<Task, 'botId' | 'sessionId'>): string {
  return JSON.stringify([task.botId, task.sessionId]);
}

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { tasks, sender, logger } = options;
  const executions = new Map<string, { session: string; work: Promise<void> }>();
  const pending = new Set<Promise<unknown>>();
  const errors: unknown[] = [];
  let timer: NodeJS.Timeout | undefined;
  let pumping: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let dirty = false;
  let closed = false;
  let paused = false;
  let connectionSignal: AbortSignal | undefined;
  const recovering = new Set<string>();
  const runner = createTaskRunner({ ...options, onTaskChange: wake });

  function checkOpen(): void {
    if (closed) throw new AppError('cancelled');
  }

  function report(error: unknown): void {
    errors.push(error);
    logger.error({
      event: '运行失败',
      errorType: getErrorType(error, 'storage'),
    });
  }

  function track<T>(work: Promise<T>): Promise<T> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    );
    return work;
  }

  function notify(request: SendRequest): void {
    if (!connectionSignal?.aborted) void track(sender.send(request)).catch(error => report(error));
  }

  function wake(): void {
    if (closed || paused) return;
    dirty = true;
    if (!pumping) void tick().catch(error => report(error));
  }

  function launch(task: Task): void {
    // 同步登记 runner 的取消控制器和实际名额，不留 close 可越过的微任务窗口。
    const recovery = recovering.delete(task.taskId);
    const work = runner.run(task, recovery, connectionSignal);
    executions.set(task.taskId, { session: sessionKey(task), work });
    const release = (): void => {
      executions.delete(task.taskId);
      wake();
    };
    // 执行与通知错误由 runner 统一报告，调度器只负责释放实际占用。
    void work.then(release, release);
  }

  async function expire(task: Task, wait: UserWait | null): Promise<boolean> {
    const deadline =
      task.status === 'queued'
        ? task.queueDeadline
        : task.status === 'running'
          ? task.executionDeadline
          : wait?.closedAt === null
            ? wait.deadline
            : null;
    if (deadline === null || Date.now() < deadline) return false;
    if (
      await tasks.transitionTask({
        taskId: task.taskId,
        inputVersion: task.inputVersion,
        from: task.status,
        to: 'timed_out',
        now: Date.now(),
      })
    ) {
      if (task.status === 'queued') {
        notify({
          subject: { kind: 'task', taskId: task.taskId, inputVersion: task.inputVersion },
          purpose: 'notice:queue_timeout',
          text: notices.queueTimeout,
        });
      }
      if (task.status === 'running') {
        recovering.delete(task.taskId);
        notify({
          subject: { kind: 'task', taskId: task.taskId, inputVersion: task.inputVersion },
          purpose: 'notice:execution_timeout',
          text: '本次查询超时，请稍后重试',
        });
      }
      return true;
    }
    // 与 /new、员工回答或其他状态推进竞争失败后，重新读取而不是用旧快照领取。
    dirty = true;
    return true;
  }

  async function pump(): Promise<void> {
    clearTimeout(timer);
    timer = undefined;
    const rows = await tasks.listActiveTasks();
    if (closed || paused) return;
    const current: Array<{ task: Task; wait: UserWait | null }> = [];
    let nextDeadline = Infinity;
    for (const task of rows) {
      const wait = task.status === 'waiting_for_user' ? await tasks.getTaskWait(task.taskId) : null;
      if (closed || paused) return;
      if (
        (task.status === 'queued' ||
          task.status === 'waiting_for_user' ||
          recovering.has(task.taskId)) &&
        (await expire(task, wait))
      )
        continue;
      current.push({ task, wait });
      if (task.status === 'queued') nextDeadline = Math.min(nextDeadline, task.queueDeadline);
      if (task.status === 'waiting_for_user' && wait?.closedAt === null)
        nextDeadline = Math.min(nextDeadline, wait.deadline);
      if (recovering.has(task.taskId) && task.executionDeadline !== null)
        nextDeadline = Math.min(nextDeadline, task.executionDeadline);
    }
    // 非排队阶段仍拥有本会话顺序；恢复不能把原 running 退回队尾。
    const owners = new Map<string, Task>();
    for (const { task } of current) {
      if (task.status !== 'queued') owners.set(sessionKey(task), task);
    }
    const visited = new Set<string>();
    const occupied = new Set([...executions.values()].map(item => item.session));
    for (const { task, wait } of current) {
      if (closed || paused || executions.size >= options.concurrency.global) break;
      const key = sessionKey(task);
      if (occupied.has(key) || visited.has(key)) continue;
      const owner = owners.get(key);
      if (owner && owner.taskId !== task.taskId) continue;
      visited.add(key);
      const acceptedWait = task.status === 'waiting_for_user' && wait?.resolution === 'accepted';
      const recovery = task.status === 'running' && recovering.has(task.taskId);
      if (task.status !== 'queued' && !acceptedWait && !recovery) continue;
      const running = recovery
        ? task
        : acceptedWait
          ? await tasks.resumeTask({
              taskId: task.taskId,
              inputVersion: task.inputVersion,
              now: Date.now,
            })
          : await tasks.claimTask({
              taskId: task.taskId,
              inputVersion: task.inputVersion,
              now: Date.now,
              executionMs: options.executionMs,
            });
      if (closed || paused) {
        if (running?.status === 'running')
          await tasks.transitionTask({
            taskId: running.taskId,
            inputVersion: running.inputVersion,
            from: 'running',
            to: 'cancelled',
            now: Date.now(),
          });
        return;
      }
      if (running?.status === 'running') {
        occupied.add(key);
        launch(running);
      }
    }
    if (!closed && !paused && Number.isFinite(nextDeadline)) {
      timer = setTimeout(wake, Math.max(0, nextDeadline - Date.now()));
    }
  }

  function tick(): Promise<void> {
    if (closed) return Promise.reject(new AppError('cancelled'));
    if (paused) return Promise.resolve();
    dirty = true;
    if (pumping) return pumping;
    const work = (async (): Promise<void> => {
      do {
        dirty = false;
        await pump();
      } while (dirty && !closed && !paused);
    })();
    pumping = work;
    const release = (): void => {
      pumping = undefined;
    };
    void work.then(release, release);
    return work;
  }

  async function enqueue(batch: CollectedBatch, recovery: boolean): Promise<boolean> {
    checkOpen();
    if (batch.finishedAt === null) throw new Error(`已结束批次缺少结束时刻 [${batch.batchId}]`);
    const result = await tasks.enqueueTask({
      taskId: randomUUID(),
      batchId: batch.batchId,
      configDigest: options.configDigest,
      now: batch.finishedAt,
      queueDeadline: batch.finishedAt + options.queueMs,
      queueLimit: options.concurrency.perSessionQueue,
    });
    checkOpen();
    wake();
    let request: SendRequest;
    if (result.status === 'stale') return true;
    if (result.status === 'full') {
      const first = (await options.chat.getBatchMessages(batch.batchId))[0];
      if (!first) throw new Error(`队列拒绝批次缺少原始消息 [${batch.batchId}]`);
      request = {
        subject: {
          kind: 'event',
          botId: batch.botId,
          sessionId: batch.sessionId,
          messageId: first.messageId,
          threadId: batch.threadId,
        },
        purpose: 'notice:queue_full',
        text: notices.full,
      };
    } else {
      if (!result.task.queueNoticeRequired) return true;
      request = {
        subject: {
          kind: 'task',
          taskId: result.task.taskId,
          inputVersion: result.task.inputVersion,
        },
        purpose: 'queued',
        text: notices.queued,
      };
    }
    checkOpen();
    const dispatch = await (recovery ? sender.recover(request) : sender.send(request));
    return isDispatchTerminal(dispatch.status);
  }

  async function drain(): Promise<void> {
    while (pumping || executions.size > 0 || pending.size > 0) {
      await Promise.allSettled([
        ...(pumping ? [pumping] : []),
        ...[...executions.values()].map(item => item.work),
        ...pending,
      ]);
    }
  }

  async function settled(): Promise<void> {
    let runnerFailure: { error: unknown } | undefined;
    do {
      await drain();
      try {
        await runner.settled();
      } catch (error) {
        runnerFailure = { error };
      }
      // 发送收尾会唤醒新的调度；两边共同空闲才算已开始工作全部结束。
    } while (pumping || executions.size > 0 || pending.size > 0);
    const failures = errors.splice(0);
    if (runnerFailure) failures.push(runnerFailure.error);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, '任务调度收尾失败');
  }

  async function resolveUserWait(input: ResolveUserWaitInput): Promise<boolean> {
    checkOpen();
    const accepted = await tasks.resolveUserWait(input);
    if (accepted && !closed) await tick();
    return accepted;
  }

  return {
    enqueue: (batch, recovery = false) => track(enqueue(batch, recovery)),
    tick,
    recover(running, signal): Promise<void> {
      checkOpen();
      signal.throwIfAborted();
      connectionSignal = signal;
      for (const task of running) recovering.add(task.taskId);
      return tick();
    },
    async pause(): Promise<void> {
      paused = true;
      clearTimeout(timer);
      recovering.clear();
      runner.cancel();
      if (pumping) await pumping;
    },
    resume(signal): Promise<void> {
      checkOpen();
      signal.throwIfAborted();
      connectionSignal = signal;
      paused = false;
      return tick();
    },
    resolveUserWait: input => track(resolveUserWait(input)),
    settled,
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      clearTimeout(timer);
      closing = (async (): Promise<void> => {
        // 关闭后不再有发送唤醒；各自等待一次，避免把同一执行错误重复聚合。
        const results = await Promise.allSettled([runner.close(), drain()]);
        const failures = results
          .filter(result => result.status === 'rejected')
          .map(result => result.reason as unknown)
          .concat(errors.splice(0));
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, '任务调度关闭失败');
      })();
      return closing;
    },
  };
}
