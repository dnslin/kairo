import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Client } from '@libsql/client';
import type {
  ApprovalDecision,
  ApprovalManagerOptions,
  ApprovalStatus,
  ApprovalTask,
  CreateApprovalTaskInput,
  ResolveApprovalTaskInput,
  StartApprovalWorkflowResult,
  ToolExecutionStatus,
} from './types.js';
import {
  APPROVAL_STEP_ID,
  resumeApprovalWorkflow,
  type HitlWorkflow,
} from './workflow.js';
import { initApprovalSchema } from './schema.js';
import { createChildLogger } from '../utils/logger.js';
import {
  ApprovalError,
  ApprovalStateConflictError,
  ApprovalTaskNotFoundError,
  ApprovalUnauthorizedError,
  WorkflowResumeError,
} from '../utils/errors.js';

const log = createChildLogger('approval-manager');

/**
 * 数据库行数据映射为强类型 ApprovalTask 实体
 */
function mapRowToTask(row: Record<string, unknown>): ApprovalTask {
  let toolArgs: Record<string, unknown> = {};
  if (typeof row.tool_args === 'string') {
    try {
      toolArgs = JSON.parse(row.tool_args) as Record<string, unknown>;
    } catch {
      toolArgs = {};
    }
  } else if (row.tool_args && typeof row.tool_args === 'object') {
    toolArgs = row.tool_args as Record<string, unknown>;
  }

  let decision: ApprovalDecision | undefined = undefined;
  if (typeof row.decision === 'string' && row.decision.trim() !== '') {
    try {
      decision = JSON.parse(row.decision) as ApprovalDecision;
    } catch {
      decision = undefined;
    }
  }

  let toolExecutionResult: unknown = undefined;
  if (
    typeof row.tool_execution_result === 'string' &&
    row.tool_execution_result.trim() !== ''
  ) {
    try {
      toolExecutionResult = JSON.parse(row.tool_execution_result);
    } catch {
      toolExecutionResult = row.tool_execution_result;
    }
  }

  return {
    id: String(row.id),
    toolCallId: String(row.tool_call_id),
    toolName: String(row.tool_name),
    toolArgs,
    applicantId: String(row.applicant_id),
    applicantName:
      typeof row.applicant_name === 'string' ? row.applicant_name : undefined,
    leaderId: String(row.leader_id),
    leaderName:
      typeof row.leader_name === 'string' ? row.leader_name : undefined,
    threadId: String(row.thread_id),
    workflowRunId:
      typeof row.workflow_run_id === 'string' ? row.workflow_run_id : undefined,
    workflowStepId:
      typeof row.workflow_step_id === 'string'
        ? row.workflow_step_id
        : undefined,
    workflowResumed: Boolean(row.workflow_resumed),
    toolExecutionStatus:
      (row.tool_execution_status as ToolExecutionStatus) ?? 'not_started',
    toolExecutionResult,
    toolExecutionError:
      typeof row.tool_execution_error === 'string'
        ? row.tool_execution_error
        : undefined,
    status: row.status as ApprovalStatus,
    decision,
    timeoutMs: Number(row.timeout_ms || 60000),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
    resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
  };
}

/**
 * KKBot 双通道 HITL 人工在环审批状态机管理器
 *
 * 核心特性：
 * 1. 纯净 LibSQL 依赖注入：由外部注入已有的 Client 实例，严禁硬编码数据库路径；
 * 2. 深度协同 Mastra Workflow：支持从创建 run 到原生 suspend 挂起，并在决议/超时时自动 resume 恢复执行；
 * 3. 严格决议鉴权与越权拦截：仅允许指定主管、配置的管理员或自定义鉴权回调执行决议；
 * 4. 强制注入稳定幂等键执行：审批前调用次数严格为 0；批准后向底层工具传递稳定 idempotencyKey；
 * 5. 进程重启自愈机制 (Self-Healing)：
 *    - 扫描 pending 任务：超期立即结算为 timed_out，未超期依据剩余时间重建定时器；
 *    - 扫描 unresumed 任务：利用 getWorkflowRunById 幂等探测，已处于终态直接标记，悬挂状态重试恢复。
 */
