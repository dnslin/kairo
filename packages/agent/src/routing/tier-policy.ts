/**
 * ModelTierPolicy: 纯本地确定性模型等级分类策略
 *
 * 核心契约：
 * 1. 类型固定为 FAST | DEEP | VISION。
 * 2. 纯同步确定性函数，输入只包含规范化文本和确定性的附件事实，不包含预选 Tier 或分类结论。
 * 3. 不调用模型、Embedding、远端 API、Agent Tool 或概率分类器。
 * 4. 固定判定优先级：VISION -> 显式 DEEP -> 显式 FAST -> 默认 DEEP。
 * 5. 相同规范化输入和同一 rulesVersion 始终产生相同 Model Tier。
 * 6. 附件存在本身不会自动选择 VISION（仅当为视觉模态且缺少完整可信文本表示时，或文本要求视觉属性时才选择）。
 * 7. 不保存 provider、model ID、fallback、retry 或 timeout 配置。
 */

export type ModelTier = 'FAST' | 'DEEP' | 'VISION';

export interface NormalizedAttachmentFact {
  /** 附件媒体模态类型 (MIME type，例如 'image/png', 'text/plain') */
  mediaType?: string;
  /** 附件文件名 (例如 'screenshot.png', 'notes.txt') */
  filename?: string;
  /** 是否为视觉模态 (图片/截图/图表等) */
  isVisual?: boolean;
  /** 是否具备完整可信文本表示 (例如已通过 OCR 提取或原生纯文本) */
  hasCompleteTrustedText?: boolean;
  /** 可信文本内容 (若有) */
  trustedText?: string;
}

export interface NormalizedModelTierInput {
  /** 规范化文本内容 */
  text: string;
  /** 附件事实列表 (若有) */
  attachments?: NormalizedAttachmentFact[];
}

/** 视觉特征关键词正则 */
const VISUAL_INTENT_REGEX =
  /(?:图片|图像|照片|截图|图表|趋势图|架构图|\bUI\b|界面|画布|颜色|色彩|排版|布局|版面|位置|坐标)/i;

/** 视觉模态 MIME 正则 (以 image/ 开头) */
const VISUAL_MIME_REGEX = /^image\//i;

/** 视觉模态扩展名正则 */
const VISUAL_EXT_REGEX = /\.(?:png|jpe?g|gif|webp|bmp|svg|tiff)$/i;
/** 显式复杂推理 / 代码重构 / 多步骤综合正则 */
const DEEP_INTENT_REGEX =
  /(?:代码|重构|架构|设计方案|复杂推理|多步骤|综合方案|算法|分析原因|死锁|性能瓶颈|并发模型)/i;

/** 显式简单问候正则 (匹配单条或组合问候词及标点空格，不吞后续英文/中文非问候句) */
const FAST_GREETING_REGEX =
  /^(?:(?:你好|您好|hi|hello|hey|早|早上好|下午好|晚上好|哈喽|在吗)[\s!！?？~～.,，]*)+$/i;
/** 显式直接组织/员工查询正则 */
const FAST_ORG_QUERY_REGEX =
  /(?:查询|查|找|谁是).*(?:员工|部门|主管|领导|汇报线|组织架构|电话|工号)|(?:直属主管|所属部门|汇报线|组织架构|通讯录)/i;

/** 显式简单操作性指令正则 */
const FAST_SIMPLE_OP_REGEX = /^(?:ping|pong|help|帮助|菜单)$/i;

/**
 * 确定性纯函数：根据规范化输入与规则版本解析 ModelTier
 *
 * @param input 规范化输入（只包含本地事实）
 * @param rulesVersion 规则版本标识
 * @returns 'FAST' | 'DEEP' | 'VISION'
 */
export function resolveModelTier(input: NormalizedModelTierInput, rulesVersion: string): ModelTier {
  if (!rulesVersion) {
    throw new Error('rulesVersion 不能为空');
  }

  const normalizedText = input.text ? input.text.trim() : '';
  const attachments = input.attachments ?? [];

  // 1. 优先级 1: 视觉能力优先 (VISION)
  // (a) 附件属于视觉模态且缺少完整可信文本表示
  const hasIncompleteVisualAttachment = attachments.some(att => {
    const isVisual =
      att.isVisual === true ||
      Boolean(att.mediaType && VISUAL_MIME_REGEX.test(att.mediaType)) ||
      Boolean(att.filename && VISUAL_EXT_REGEX.test(att.filename));
    return isVisual && att.hasCompleteTrustedText !== true;
  });
  if (hasIncompleteVisualAttachment) {
    return 'VISION';
  }

  // (b) 文本明确要求分析图片内容、图表关系、颜色、位置或版面等视觉属性
  if (normalizedText && VISUAL_INTENT_REGEX.test(normalizedText)) {
    return 'VISION';
  }

  // 2. 优先级 2: 显式复杂文本规则 (DEEP)
  if (normalizedText && DEEP_INTENT_REGEX.test(normalizedText)) {
    return 'DEEP';
  }

  // 3. 优先级 3: 显式简单文本规则 (FAST)
  if (
    normalizedText &&
    (FAST_GREETING_REGEX.test(normalizedText) ||
      FAST_ORG_QUERY_REGEX.test(normalizedText) ||
      FAST_SIMPLE_OP_REGEX.test(normalizedText))
  ) {
    return 'FAST';
  }

  // 4. 优先级 4: 唯一默认路径 (DEEP)
  return 'DEEP';
}
