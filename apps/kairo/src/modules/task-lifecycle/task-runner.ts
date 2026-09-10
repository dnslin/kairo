import { randomUUID } from 'node:crypto';
import type { SendPurpose } from '../im-transport/send-policy.js';
import type { SendService } from '../im-transport/send-service.js';
import { AppError, getErrorType, getFailureMessage } from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import type { ContextService } from '../private-chat-core/context-service.js';
import type { ChatContext, PrivateChatStore } from '../private-chat-core/types.js';
import { scheduleDeadline } from './deadlines.js';
import type { Task, TaskAttempt, TaskStore, TaskVersion } from './types.js';

export type TaskExecutionResult =
  | { kind: 'answer'; text: string }
  | { kind: 'waiting_for_user'; question: string; allowedQuestionIds: string[] };

/** answer 必须已由调用方检查。只有 Agent 不再发起 Tool 且全部 Tool/子进程回收后才能 settle。 */
export type TaskExecutor = (input: {
  task: Task;
  attempt: TaskAttempt;
  context: ChatContext;
  signal: AbortSignal;
}) => Promise<TaskExecutionResult>;

export interface TaskRunnerOptions {
  tasks: Pick<
    TaskStore,
    'getTask' | 'startAttempt' | 'finishAttempt' | 'transitionTask' | 'adoptAttempt' | 'waitForUser'
  >;
  contexts: ContextService;
  chat: Pick<PrivateChatStore, 'getContext'>;
  sender: Pick<SendService, 'send'>;
  execute: TaskExecutor;
  configDigest: string;
  progressMs: number;
  logger: AppLogger;
  /** 只发出唤醒，不在回调中等待下一轮调度。 */
  onTaskChange: () => void;
}

export interface TaskRunner {
  /** 已领取的 running 任务；释放实际名额不等待最终发送。 */
  run(task: Task): Promise<void>;
  settled(): Promise<void>;
  /** 停止接纳并等待真实执行与通知；不关闭共享 sender/连接池。 */
  close(): Promise<void>;
}

function throwFailures(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, '任务执行与收尾存在多个错误');
}