export class ApprovalManager extends EventEmitter {
  private readonly client: Client;
  private readonly workflow?: HitlWorkflow;
  private readonly adminUserIds: Set<string>;
  private readonly authorizeDecider?: (
    task: ApprovalTask,
    deciderId: string
  ) => boolean | Promise<boolean>;
  private readonly toolExecutor?: (
    toolName: string,
    toolArgs: Record<string, unknown>,
    context: {
      approvalTaskId: string;
      idempotencyKey: string;
      threadId: string;
      applicantId: string;
    }
  ) => Promise<unknown>;
  private readonly defaultTimeoutMs: number;
  private readonly fallbackDegradeMessage: string;
  private readonly activeTimers = new Map<string, NodeJS.Timeout>();
  private initialized = false;

  constructor(options: ApprovalManagerOptions) {
    super();
    if (!options.client) {
      throw new ApprovalError(
        'ApprovalManager 初始化失败: 必须提供有效的 LibSQL Client 实例'
      );
    }
    this.client = options.client;
    this.workflow = options.workflow;
    this.adminUserIds =
      options.adminUserIds instanceof Set
        ? options.adminUserIds
        : new Set(options.adminUserIds ?? []);
    this.authorizeDecider = options.authorizeDecider;
    this.toolExecutor = options.toolExecutor;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 60000;
    this.fallbackDegradeMessage =
      options.fallbackDegradeMessage ??
      '业务涉及敏感权限，审批超时已为您转人工客服处理';
  }

  /**
   * 初始化数据库 Schema 并执行进程重启自愈扫描
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    log.debug('正在初始化 ApprovalManager 并自愈挂起任务...');
    await initApprovalSchema(this.client);
    await this.recoverPendingTasks();
    await this.recoverUnresumedWorkflows();
    this.initialized = true;
    log.info('ApprovalManager 初始化与自愈扫描完成');
  }

  /**
   * 进程重启自愈扫描：待办任务超期结算与定时器恢复
   */
  private async recoverPendingTasks(): Promise<void> {
    const result = await this.client.execute({
      sql: `SELECT * FROM approval_tasks WHERE status = 'pending' ORDER BY created_at ASC`,
      args: [],
    });

    const now = Date.now();
    let expiredCount = 0;
    let timerRestoredCount = 0;

    for (const rawRow of result.rows) {
      const task = mapRowToTask(rawRow as unknown as Record<string, unknown>);

      if (task.expiresAt <= now) {
        log.warn(
          { taskId: task.id, expiresAt: task.expiresAt, now },
          '进程重启检测到在离线期间已超时的审批任务，立即执行结算'
        );
        await this.timeoutTask(task.id, now);
        expiredCount++;
      } else {
        const remainingMs = task.expiresAt - now;
        log.info(
          { taskId: task.id, remainingMs },
          '进程重启检测到有效的待办审批任务，重建剩余超时定时器'
        );
        this.scheduleTimeout(task.id, remainingMs);
        timerRestoredCount++;
      }
    }

    log.info(
      { total: result.rows.length, expiredCount, timerRestoredCount },
      '挂起待办任务自愈扫描完成'
    );
  }

