import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  InMemorySendOperationStore,
  type IKK9Driver,
  type SendOperationStore,
  type SendResult,
} from '@kairo/driver';
import { AppError, getErrorType, getFailureMessage } from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import type { PrivateChatStore } from '../private-chat-core/types.js';
import type { Task, TaskStore } from '../task-lifecycle/types.js';
import {
  SEND_QUERY_WAIT_MS,
  createSendIntent,
  isDispatchTerminal,
  statusAfterObservation,
  type DispatchUpdate,
  type SendDispatch,
  type SendDispatchStore,
  type SendRequest,
} from './send-policy.js';

type OutboundDriver = Pick<IKK9Driver, 'sendText' | 'getSendStatus'>;

export interface SendServiceOptions {
  createDriver(store: SendOperationStore): OutboundDriver;
  driverStore: SendOperationStore;
  dispatches: SendDispatchStore;
  tasks: Pick<TaskStore, 'getTask' | 'transitionTask'>;
  contexts: Pick<PrivateChatStore, 'getContext' | 'getRawMessage'>;
  logger: AppLogger;
}

export interface StorageFailureEvent {
  botId: string;
  sessionId: string;
  messageId: string;
}

/** 故障提示只在当前进程尽力一次；不因服务实例重建或连接恢复而补发。 */
const attemptedStorageNotices = new Set<string>();

export interface SendService {
  readonly driver: OutboundDriver;
  send(request: SendRequest): Promise<SendDispatch>;
  /** 仅在旧进程已停止后调用；不负责扫描任务或建立恢复队列。 */
  recover(request: SendRequest): Promise<SendDispatch>;
  sendStorageFailure(event: StorageFailureEvent, error: AppError): Promise<SendResult | null>;
  /** 取消本协调器等待，不关闭调用方拥有的 Driver 或连接池。 */
  close(): void;
}

