import type {
  ApprovalNotification,
  ApprovalTask,
  LeaderApprovalRouterOptions,
  OrgRepositoryLike,
} from './types.js';
import { LeaderNotFoundError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('leader-router');

/**
 * 格式化参数对象为可读的摘要文本
 */
export function formatArgsSummary(args: Record<string, unknown>, maxKeys = 5): string {
  const entries = Object.entries(args);
  if (entries.length === 0) {
    return '无参数';
  }
  return entries
    .slice(0, maxKeys)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ');
}

/**
 * 生成多任务消歧引导提示文案纯函数
 */
export function formatDisambiguationPrompt(tasks: ApprovalTask[]): string {
  const lines = [`⚠️ 您当前有 ${tasks.length} 项待处理的审批事项：`];

  tasks.forEach((task, index) => {
    const applicant = task.applicantName ?? task.applicantId;
    const argsSummary = formatArgsSummary(task.toolArgs, 3);
    lines.push(`${index + 1}. 【${applicant}】${task.toolName} - ${argsSummary}`);
  });

  lines.push('———————————————');
  lines.push(
    '👉 请回复【同意 编号】或【拒绝 编号】（例如：回复「同意 1」或「拒绝 2」进行精确决议）。'
  );

  return lines.join('\n');
}

/**
 * 直属主管审批主动路由解析器 (LeaderApprovalRouter)
 *
 * 核心功能：
 * 1. 结合 OrgRepository 组织架构汇报链，自动解析申请人的直属领导 (leaderId)；
 * 2. 生成向主管私聊主动推送的高危工具审批卡片与通知文案；
 * 3. 生成多任务消歧引导提示文案。
 */
export class LeaderApprovalRouter {
  private readonly orgRepository: OrgRepositoryLike;
  private readonly fallbackLeaderId?: string;
  private readonly fallbackLeaderName?: string;

  constructor(options: LeaderApprovalRouterOptions) {
    this.orgRepository = options.orgRepository;
    this.fallbackLeaderId = options.fallbackLeaderId;
    this.fallbackLeaderName = options.fallbackLeaderName;
  }

  /**
   * 解析员工的直属审批主管
   *
   * @param applicantId 申请人员工 UID/ID
   */
  public async resolveLeader(
    applicantId: string
  ): Promise<{ leaderId: string; leaderName?: string }> {
    const empId = String(applicantId).trim();
    log.debug({ empId }, '正在解析员工直属主管...');

    // 1. 查询员工档案
    const employee = await this.orgRepository.getEmployeeById(empId);
    if (!employee) {
      log.warn({ empId }, '未找到申请人员工档案，尝试 fallback');
      if (this.fallbackLeaderId) {
        return {
          leaderId: this.fallbackLeaderId,
          leaderName: this.fallbackLeaderName,
        };
      }
      throw new LeaderNotFoundError(empId);
    }

    // 2. 若直接配置了 leaderId
    if (employee.leaderId && String(employee.leaderId).trim() !== '') {
      const directLeaderId = String(employee.leaderId).trim();
      const leaderEmp = await this.orgRepository.getEmployeeById(directLeaderId);
      return {
        leaderId: directLeaderId,
        leaderName: leaderEmp?.name,
      };
    }

    // 3. 若无直接 leaderId，查询汇报链
    const reportingChain = await this.orgRepository.getReportingChain(empId);
    const upperLeaders = reportingChain.filter(node => String(node.id).trim() !== empId);

    const nearestLeader = upperLeaders[0];
    if (nearestLeader) {
      return {
        leaderId: String(nearestLeader.id),
        leaderName: nearestLeader.name,
      };
    }

    // 4. 若为顶级管理者或无汇报链，使用 fallback 或报错
    if (this.fallbackLeaderId) {
      log.info(
        { empId, fallbackLeaderId: this.fallbackLeaderId },
        '申请人无上级汇报链，降级路由至系统预设管理员'
      );
      return {
        leaderId: this.fallbackLeaderId,
        leaderName: this.fallbackLeaderName,
      };
    }

    throw new LeaderNotFoundError(empId);
  }

  /**
   * 生成向主管私聊主动推送的高危工具审批卡片与通知
   */
  public formatApprovalNotification(task: ApprovalTask): ApprovalNotification {
    const applicantDisplay = task.applicantName
      ? `${task.applicantName} (UID: ${task.applicantId})`
      : `员工 ${task.applicantId}`;
    const timeoutSec = Math.round(task.timeoutMs / 1000);
    const argsSummary = formatArgsSummary(task.toolArgs);

    const text = [
      '🚨【KKBot 人工审批待办】',
      `• 申请员工：${applicantDisplay}`,
      `• 申请操作：高危工具【${task.toolName}】`,
      `• 操作入参：${argsSummary}`,
      `• 有效时限：${timeoutSec} 秒 (超时将自动降级转人工)`,
      '———————————————',
      '👉 请在此私聊窗口中直接回复【同意】或【拒绝】完成审批。',
    ].join('\n');

    return {
      leaderId: task.leaderId,
      text,
      summary: `【审批待办】${applicantDisplay} 申请调用 ${task.toolName}`,
      task,
    };
  }

  /**
   * 生成多任务消歧引导提示文案
   */
  public formatDisambiguationPrompt(tasks: ApprovalTask[]): string {
    return formatDisambiguationPrompt(tasks);
  }
}
