import type { DriverConfig, IKK9Driver, KK9Message, SendOperationStore } from '@kairo/driver';
import type { Pool } from 'pg';
import type { BotConfig } from '../../config/schema.js';
import type { KairoAgent } from '../../mastra/agent.js';
import type { DriverGeneration } from '../im-transport/driver-supervisor.js';
import { PostgresSendDispatchStore } from '../im-transport/postgres-send-dispatch-store.js';
import { PostgresSendOperationStore } from '../im-transport/postgres-send-operation-store.js';
import { createSendService, type SendService } from '../im-transport/send-service.js';
import type { SendDispatch, SendRequest } from '../im-transport/send-policy.js';
import {
  AppError,
  getErrorType,
  getFailureMessage,
  type AppErrorType,
} from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import { createCollector, type Collector } from '../private-chat-core/collector.js';
import { createContextService } from '../private-chat-core/context-service.js';
import { isNewCommand } from '../private-chat-core/control-message.js';
import { createIngress, type IngressResult } from '../private-chat-core/ingress.js';
import { PostgresPrivateChatStore } from '../private-chat-core/store.js';
import { cancelConnectionWork, createRecovery } from '../task-lifecycle/recovery.js';
import { createScheduler } from '../task-lifecycle/scheduler.js';
import { PostgresTaskStore } from '../task-lifecycle/store.js';
import { PostgresKnowledgeRecordStore } from './knowledge-record-store.js';
import { createKnowledgeService } from './knowledge-service.js';

interface ConnectionWork {
  driver: IKK9Driver;
  sender: SendService;
  generation?: DriverGeneration;
  botId?: string;
  collector?: Collector;
  ingress?: (message: KK9Message) => Promise<IngressResult>;
}

export interface EnterpriseRuntime {
  createDriver(config: DriverConfig): IKK9Driver;
  onConnected(driver: IKK9Driver, generation: DriverGeneration, botId: string): Promise<void>;
  onMessage(message: KK9Message, generation: DriverGeneration): Promise<void>;
  onInvalidate(generation: DriverGeneration): Promise<void>;
  dependenciesChanged(): void;
  close(): Promise<void>;
}

