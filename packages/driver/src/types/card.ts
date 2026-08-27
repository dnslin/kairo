/**
 * @kkbot/driver 视觉卡片 (Canvas Card) 强类型系统
 */

/**
 * 内置卡片主题类型
 */
export type CardThemeType = 'primary' | 'success' | 'warning' | 'danger' | 'info';

/**
 * 自定义卡片主题配色方案
 */
export interface CardThemeCustom {
  /** 顶部横幅渐变起始色 (十六进制或 RGB/RGBA) */
  gradientStart: string;
  /** 顶部横幅渐变结束色 (十六进制或 RGB/RGBA) */
  gradientEnd: string;
  /** 强调色 / 按钮重点色 */
  accentColor?: string;
  /** 状态药丸标签背景色 */
  tagBg?: string;
  /** 状态药丸标签文字色 */
  tagColor?: string;
  /** 标题栏文字颜色，默认为 #FFFFFF */
  textColor?: string;
  /** 边框高亮色 */
  borderColor?: string;
}

/**
 * 卡片主题配置，支持内置主题枚举或完全自定义配色
 */
export type CardTheme = CardThemeType | CardThemeCustom;

/**
 * 标签视觉风格变体
 */
export type CardTagVariant = 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'info';

/**
 * 卡片头部状态药丸标签 (Tag / Badge)
 */
export interface CardTag {
  /** 标签文本内容 */
  text: string;
  /** 标签语义主题变体 */
  variant?: CardTagVariant;
  /** 自定义文字颜色 */
  color?: string;
  /** 自定义背景颜色 */
  bgColor?: string;
  /** 自定义边框颜色 */
  borderColor?: string;
}

/**
 * 卡片头部配置
 */
export interface CardHeader {
  /** 卡片主标题 */
  title: string;
  /** 卡片副标题 / 发起系统 / 类别标注 */
  subtitle?: string;
  /** 顶部图标或 Emoji (如 '🛡️', '🚨', '📋') */
  icon?: string;
  /** 头部右侧状态药丸标签 */
  tag?: CardTag;
  /** 右上角附加信息 (如时间、编号等) */
  extra?: string;
}

/**
 * 字段值展示状态变体
 */
export type CardFieldVariant =
  | 'default'
  | 'muted'
  | 'highlight'
  | 'danger'
  | 'warning'
  | 'success'
  | 'info';

/**
 * 字段栅格布局跨度
 * - 1 / 'half': 半宽 (两列排布)
 * - 2 / 'full': 整行独占 (单列排布)
 */
export type CardFieldSpan = 1 | 2 | 'half' | 'full';

/**
 * 结构化属性键值对字段
 */
export interface CardField {
  /** 属性名称 / 标签 (如 '工单编号', '风险等级') */
  label: string;
  /** 属性取值 (如 'TASK-20260819-01', '🚨 P1 极高风险') */
  value: string;
  /** 字段语义变体 (决定文字颜色与加粗样式) */
  variant?: CardFieldVariant;
  /** 快捷告警红字标识 (等同于 variant: 'danger') */
  danger?: boolean;
  /** 快捷高亮标识 (等同于 variant: 'highlight') */
  highlight?: boolean;
  /** 栅格跨度 (1 为半宽，2 为全宽，默认根据排版自适应) */
  span?: CardFieldSpan;
}

/**
 * 模拟按钮样式变体
 */
export type CardActionVariant =
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'secondary'
  | 'default'
  | 'outline';

/**
 * 模拟交互按钮与快捷指令提示
 */
export interface CardAction {
  /** 按钮显示文本 (如 '查看详情') */
  text: string;
  /** 按钮语义变体样式 */
  variant?: CardActionVariant;
  /** 前缀图标或 Emoji (如 '✔', '✖', '🔗') */
  icon?: string;
  /** 便捷快捷回复指令提示 (如 '回复 1', '1') */
  replyCommand?: string;
  /** 自定义文字颜色 */
  color?: string;
  /** 自定义背景渐变或纯色 */
  bgColor?: string;
}

