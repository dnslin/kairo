import { z } from 'zod';
import { createAgentTool } from '../registry.js';
import type { AgentTool } from '../types.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('tool-register-schedule');

/**
 * 主动定时任务注册工具入参 Schema
 */
export const RegisterProactiveScheduleInputSchema = z.object({
  name: z
    .string()
    .min(1, '任务名称不能为空')
    .describe('定时任务名称或业务描述 (如 "每日晨间工单提醒")'),
  cron: z
    .string()
    .min(5, 'Cron 表达式格式不正确')
    .describe('标准 5 位 Cron 表达式 (如 "0 9 * * *" 表示每天 9 点, "0 17 * * 5" 表示每周五 17 点)'),
  message: z
    .string()
    .min(1, '提醒内容不能为空')
    .describe('到点主动推送给员工的具体提醒文案或工作内容'),
});

export type RegisterProactiveScheduleInput = z.infer<
  typeof RegisterProactiveScheduleInputSchema
>;

/**
 * 主动定时任务注册工具输出契约
 */
export interface RegisterProactiveScheduleOutput {
  success: boolean;
  scheduleId?: string;
  name: string;
  cron: string;
  nextFireAt?: string;
  message?: string;
  error?: string;
}

/**
 * 最小化 ProactiveScheduleManager 契约
 */
export interface ProactiveScheduleManagerLike {
  registerSchedule(def: {
    name: string;
    cron: string;
    targetSessionId: string;
    message?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{
    id: string;
    name?: string;
    cron: string;
    nextFireAt?: number;
    targetSessionId: string;
  }>;
}

/**
 * 创建 register_proactive_schedule 内置工具
 * 支持 LLM 解析员工自然语言意图（如“每天早上 9 点提醒我写周报”）并注册主动定时推送
 */
export function createRegisterProactiveScheduleTool(options: {
  scheduleManager: ProactiveScheduleManagerLike;
}): AgentTool<RegisterProactiveScheduleInput, RegisterProactiveScheduleOutput> {
  const { scheduleManager } = options;

  return createAgentTool<
    RegisterProactiveScheduleInput,
    RegisterProactiveScheduleOutput
  >({
    id: 'register_proactive_schedule',
    description:
      '注册或创建主动定时任务与工作提醒（支持基于 Cron 表达式在指定时间主动私聊推送）。',
    readOnly: false,
    inputSchema: RegisterProactiveScheduleInputSchema,
    execute: async (input, context) => {
      // 安全防线 (Fail-Closed): 严格绑定当前可信交互会话 (context.threadId)，严禁跨会话越权注册
      const targetSessionId = context?.threadId?.trim();

      if (!targetSessionId) {
        log.warn(
          { name: input.name, senderId: context?.senderId },
          '安全拦截: 缺少可信会话上下文 (context.threadId)，拒绝注册定时任务'
        );
        return {
          success: false,
          name: input.name,
          cron: input.cron,
          error: '安全拦截: 缺少可信会话上下文 (context.threadId)，拒绝注册跨会话定时任务',
        };
      }
      log.info(
        {
          name: input.name,
          cron: input.cron,
          targetSessionId,
        },
        'Agent 正在通过 Tool 调用注册主动定时任务'
      );

      try {
        const schedule = await scheduleManager.registerSchedule({
          name: input.name.trim(),
          cron: input.cron.trim(),
          targetSessionId,
          message: input.message.trim(),
          metadata: {
            createdViaTool: true,
            applicantId: context?.senderId,
          },
        });

        return {
          success: true,
          scheduleId: schedule.id,
          name: schedule.name || input.name,
          cron: schedule.cron,
          nextFireAt: schedule.nextFireAt
            ? new Date(schedule.nextFireAt).toISOString()
            : undefined,
          message: `已为您成功创建定时提醒【${schedule.name || input.name}】，触发规则: ${schedule.cron}`,
        };
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log.error({ err, name: input.name, cron: input.cron }, '注册主动定时任务失败');
        return {
          success: false,
          name: input.name,
          cron: input.cron,
          error: errorMsg,
        };
      }
    },
  });
}
