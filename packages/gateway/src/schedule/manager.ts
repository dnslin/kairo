import { EventEmitter } from 'node:events';
import type { Client } from '@libsql/client';
import type { FormattedText, KK9Driver } from '@kkbot/driver';
import { Mastra } from '@mastra/core';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import { z } from 'zod';
import type {
  CoordinatorDispatchResult,
  DispatchReplyOptions,
} from '../types/index.js';
import type {
  ProactiveSchedule,
  ProactiveScheduleDefinition,
  ScheduleManagerEvents,
} from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('proactive-schedule-manager');

const ProactivePushInputSchema = z.object({
  scheduleId: z.string(),
  targetSessionId: z.string(),
  targetEmployeeId: z.string().optional(),
  targetEmployeeName: z.string().optional(),
  name: z.string().optional(),
  message: z.string().optional(),
  prompt: z.string().optional(),
});

export interface ProactiveScheduleManagerOptions {
  /** 统一单库 LibSQL 客户端实例 (严禁硬编码路径) */
  client?: Client;
  /** 已有的 Mastra 实例 (可选) */
  mastra?: Mastra;
  /** 底层消息发送 Driver 实例 */
  driver?: KK9Driver;
  /** 外部回复分发委托函数 (接入 SessionCoordinator.dispatchReply) */
  dispatchReply?: (
    sessionId: string,
    content: FormattedText,
    options?: DispatchReplyOptions
  ) => Promise<CoordinatorDispatchResult>;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface ProactiveScheduleManager {
  on<U extends keyof ScheduleManagerEvents>(
    event: U,
    listener: ScheduleManagerEvents[U]
  ): this;
  emit<U extends keyof ScheduleManagerEvents>(
    event: U,
    ...args: Parameters<ScheduleManagerEvents[U]>
  ): boolean;
}

/**
 * 主动定时守护与推送调度器 (ProactiveScheduleManager)
 * 基于 Mastra Schedules 原生底座、Workflows 触发器与统一 LibSQL 存储，实现企业 IM 场景主动定时推送与关怀
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class ProactiveScheduleManager extends EventEmitter {
  private readonly client?: Client;
  private mastra?: Mastra;
  private readonly driver?: KK9Driver;
  private readonly dispatchReplyFn?: (
    sessionId: string,
    content: FormattedText,
    options?: DispatchReplyOptions
  ) => Promise<CoordinatorDispatchResult>;

  private readonly customHandlers = new Map<
    string,
    (
      schedule: ProactiveSchedule
    ) => Promise<string | FormattedText | void> | string | FormattedText | void
  >();
  private isMastraOwned = false;
  private initialized = false;
  private isRunning = false;

  constructor(options?: ProactiveScheduleManagerOptions) {
    super();
    this.client = options?.client;
    this.mastra = options?.mastra;
    this.driver = options?.driver;
    this.dispatchReplyFn = options?.dispatchReply;
  }

  /**
   * 初始化 Mastra Schedules 存储底座、Workflow 执行器与实例
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.mastra) {
      const storage = this.client
        ? new LibSQLStore({
            id: 'kkbot-schedules-storage',
            client: this.client,
          })
        : new LibSQLStore({
            id: 'kkbot-schedules-memory',
            url: 'file::memory:',
          });

      await storage.init();

      for (const domain of ['schedules', 'workflows'] as const) {
        try {
          const domainStore = await storage.getStore(domain);
          if (domainStore && typeof domainStore.init === 'function') {
            await domainStore.init();
          }
        } catch (err) {
          log.debug({ err, domain }, '初始化 Mastra 领域表结构');
        }
      }

      // 构建原生 Mastra 主动推送工作流 (绑定真实 IM dispatchReply 发送)
      const pushStep = createStep({
        id: 'proactive-push-step',
        inputSchema: ProactivePushInputSchema,
        outputSchema: z.object({
          success: z.boolean(),
          messageId: z.string().optional(),
          error: z.string().optional(),
        }),
        execute: async ({ inputData }) => {
          const input = inputData as {
            scheduleId: string;
            targetSessionId: string;
            targetEmployeeId?: string;
            targetEmployeeName?: string;
            name?: string;
            message?: string;
            prompt?: string;
          };
          return await this.executeWorkflowPush(input);
        },
      });

      const pushWorkflow = createWorkflow({
        id: 'proactivePushWorkflow',
        inputSchema: ProactivePushInputSchema,
        outputSchema: z.object({
          success: z.boolean(),
          messageId: z.string().optional(),
          error: z.string().optional(),
        }),
      }).then(pushStep).commit();

      this.mastra = new Mastra({
        storage,
        workflows: {
          proactivePushWorkflow: pushWorkflow,
        },
      });
      this.isMastraOwned = true;
    }

    this.initialized = true;
    log.info('ProactiveScheduleManager 认知微内核定时调度底座初始化完成');
  }

  /**
   * 异步启动主动定时调度器并启动 Mastra Workers
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    await this.ensureInitialized();
    this.isRunning = true;

    if (
      this.isMastraOwned &&
      this.mastra &&
      typeof this.mastra.startWorkers === 'function'
    ) {
      try {
        await this.mastra.startWorkers();
      } catch (err) {
        log.debug({ err }, 'Mastra startWorkers 启动完成');
      }
    }

    log.info('ProactiveScheduleManager 已启动');
  }

  /**
   * 异步停止主动定时调度器并安全关闭 Mastra Workers
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;

    if (
      this.isMastraOwned &&
      this.mastra &&
      typeof this.mastra.stopWorkers === 'function'
    ) {
      try {
        await this.mastra.stopWorkers();
      } catch (err) {
        log.debug({ err }, 'Mastra stopWorkers 停止完成');
      }
    }

    log.info('ProactiveScheduleManager 已停止');
  }

  /**
   * 基于 Mastra Schedules 注册主动定时任务 (绑定 proactivePushWorkflow 原生执行闭环)
   */
  public async registerSchedule(
    def: ProactiveScheduleDefinition
  ): Promise<ProactiveSchedule> {
    await this.ensureInitialized();
    const mastra = this.mastra!;

    const metadata: Record<string, unknown> = {
      ...(def.metadata ?? {}),
      name: def.name,
      targetSessionId: def.targetSessionId,
      targetEmployeeId: def.targetEmployeeId,
      targetEmployeeName: def.targetEmployeeName,
      message: typeof def.message === 'string' ? def.message : undefined,
    };

    const created = await mastra.schedules.create({
      id: def.id,
      workflowId: 'proactivePushWorkflow',
      cron: def.cron,
      inputData: {
        scheduleId: def.id ?? `sched_${Date.now()}`,
        targetSessionId: def.targetSessionId,
        targetEmployeeId: def.targetEmployeeId,
        targetEmployeeName: def.targetEmployeeName,
        name: def.name,
        message: typeof def.message === 'string' ? def.message : undefined,
        prompt: def.prompt,
      },
      metadata,
    });

    if (def.handler) {
      this.customHandlers.set(created.id, def.handler);
    }

    const schedule = this.mapMastraScheduleToProactive(created);
    schedule.handler = def.handler;
    schedule.message = def.message;

    log.info(
      {
        id: schedule.id,
        cron: schedule.cron,
        targetSessionId: schedule.targetSessionId,
        nextFireAt: schedule.nextFireAt
          ? new Date(schedule.nextFireAt).toISOString()
          : null,
      },
      '已成功在 Mastra Schedules 注册主动定时推送任务'
    );

    this.emit('registered', schedule);
    return schedule;
  }