  /**
   * 进程重启自愈扫描：自动重试恢复此前决议后未成功 resume 的 Mastra Workflow
   * 先用 getWorkflowRunById 探测状态，杜绝已完成任务重复 resume 报错
   */
  private async recoverUnresumedWorkflows(): Promise<void> {
    if (!this.workflow) {
      return;
    }

    const result = await this.client.execute({
      sql: `SELECT * FROM approval_tasks
            WHERE workflow_run_id IS NOT NULL
              AND workflow_resumed = 0
              AND status IN ('approved', 'rejected', 'timed_out')
            ORDER BY created_at ASC`,
      args: [],
    });

    if (result.rows.length === 0) {
      return;
    }

    log.info(
      { count: result.rows.length },
      '检测到未成功恢复执行的遗留工作流，开始自愈重试'
    );

    for (const rawRow of result.rows) {
      const task = mapRowToTask(rawRow as unknown as Record<string, unknown>);
      if (!task.workflowRunId || !task.decision) {
        continue;
      }

      try {
        // 1. 幂等状态探测：查询当前 Run 实际状态
        const runInfo = await this.workflow.getWorkflowRunById(task.workflowRunId);

        if (runInfo && (runInfo.status === 'success' || runInfo.status === 'failed')) {
          log.info(
            { taskId: task.id, runId: task.workflowRunId, status: runInfo.status },
            '检测到底层 Workflow Run 已处于终态，直接补齐 workflow_resumed 标记'
          );
          await this.client.execute({
            sql: `UPDATE approval_tasks SET workflow_resumed = 1 WHERE id = ?`,
            args: [task.id],
          });
          continue;
        }

        let resumeDecision = task.decision;

        // 2. 工具执行状态机与 Workflow 恢复严格穷举对齐 (四态穷举防分叉与防漏执行)：
        if (this.toolExecutor && task.status === 'approved') {
          if (task.toolExecutionStatus === 'failed') {
            resumeDecision = {
              approved: false,
              deciderId: task.decision.deciderId,
              deciderName: task.decision.deciderName,
              reason: `高危工具底层执行失败: ${task.toolExecutionError ?? '执行异常'}`,
              decidedAt: task.decision.decidedAt,
            };
          } else if (
            task.toolExecutionStatus === 'not_started' ||
            task.toolExecutionStatus === 'executing'
          ) {
            try {
              await this.client.execute({
                sql: `UPDATE approval_tasks SET tool_execution_status = 'executing' WHERE id = ?`,
                args: [task.id],
              });

              log.info(
                { taskId: task.id, toolName: task.toolName, status: task.toolExecutionStatus },
                '自愈恢复：按稳定幂等键执行/重试高危工具'
              );

              const execRes = await this.toolExecutor(task.toolName, task.toolArgs, {
                approvalTaskId: task.id,
                idempotencyKey: task.id,
                threadId: task.threadId,
                applicantId: task.applicantId,
              });

              await this.client.execute({
                sql: `UPDATE approval_tasks SET tool_execution_status = 'succeeded', tool_execution_result = ? WHERE id = ?`,
                args: [JSON.stringify(execRes), task.id],
              });

              resumeDecision = { ...task.decision, approved: true };
            } catch (error) {
              const err = error instanceof Error ? error : new Error(String(error));
              await this.client.execute({
                sql: `UPDATE approval_tasks SET tool_execution_status = 'failed', tool_execution_error = ? WHERE id = ?`,
                args: [err.message, task.id],
              });

              resumeDecision = {
                approved: false,
                deciderId: task.decision.deciderId,
                deciderName: task.decision.deciderName,
                reason: `高危工具自愈执行失败: ${err.message}`,
                decidedAt: task.decision.decidedAt,
              };
            }
          } else if (task.toolExecutionStatus === 'succeeded') {
            resumeDecision = { ...task.decision, approved: true };
          }
        }

        // 3. 恢复挂起的 Workflow Run
        await resumeApprovalWorkflow(this.workflow, {
          runId: task.workflowRunId,
          stepId: task.workflowStepId ?? APPROVAL_STEP_ID,
          decision: resumeDecision,
        });

        await this.client.execute({
          sql: `UPDATE approval_tasks SET workflow_resumed = 1 WHERE id = ?`,
          args: [task.id],
        });

        log.info(
          { taskId: task.id, runId: task.workflowRunId, approved: resumeDecision.approved },
          '遗留 Mastra Workflow 自愈恢复成功'
        );
      } catch (error) {
        log.error(
          { err: error, taskId: task.id, runId: task.workflowRunId },
          '遗留 Mastra Workflow 自愈恢复失败'
        );
      }
    }
  }

