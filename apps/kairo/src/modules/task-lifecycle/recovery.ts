import type { SendRequest } from '../im-transport/send-policy.js';
import type { SendService } from '../im-transport/send-service.js';
import type { AppLogger } from '../operability/logger.js';
import type { Collector } from '../private-chat-core/collector.js';
import type { Scheduler } from './scheduler.js';
import type { Task, TaskStore } from './types.js';

export interface RecoveryOptions {
  tasks: Pick<TaskStore, 'listActiveTasks' | 'failRecovery' | 'getTaskWait' | 'transitionTask'>;
  collector: Pick<Collector, 'recover'>;
  scheduler: Pick<Scheduler, 'recover' | 'tick'>;
  sender: Pick<SendService, 'send' | 'recover'>;
  signal: AbortSignal;
  logger: AppLogger;
}

/** 仅用于旧进程已退出后的启动；连接断线必须取消旧任务，不能调用此入口。 */
export function createRecovery(options: RecoveryOptions): { recover(): Promise<void> } {
  let started: Promise<void> | undefined;

  async function restore(): Promise<void> {
    options.signal.throwIfAborted();
    const rows = await options.tasks.listActiveTasks();
    options.signal.throwIfAborted();
    const running: Task[] = [];
    const sends: Array<{ request: SendRequest; recover: boolean }> = [];
    const request = (task: Task, purpose: SendRequest['purpose'], text: string): SendRequest => ({
      subject: { kind: 'task', taskId: task.taskId, inputVersion: task.inputVersion },
      purpose,
      text,
    });

    async function fail(task: Task): Promise<void> {
      const version = { taskId: task.taskId, inputVersion: task.inputVersion };
      if (await options.tasks.failRecovery({ ...version, now: Date.now })) {
        options.logger.error({
          event: '运行失败',
          taskId: task.taskId,
          sessionId: task.sessionId,
          errorType: 'internal',
        });
        sends.push({
          request: request(
            task,
            'notice:recovery_failure',
            '本次任务无法恢复，已结束，请重新发送问题。'
          ),
          recover: false,
        });
      } else if (task.status === 'running') {
        // 等锁期间可能恰好截止；原调度器必须重新读取并结束，而不是留下无人执行的 running。
        running.push(task);
      } else if (
        task.status === 'ready_to_send' &&
        (await options.tasks.transitionTask({
          ...version,
          from: 'ready_to_send',
          to: 'timed_out',
          now: Date.now(),
        }))
      ) {
        sends.push({
          request: request(task, 'notice:execution_timeout', '本次查询超时，请稍后重试'),
          recover: false,
        });
      }
    }

    async function classify(task: Task): Promise<void> {
      options.signal.throwIfAborted();
      if (task.status === 'running') {
        if (
          !task.recoveryUsed ||
          (task.executionDeadline !== null && Date.now() >= task.executionDeadline)
        )
          running.push(task);
        else await fail(task);
      } else if (task.status === 'ready_to_send' || task.status === 'sending') {
        if (task.answerText === null) await fail(task);
        else sends.push({ request: request(task, 'final', task.answerText), recover: true });
      } else if (task.status === 'waiting_for_user') {
        const wait = await options.tasks.getTaskWait(task.taskId);
        if (wait?.closedAt === null && Date.now() < wait.deadline) {
          sends.push({
            request: request(task, `notice:user_wait:${wait.waitId}`, wait.question),
            recover: true,
          });
        }
      }
    }

    async function send(item: (typeof sends)[number]): Promise<void> {
      options.signal.throwIfAborted();
      const errors: unknown[] = [];
      try {
        await (item.recover
          ? options.sender.recover(item.request)
          : options.sender.send(item.request));
      } catch (error) {
        errors.push(error);
      }
      try {
        if (!options.signal.aborted && item.request.purpose === 'final')
          await options.scheduler.tick();
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, '发送恢复及调度收尾均失败');
    }

    // 分类不执行外部发送；单个会话的存储或通知失败不能阻断其他独立恢复。
    const classified = await Promise.allSettled(rows.map(classify));
    options.signal.throwIfAborted();
    const results = await Promise.allSettled([
      options.scheduler.recover(running, options.signal),
      options.collector.recover(),
      ...sends.map(send),
    ]);
    const errors = [...classified, ...results]
      .filter(result => result.status === 'rejected')
      .map(result => result.reason as unknown);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '启动恢复存在多个失败');
  }

  return {
    recover(): Promise<void> {
      // 同一启动只扫描一次；重复调用不能把本进程的新 running 当作崩溃任务。
      started ??= restore();
      return started;
    },
  };
}

/** 监督器已同步封闭旧 intake 并 abort 代次后调用；不是进程重启恢复。 */
export async function cancelConnectionWork(options: {
  botId: string;
  tasks: Pick<TaskStore, 'cancelUnfinished'>;
  scheduler: Pick<Scheduler, 'pause'>;
  collector: Pick<Collector, 'close'>;
  sender: Pick<SendService, 'close'>;
}): Promise<void> {
  const errors: unknown[] = [];
  try {
    options.sender.close();
  } catch (error) {
    errors.push(error);
  }
  const stopped = await Promise.allSettled([options.scheduler.pause(), options.collector.close()]);
  for (const result of stopped)
    if (result.status === 'rejected') errors.push(result.reason as unknown);
  // 旧聚合与领取事务结束后再取消，避免其在取消扫描之后创建遗留任务。
  try {
    await options.tasks.cancelUnfinished(options.botId, Date.now);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, '连接断线取消及收尾失败');
}
