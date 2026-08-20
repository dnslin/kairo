import type {
  ApprovalMatcherResult,
  ApprovalTask,
  StatefulApprovalMatcherOptions,
} from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('stateful-matcher');

// 单任务明确审批动词正则 (严格限制为显式确认动词，杜绝日常口语词如 好/可以/行/没问题/ok/yes，防止误批高危操作)
const SINGLE_APPROVE_REGEX =
  /^(?:同意|通过|批准|准了|准|通过审批|同意申请)(?:\s*(?:1|一))?$/i;
const SINGLE_REJECT_REGEX =
  /^(?:拒绝|驳回|不通过|不同意|不批准|否决|拒)(?:\s*(?:1|一))?$/i;

// 多任务带编号指令正则 (如 "同意 1", "批准 2", "拒绝 1", "驳回 2")
const MULTI_APPROVE_INDEX_REGEX =
  /^(?:同意|通过|批准|准了|准|通过审批|同意申请)\s*(\d+)$/i;
const MULTI_REJECT_INDEX_REGEX =
  /^(?:拒绝|驳回|不通过|不同意|不批准|否决|拒)\s*(\d+)$/i;

// 多任务无编号泛化审批动词正则 (触发消歧引导)
const GENERIC_APPROVE_REGEX =
  /^(?:同意|通过|批准|准了|准|通过审批|同意申请)$/i;
const GENERIC_REJECT_REGEX =
  /^(?:拒绝|驳回|不通过|不同意|不批准|否决|拒)$/i;

/**
 * 消歧快照项实体
 */
interface DisambiguationSnapshotItem {
  index: number;
  taskId: string;
  task: ApprovalTask;
}

/**
 * 主管消歧上下文快照
 */
interface DisambiguationSnapshot {
  timestamp: number;
  items: DisambiguationSnapshotItem[];
}

/**
 * 默认参数摘要生成器
 */
function defaultFormatArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '无参数';
  return entries
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? `"${v}"` : JSON.stringify(v)}`)
    .join(', ');
}

/**
 * 主管私聊窗口内的状态化自然语言与指令消歧匹配器 (StatefulApprovalMatcher)
 *
 * 核心安全特性：
 * 1. 严格显式动词匹配：只接受“同意/通过/批准/准了/拒绝/驳回/不通过/不同意”等明确审批动词，将“好/可以/行/没问题/收到”等日常对话安全放行；
 * 2. 状态化消歧快照机制 (Stateful Disambiguation Snapshot)：
 *    - 当展示多任务编号列表时，将编号 1..N 与稳定的 taskId 强绑定到主管上下文中；
 *    - 当主管回复“同意 2”时，无论中间是否有其他任务被 Web 审批或超时导致列表重排，始终按快照中的 taskId 结算；
 *    - 决议前实时核验数据库状态，若目标任务已非 pending，返回明确提示，彻底杜绝“索引漂移错批高危操作”！
 */
export class StatefulApprovalMatcher {
  private readonly approvalManager: {
    getPendingTasksByLeaderId(leaderId: string): Promise<ApprovalTask[]>;
    getTaskById(id: string): Promise<ApprovalTask | null>;
  };
  private readonly router?: {
    formatDisambiguationPrompt(tasks: ApprovalTask[]): string;
  };
  private readonly snapshotTtlMs: number;
  // 主管 UID -> 状态化消歧快照
  private readonly snapshots = new Map<string, DisambiguationSnapshot>();

  constructor(
    options: StatefulApprovalMatcherOptions & { snapshotTtlMs?: number }
  ) {
    this.approvalManager = options.approvalManager;
    this.router = options.router;
    this.snapshotTtlMs = options.snapshotTtlMs ?? 300000; // 默认快照保留 5 分钟
  }

  /**
   * 匹配主管输入的消息，判定是否为审批指令并执行状态化消歧
   *
   * @param leaderId 主管 UID
   * @param inputMessage 主管在私聊窗口输入的文本
   */
  public async match(
    leaderId: string,
    inputMessage: string
  ): Promise<ApprovalMatcherResult> {
    const rawInput = inputMessage.trim();
    if (!rawInput) {
      return { matched: false, rawInput: inputMessage };
    }

    const pendingTasks = await this.approvalManager.getPendingTasksByLeaderId(
      leaderId
    );

    // 1. 检查是否存在带编号的审批指令 (如 "同意 1", "拒绝 2")
    const approveMatch = rawInput.match(MULTI_APPROVE_INDEX_REGEX);
    const rejectMatch = rawInput.match(MULTI_REJECT_INDEX_REGEX);

    const matchObj = approveMatch || rejectMatch;
    if (matchObj && matchObj[1]) {
      const isApprove = Boolean(approveMatch);
      const targetIndex = parseInt(matchObj[1], 10);

      return this.handleIndexedApproval(
        leaderId,
        targetIndex,
        isApprove,
        inputMessage,
        pendingTasks
      );
    }

    // 2. 若无待办任务，且非带编号指令，放行正常对话
    if (pendingTasks.length === 0) {
      return { matched: false, rawInput: inputMessage };
    }

    // 3. 单笔待办任务场景 (且未输入编号)
    if (pendingTasks.length === 1) {
      const task = pendingTasks[0];
      if (!task) {
        return { matched: false, rawInput: inputMessage };
      }
      if (SINGLE_APPROVE_REGEX.test(rawInput)) {
        log.info(
          { leaderId, taskId: task.id, rawInput },
          '单笔待办匹配到显式同意指令'
        );
        this.clearSnapshot(leaderId);
        return {
          matched: true,
          action: 'approve',
          task,
          rawInput: inputMessage,
        };
      }

      if (SINGLE_REJECT_REGEX.test(rawInput)) {
        log.info(
          { leaderId, taskId: task.id, rawInput },
          '单笔待办匹配到显式拒绝指令'
        );
        this.clearSnapshot(leaderId);
        return {
          matched: true,
          action: 'reject',
          task,
          rawInput: inputMessage,
        };
      }

      return { matched: false, rawInput: inputMessage };
    }

    // 4. 多笔待办任务场景 (>= 2 笔，输入了无编号的泛化审批词)
    if (
      GENERIC_APPROVE_REGEX.test(rawInput) ||
      GENERIC_REJECT_REGEX.test(rawInput)
    ) {
      log.info(
        { leaderId, pendingCount: pendingTasks.length, rawInput },
        '多任务收到泛化审批词，生成并记录状态化消歧快照'
      );

      // 记录状态化消歧快照，将 index (1..N) 与稳定的 taskId 强绑定
      this.saveDisambiguationSnapshot(leaderId, pendingTasks);

      const promptMessage = this.router
        ? this.router.formatDisambiguationPrompt(pendingTasks)
        : this.formatDefaultDisambiguation(pendingTasks);

      return {
        matched: true,
        action: 'needs_disambiguation',
        promptMessage,
        rawInput: inputMessage,
      };
    }

    // 5. 普通日常对话放行
    return { matched: false, rawInput: inputMessage };
  }

  /**
   * 处理带编号的审批指令，结合消歧快照防错批
   */
  private async handleIndexedApproval(
    leaderId: string,
    index: number,
    isApprove: boolean,
    rawInput: string,
    currentPendingTasks: ApprovalTask[]
  ): Promise<ApprovalMatcherResult> {
    const now = Date.now();
    const snapshot = this.snapshots.get(leaderId);
    let targetTaskId: string | null = null;
    let fallbackTask: ApprovalTask | undefined = undefined;

    // 1. 高危审批 Fail-Closed：若无有效消歧快照（如重启后或 TTL 过期），绝不猜测索引，必须重新提示列表并生成新快照
    if (!snapshot || now - snapshot.timestamp > this.snapshotTtlMs) {
      log.warn(
        { leaderId, index, hasSnapshot: Boolean(snapshot) },
        '带编号审批指令无有效消歧快照 (重启或已过期)，触发 Fail-Closed 重新生成待办快照'
      );
      this.saveDisambiguationSnapshot(leaderId, currentPendingTasks);
      const promptMessage = this.router
        ? this.router.formatDisambiguationPrompt(currentPendingTasks)
        : this.formatDefaultDisambiguation(currentPendingTasks);

      return {
        matched: true,
        action: 'needs_disambiguation',
        promptMessage: `⚠️ 未检测到有效的审批待办上下文（可能已过期或系统已重启），已为您重新生成最新待办列表：\n${promptMessage}`,
        rawInput,
      };
    }

    // 2. 存在有效快照时，根据快照查找绑定的稳定 taskId
    const item = snapshot.items.find(it => it.index === index);
    if (!item) {
      log.warn(
        { leaderId, index, snapshotTotal: snapshot.items.length },
        '带编号指令在消歧快照中超出范围'
      );
      return {
        matched: true,
        action: 'disambiguation_error',
        promptMessage: `输入的审批编号不存在，请从 1 到 ${snapshot.items.length} 中选择编号进行回复。`,
        rawInput,
      };
    }
    targetTaskId = item.taskId;
    fallbackTask = item.task;
    // 2. 实时核验目标任务在数据库中的最新状态，杜绝由于外部审批或超时导致的错批
    const realTask = await this.approvalManager.getTaskById(targetTaskId);
    if (!realTask || realTask.status !== 'pending') {
      log.warn(
        { leaderId, targetTaskId, realStatus: realTask?.status },
        '目标审批任务已被外部处理或已超时，阻断执行并提醒主管'
      );
      return {
        matched: true,
        action: 'disambiguation_error',
        promptMessage: `您选择的第 ${index} 项审批事项（${fallbackTask?.toolName ?? '高危操作'}）已被处理或已超时，请重新核对。`,
        rawInput,
      };
    }

    log.info(
      { leaderId, taskId: realTask.id, index, isApprove },
      '状态化消歧精准命中有效任务'
    );

    return {
      matched: true,
      action: isApprove ? 'approve' : 'reject',
      task: realTask,
      rawInput,
    };
  }

  /**
   * 保存主管的多任务消歧快照
   */
  public saveDisambiguationSnapshot(
    leaderId: string,
    tasks: ApprovalTask[]
  ): void {
    const items: DisambiguationSnapshotItem[] = tasks.map((task, idx) => ({
      index: idx + 1,
      taskId: task.id,
      task,
    }));

    this.snapshots.set(leaderId, {
      timestamp: Date.now(),
      items,
    });
  }

  /**
   * 清除指定主管的消歧快照
   */
  public clearSnapshot(leaderId: string): void {
    this.snapshots.delete(leaderId);
  }

  /**
   * 默认多任务消歧引导提示生成器
   */
  private formatDefaultDisambiguation(tasks: ApprovalTask[]): string {
    const lines = [`⚠️ 您当前有 ${tasks.length} 项待处理的审批事项：`];

    tasks.forEach((task, index) => {
      const applicant = task.applicantName ?? task.applicantId;
      const argsSummary = defaultFormatArgs(task.toolArgs);
      lines.push(`${index + 1}. 【${applicant}】${task.toolName} - ${argsSummary}`);
    });

    lines.push('———————————————');
    lines.push(
      '👉 请回复【同意 编号】或【拒绝 编号】（例如：回复「同意 1」或「拒绝 2」进行精确决议）。'
    );

    return lines.join('\n');
  }
}
