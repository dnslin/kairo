import type { Client } from '@libsql/client';
import type { HitlWorkflow } from './workflow.js';

/**
 * 审批状态流转枚举
 * - pending: 挂起等待审批中 (60s 倒计时)
 * - approved: 主管或管理员已批准
 * - rejected: 主管或管理员已驳回/拒绝
 * - timed_out: 超时未决，触发安全降级转人工
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timed_out';

/**
 * 批准后工具执行状态
 * - not_started: 尚未开始执行
 * - executing: 已 CAS 抢占执行权，正在执行中
 * - succeeded: 工具执行成功，并已持久化返回值
 * - failed: 工具执行失败，并已持久化错误信息
 */
export type ToolExecutionStatus = 'not_started' | 'executing' | 'succeeded' | 'failed';

/**
 * 审批决议实体契约
 */
export interface ApprovalDecision {
  /** 是否批准执行 */
  approved: boolean;
  /** 审批人 UID/ID */
  deciderId: string;
  /** 审批人姓名 (可选) */
  deciderName?: string;
  /** 决议说明或批注理由 (可选) */
  reason?: string;
  /** 决议时间戳 */
  decidedAt: number;
}

/**
 * 结构化审批任务实体契约
 */
export interface ApprovalTask {
  /** 审批任务唯一标识 (格式: appr_uuid) */
  id: string;
  /** 关联的大模型工具调用 ID (call_xxx) */
  toolCallId: string;
  /** 高危工具名称 (如 delete_user, batch_update_config) */
  toolName: string;
  /** 传入高危工具的调用参数 */
  toolArgs: Record<string, unknown>;
  /** 申请人员工 UID/ID */
  applicantId: string;
  /** 申请人员工姓名 (可选) */
  applicantName?: string;
  /** 审批直属主管 UID/ID */
  leaderId: string;
  /** 审批直属主管姓名 (可选) */
  leaderName?: string;
  /** 发起申请的原始会话 Thread ID */
  threadId: string;
  /** 关联的 Mastra Workflow Run ID (可选) */
  workflowRunId?: string;
  /** 关联的 Mastra Workflow Step ID (可选) */
  workflowStepId?: string;
  /** 关联的 Mastra Workflow 是否已被成功恢复执行 (崩溃自愈追踪) */
  workflowResumed?: boolean;
  /** 批准后工具执行状态 */
  toolExecutionStatus?: ToolExecutionStatus;
  /** 批准后执行工具产出的真实结果数据 */
  toolExecutionResult?: unknown;
  /** 批准后执行工具发生的错误描述 (若失败) */
  toolExecutionError?: string;
  /** 当前审批状态 */
  status: ApprovalStatus;
  /** 审批决议结果 (决议后填充) */
  decision?: ApprovalDecision;
  /** 审批倒计时时长 (毫秒，默认 60000ms) */
  timeoutMs: number;
  /** 任务创建时间戳 */
  createdAt: number;
  /** 超时截止时间戳 (createdAt + timeoutMs) */
  expiresAt: number;
  /** 最终结算时间戳 (approved/rejected/timed_out 时记录) */
  resolvedAt?: number;
}

/**
 * 创建审批任务入参结构
 */
export interface CreateApprovalTaskInput {
  /** 关联的大模型工具调用 ID */
  toolCallId: string;
  /** 高危工具名称 */
  toolName: string;
  /** 工具调用入参 */
  toolArgs: Record<string, unknown>;
  /** 申请人员工 UID */
  applicantId: string;
  /** 申请人员工姓名 (可选) */
  applicantName?: string;
  /** 审批直属主管 UID */
  leaderId: string;
  /** 审批直属主管姓名 (可选) */
  leaderName?: string;
  /** 原始会话 ID */
  threadId: string;
  /** 关联的 Mastra Workflow Run ID (可选) */
  workflowRunId?: string;
  /** 关联的 Mastra Workflow Step ID (可选) */
  workflowStepId?: string;
  /** 自定义超时毫秒数 (可选，若不传则使用默认配置) */
  timeoutMs?: number;
}

/**
 * 决议审批任务入参结构
 */
export interface ResolveApprovalTaskInput {
  /** 审批任务 ID */
  taskId: string;
  /** 是否同意批准 */
  approved: boolean;
  /** 审批人 UID */
  deciderId: string;
  /** 审批人姓名 (可选) */
  deciderName?: string;
  /** 批复理由 (可选) */
  reason?: string;
}

/**
 * 启动审批工作流并创建待办任务返回结果
 */