export function createTaskRunner(options: TaskRunnerOptions): TaskRunner {
  const active = new Map<string, { controller: AbortController; promise: Promise<void> }>();
  const notifications = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let closed = false;

  function report(task: Task, runId: string, error: unknown): void {
    try {
      options.logger.error({
        event: '运行失败',
        errorType: getErrorType(error),
        taskId: task.taskId,
        runId,
        sessionId: task.sessionId,
        contextId: task.threadId,
      });
    } catch (logError) {
      failures.push(logError);
    }
  }

  function notify(task: Task, runId: string, purpose: SendPurpose, text: string): void {
    const sent = Promise.resolve().then(() =>
      options.sender.send({
        subject: { kind: 'task', taskId: task.taskId, inputVersion: task.inputVersion },
        purpose,
        text,
      })
    );
    const observed = sent
      .then(
        () => {
          options.onTaskChange();
        },
        error => {
          failures.push(error);
          report(task, runId, error);
          options.onTaskChange();
        }
      )
      .catch(error => {
        // 唤醒或日志边界自身失败也必须有归属，不能产生游离 rejection。
        failures.push(error);
      });
    notifications.add(observed);
    void observed.then(() => {
      notifications.delete(observed);
    });
  }

  async function executeTask(
    task: Task,
    controller: AbortController,
    runId: string
  ): Promise<void> {
    const { tasks } = options;
    const errors: unknown[] = [];
    const pending = new Set<Promise<void>>();
    const attemptId = randomUUID();
    let attempt: TaskAttempt | null = null;
    let attemptedFinish = false;
    let release: (() => void) | undefined;
    let stopDeadline: (() => void) | undefined;
    let stopProgress: (() => void) | undefined;
    let stopping: Promise<void> | undefined;
    let executionPending = false;
    const version = (): TaskVersion => ({
      taskId: task.taskId,
      inputVersion: task.inputVersion,
      now: Date.now(),
    });
    const overdue = (): boolean =>
      task.executionDeadline !== null && Date.now() >= task.executionDeadline;

    function observe(operation: Promise<void>): void {
      const observed = operation.catch(error => {
        errors.push(error);
        report(task, runId, error);
      });
      pending.add(observed);
      void observed.then(() => {
        pending.delete(observed);
      });
    }

    function stopBusiness(timeout: boolean): Promise<void> {
      stopping ??= (async (): Promise<void> => {
        const current = await tasks.getTask(task.taskId);
        if (
          !current ||
          current.inputVersion !== task.inputVersion ||
          (current.status !== 'running' && current.status !== 'ready_to_send')
        )
          return;
        let changed = await tasks.transitionTask({
          ...version(),
          from: current.status,
          to: timeout ? 'timed_out' : 'cancelled',
        });
        // 采用事务可能恰好先提交；未交付 IM 的 ready 仍属于同一截止。
        if (!changed && current.status === 'running') {
          changed = await tasks.transitionTask({
            ...version(),
            from: 'ready_to_send',
            to: timeout ? 'timed_out' : 'cancelled',
          });
        }
        if (changed) {
          options.onTaskChange();
          if (timeout) notify(task, runId, 'notice:execution_timeout', '本次查询超时，请稍后重试');
        }
      })();
      return stopping;
    }

    function abort(): void {
      stopProgress?.();
      const type = getErrorType(controller.signal.reason);
      if (type !== 'timeout' && type !== 'cancelled') return;
      if (executionPending) {
        // 业务终态不代表实际退出；此关联任务仍占名额，持续不退出时需人工处理。
        try {
          options.logger.warn({
            event: '运行状态',
            status: 'degraded',
            errorType: type,
            taskId: task.taskId,
            runId,
            sessionId: task.sessionId,
            contextId: task.threadId,
          });
        } catch (error) {
          errors.push(error);
        }
      }
      observe(stopBusiness(overdue() || type === 'timeout'));
    }

    function expire(): void {
      // 同一个真实控制器先开始取消，再推进超时账本；不以 Promise.race 假释放名额。
      controller.abort(new DOMException('任务执行截止', 'TimeoutError'));
      if (!stopping) observe(stopBusiness(true));
    }

    async function finish(error: unknown): Promise<void> {
      if (!attempt || attemptedFinish) return;
      attemptedFinish = true;
      const errorType =
        error !== null
          ? getErrorType(error)
          : controller.signal.aborted
            ? getErrorType(controller.signal.reason)
            : overdue()
              ? 'timeout'
              : null;
      if (
        !(await tasks.finishAttempt({
          attemptId: attempt.attemptId,
          finishedAt: Date.now(),
          errorType,
        }))
      ) {
        throw new Error('执行尝试结束记录未保存');
      }
    }

    async function endFailed(error: unknown): Promise<void> {
      if (overdue()) {
        expire();
        return;
      }
      if (controller.signal.aborted && getErrorType(controller.signal.reason) === 'cancelled') {
        if (!stopping) observe(stopBusiness(false));
        return;
      }
      const current = await tasks.getTask(task.taskId);
      if (!current || current.status !== 'running' || current.inputVersion !== task.inputVersion)
        return;
      const owned = current.currentAttemptId === (attempt?.attemptId ?? attemptId);
      if (!owned && current.currentAttemptId !== task.currentAttemptId) return;
      const changed = await tasks.transitionTask(
        owned
          ? {
              ...version(),
              from: 'running',
              to: 'failed',
              expectedAttemptId: current.currentAttemptId!,
            }
          : { ...version(), from: 'running', to: 'cancelled' }
      );
      if (changed) {
        options.onTaskChange();
        if (owned)
          notify(task, runId, 'notice:execution_failure', getFailureMessage(getErrorType(error)));
      }
    }

    controller.signal.addEventListener('abort', abort, { once: true });
    try {
      if (
        task.status !== 'running' ||
        task.executionDeadline === null ||
        task.executionBudgetMs === null
      ) {
        throw new Error('执行器需要已领取且具有原始执行预算的任务');
      }
      stopDeadline = scheduleDeadline(task.executionDeadline, expire);
      if (controller.signal.aborted) {
        if (!stopping) observe(stopBusiness(overdue()));
        return;
      }
      const context = await options.chat.getContext(task.threadId);
      controller.signal.throwIfAborted();
      if (
        !context ||
        context.invalidatedAt !== null ||
        context.botId !== task.botId ||
        context.sessionId !== task.sessionId ||
        context.employeeId !== task.employeeId
      ) {
        controller.abort(new AppError('cancelled'));
        return;
      }
      attempt = await tasks.startAttempt({
        ...version(),
        attemptId,
        runId,
        configDigest: options.configDigest,
        expectedAttemptId: task.currentAttemptId,
      });
      controller.signal.throwIfAborted();
      if (!attempt) {
        if (overdue()) expire();
        else await endFailed(new AppError('cancelled'));
        return;
      }
      release = await options.contexts.registerExecution(
        {
          taskId: task.taskId,
          inputVersion: task.inputVersion,
          contextVersion: context.version,
          attemptId,
        },
        controller
      );
      if (overdue()) expire();
      if (controller.signal.aborted) {
        await finish(null);
        return;
      }
      stopProgress = scheduleDeadline(
        task.executionDeadline - task.executionBudgetMs + options.progressMs + 1,
        () => {
          if (!controller.signal.aborted && !overdue()) {
            notify(task, runId, 'progress', '正在查询企业知识，请稍候');
          }
        }
      );
      let result: TaskExecutionResult;
      executionPending = true;
      try {
        result = await options.execute({
          task: { ...task, currentAttemptId: attemptId },
          attempt,
          context,
          signal: controller.signal,
        });
      } finally {
        executionPending = false;
      }
      if (overdue()) expire();
      await finish(null);
      if (overdue()) expire();
      if (controller.signal.aborted) return;
      if (result.kind === 'waiting_for_user') {
        const waitId = randomUUID();
        const waiting = await tasks.waitForUser({
          ...version(),
          now: Date.now,
          attemptId,
          waitId,
          question: result.question,
          allowedQuestionIds: result.allowedQuestionIds,
        });
        if (waiting) {
          // 预算在锁内进入 waiting 时暂停，不将 COMMIT 回执延迟算回运行预算。
          stopDeadline();
          stopProgress();
          options.onTaskChange();
          notify(task, runId, `notice:user_wait:${waitId}`, result.question);
        } else if (overdue()) expire();
        else await endFailed(new AppError('cancelled'));
      } else {
        const adopted = await tasks.adoptAttempt({ ...version(), attemptId });
        if (adopted) options.onTaskChange();
        if (overdue()) expire();
        if (adopted && !controller.signal.aborted) notify(task, runId, 'final', result.text);
        else if (!adopted && !controller.signal.aborted) await endFailed(new AppError('cancelled'));
      }
    } catch (error) {
      const abortType = getErrorType(controller.signal.reason);
      const confirmedCancellation =
        controller.signal.aborted &&
        (abortType === 'cancelled' || abortType === 'timeout') &&
        (error === controller.signal.reason ||
          ((error instanceof Error || error instanceof DOMException) &&
            error.name === 'AbortError'));
      if (!confirmedCancellation) errors.push(error);
      controller.abort(error);
      try {
        await finish(confirmedCancellation ? null : error);
      } catch (finishError) {
        errors.push(finishError);
      }
      try {
        await endFailed(error);
      } catch (stateError) {
        errors.push(stateError);
      }
    } finally {
      stopDeadline?.();
      stopProgress?.();
      while (pending.size > 0) await Promise.all([...pending]);
      controller.signal.removeEventListener('abort', abort);
      release?.();
      throwFailures(errors);
    }
  }

  async function settled(): Promise<void> {
    while (active.size > 0 || notifications.size > 0) {
      await Promise.allSettled(
        [...active.values()].map(item => item.promise).concat([...notifications])
      );
    }
    throwFailures(failures);
  }

  return {
    run(task): Promise<void> {
      if (closed) return Promise.reject(new AppError('cancelled'));
      if (active.has(task.taskId)) return Promise.reject(new Error('任务已有未退出的真实执行'));
      const controller = new AbortController();
      const runId = randomUUID();
      const promise = executeTask(task, controller, runId);
      active.set(task.taskId, { controller, promise });
      void promise.then(
        () => {
          active.delete(task.taskId);
        },
        error => {
          active.delete(task.taskId);
          failures.push(error);
          report(task, runId, error);
        }
      );
      return promise;
    },
    settled,
    close(): Promise<void> {
      closed = true;
      for (const { controller } of active.values()) controller.abort(new AppError('cancelled'));
      return settled();
    },
  };
}
