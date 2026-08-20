/**
 * @kkbot/driver 业务卡片预设模板库 (Canvas Card Templates)
 *
 * 核心特性：
 * 1. 0 数据库与原生编译依赖，纯函数式组装标准 CardData 结构
 * 2. 覆盖审批决策、监控告警、汇总报告、多选决策等典型企业 IM 场景
 * 3. 内置高品质视觉规范与动态语义主题映射、自适应两列网格与长文本折行排版
 * 4. 自动注入模拟快捷回复指令 (如 '回复 1', '回复 2') 与截止时间提示
 */

import type {
  AlertCardParams,
  AlertSeverity,
  ApprovalCardParams,
  ApprovalRiskLevel,
  CardAction,
  CardData,
  CardField,
  CardTagVariant,
  CardThemeType,
  DecisionCardParams,
  ReportCardParams,
  ReportStatus,
} from '../types/index.js';
import { DriverError } from '../utils/errors.js';

/**
 * 审批风险等级视觉映射配置
 */
interface RiskLevelConfig {
  theme: CardThemeType;
  tagText: string;
  tagVariant: CardTagVariant;
  riskDisplay: string;
  isDanger: boolean;
  isWarning: boolean;
}

const RISK_LEVEL_MAP: Record<ApprovalRiskLevel, RiskLevelConfig> = {
  P1: {
    theme: 'danger',
    tagText: 'P1 极高风险',
    tagVariant: 'danger',
    riskDisplay: '🚨 P1 极高风险',
    isDanger: true,
    isWarning: false,
  },
  P2: {
    theme: 'warning',
    tagText: 'P2 高风险',
    tagVariant: 'warning',
    riskDisplay: '⚠️ P2 高风险',
    isDanger: false,
    isWarning: true,
  },
  P3: {
    theme: 'primary',
    tagText: 'P3 中风险',
    tagVariant: 'primary',
    riskDisplay: '📋 P3 中风险',
    isDanger: false,
    isWarning: false,
  },
  P4: {
    theme: 'info',
    tagText: 'P4 低风险',
    tagVariant: 'info',
    riskDisplay: 'ℹ️ P4 低风险',
    isDanger: false,
    isWarning: false,
  },
};

/**
 * 告警严重级别视觉映射配置
 */
interface SeverityConfig {
  theme: CardThemeType;
  tagText: string;
  tagVariant: CardTagVariant;
  defaultIcon: string;
  severityDisplay: string;
  isDanger: boolean;
  isWarning: boolean;
}

const SEVERITY_MAP: Record<AlertSeverity, SeverityConfig> = {
  critical: {
    theme: 'danger',
    tagText: 'CRITICAL 致命',
    tagVariant: 'danger',
    defaultIcon: '🚨',
    severityDisplay: '🚨 致命 (Critical)',
    isDanger: true,
    isWarning: false,
  },
  high: {
    theme: 'danger',
    tagText: 'HIGH 严重',
    tagVariant: 'danger',
    defaultIcon: '🚨',
    severityDisplay: '🚨 严重 (High)',
    isDanger: true,
    isWarning: false,
  },
  medium: {
    theme: 'warning',
    tagText: 'MEDIUM 警告',
    tagVariant: 'warning',
    defaultIcon: '⚠️',
    severityDisplay: '⚠️ 警告 (Medium)',
    isDanger: false,
    isWarning: true,
  },
  low: {
    theme: 'info',
    tagText: 'LOW 次要',
    tagVariant: 'info',
    defaultIcon: 'ℹ️',
    severityDisplay: 'ℹ️ 次要 (Low)',
    isDanger: false,
    isWarning: false,
  },
  info: {
    theme: 'info',
    tagText: 'INFO 提示',
    tagVariant: 'info',
    defaultIcon: 'ℹ️',
    severityDisplay: 'ℹ️ 提示 (Info)',
    isDanger: false,
    isWarning: false,
  },
};

/**
 * 报告执行状态视觉映射配置
 */
interface ReportStatusConfig {
  theme: CardThemeType;
  tagText: string;
  tagVariant: CardTagVariant;
  defaultIcon: string;
}

const REPORT_STATUS_MAP: Record<ReportStatus, ReportStatusConfig> = {
  success: {
    theme: 'success',
    tagText: 'SUCCESS 成功',
    tagVariant: 'success',
    defaultIcon: '✅',
  },
  warning: {
    theme: 'warning',
    tagText: 'WARNING 告警',
    tagVariant: 'warning',
    defaultIcon: '⚠️',
  },
  failure: {
    theme: 'danger',
    tagText: 'FAILED 失败',
    tagVariant: 'danger',
    defaultIcon: '❌',
  },
  running: {
    theme: 'primary',
    tagText: 'RUNNING 进行中',
    tagVariant: 'primary',
    defaultIcon: '⏳',
  },
};