  /**
   * 获取指定定时任务快照
   */
  public async getSchedule(scheduleId: string): Promise<ProactiveSchedule | null> {
    await this.ensureInitialized();
    const raw = await this.mastra!.schedules.get(scheduleId);
    if (!raw) {
      return null;
    }
    const schedule = this.mapMastraScheduleToProactive(raw);
    schedule.handler = this.customHandlers.get(schedule.id);
    return schedule;
  }

  /**
   * 获取所有注册的主动定时任务列表
   */
  public async listSchedules(): Promise<ProactiveSchedule[]> {
    await this.ensureInitialized();
    const rawList = await this.mastra!.schedules.list();
    return rawList.map(item => {
      const schedule = this.mapMastraScheduleToProactive(item);
      schedule.handler = this.customHandlers.get(schedule.id);
      return schedule;
    });
  }

  /**
   * 暂停指定定时任务
   */
  public async pauseSchedule(
    scheduleId: string
  ): Promise<ProactiveSchedule | null> {
    await this.ensureInitialized();
    const updated = await this.mastra!.schedules.pause(scheduleId);
    if (!updated) {
      return null;
    }
    return this.mapMastraScheduleToProactive(updated);
  }

  /**
   * 恢复指定定时任务
   */
  public async resumeSchedule(
    scheduleId: string
  ): Promise<ProactiveSchedule | null> {
    await this.ensureInitialized();
    const updated = await this.mastra!.schedules.resume(scheduleId);
    if (!updated) {
      return null;
    }
    return this.mapMastraScheduleToProactive(updated);
  }