  /**
   * 启动 Mastra Workflow 挂起流并创建关联的审批待办任务 (端到端一体化调用入口)
   */
  public async startApprovalWorkflow(
    input: CreateApprovalTaskInput
  ): Promise<StartApprovalWorkflowResult> {
    let workflowRunId = input.workflowRunId;
    const workflowStepId = input.workflowStepId ?? APPROVAL_STEP_ID;
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;

    // 若配置了 Workflow，创建并启动 Run 进入原生挂起状态
    if (this.workflow) {
      log.debug(
        { toolName: input.toolName, applicantId: input.applicantId },
        '正在启动 Mastra Workflow 并挂起高危任务...'
      );
      const run = await this.workflow.createRun();
      workflowRunId = run.runId;

      await run.start({
        inputData: {
          toolCallId: input.toolCallId,
          toolName: input.toolName,
          toolArgs: input.toolArgs,
          applicantId: input.applicantId,
          applicantName: input.applicantName,
          leaderId: input.leaderId,
          leaderName: input.leaderName,
          threadId: input.threadId,
          timeoutMs,
        },
      });

      log.info(
        { runId: workflowRunId, toolName: input.toolName },
        'Mastra Workflow 已成功挂起并生成 Run ID'
      );
    }

    // 创建并持久化数据库任务
    const task = await this.createTask({
      ...input,
      workflowRunId,
      workflowStepId,
      timeoutMs,
    });

    return {
      task,
      runId: workflowRunId,
    };
  }

  /**
   * 创建新的高危审批任务
   */
  public async createTask(input: CreateApprovalTaskInput): Promise<ApprovalTask> {
    const id = `appr_${randomUUID().replace(/-/g, '')}`;
    const createdAt = Date.now();
    const timeoutMs = input.timeoutMs ?? this.defaultTimeoutMs;
    const expiresAt = createdAt + timeoutMs;

    const task: ApprovalTask = {
      id,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      toolArgs: input.toolArgs,
      applicantId: input.applicantId,
      applicantName: input.applicantName,
      leaderId: input.leaderId,
      leaderName: input.leaderName,
      threadId: input.threadId,
      workflowRunId: input.workflowRunId,
      workflowStepId: input.workflowStepId,
      workflowResumed: false,
      toolExecutionStatus: 'not_started',
      status: 'pending',
      timeoutMs,
      createdAt,
      expiresAt,
    };

    await this.client.execute({
      sql: `INSERT INTO approval_tasks (
        id, tool_call_id, tool_name, tool_args, applicant_id, applicant_name,
        leader_id, leader_name, thread_id, workflow_run_id, workflow_step_id,
        workflow_resumed, tool_execution_status, tool_execution_result, tool_execution_error,
        status, timeout_ms, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        task.id,
        task.toolCallId,
        task.toolName,
        JSON.stringify(task.toolArgs),
        task.applicantId,
        task.applicantName ?? null,
        task.leaderId,
        task.leaderName ?? null,
        task.threadId,
        task.workflowRunId ?? null,
        task.workflowStepId ?? null,
        0,
        'not_started',
        null,
        null,
        task.status,
        task.timeoutMs,
        task.createdAt,
        task.expiresAt,
      ],
    });

    log.info(
      { taskId: task.id, toolName: task.toolName, leaderId: task.leaderId },
      '高危审批任务已生成并持久化'
    );

    // 调度超时定时器
    this.scheduleTimeout(task.id, timeoutMs);

    // 派发任务创建事件
    this.emit('taskCreated', task);

    return task;
  }

  /**
   * 按 ID 获取审批任务详情
   */
  public async getTaskById(id: string): Promise<ApprovalTask | null> {
    const result = await this.client.execute({
      sql: `SELECT * FROM approval_tasks WHERE id = ?`,
      args: [id],
    });

    if (result.rows.length === 0) {
      return null;
    }

    return mapRowToTask(result.rows[0] as unknown as Record<string, unknown>);
  }

  /**
   * 查询指定主管当前所有的 pending 待处理任务 (按创建时间升序排列)
   */
  public async getPendingTasksByLeaderId(leaderId: string): Promise<ApprovalTask[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM approval_tasks WHERE leader_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      args: [leaderId],
    });

    return result.rows.map(row =>
      mapRowToTask(row as unknown as Record<string, unknown>)
    );
  }

  /**
   * 查询指定会话 Thread 下的所有 pending 待处理任务
   */
  public async getPendingTasksByThreadId(threadId: string): Promise<ApprovalTask[]> {
    const result = await this.client.execute({
      sql: `SELECT * FROM approval_tasks WHERE thread_id = ? AND status = 'pending' ORDER BY created_at ASC`,
      args: [threadId],
    });

    return result.rows.map(row =>
      mapRowToTask(row as unknown as Record<string, unknown>)
    );
  }

  /**
   * 原子消费已批准的任务执行权 (防篡改、防重放、严格互斥校验)
   */
  public async consumeApprovedTask(
    taskId: string,
    expected: {
      toolName: string;
      toolArgs: Record<string, unknown>;
    }
  ): Promise<{ task: ApprovalTask; alreadyExecuted: boolean }> {
    const task = await this.getTaskById(taskId);
    if (!task) {
      throw new ApprovalTaskNotFoundError(taskId);
    }

    if (task.status !== 'approved') {
      throw new ApprovalStateConflictError(
        taskId,
        `任务状态为 ${task.status}，未获审批通过`
      );
    }

    // 1. 校验工具名称一致性
    if (task.toolName !== expected.toolName) {
      throw new ApprovalError(
        `高危工具授权防篡改校验失败: 审批工具为 "${task.toolName}"，实际调用为 "${expected.toolName}"`
      );
    }

    // 2. 深度校验工具参数一致性 (防参数篡改)
    const taskArgsStr = JSON.stringify(task.toolArgs);
    const expectedArgsStr = JSON.stringify(expected.toolArgs);
    if (taskArgsStr !== expectedArgsStr) {
      throw new ApprovalError(
        `高危工具授权防篡改校验失败: 传入参数与主管审批通过的参数不一致`
      );
    }

    // 3. 若已经执行成功过，直接返回已持久化的结果并标记 alreadyExecuted = true (防重复产生副作用)
    if (task.toolExecutionStatus === 'succeeded') {
      log.info(
        { taskId, toolName: task.toolName },
        '任务此前已成功执行，返回已持久化的执行结果'
      );
      return { task, alreadyExecuted: true };
    }

    // 4. 若已被其他进程抢占执行中，坚决拒绝并发执行 (严格排他互斥)
    if (task.toolExecutionStatus === 'executing') {
      throw new ApprovalError(
        `高危任务 ${taskId} 当前正在由其他进程执行中，拒绝并发重复执行`
      );
    }

    // 5. 严格 CAS 抢占执行锁 (必须 rowsAffected === 1)
    const claimRes = await this.client.execute({
      sql: `UPDATE approval_tasks
            SET tool_execution_status = 'executing'
            WHERE id = ? AND tool_execution_status = 'not_started' AND status = 'approved'`,
      args: [taskId],
    });

    if (claimRes.rowsAffected === 0) {
      throw new ApprovalError(`高危任务 ${taskId} 执行权抢占失败 (已被处理或状态已变更)`);
    }

    return { task: { ...task, toolExecutionStatus: 'executing' }, alreadyExecuted: false };
  }

  /**
   * 记录工具执行成功结果 (条件更新：仅允许处于 executing 状态的持有者更新)
   */
  public async recordToolExecutionResult(
    taskId: string,
    result: unknown
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE approval_tasks
            SET tool_execution_status = 'succeeded', tool_execution_result = ?
            WHERE id = ? AND tool_execution_status = 'executing'`,
      args: [JSON.stringify(result), taskId],
    });
  }