/**
 * 格式化时间戳为易读日期时间字符串 (YYYY-MM-DD HH:mm:ss)
 */
function formatTimestamp(timestamp?: string | number): string {
  if (!timestamp) {
    const now = new Date();
    return formatDate(now);
  }
  if (typeof timestamp === 'string') {
    return timestamp;
  }
  return formatDate(new Date(timestamp));
}

/**
 * 格式化 Date 对象
 */
function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const seconds = String(d.getSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

/**
 * 辅助函数：根据两个可能存在的可选字段计算双列跨度
 */
function appendPairedFields(
  fields: CardField[],
  field1?: CardField,
  field2?: CardField
): void {
  if (field1 && field2) {
    fields.push({ ...field1, span: 1 }, { ...field2, span: 1 });
  } else if (field1) {
    fields.push({ ...field1, span: 2 });
  } else if (field2) {
    fields.push({ ...field2, span: 2 });
  }
}

/**
 * 构建企业审批决策卡片
 *
 * 根据 P1~P4 风险等级自动映射视觉主题与告警标签，排版申请人/工单属性，并提供同意与拒绝双操作按钮
 *
 * @param params 审批卡片构建参数
 * @returns 标准 CardData 结构
 */
export function createApprovalCard(params: ApprovalCardParams): CardData {
  if (!params || typeof params !== 'object') {
    throw new DriverError('审批卡片参数非法: params 不能为空', 'INVALID_APPROVAL_PARAMS');
  }
  if (!params.applicant || typeof params.applicant !== 'string') {
    throw new DriverError('审批卡片参数非法: applicant 申请人不能为空', 'INVALID_APPROVAL_APPLICANT');
  }
  if (!params.item || typeof params.item !== 'string') {
    throw new DriverError('审批卡片参数非法: item 申请事项不能为空', 'INVALID_APPROVAL_ITEM');
  }

  const riskLevel: ApprovalRiskLevel = params.riskLevel || 'P3';
  const riskConfig = RISK_LEVEL_MAP[riskLevel] || RISK_LEVEL_MAP.P3;

  // 组装结构化字段列表 (两列属性与全宽事项)
  const fields: CardField[] = [];

  if (params.orderNo) {
    fields.push({ label: '工单编号', value: params.orderNo, span: 1 });
  }

  fields.push({ label: '申请人', value: params.applicant, span: 1 });

  if (params.department) {
    fields.push({ label: '所属部门', value: params.department, span: 1 });
  }

  fields.push({
    label: '风险等级',
    value: riskConfig.riskDisplay,
    danger: riskConfig.isDanger,
    variant: riskConfig.isDanger ? 'danger' : riskConfig.isWarning ? 'warning' : 'default',
    span: 1,
  });

  fields.push({
    label: '申请事项',
    value: params.item,
    highlight: true,
    span: 2,
  });

  if (params.reason) {
    fields.push({
      label: '申请理由',
      value: params.reason,
      span: 2,
    });
  }

  if (params.customFields && Array.isArray(params.customFields)) {
    fields.push(...params.customFields);
  }

  // 组装操作按钮列表
  let actions: CardAction[];
  if (params.actions && Array.isArray(params.actions)) {
    actions = params.actions;
  } else {
    const approve: CardAction =
      typeof params.approveAction === 'string'
        ? { text: params.approveAction, variant: 'success', replyCommand: '1' }
        : {
            text: params.approveAction?.text || '✔ 同意',
            variant: params.approveAction?.variant || 'success',
            replyCommand: params.approveAction?.replyCommand || '1',
            icon: params.approveAction?.icon,
            color: params.approveAction?.color,
            bgColor: params.approveAction?.bgColor,
          };

    const reject: CardAction =
      typeof params.rejectAction === 'string'
        ? { text: params.rejectAction, variant: 'danger', replyCommand: '2' }
        : {
            text: params.rejectAction?.text || '✖ 拒绝',
            variant: params.rejectAction?.variant || 'danger',
            replyCommand: params.rejectAction?.replyCommand || '2',
            icon: params.rejectAction?.icon,
            color: params.rejectAction?.color,
            bgColor: params.rejectAction?.bgColor,
          };

    actions = [approve, reject];
  }

  // 底部提示
  const footer =
    params.footer || {
      icon: '💡',
      text: '提示：请在会话中直接回复数字 [1] 同意 或 [2] 拒绝',
    };

  return {
    theme: riskConfig.theme,
    header: {
      title: params.title || '审批申请',
      subtitle: params.subtitle || '审批决策中心',
      icon: params.icon || '🛡️',
      tag: { text: riskConfig.tagText, variant: riskConfig.tagVariant },
    },
    fields,
    actions,
    footer,
  };
}

/**
 * 构建监控告警卡片
 *
 * 自动将严重度映射为高对比告警色，指标差异字段高亮标红，并格式化排查处置动作
 *
 * @param params 告警卡片构建参数
 * @returns 标准 CardData 结构
 */
export function createAlertCard(params: AlertCardParams): CardData {
  if (!params || typeof params !== 'object') {
    throw new DriverError('告警卡片参数非法: params 不能为空', 'INVALID_ALERT_PARAMS');
  }
  if (!params.title || typeof params.title !== 'string') {
    throw new DriverError('告警卡片参数非法: title 标题不能为空', 'INVALID_ALERT_TITLE');
  }

  const severity: AlertSeverity = params.severity || 'high';
  const sevConfig = SEVERITY_MAP[severity] || SEVERITY_MAP.high;

  // 组装结构化字段列表
  const fields: CardField[] = [];

  if (params.service) {
    fields.push({ label: '告警服务', value: params.service, highlight: true, span: 1 });
    fields.push({
      label: '严重级别',
      value: sevConfig.severityDisplay,
      danger: sevConfig.isDanger,
      variant: sevConfig.isDanger ? 'danger' : sevConfig.isWarning ? 'warning' : 'default',
      span: 1,
    });
  } else {
    fields.push({
      label: '严重级别',
      value: sevConfig.severityDisplay,
      danger: sevConfig.isDanger,
      variant: sevConfig.isDanger ? 'danger' : sevConfig.isWarning ? 'warning' : 'default',
      span: 2,
    });
  }

  // 监控指标项列表 (超标标红)
  if (params.metrics && Array.isArray(params.metrics) && params.metrics.length > 0) {
    const isSingleMetric = params.metrics.length === 1;
    for (const metric of params.metrics) {
      const valStr =
        metric.threshold !== undefined
          ? `${metric.value} (阈值: ${metric.threshold})`
          : String(metric.value);
      const isExceeded = metric.exceeded !== false;
      fields.push({
        label: metric.name,
        value: valStr,
        danger: isExceeded,
        variant: isExceeded ? 'danger' : 'default',
        span: isSingleMetric ? 2 : 1,
      });
    }
  }

  if (params.description) {
    fields.push({
      label: '故障详情',
      value: params.description,
      span: 2,
    });
  }

  if (params.customFields && Array.isArray(params.customFields)) {
    fields.push(...params.customFields);
  }

  // 底部提示与时间戳
  const footer =
    params.footer || {
      icon: '🕒',
      text: `告警时间：${formatTimestamp(params.timestamp)}`,
    };

  return {
    theme: sevConfig.theme,
    header: {
      title: params.title,
      subtitle: params.subtitle || '监控告警中心',
      icon: params.icon || sevConfig.defaultIcon,
      tag: { text: sevConfig.tagText, variant: sevConfig.tagVariant },
    },
    fields,
    actions: params.actions || [],
    footer,
  };
}

/**
 * 构建汇总报告卡片
 *
 * 根据成功/失败状态匹配主题，自动网格化指标项与耗时，排版总结说明
 *
 * @param params 汇总报告构建参数
 * @returns 标准 CardData 结构
 */
export function createReportCard(params: ReportCardParams): CardData {
  if (!params || typeof params !== 'object') {
    throw new DriverError('报告卡片参数非法: params 不能为空', 'INVALID_REPORT_PARAMS');
  }
  if (!params.title || typeof params.title !== 'string') {
    throw new DriverError('报告卡片参数非法: title 标题不能为空', 'INVALID_REPORT_TITLE');
  }

  const status: ReportStatus = params.status || 'success';
  const statusConfig = REPORT_STATUS_MAP[status] || REPORT_STATUS_MAP.success;

  // 组装结构化字段列表
  const fields: CardField[] = [];

  const reportIdField = params.reportId
    ? { label: '报告编号', value: params.reportId }
    : undefined;
  const durationField = params.duration
    ? { label: '执行耗时', value: params.duration, highlight: true }
    : undefined;

  appendPairedFields(fields, reportIdField, durationField);

  // 网格化核心指标项 (均为 span 1)
  if (params.metrics && Array.isArray(params.metrics) && params.metrics.length > 0) {
    for (const metric of params.metrics) {
      let variant = metric.variant;
      if (!variant) {
        if (status === 'failure' && metric.highlight) {
          variant = 'danger';
        } else if (metric.highlight) {
          variant = 'highlight';
        } else {
          variant = 'default';
        }
      }
      fields.push({
        label: metric.label,
        value: String(metric.value),
        variant,
        highlight: metric.highlight,
        span: 1,
      });
    }
  }

  if (params.summary) {
    fields.push({
      label: '摘要说明',
      value: params.summary,
      span: 2,
    });
  }

  if (params.customFields && Array.isArray(params.customFields)) {
    fields.push(...params.customFields);
  }

  // 底部提示
  const footer =
    params.footer || {
      icon: '📊',
      text: 'KKBot 报告生成中心 · 自动生成',
    };

  return {
    theme: statusConfig.theme,
    header: {
      title: params.title,
      subtitle: params.subtitle || '自动化巡检与统计',
      icon: params.icon || statusConfig.defaultIcon,
      tag: { text: statusConfig.tagText, variant: statusConfig.tagVariant },
    },
    fields,
    actions: params.actions || [],
    footer,
  };
}

/**
 * 构建多选决策卡片
 *
 * 格式化选项编号，为推荐项注入高亮视觉标识，自动生成对应的选项模拟按钮与快捷指令
 *
 * @param params 多选决策卡片构建参数
 * @returns 标准 CardData 结构
 */
export function createDecisionCard(params: DecisionCardParams): CardData {
  if (!params || typeof params !== 'object') {
    throw new DriverError('决策卡片参数非法: params 不能为空', 'INVALID_DECISION_PARAMS');
  }
  if (!params.title || typeof params.title !== 'string') {
    throw new DriverError('决策卡片参数非法: title 标题不能为空', 'INVALID_DECISION_TITLE');
  }
  if (!params.options || !Array.isArray(params.options) || params.options.length === 0) {
    throw new DriverError('决策卡片参数非法: options 选项列表不能为空', 'INVALID_DECISION_OPTIONS');
  }

  // 组装结构化字段列表
  const fields: CardField[] = [];

  const sponsorField = params.sponsor
    ? { label: '发起人', value: params.sponsor }
    : undefined;
  const deadlineField = params.deadline
    ? { label: '截止时间', value: params.deadline, variant: 'warning' as const }
    : undefined;

  appendPairedFields(fields, sponsorField, deadlineField);

  if (params.description) {
    fields.push({
      label: '决策背景',
      value: params.description,
      span: 2,
    });
  }

  // 格式化选项列表
  for (let idx = 0; idx < params.options.length; idx++) {
    const opt = params.options[idx];
    if (!opt) continue;
    const key = opt.key !== undefined ? String(opt.key) : String(idx + 1);
    const isRec = Boolean(opt.recommended);
    const label = isRec ? `⭐ 选项 ${key}` : `选项 ${key}`;
    const desc = opt.description ? ` (${opt.description})` : '';
    const valStr = isRec ? `[推荐] ${opt.title}${desc}` : `${opt.title}${desc}`;

    fields.push({
      label,
      value: valStr,
      highlight: isRec,
      variant: isRec ? 'highlight' : 'default',
      span: 2,
    });
  }

  if (params.customFields && Array.isArray(params.customFields)) {
    fields.push(...params.customFields);
  }

  // 组装操作按钮列表 (若未显式传入则根据选项自动生成)
  let actions: CardAction[];
  if (params.actions && Array.isArray(params.actions)) {
    actions = params.actions;
  } else {
    actions = params.options.map((opt, idx) => {
      const key = opt.key !== undefined ? String(opt.key) : String(idx + 1);
      const isRec = Boolean(opt.recommended);
      const cmd = opt.replyCommand || key;
      const text = isRec ? `⭐ 选项 ${key}` : `选项 ${key}`;
      return {
        text,
        variant: isRec ? 'primary' : 'default',
        replyCommand: cmd,
      };
    });
  }

  // 底部提示
  let footer = params.footer;
  if (!footer) {
    const optionKeys = params.options.map((opt, idx) =>
      opt.key !== undefined ? String(opt.key) : String(idx + 1)
    );
    const deadlineSuffix = params.deadline ? ` (截止：${params.deadline})` : '';
    footer = {
      icon: '💡',
      text: `提示：请直接回复选项 [${optionKeys.join('/')}] 完成决策${deadlineSuffix}`,
    };
  }

  return {
    theme: 'primary',
    header: {
      title: params.title,
      subtitle: params.subtitle || '架构与方案决策中心',
      icon: params.icon || '⚖️',
      tag: { text: '待决策', variant: 'primary' },
    },
    fields,
    actions,
    footer,
  };
}