export interface StartApprovalWorkflowResult {
  /** 生成并持久化的审批任务 */
  task: ApprovalTask;
  /** 关联的 Mastra Workflow Run ID (若配置了 workflow 则返回) */
  runId?: string;
}

/**
 * ApprovalManager 初始化配置选项
 */
export interface ApprovalManagerOptions {
  /** 注入的 LibSQL 数据库客户端实例 (必须复用系统连接池，严禁硬编码路径) */
  client: Client;
  /** 关联的 Mastra 原生 HITL 工作流实例 (可选，用于自动触发 suspend 与 resume 恢复流) */
  workflow?: HitlWorkflow;
  /** 允许直接越级审批的管理员 UID 集合 (如 Web 后台管理员/安全管理员) */
  adminUserIds?: string[] | Set<string>;
  /** 自定义决议人鉴权回调 (可选) */
  authorizeDecider?: (task: ApprovalTask, deciderId: string) => boolean | Promise<boolean>;
  /** 批准后自动执行高危工具的处理回调函数 (强制接收包含 idempotencyKey 的 context) */
  toolExecutor?: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: {
      approvalTaskId: string;
      idempotencyKey: string;
      threadId: string;
      applicantId: string;
    }
  ) => Promise<unknown>;
  /** 默认审批超时毫秒数，默认 60000ms (60秒) */
  defaultTimeoutMs?: number;
  /** 超时降级转人工提示话术 */
  fallbackDegradeMessage?: string;
}

/**
 * 组织架构仓库接口最小约束 (适配 @kkbot/store OrgRepository)
 */
export interface OrgRepositoryLike {
  getEmployeeById(id: string | number): Promise<{
    id: string;
    name: string;
    leaderId?: string | null;
    [key: string]: unknown;
  } | null>;
  getReportingChain(employeeId: string | number): Promise<
    Array<{
      id: string;
      name: string;
      leaderId?: string | null;
      [key: string]: unknown;
    }>
  >;
}

/**
 * 直属主管路由配置选项
 */
export interface LeaderApprovalRouterOptions {
  /** 组织架构仓库实例 */
  orgRepository: OrgRepositoryLike;
  /** 当无直属领导时的降级审批人 UID (如系统超级管理员) */
  fallbackLeaderId?: string;
  /** 降级审批人姓名 (可选) */
  fallbackLeaderName?: string;
}

/**
 * 主管私聊审批卡片/通知内容
 */
export interface ApprovalNotification {
  /** 目标主管 UID */
  leaderId: string;
  /** 通知纯文本/富文本内容 */
  text: string;
  /** 结构化摘要信息 */
  summary: string;
  /** 关联的审批任务 */
  task: ApprovalTask;
}

/**
 * 主管审批自然语言消歧匹配动作类型
 * - approve: 明确同意
 * - reject: 明确拒绝
 * - needs_disambiguation: 存在多笔待办，且用户输入了无编号的泛化词（如仅回复“同意”），需要引导编号消歧
 * - disambiguation_error: 输入了超出范围的无效编号（如当前仅 2 笔，输入了“同意 5”）
 */
export type MatcherActionType =
  | 'approve'
  | 'reject'
  | 'needs_disambiguation'
  | 'disambiguation_error';

/**
 * StatefulApprovalMatcher 自然语言与指令匹配结果
 */
export interface ApprovalMatcherResult {
  /** 是否命中审批匹配逻辑 */
  matched: boolean;
  /** 匹配到的决议动作类型 */
  action?: MatcherActionType;
  /** 关联命中的单一审批任务 (在 approve/reject 且无歧义时返回) */
  task?: ApprovalTask;
  /** 需要向主管回复的提示文案 (消歧引导列表或错误提示) */
  promptMessage?: string;
  /** 主管原始输入的文本 */
  rawInput: string;
}

/**
 * StatefulApprovalMatcher 初始化配置选项
 */
export interface StatefulApprovalMatcherOptions {
  /** 审批管理器实例 */
  approvalManager: {
    getPendingTasksByLeaderId(leaderId: string): Promise<ApprovalTask[]>;
    getTaskById(id: string): Promise<ApprovalTask | null>;
  };
  /** 主管路由实例 (可选，用于生成消歧提示文案) */
  router?: {
    formatDisambiguationPrompt(tasks: ApprovalTask[]): string;
  };
}

/**
 * Mastra HITL Workflow 恢复执行入参
 */
export interface ResumeApprovalWorkflowInput {
  /** Mastra Workflow Run ID */
  runId: string;
  /** 挂起的 Step ID (默认 approval-step) */
  stepId?: string;
  /** 决议数据 */
  decision: ApprovalDecision;
}