/** 唯一生产入口的业务装配；重连只更换连接工作，不重建实际执行名额。 */
export function createEnterpriseRuntime(options: {
  pool: Pool;
  agent: KairoAgent;
  config: BotConfig;
  configDigest: string;
  bootId: string;
  logger: AppLogger;
  dependencyError(): AppErrorType | null;
  createDriver(config: DriverConfig, store: SendOperationStore): IKK9Driver;
}): EnterpriseRuntime {
  const chat = new PostgresPrivateChatStore(options.pool);
  const tasks = new PostgresTaskStore(options.pool);
  const records = new PostgresKnowledgeRecordStore(options.pool);
  const dispatches = new PostgresSendDispatchStore(options.pool);
  const operations = new PostgresSendOperationStore(options.pool);
  const contexts = createContextService({
    store: chat,
    tasks,
    idleMs: options.config.timeouts.contextIdleMs,
  });
  const knowledge = createKnowledgeService({
    agent: options.agent,
    config: options.config,
    bootId: options.bootId,
    chat,
    knowledge: records,
    tasks,
    logger: options.logger,
  });
  let current: ConnectionWork | undefined;
  let recoveryStarted = false;
  let connectedBotId: string | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;
  const dependencyErrors: unknown[] = [];

  function checkGeneration(work: ConnectionWork, generation: DriverGeneration): void {
    generation.signal.throwIfAborted();
    if (closed || current !== work || !generation.isCurrent()) throw new AppError('cancelled');
  }

  async function sendUsing(
    work: ConnectionWork,
    generation: DriverGeneration,
    request: SendRequest,
    recovery = false
  ): Promise<SendDispatch> {
    checkGeneration(work, generation);
    if (request.subject.kind === 'task') {
      const task = await tasks.getTask(request.subject.taskId);
      checkGeneration(work, generation);
      if (
        !task ||
        task.botId !== work.botId ||
        !options.config.employeeAllowlist.includes(task.employeeId)
      )
        throw new AppError('cancelled');
    } else if (request.subject.botId !== work.botId) throw new AppError('identity');
    return knowledge.send(request, work.sender, recovery);
  }

  function send(request: SendRequest, recovery = false): Promise<SendDispatch> {
    // 必须在任何 await 前捕获本次代次，旧检查收尾不得借新 sender 交付。
    const work = current;
    if (!work?.generation) return Promise.reject(new AppError('cancelled'));
    return sendUsing(work, work.generation, request, recovery);
  }

  const sender = {
    send: (request: SendRequest): Promise<SendDispatch> => send(request),
    recover: (request: SendRequest): Promise<SendDispatch> => send(request, true),
  };
  const scheduler = createScheduler({
    get botId() {
      return connectedBotId;
    },
    canExecute: () =>
      current?.generation?.isCurrent() === true && options.dependencyError() === null,
    tasks,
    contexts,
    chat,
    sender,
    execute: input => {
      const error = options.dependencyError();
      if (error) return Promise.reject(new AppError(error));
      return knowledge.execute(input);
    },
    configDigest: options.configDigest,
    concurrency: options.config.concurrency,
    queueMs: options.config.timeouts.queueMs,
    executionMs: options.config.timeouts.executionMs,
    progressMs: options.config.timeouts.progressMs,
    logger: options.logger,
  });

  return {
    dependenciesChanged(): void {
      if (closed || !current?.generation?.isCurrent()) return;
      void scheduler.tick().catch(error => {
        dependencyErrors.push(error);
        options.logger.error({ event: '运行失败', errorType: getErrorType(error, 'storage') });
      });
    },
    createDriver(config): IKK9Driver {
      if (closed) throw new AppError('cancelled');
      let driver!: IKK9Driver;
      const pairedSender = createSendService({
        createDriver(store) {
          driver = options.createDriver(config, store);
          return driver;
        },
        driverStore: operations,
        dispatches,
        tasks,
        contexts: chat,
        logger: options.logger,
      });
      current = { driver, sender: pairedSender };
      return driver;
    },
    async onConnected(driver, generation, botId): Promise<void> {
      const work = current;
      if (!work || work.driver !== driver) throw new AppError('driver');
      if (connectedBotId !== undefined && connectedBotId !== botId) throw new AppError('identity');
      connectedBotId = botId;
      checkGeneration(work, generation);
      work.generation = generation;
      work.botId = botId;
      const connectionSender = {
        send(request: SendRequest): Promise<SendDispatch> {
          checkGeneration(work, generation);
          return sendUsing(work, generation, request);
        },
        recover(request: SendRequest): Promise<SendDispatch> {
          checkGeneration(work, generation);
          return sendUsing(work, generation, request, true);
        },
      };
      const collector = createCollector({
        botId,
        store: chat,
        contexts,
        sender: connectionSender,
        deliverReady: (batch, recovery) => scheduler.enqueue(batch, recovery),
        batching: options.config.batching,
        logger: options.logger,
      });
      work.collector = collector;
      work.ingress = createIngress({
        botId,
        employeeAllowlist: options.config.employeeAllowlist,
        driver,
        store: chat,
        sender: connectionSender,
        logger: options.logger,
      });
      for (const task of await tasks.listActiveTasks()) {
        checkGeneration(work, generation);
        if (task.botId === botId && !options.config.employeeAllowlist.includes(task.employeeId))
          await tasks.transitionTask({
            taskId: task.taskId,
            inputVersion: task.inputVersion,
            from: task.status,
            to: 'cancelled',
            now: Date.now(),
          });
      }
      await knowledge.reconcileDelivered(botId, generation.signal);
      if (!recoveryStarted) {
        recoveryStarted = true;
        await createRecovery({
          botId,
          tasks,
          collector,
          scheduler,
          sender: connectionSender,
          signal: generation.signal,
          logger: options.logger,
        }).recover();
      }
      checkGeneration(work, generation);
      await scheduler.resume(generation.signal);
    },
    async onMessage(message, generation): Promise<void> {
      const work = current;
      if (!work?.ingress || !work.collector || work.generation !== generation) return;
      checkGeneration(work, generation);
      let accepted: IngressResult;
      try {
        accepted = await work.ingress(message);
      } catch (cause) {
        const uid = /^0-([0-9]+)(?![\s\S])/.exec(message.sessionId)?.[1];
        if (
          getErrorType(cause, 'storage') === 'storage' &&
          !generation.signal.aborted &&
          message.direction === 'inbound' &&
          message.sessionType === 'private' &&
          uid &&
          options.config.employeeAllowlist.includes(uid)
        ) {
          try {
            const employee = await work.driver.getEmployeeBySession(message.sessionId);
            if (String(employee?.id) === uid && !generation.signal.aborted) {
              await work.sender.sendStorageFailure(
                { botId: work.botId!, sessionId: message.sessionId, messageId: message.id },
                new AppError('storage', { cause })
              );
            }
          } catch (noticeError) {
            throw new AggregateError([cause, noticeError], '入站存储与故障通知均失败');
          }
        }
        throw cause;
      }
      checkGeneration(work, generation);
      const error = options.dependencyError();
      if (accepted.status === 'accepted' && !isNewCommand(accepted.message) && error) {
        options.logger.warn({
          event: '运行失败',
          sessionId: accepted.message.sessionId,
          status: 'not_ready',
          errorType: error,
        });
        await work.sender.send({
          subject: {
            kind: 'event',
            botId: accepted.botId,
            sessionId: accepted.message.sessionId,
            messageId: accepted.message.messageId,
          },
          purpose: 'notice:dependency_failure',
          text: getFailureMessage(error),
        });
        return;
      }
      await work.collector.accept(accepted);
    },
    onInvalidate(generation): Promise<void> {
      const work = current;
      if (!work || work.driver.getStartupGenerationId() !== generation.id) return Promise.resolve();
      // 同步关闭真实发送门禁；取消账本与聚合收尾不能释放仍未退出的 Agent 名额。
      work.sender.close();
      if (!work.collector || !work.botId) return scheduler.pause();
      return cancelConnectionWork({
        botId: work.botId,
        tasks,
        scheduler,
        collector: work.collector,
        sender: work.sender,
      });
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      current?.sender.close();
      closing = (async (): Promise<void> => {
        const results = await Promise.allSettled([
          scheduler.close(),
          ...(current?.collector ? [current.collector.close()] : []),
        ]);
        const errors = results
          .filter(result => result.status === 'rejected')
          .map(result => result.reason as unknown);
        errors.push(...dependencyErrors);
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) throw new AggregateError(errors, '企业问答工作关闭失败');
      })();
      return closing;
    },
  };
}