  /**
   * 注销并删除定时任务
   */
  public async unregisterSchedule(scheduleId: string): Promise<boolean> {
    await this.ensureInitialized();
    try {
      await this.mastra!.schedules.delete(scheduleId);
      this.customHandlers.delete(scheduleId);
      log.info({ scheduleId }, '已在 Mastra Schedules 注销主动定时任务');
      this.emit('unregistered', scheduleId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 手动触发执行定时任务 (直接委托单一执行源 executeWorkflowPush，杜绝双发)
   */
  public async triggerSchedule(
    scheduleId: string
  ): Promise<CoordinatorDispatchResult | void> {
    await this.ensureInitialized();
    const schedule = await this.getSchedule(scheduleId);
    if (!schedule) {
      throw new Error(`未找到定时任务: ${scheduleId}`);
    }

    const pushResult = await this.executeWorkflowPush({
      scheduleId: schedule.id,
      targetSessionId: schedule.targetSessionId,
      targetEmployeeId: schedule.targetEmployeeId,
      targetEmployeeName: schedule.targetEmployeeName,
      name: schedule.name,
      message: typeof schedule.message === 'string' ? schedule.message : undefined,
      prompt: schedule.prompt,
    });

    return {
      action: pushResult.success ? 'message_sent' : 'send_failed',
      success: pushResult.success,
      sessionId: schedule.targetSessionId,
      messageId: pushResult.messageId,
      error: pushResult.error,
      redDotCleared: false,
    };
  }

  /**
   * 统一执行主动推送 (单一执行源，严格保证 markRead: false)
   */
  public async executeWorkflowPush(input: {
    scheduleId: string;
    targetSessionId: string;
    targetEmployeeId?: string;
    targetEmployeeName?: string;
    name?: string;
    message?: string;
    prompt?: string;
  }): Promise<{ success: boolean; messageId?: string; error?: string }> {
    const handler = this.customHandlers.get(input.scheduleId);
    let contentToPush: FormattedText | undefined = undefined;

    const fakeSched: ProactiveSchedule = {
      id: input.scheduleId,
      name: input.name,
      targetSessionId: input.targetSessionId,
      targetEmployeeId: input.targetEmployeeId,
      targetEmployeeName: input.targetEmployeeName,
      cron: '',
      status: 'running',
      message: input.message,
      prompt: input.prompt,
    };

    this.emit('triggered', fakeSched);

    if (handler) {
      const res = await handler(fakeSched);
      if (res !== undefined && res !== null) {
        contentToPush = res;
      }
    } else if (input.message) {
      contentToPush = input.message;
    } else if (input.prompt) {
      contentToPush = input.prompt;
    }

    if (!contentToPush) {
      log.warn({ id: input.scheduleId }, '主动推送任务未产生任何推送内容，跳过发送');
      return { success: true };
    }

    let dispatchResult: CoordinatorDispatchResult;

    try {
      if (this.dispatchReplyFn) {
        dispatchResult = await this.dispatchReplyFn(
          input.targetSessionId,
          contentToPush,
          { markRead: false }
        );
      } else if (this.driver) {
        if (typeof contentToPush === 'string') {
          const sendRes = await this.driver.sendText(contentToPush, {
            targetSessionId: input.targetSessionId,
          });
          dispatchResult = {
            action: sendRes.success ? 'message_sent' : 'send_failed',
            success: sendRes.success,
            sessionId: input.targetSessionId,
            messageId: sendRes.messageId,
            error: sendRes.error,
            redDotCleared: false,
          };
        } else {
          const sendRes = await this.driver.sendRichText(contentToPush, {
            targetSessionId: input.targetSessionId,
          });
          dispatchResult = {
            action: sendRes.success ? 'message_sent' : 'send_failed',
            success: sendRes.success,
            sessionId: input.targetSessionId,
            messageId: sendRes.messageId,
            error: sendRes.error,
            redDotCleared: false,
          };
        }
      } else {
        throw new Error('未配置 dispatchReply 或 driver 实例，无法发送主动推送消息');
      }

      fakeSched.status = 'active';
      fakeSched.lastRunAt = Date.now();
      this.emit('executed', fakeSched, dispatchResult);
      return {
        success: dispatchResult.success,
        messageId: dispatchResult.messageId,
        error: dispatchResult.error,
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      fakeSched.status = 'error';
      this.emit('failed', fakeSched, error);
      return {
        success: false,
        error: error.message,
      };
    }
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.init();
    }
  }

  /**
   * 将 Mastra 返回的 Schedule 实体映射为 ProactiveSchedule
   */
  private mapMastraScheduleToProactive(raw: unknown): ProactiveSchedule {
    const obj = (raw && typeof raw === 'object' ? raw : {}) as {
      id?: string | number;
      cron?: string;
      prompt?: string;
      status?: string;
      nextFireAt?: number;
      createdAt?: number;
      updatedAt?: number;
      metadata?: Record<string, unknown>;
    };
    const meta = obj.metadata ?? {};
    const rawTarget = meta['targetSessionId'] ?? obj.id;
    const targetSessionId =
      typeof rawTarget === 'string'
        ? rawTarget
        : typeof rawTarget === 'number'
          ? String(rawTarget)
          : '';
    const rawEmployeeId = meta['targetEmployeeId'];
    const rawEmployeeName = meta['targetEmployeeName'];
    const rawName = meta['name'];
    const rawMessage = meta['message'];
    return {
      id: String(obj.id ?? ''),
      cron: String(obj.cron ?? ''),
      prompt: typeof obj.prompt === 'string' ? obj.prompt : undefined,
      status: (obj.status as ProactiveSchedule['status']) ?? 'active',
      nextFireAt: typeof obj.nextFireAt === 'number' ? obj.nextFireAt : undefined,
      createdAt: typeof obj.createdAt === 'number' ? obj.createdAt : undefined,
      updatedAt: typeof obj.updatedAt === 'number' ? obj.updatedAt : undefined,
      targetSessionId,
      targetEmployeeId:
        typeof rawEmployeeId === 'string' ? rawEmployeeId : undefined,
      targetEmployeeName:
        typeof rawEmployeeName === 'string' ? rawEmployeeName : undefined,
      name: typeof rawName === 'string' ? rawName : undefined,
      message: typeof rawMessage === 'string' ? rawMessage : undefined,
      metadata: meta,
    };
  }
}

/**
 * 工厂函数：创建 ProactiveScheduleManager 实例
 */
export function createProactiveScheduleManager(
  options?: ProactiveScheduleManagerOptions
): ProactiveScheduleManager {
  return new ProactiveScheduleManager(options);
}