  /**
   * 记录工具执行失败信息 (条件更新：仅允许处于 executing 状态的持有者更新)
   */
  public async recordToolExecutionError(
    taskId: string,
    error: string
  ): Promise<void> {
    await this.client.execute({
      sql: `UPDATE approval_tasks
            SET tool_execution_status = 'failed', tool_execution_error = ?
            WHERE id = ? AND tool_execution_status = 'executing'`,
      args: [error, taskId],
    });
  }

  /**
   * 主管或管理员决议审批任务 (批准/驳回)，并自动恢复关联的 Mastra Workflow Run
   */
  public async resolveTask(input: ResolveApprovalTaskInput): Promise<ApprovalTask> {
    const task = await this.getTaskById(input.taskId);
    if (!task) {
      throw new ApprovalTaskNotFoundError(input.taskId);
    }

    if (task.status !== 'pending') {
      throw new ApprovalStateConflictError(input.taskId, task.status);
    }

    // 1. 决议鉴权：必须为指定主管、管理员或通过授权回调
    const isLeader = input.deciderId === task.leaderId;
    const isAdmin = this.adminUserIds.has(input.deciderId);
    let isCustomAuthorized = false;
    if (this.authorizeDecider) {
      isCustomAuthorized = await this.authorizeDecider(task, input.deciderId);
    }

    if (!isLeader && !isAdmin && !isCustomAuthorized) {
      log.warn(
        {
          taskId: input.taskId,
          deciderId: input.deciderId,
          leaderId: task.leaderId,
        },
        '非主管且无管理员权限的用户尝试决议审批任务，已拒绝并拦截越权操作'
      );
      throw new ApprovalUnauthorizedError(input.taskId, input.deciderId);
    }

    // 清除超时定时器
    this.clearTimer(input.taskId);

    const now = Date.now();
    const status: ApprovalStatus = input.approved ? 'approved' : 'rejected';
    const decision: ApprovalDecision = {
      approved: input.approved,
      deciderId: input.deciderId,
      deciderName: input.deciderName,
      reason: input.reason,
      decidedAt: now,
    };

    // 2. CAS 更新任务状态与决议数据
    const updateRes = await this.client.execute({
      sql: `UPDATE approval_tasks
            SET status = ?, decision = ?, resolved_at = ?
            WHERE id = ? AND status = 'pending'`,
      args: [status, JSON.stringify(decision), now, input.taskId],
    });

    if (updateRes.rowsAffected === 0) {
      throw new ApprovalStateConflictError(input.taskId, 'concurrent_modified');
    }

    let toolExecutionStatus: ToolExecutionStatus = task.toolExecutionStatus ?? 'not_started';
    let toolExecutionResult = task.toolExecutionResult;
    let toolExecutionError: string | undefined = undefined;

    // 3. 若批准执行且配置了 toolExecutor：基于 taskId 幂等键执行
    if (input.approved && this.toolExecutor) {
      // CAS 抢占执行锁
      const claimRes = await this.client.execute({
        sql: `UPDATE approval_tasks
              SET tool_execution_status = 'executing'
              WHERE id = ? AND tool_execution_status = 'not_started'`,
        args: [task.id],
      });

      if (claimRes.rowsAffected > 0 || task.toolExecutionStatus === 'executing') {
        try {
          log.info(
            { taskId: task.id, toolName: task.toolName, idempotencyKey: task.id },
            '审批批准，开始调用高危底层工具 (传递稳定 idempotencyKey)'
          );
          toolExecutionResult = await this.toolExecutor(
            task.toolName,
            task.toolArgs,
            {
              approvalTaskId: task.id,
              idempotencyKey: task.id,
              threadId: task.threadId,
              applicantId: task.applicantId,
            }
          );
          toolExecutionStatus = 'succeeded';

          await this.client.execute({
            sql: `UPDATE approval_tasks
                  SET tool_execution_status = 'succeeded', tool_execution_result = ?
                  WHERE id = ?`,
            args: [JSON.stringify(toolExecutionResult), task.id],
          });
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          toolExecutionStatus = 'failed';
          toolExecutionError = err.message;
          await this.client.execute({
            sql: `UPDATE approval_tasks
                  SET tool_execution_status = 'failed', tool_execution_error = ?
                  WHERE id = ?`,
            args: [err.message, task.id],
          });
          log.error(
            { err, taskId: task.id, toolName: task.toolName },
            '高危工具执行失败'
          );
          throw error;
        }
      }
    }

    let workflowResumed = false;

    // 4. 若关联了 Mastra Workflow Run 且注入了 Workflow，自动恢复执行
    if (task.workflowRunId && this.workflow) {
      try {
        await resumeApprovalWorkflow(this.workflow, {
          runId: task.workflowRunId,
          stepId: task.workflowStepId ?? APPROVAL_STEP_ID,
          decision,
        });
        workflowResumed = true;
        await this.client.execute({
          sql: `UPDATE approval_tasks SET workflow_resumed = 1 WHERE id = ?`,
          args: [task.id],
        });
        log.info(
          { taskId: task.id, runId: task.workflowRunId },
          '关联的 Mastra Workflow Run 已自动恢复执行'
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.error(
          { err, taskId: task.id, runId: task.workflowRunId },
          '自动恢复 Mastra Workflow Run 异常，保留 workflow_resumed = 0 供自愈'
        );
        throw new WorkflowResumeError(task.workflowRunId, err);
      }
    }

    const updatedTask: ApprovalTask = {
      ...task,
      status,
      decision,
      workflowResumed,
      toolExecutionStatus,
      toolExecutionResult,
      toolExecutionError,
      resolvedAt: now,
    };

    log.info(
      { taskId: updatedTask.id, status, deciderId: input.deciderId },
      '审批任务决议成功'
    );

    // 派发事件
    this.emit(status === 'approved' ? 'taskApproved' : 'taskRejected', updatedTask);
    this.emit('taskResolved', updatedTask);

    return updatedTask;
  }

  /**
   * 触发任务超时结算 (置为 timed_out)，并自动恢复关联的 Mastra Workflow Run 进行安全降级
   */
  public async timeoutTask(taskId: string, resolvedAt = Date.now()): Promise<ApprovalTask | null> {
    this.clearTimer(taskId);

    const task = await this.getTaskById(taskId);
    if (!task || task.status !== 'pending') {
      return null;
    }

    const decision: ApprovalDecision = {
      approved: false,
      deciderId: 'system_timeout',
      reason: this.fallbackDegradeMessage,
      decidedAt: resolvedAt,
    };

    const updateRes = await this.client.execute({
      sql: `UPDATE approval_tasks
            SET status = 'timed_out', decision = ?, resolved_at = ?
            WHERE id = ? AND status = 'pending'`,
      args: [JSON.stringify(decision), resolvedAt, taskId],
    });

    if (updateRes.rowsAffected === 0) {
      return null;
    }

    let workflowResumed = false;

    // 若关联了 Mastra Workflow Run 且注入了 Workflow，自动恢复执行以传递超时状态
    if (task.workflowRunId && this.workflow) {
      try {
        await resumeApprovalWorkflow(this.workflow, {
          runId: task.workflowRunId,
          stepId: task.workflowStepId ?? APPROVAL_STEP_ID,
          decision,
        });
        workflowResumed = true;
        await this.client.execute({
          sql: `UPDATE approval_tasks SET workflow_resumed = 1 WHERE id = ?`,
          args: [taskId],
        });
        log.info(
          { taskId: task.id, runId: task.workflowRunId },
          '超时降级已自动恢复关联的 Mastra Workflow Run'
        );
      } catch (error) {
        log.error(
          { err: error, taskId: task.id, runId: task.workflowRunId },
          '超时降级恢复 Mastra Workflow Run 异常，保留 workflow_resumed = 0 供自愈'
        );
      }
    }

    const updatedTask: ApprovalTask = {
      ...task,
      status: 'timed_out',
      decision,
      workflowResumed,
      resolvedAt,
    };

    log.warn(
      { taskId, leaderId: task.leaderId, toolName: task.toolName },
      '审批任务超时未决，已自动结算为 timed_out 并触发安全降级'
    );

    this.emit('taskTimedOut', updatedTask);
    this.emit('taskResolved', updatedTask);

    return updatedTask;
  }

  /**
   * 获取安全降级话术
   */
  public getTimeoutDegradeMessage(): string {
    return this.fallbackDegradeMessage;
  }

  /**
   * 设置并管理内存超时定时器
   */
  private scheduleTimeout(taskId: string, delayMs: number): void {
    this.clearTimer(taskId);

    const timer = setTimeout(() => {
      void (async () => {
        try {
          await this.timeoutTask(taskId);
        } catch (error) {
          log.error({ err: error, taskId }, '定时器执行任务超时结算失败');
        }
      })();
    }, Math.max(0, delayMs));

    this.activeTimers.set(taskId, timer);
  }

  /**
   * 清除指定任务的超时定时器
   */
  private clearTimer(taskId: string): void {
    const timer = this.activeTimers.get(taskId);
    if (timer) {
      clearTimeout(timer);
      this.activeTimers.delete(taskId);
    }
  }

  /**
   * 关闭管理器，清理所有内存定时器与事件监听
   */
  public async close(): Promise<void> {
    await Promise.resolve();
    for (const timer of this.activeTimers.values()) {
      clearTimeout(timer);
    }
    this.activeTimers.clear();
    this.removeAllListeners();
    this.initialized = false;
    log.info('ApprovalManager 已安全关闭');
  }
}
