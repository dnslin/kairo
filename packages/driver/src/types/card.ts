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
export type CardFieldVariant = 'default' | 'muted' | 'highlight' | 'danger' | 'warning' | 'success' | 'info';

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
export type CardActionVariant = 'primary' | 'success' | 'warning' | 'danger' | 'secondary' | 'default' | 'outline';

/**
 * 模拟交互按钮与快捷指令提示
 */
export interface CardAction {
  /** 按钮显示文本 (如 '✔ 确认授权执行') */
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
  /** 底部提示文本 (如 '💡 提示：本消息为智能卡片，请直接在会话中回复数字 [1] 或 [2] 完成决策') */
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
