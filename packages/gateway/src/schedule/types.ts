import type { FormattedText } from '@kkbot/driver';
import type { CoordinatorDispatchResult } from '../types/index.js';

/**
 * 主动定时任务定义输入契约
 */
export interface ProactiveScheduleDefinition {
  /** 定时任务唯一标识 (可选，未提供时自动生成) */
  id?: string;
  /** 任务名称 / 业务描述 (如 "每日晨报工单推送") */
  name: string;
  /** 目标推送会话 ID (私聊或群聊) */
  targetSessionId: string;
  /** 目标员工 ID (可选) */
  targetEmployeeId?: string;
  /** 目标员工姓名 (可选) */
  targetEmployeeName?: string;
  /** 标准 Cron 表达式 (如 "0 9 * * *") */
  cron: string;
  /** 提示词或任务指令 */
  prompt?: string;
  /** 动态生成待推送内容的业务处理器 */
  handler?: (
    schedule: ProactiveSchedule
  ) => Promise<string | FormattedText | void> | string | FormattedText | void;
  /** 静态固定推送文案 (当未传入 handler 时使用) */
  message?: string | FormattedText;
  /** 自定义扩展元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 运行时主动定时任务实体 (对应 Mastra Schedules 视图)
 */
export interface ProactiveSchedule {
  /** 定时任务唯一标识 */
  id: string;
  /** 任务名称 */
  name?: string;
  /** 目标推送会话 ID */
  targetSessionId: string;
  /** 目标员工 ID */
  targetEmployeeId?: string;
  /** 目标员工姓名 */
  targetEmployeeName?: string;
  /** Cron 表达式 */
  cron: string;
  /** 提示词 */
  prompt?: string;
  /** 任务状态 */
  status: 'active' | 'paused' | 'running' | 'completed' | 'error';
  /** 下次计划触发时间戳 (毫秒) */
  nextFireAt?: number;
  /** 上次实际触发时间戳 (毫秒) */
  lastRunAt?: number;
  /** 累计执行次数 */
  runCount?: number;
  /** 自定义处理器 */
  handler?: (
    schedule: ProactiveSchedule
  ) => Promise<string | FormattedText | void> | string | FormattedText | void;
  /** 固定推送内容 */
  message?: string | FormattedText;
  /** 元数据 */
  metadata?: Record<string, unknown>;
  /** 创建时间戳 */
  createdAt?: number;
  /** 更新时间戳 */
  updatedAt?: number;
}

/**
 * 定时调度管理器事件定义
 */
export interface ScheduleManagerEvents {
  /** 任务注册事件 */
  registered: (schedule: ProactiveSchedule) => void;
  /** 任务移除事件 */
  unregistered: (scheduleId: string) => void;
  /** 任务触发启动事件 */
  triggered: (schedule: ProactiveSchedule) => void;
  /** 任务执行完毕事件 */
  executed: (schedule: ProactiveSchedule, result: CoordinatorDispatchResult) => void;
  /** 任务执行异常事件 */
  failed: (schedule: ProactiveSchedule, error: Error) => void;
}
