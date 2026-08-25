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
  mediaType?: string;
  filename?: string;
  isVisual?: boolean;
  hasCompleteTrustedText?: boolean;
  trustedText?: string;
}

export interface NormalizedModelTierInput {
  text: string;
  attachments?: NormalizedAttachmentFact[];
}

const VISUAL_INTENT_REGEX =
  /(?:(?:看图|识图|看截图|看照片)|(?:图[中里上]|截图[中里上]|照片[中里上])|(?:识别|查看|分析|提取|对比|描述)(?:[一这那该幅张个份条]*[张份幅个条]?|\s*)*(?:图片|图像|照片|截图|图表|趋势图|架构图|曲线图|饼图|柱状图)(?!.*(?:压缩|编码|解码|格式转换|存储|协议|算法原理|压缩算法))|(?:UI截图|界面截图|图表关系|按钮颜色|颜色搭配|色彩分布|界面布局|排版布局|版面位置|版面结构|视觉风格))/i;

const VISUAL_MIME_REGEX = /^image\//i;
const VISUAL_EXT_REGEX = /\.(?:png|jpe?g|gif|webp|bmp|svg|tiff)$/i;
const DEEP_INTENT_REGEX =
  /(?:代码|重构|架构|设计方案|复杂推理|多步骤|综合方案|算法|分析原因|死锁|性能瓶颈|并发模型)/i;

const FAST_GREETING_REGEX =
  /^(?:(?:你好|您好|hi|hello|hey|早|早上好|下午好|晚上好|哈喽|在吗)[\s!！?？~～.,，]*)+$/i;
const FAST_ORG_QUERY_REGEX =
  /(?:查询|查|找|谁是).*(?:员工|部门|主管|领导|汇报线|组织架构|电话|工号)|(?:直属主管|所属部门|汇报线|组织架构|通讯录)/i;
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

  // 1. 视觉能力优先 (VISION)
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

  // 2. 显式复杂文本规则 (DEEP)
  if (normalizedText && DEEP_INTENT_REGEX.test(normalizedText)) {
    return 'DEEP';
  }

  // 3. 显式简单文本规则 (FAST)
  if (
    normalizedText &&
    (FAST_GREETING_REGEX.test(normalizedText) ||
      FAST_ORG_QUERY_REGEX.test(normalizedText) ||
      FAST_SIMPLE_OP_REGEX.test(normalizedText))
  ) {
    return 'FAST';
  }

  // 4. 唯一默认路径 (DEEP)
  return 'DEEP';
}
