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
type SendHandoff = {
  result: Promise<{ result: SendResult; observedAt: number } | { error: AppError }>;
};
type OutputValidity = boolean | 'paused';
type SendOutcome = { dispatch: SendDispatch; paused?: boolean };
type SendStep = SendOutcome & { stopped: boolean };

function waitNoticeId(purpose: SendRequest['purpose']): string | undefined {
  return purpose.startsWith('notice:user_wait:')
    ? purpose.slice('notice:user_wait:'.length)
    : undefined;
}

export interface SendServiceOptions {
  createDriver(store: SendOperationStore): OutboundDriver;
  driverStore: SendOperationStore;
  dispatches: SendDispatchStore;
  tasks: Pick<TaskStore, 'getTask' | 'transitionTask' | 'withTaskOutput'>;
  contexts: Pick<PrivateChatStore, 'getContext' | 'getRawMessage' | 'withContextOutput'>;
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
  const active = new Map<string, Promise<SendOutcome>>();
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
      resultAt: isDispatchTerminal(update.status ?? dispatch.status)
        ? (dispatch.resultAt ?? update.resultAt ?? Date.now())
        : null,
    });
  }

  function validTask(request: SendRequest, task: Task, afterTrigger = false): OutputValidity {
    if (request.purpose === 'final') {
      if (task.status !== 'ready_to_send' && task.status !== 'sending') return false;
      return (
        (afterTrigger && task.status === 'sending') ||
        (task.executionDeadline !== null && Date.now() < task.executionDeadline)
      );
    }
    if (request.purpose === 'queued')
      return task.status === 'queued' && Date.now() < task.queueDeadline;
    if (request.purpose === 'progress') {
      if (task.status === 'waiting_for_user' && task.currentWaitId !== null) return 'paused';
      return (
        task.status === 'running' &&
        task.executionDeadline !== null &&
        Date.now() < task.executionDeadline
      );
    }
    const userWaitId = waitNoticeId(request.purpose);
    if (userWaitId !== undefined)
      return task.status === 'waiting_for_user' && task.currentWaitId === userWaitId;
    return task.status !== 'cancelled';
  }

  async function valid(request: SendRequest, afterTrigger = false): Promise<OutputValidity> {
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
    const userWaitId = waitNoticeId(request.purpose);
    if (userWaitId !== undefined) {
      const gated = await tasks.withTaskOutput({ ...subject, userWaitId }, task =>
        validTask(request, task, afterTrigger)
      );
      return gated?.value ?? false;
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
    return validTask(request, task, afterTrigger);
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
      if (
        (dispatch.status === 'delivered' || dispatch.status === 'send_unconfirmed') &&
        dispatch.resultAt === null
      )
        throw new Error('最终发送结果缺少真实判定时刻，不能恢复上下文空闲起点');
      const task = await tasks.getTask(request.subject.taskId);
      if (
        task &&
        task.inputVersion === request.subject.inputVersion &&
        (task.status === 'ready_to_send' || task.status === 'sending')
      ) {
        const effective = await valid(request, true);
        let to: 'completed' | 'failed' | 'send_unconfirmed' | 'cancelled' | 'timed_out';
        if (effective !== true || dispatch.status === 'cancelled') {
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
          ...(to === 'completed' || to === 'send_unconfirmed'
            ? { idleSince: dispatch.resultAt! }
            : {}),
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
    result: SendResult,
    observedAt = Date.now()
  ): Promise<SendDispatch> {
    checkOpen();
    if (!result.status || (result.status === 'delivered' && !result.messageId)) {
      throw new AppError('driver', {
        cause: new Error('带 operationId 的 Driver 结果缺少发送状态或送达编号'),
      });
    }
    // 原生送达证据仍由 Driver 保存；失效任务的协调结果不能成为可采用的 delivered。
    const status =
      (await valid(request, true)) === true
        ? statusAfterObservation(result.status, dispatch)
        : 'cancelled';
    const saved = await change(dispatch, {
      status,
      messageId: result.messageId ?? null,
      resultAt: isDispatchTerminal(status) ? observedAt : null,
    });
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

  async function adoptStoredDelivery(
    request: SendRequest,
    dispatch: SendDispatch
  ): Promise<SendDispatch | null> {
    // 读取既有送达事实不消耗 Driver 查询机会，也不能因恢复中断而刷新原时间。
    const priorEvidence = await options.driverStore.get(dispatch.operationId);
    if (priorEvidence?.status === 'delivered') {
      return observe(
        request,
        dispatch,
        {
          success: true,
          status: 'delivered',
          operationId: priorEvidence.operationId,
          messageId: priorEvidence.messageId,
        },
        priorEvidence.updatedAt
      );
    }
    return null;
  }

  async function query(request: SendRequest, dispatch: SendDispatch): Promise<SendDispatch> {
    const delivered = await adoptStoredDelivery(request, dispatch);
    if (delivered) return delivered;
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
    if (remaining > 0) {
      await delay(remaining, undefined, { signal: shutdown.signal });
      // 等待期间旧调用仍可能保存回执；查询前不能继续使用等待前的未知快照。
      const deliveredWhileWaiting = await adoptStoredDelivery(request, dispatch);
      if (deliveredWhileWaiting) return deliveredWhileWaiting;
    }
    checkOpen();
    if ((await valid(request, true)) !== true) {
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

  async function sendOnce(request: SendRequest, dispatch: SendDispatch): Promise<SendStep> {
    const effective = await valid(request, dispatch.sendCalls > 0);
    if (effective === 'paused') return { dispatch, stopped: true, paused: true };
    if (!effective) {
      const saved = await change(dispatch, { status: 'cancelled' });
      return { dispatch: saved ?? (await current(dispatch)), stopped: true };
    }
    const claimed = await change(dispatch, {
      status: 'sending',
      sendCalls: dispatch.sendCalls + 1,
      queryDueAt: dispatch.queryDueAt ?? Date.now() + SEND_QUERY_WAIT_MS,
    });
    if (!claimed) return { dispatch: await current(dispatch), stopped: true };
    await enterSending(request);
    // 只在锁内同步交付 Driver；回执和数据库提交分别等待，不让旧调用阻塞 /new。
    const output = (): SendHandoff => {
      checkOpen();
      try {
        return {
          result: driver
            .sendText(request.text, {
              operationId: claimed.operationId,
              targetSessionId: claimed.sessionId,
            })
            .then(
              result => ({ result, observedAt: Date.now() }),
              cause => ({ error: new AppError('driver', { cause }) })
            ),
        };
      } catch (cause) {
        throw new AppError('driver', { cause });
      }
    };
    const subject = request.subject;
    let triggered: SendHandoff | null | undefined;
    let paused = false;
    if (subject.kind === 'task') {
      const gated = await tasks.withTaskOutput(
        { ...subject, userWaitId: waitNoticeId(request.purpose) },
        task => {
          const effective = validTask(request, task, dispatch.sendCalls > 0);
          paused = effective === 'paused';
          return effective === true ? output() : null;
        }
      );
      triggered = gated?.value;
    } else if (subject.threadId) {
      const gated = await contexts.withContextOutput(subject.threadId, context =>
        context.botId === subject.botId && context.sessionId === subject.sessionId ? output() : null
      );
      triggered = gated?.value;
    } else {
      triggered = output();
    }
    if (!triggered) {
      // 仅本活调用在有效交付锁内确认暂停且未调用 Driver，才退还本次占用。
      // 不推测 sending/unknown 崩溃快照，也不退还此前实际调用或查询的预算。
      const saved = await change(
        claimed,
        paused
          ? {
              status: dispatch.status,
              sendCalls: dispatch.sendCalls,
              queryDueAt: dispatch.queryDueAt,
            }
          : { status: 'cancelled' }
      );
      return {
        dispatch: saved ?? (await current(claimed)),
        stopped: true,
        paused: paused && saved !== null,
      };
    }
    const observed = await triggered.result;
    // 异常不证明发送未发生；保留 sending 与已占用预算，显式恢复时只查不盲发。
    if ('error' in observed) throw observed.error;
    return {
      dispatch: await observe(request, claimed, observed.result, observed.observedAt),
      stopped: false,
    };
  }

  async function drive(
    request: SendRequest,
    dispatch: SendDispatch,
    recovering: boolean
  ): Promise<SendOutcome> {
    if (isDispatchTerminal(dispatch.status))
      return { dispatch: await finishTask(request, dispatch) };
    if (
      recovering &&
      (dispatch.status === 'sending' ||
        dispatch.status === 'querying' ||
        (dispatch.status === 'retryable' && !dispatch.queryUsed))
    ) {
      dispatch = await query(request, dispatch);
    } else if (dispatch.status === 'sending' || dispatch.status === 'querying') {
      return { dispatch };
    }
    while (!isDispatchTerminal(dispatch.status)) {
      checkOpen();
      const before = dispatch;
      if (dispatch.status === 'prepared' || dispatch.status === 'retryable') {
        const step = await sendOnce(request, dispatch);
        dispatch = step.dispatch;
        if (step.stopped)
          return { dispatch: await finishTask(request, dispatch), paused: step.paused };
      } else if (dispatch.status === 'unknown') {
        dispatch = await query(request, dispatch);
      } else {
        return { dispatch };
      }
      // CAS 败方不接管胜方的进行中调用，普通重复事件不是进程恢复。
      if (
        dispatch.revision === before.revision ||
        dispatch.status === 'sending' ||
        dispatch.status === 'querying'
      )
        return { dispatch };
    }
    return { dispatch: await finishTask(request, dispatch) };
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
    if (existing) {
      const result = await existing;
      // 恢复请求不能只消费旧暂停结果；旧活调用退出后才重检并推进同一意图。
      // 只有确证暂停才续发，CAS 败方、已触发或未知结果仍由原流程处理。
      if (result.paused && (await valid(request)) === true) return submit(request, recovering);
      return result.dispatch;
    }
    const work = drive(request, dispatch, recovering);
    active.set(dispatch.operationId, work);
    try {
      return (await work).dispatch;
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