/**
 * 底部说明栏配置
 */
export interface CardFooter {
  /** 底部提示文本 (如 '提示：请在会话中选择一个方案') */
  text: string;
  /** 底部图标或 Emoji (如 '💡') */
  icon?: string;
  /** 时间戳显示 (文本或毫秒数字) */
  timestamp?: string | number;
  /** 对齐方式，默认为 'center' */
  align?: 'left' | 'center' | 'right';
}

/**
 * 完整 Canvas 视觉卡片数据模型
 */
export interface CardData {
  /** 卡片整体视觉主题，默认为 'primary' */
  theme?: CardTheme;
  /** 卡片头部 (标题、副标题、图标、标签) */
  header: CardHeader;
  /** 结构化键值对属性字段列表 */
  fields?: CardField[];
  /** 底部模拟操作按钮列表 */
  actions?: CardAction[];
  /** 底部提示信息 (支持字符串简写或结构化对象) */
  footer?: CardFooter | string;
  /** 自定义扩展元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Canvas 渲染引擎选项配置
 */
export interface RenderCanvasOptions {
  /** Retina 超采样缩放比例，默认为 2 (高清抗锯齿) */
  dpr?: number;
  /** 卡片逻辑像素宽度，默认为 460 */
  width?: number;
  /** 卡片外层内边距，默认为 18 */
  padding?: number;
  /** 卡片圆角半径，默认为 12 */
  borderRadius?: number;
  /** 字体族配置，默认为 '"Microsoft YaHei", "PingFang SC", -apple-system, sans-serif' */
  fontFamily?: string;
  /** 顶部横幅最小高度，默认为 68 */
  headerHeight?: number;
  /** 卡片主体背景色，默认为 '#FFFFFF' */
  backgroundColor?: string;
  /** 卡片外边框颜色，默认为 '#E5E6EB' */
  borderColor?: string;
  /** 是否绘制微质感柔和阴影，默认为 true */
  shadow?: boolean;
}

/**
 * 解析后的主题具体配色实体
 */
export interface ResolvedCardTheme {
  type: CardThemeType | 'custom';
  gradientStart: string;
  gradientEnd: string;
  accentColor: string;
  tagBg: string;
  tagColor: string;
  textColor: string;
  borderColor: string;
}

/**
 * 卡片布局计算结果与尺寸预估
 */
export interface CardLayoutResult {
  width: number;
  height: number;
  dpr: number;
  headerHeight: number;
  fieldsHeight: number;
  actionsHeight: number;
  footerHeight: number;
}

/**
 * 告警严重级别
 */
export type AlertSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

/**
 * 告警监控指标项
 */
export interface AlertMetric {
  /** 指标名称 (如 'CPU 使用率', '接口错误率') */
  name: string;
  /** 当前指标数值 (如 '98.5%', '520ms') */
  value: string | number;
  /** 告警阈值 (如 '> 80%', '200ms') */
  threshold?: string | number;
  /** 是否超标 (默认为 true，若为 true 则在卡片中高亮/标红展示) */
  exceeded?: boolean;
}

/**
 * 监控告警卡片参数
 */
export interface AlertCardParams {
  /** 告警主标题 (如 '生产服务熔断告警') (必填) */
  title: string;
  /** 严重程度 (critical 致命, high 严重, medium 警告, low 次要, info 提示)，默认为 'high' */
  severity?: AlertSeverity;
  /** 影响服务 / 目标资源 (如 'payment-gateway-service') */
  service?: string;
  /** 故障详情 / 告警描述 */
  description?: string;
  /** 监控指标列表 (当前值/阈值对比，超标自动标红) */
  metrics?: AlertMetric[];
  /** 告警发生时间戳 (格式化字符串或毫秒数值，默认自动生成当前时间) */
  timestamp?: string | number;
  /** 告警副标题 / 监控系统，默认为 '监控告警中心' */
  subtitle?: string;
  /** 顶部图标或 Emoji (缺省根据 severity 自动匹配) */
  icon?: string;
  /** 自定义扩展属性字段列表 */
  customFields?: CardField[];
  /** 排查与处置操作按钮列表 (如 '查看日志', '立即切流', '静音 15 分钟') */
  actions?: CardAction[];
  /** 底部提示说明或排查建议 (缺省自动带有时间戳与排查提示) */
  footer?: CardFooter | string;
}

/**
 * 报告执行状态
 */
export type ReportStatus = 'success' | 'warning' | 'failure' | 'running';

/**
 * 报告核心指标项
 */
export interface ReportMetric {
  /** 指标名称 (如 '总用例数', '通过率', '构建耗时') */
  label: string;
  /** 指标数值 (如 '1,280', '99.8%', '35s') */
  value: string | number;
  /** 视觉变体风格 (如 'success', 'danger', 'highlight', 'muted') */
  variant?: CardFieldVariant;
  /** 快捷高亮 */
  highlight?: boolean;
}

/**
 * 汇总报告卡片参数
 */
export interface ReportCardParams {
  /** 报告主标题 (如 '日常巡检报告', 'CI/CD 构建报告') (必填) */
  title: string;
  /** 执行状态 (success 成功, warning 警告, failure 失败, running 执行中)，默认为 'success' */
  status?: ReportStatus;
  /** 耗时统计 (如 '1m 24s', '350ms') */
  duration?: string;
  /** 核心指标项列表 (将自动两列网格化排布) */
  metrics?: ReportMetric[];
  /** 摘要说明 / 报告总结 */
  summary?: string;
  /** 报告批次 / 编号 / 环境 (如 'Pipeline #4521', 'Production') */
  reportId?: string;
  /** 报告副标题 / 来源系统，默认为 '自动化巡检与统计' */
  subtitle?: string;
  /** 顶部图标或 Emoji (缺省根据 status 自动匹配) */
  icon?: string;
  /** 自定义扩展属性字段列表 */
  customFields?: CardField[];
  /** 底部操作按钮列表 (如 '查看详细报告', '重新执行') */
  actions?: CardAction[];
  /** 底部提示或生成时间说明 */
  footer?: CardFooter | string;
}

/**
 * 决策选项项
 */
export interface DecisionOption {
  /** 选项编号 / 标识 (如 '1', '2', 'A', 'B'，若未指定则自动按序号分配 1, 2, 3...) */
  key?: string | number;
  /** 选项标题 / 名称 (必填，如 '方案一：就地水平扩容') */
  title: string;
  /** 选项详细说明 / 优劣势描述 */
  description?: string;
  /** 是否为推荐选项 (推荐项注入高亮视觉标识与专属推荐标记) */
  recommended?: boolean;
  /** 对应的快捷回复指令 (如 '1', 'A'，缺省为 key) */
  replyCommand?: string;
}

/**
 * 多选决策卡片参数
 */
export interface DecisionCardParams {
  /** 决策主标题 (如 '技术架构方案评审决策') (必填) */
  title: string;
  /** 选项列表 (必填，至少包含 1 个选项) */
  options: DecisionOption[];
  /** 决策背景描述 / 问题背景 */
  description?: string;
  /** 截止时间 (如 '今天 18:00 前', '2026-08-20 20:00') */
  deadline?: string;
  /** 决策发起人 / 负责人 */
  sponsor?: string;
  /** 决策副标题 / 发起系统，默认为 '架构与方案决策中心' */
  subtitle?: string;
  /** 顶部图标或 Emoji，默认为 '⚖️' */
  icon?: string;
  /** 自定义扩展属性字段列表 */
  customFields?: CardField[];
  /** 自定义操作按钮列表 (若未提供，将自动从 options 生成对应的模拟按钮) */
  actions?: CardAction[];
  /** 底部提示说明 (若未提供，将自动生成带有截止时间与选项回复指导的提示) */
  footer?: CardFooter | string;
}