export function createSendService(options: SendServiceOptions): SendService {
  const { dispatches, tasks, contexts, logger } = options;
  const shutdown = new AbortController();
  const active = new Map<string, Promise<SendDispatch>>();
  const emergencyIds = new Set<string>();
  const emergencyStore = new InMemorySendOperationStore();
  // 这不是普通发送的存储回退：只有下方固定故障提示入口可登记例外 ID。
  const operationStore: SendOperationStore = {
    claim: input =>
      (emergencyIds.has(input.operationId) ? emergencyStore : options.driverStore).claim(input),
    get: operationId =>
      (emergencyIds.has(operationId) ? emergencyStore : options.driverStore).get(operationId),
    update: (operationId, update) =>
      (emergencyIds.has(operationId) ? emergencyStore : options.driverStore).update(
        operationId,
        update
      ),
  };
  const driver = options.createDriver(operationStore);

  function checkOpen(): void {
    if (shutdown.signal.aborted) throw new AppError('cancelled');
  }

  async function current(dispatch: SendDispatch): Promise<SendDispatch> {
    const saved = await dispatches.get(dispatch.operationId);
    if (!saved) throw new Error(`未找到出站协调记录 [${dispatch.operationId}]`);
    return saved;
  }

  async function change(
    dispatch: SendDispatch,
    update: Partial<DispatchUpdate>
  ): Promise<SendDispatch | null> {
    checkOpen();
    return dispatches.compareAndSet(dispatch.operationId, dispatch.revision, {
      ...dispatch,
      ...update,
    });
  }

  async function valid(request: SendRequest, afterTrigger = false): Promise<boolean> {
    const subject = request.subject;
    if (subject.kind === 'event') {
      const message = await contexts.getRawMessage(subject);
      if (!message || message.direction !== 'inbound') return false;
      if (!subject.threadId) return true;
      const context = await contexts.getContext(subject.threadId);
      return (
        context !== null &&
        context.invalidatedAt === null &&
        context.botId === subject.botId &&
        context.sessionId === subject.sessionId
      );
    }
    const task = await tasks.getTask(subject.taskId);
    if (!task || task.inputVersion !== subject.inputVersion) return false;
    const context = await contexts.getContext(task.threadId);
    if (
      !context ||
      context.invalidatedAt !== null ||
      context.sessionId !== task.sessionId ||
      context.botId !== task.botId ||
      context.employeeId !== task.employeeId
    )
      return false;
    if (request.purpose === 'final') {
      if (task.status !== 'ready_to_send' && task.status !== 'sending') return false;
      return (
        (afterTrigger && task.status === 'sending') ||
        (task.executionDeadline !== null && Date.now() < task.executionDeadline)
      );
    }
    if (request.purpose === 'queued')
      return task.status === 'queued' && Date.now() < task.queueDeadline;
    if (request.purpose === 'progress')
      return (
        task.status === 'running' &&
        task.executionDeadline !== null &&
        Date.now() < task.executionDeadline
      );
    return task.status !== 'cancelled';
  }

  async function enterSending(request: SendRequest): Promise<void> {
    if (request.purpose !== 'final' || request.subject.kind !== 'task') return;
    const task = await tasks.getTask(request.subject.taskId);
    if (task?.status === 'ready_to_send') {
      await tasks.transitionTask({
        taskId: task.taskId,
        inputVersion: request.subject.inputVersion,
        now: Date.now(),
        from: 'ready_to_send',
        to: 'sending',
      });
    }
  }

  async function finishTask(request: SendRequest, dispatch: SendDispatch): Promise<SendDispatch> {
    if (!isDispatchTerminal(dispatch.status)) return dispatch;
    if (request.purpose === 'final' && request.subject.kind === 'task') {
      const task = await tasks.getTask(request.subject.taskId);
      if (
        task &&
        task.inputVersion === request.subject.inputVersion &&
        (task.status === 'ready_to_send' || task.status === 'sending')
      ) {
        const effective = await valid(request, true);
        let to: 'completed' | 'failed' | 'send_unconfirmed' | 'cancelled' | 'timed_out';
        if (!effective || dispatch.status === 'cancelled') {
          to =
            task.status === 'ready_to_send' &&
            task.executionDeadline !== null &&
            Date.now() >= task.executionDeadline
              ? 'timed_out'
              : 'cancelled';
        } else {
          to =
            dispatch.status === 'delivered'
              ? 'completed'
              : dispatch.status === 'failed'
                ? 'failed'
                : 'send_unconfirmed';
        }
        checkOpen();
        await tasks.transitionTask({
          taskId: task.taskId,
          inputVersion: request.subject.inputVersion,
          now: Date.now(),
          from: task.status,
          to,
        });
      }
    }
    return dispatch;
  }

  async function observe(
    request: SendRequest,
    dispatch: SendDispatch,
    result: SendResult
  ): Promise<SendDispatch> {
    checkOpen();
    if (!result.status || (result.status === 'delivered' && !result.messageId)) {
      throw new AppError('driver', {
        cause: new Error('带 operationId 的 Driver 结果缺少发送状态或送达编号'),
      });
    }
    // 原生送达证据仍由 Driver 保存；失效任务的协调结果不能成为可采用的 delivered。
    const status = (await valid(request, true))
      ? statusAfterObservation(result.status, dispatch)
      : 'cancelled';
    const saved = await change(dispatch, { status, messageId: result.messageId ?? null });
    if (!saved) return current(dispatch);
    logger[status === 'send_unconfirmed' ? 'warn' : 'info']({
      event: '运行状态',
      taskId: saved.taskId ?? undefined,
      sessionId: saved.sessionId,
      status: result.status,
      ...(status === 'send_unconfirmed' ? { errorType: 'send_unknown' } : {}),
    });
    return saved;
  }

  async function query(request: SendRequest, dispatch: SendDispatch): Promise<SendDispatch> {
    if (dispatch.queryUsed) {
      const saved = await change(dispatch, { status: 'send_unconfirmed' });
      if (saved)
        logger.warn({
          event: '运行状态',
          taskId: saved.taskId ?? undefined,
          sessionId: saved.sessionId,
          status: 'unknown',
          errorType: 'send_unknown',
        });
      return saved ?? current(dispatch);
    }
    if (dispatch.queryDueAt === null) throw new Error('已触发发送缺少查询截止时间');
    const remaining = dispatch.queryDueAt - Date.now();
    if (remaining > 0) await delay(remaining, undefined, { signal: shutdown.signal });
    checkOpen();
    if (!(await valid(request, true))) {
      const saved = await change(dispatch, { status: 'cancelled' });
      return saved ?? current(dispatch);
    }
    await enterSending(request);
    const claimed = await change(dispatch, { status: 'querying', queryUsed: true });
    if (!claimed) return current(dispatch);
    let result: SendResult;
    try {
      result = await driver.getSendStatus(claimed.operationId);
    } catch (cause) {
      const failure = new AppError('driver', { cause });
      if (!shutdown.signal.aborted) {
        try {
          const saved = await change(claimed, { status: 'send_unconfirmed' });
          await finishTask(request, saved ?? (await current(claimed)));
        } catch (storageError) {
          throw new AggregateError([failure, storageError], '查询发送状态及保存未确认结果均失败');
        }
      }
      throw failure;
    }
    return observe(request, claimed, result);
  }

  async function sendOnce(request: SendRequest, dispatch: SendDispatch): Promise<SendDispatch> {
    if (!(await valid(request, dispatch.sendCalls > 0))) {
      const saved = await change(dispatch, { status: 'cancelled' });
      return saved ?? current(dispatch);
    }
    const claimed = await change(dispatch, {
      status: 'sending',
      sendCalls: dispatch.sendCalls + 1,
      queryDueAt: dispatch.queryDueAt ?? Date.now() + SEND_QUERY_WAIT_MS,
    });
    if (!claimed) return current(dispatch);
    await enterSending(request);
    // /new 可在前次检查与 ready_to_send→sending 之间作废上下文，必须再次检查。
    if (!(await valid(request, dispatch.sendCalls > 0))) {
      const saved = await change(claimed, { status: 'cancelled' });
      return saved ?? current(claimed);
    }
    checkOpen();
    let result: SendResult;
    try {
      result = await driver.sendText(request.text, {
        operationId: claimed.operationId,
        targetSessionId: claimed.sessionId,
      });
    } catch (cause) {
      // 异常不证明发送未发生；保留 sending 与已占用预算，显式恢复时只查不盲发。
      throw new AppError('driver', { cause });
    }
    return observe(request, claimed, result);
  }

  async function drive(
    request: SendRequest,
    dispatch: SendDispatch,
    recovering: boolean
  ): Promise<SendDispatch> {
    if (isDispatchTerminal(dispatch.status)) return finishTask(request, dispatch);
    if (
      recovering &&
      (dispatch.status === 'sending' ||
        dispatch.status === 'querying' ||
        (dispatch.status === 'retryable' && !dispatch.queryUsed))
    ) {
      dispatch = await query(request, dispatch);
    } else if (dispatch.status === 'sending' || dispatch.status === 'querying') {
      return dispatch;
    }
    while (!isDispatchTerminal(dispatch.status)) {
      checkOpen();
      const before = dispatch;
      if (dispatch.status === 'prepared' || dispatch.status === 'retryable') {
        dispatch = await sendOnce(request, dispatch);
      } else if (dispatch.status === 'unknown') {
        dispatch = await query(request, dispatch);
      } else {
        return dispatch;
      }
      // CAS 败方不接管胜方的进行中调用，普通重复事件不是进程恢复。
      if (
        dispatch.revision === before.revision ||
        dispatch.status === 'sending' ||
        dispatch.status === 'querying'
      )
        return dispatch;
    }
    return finishTask(request, dispatch);
  }

  async function submit(input: SendRequest, recovering: boolean): Promise<SendDispatch> {
    checkOpen();
    const request: SendRequest = { ...input, subject: { ...input.subject } };
    const subject = request.subject;
    let task: Task | null = null;
    if (subject.kind === 'task') {
      task = await tasks.getTask(subject.taskId);
      if (!task || task.inputVersion !== subject.inputVersion) throw new AppError('cancelled');
    } else if (!request.purpose.startsWith('notice:')) {
      throw new Error('无任务的事件只允许固定提示用途');
    }
    const sessionId = subject.kind === 'event' ? subject.sessionId : task!.sessionId;
    const dispatch = await dispatches.ensure(createSendIntent(request, sessionId));
    checkOpen();
    const existing = active.get(dispatch.operationId);
    if (existing) return existing;
    const work = drive(request, dispatch, recovering);
    active.set(dispatch.operationId, work);
    try {
      return await work;
    } catch (error) {
      logger.error({
        event: '运行失败',
        taskId: dispatch.taskId ?? undefined,
        sessionId,
        errorType: getErrorType(error, 'storage'),
      });
      throw error;
    } finally {
      active.delete(dispatch.operationId);
    }
  }

  return {
    driver,
    send: request => submit(request, false),
    recover: request => submit(request, true),
    async sendStorageFailure(event, error): Promise<SendResult | null> {
      checkOpen();
      if (!(error instanceof AppError) || error.type !== 'storage') throw error;
      const operationId = `storage-notice:${createHash('sha256')
        .update(JSON.stringify([event.botId, event.sessionId, event.messageId]))
        .digest('hex')}`;
      if (attemptedStorageNotices.has(operationId)) return null;
      attemptedStorageNotices.add(operationId);
      emergencyIds.add(operationId);
      logger.error({
        event: '运行失败',
        sessionId: event.sessionId,
        messageId: event.messageId,
        errorType: 'storage',
      });
      // 不访问任务、上下文或 PostgreSQL；只有这一固定正文可使用上述例外 Store。
      try {
        return await driver.sendText(getFailureMessage('storage'), {
          targetSessionId: event.sessionId,
          operationId,
        });
      } catch (cause) {
        logger.error({
          event: '运行失败',
          sessionId: event.sessionId,
          messageId: event.messageId,
          errorType: 'driver',
        });
        throw new AppError('driver', { cause });
      }
    },
    close(): void {
      shutdown.abort();
    },
  };
}
