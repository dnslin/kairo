import type { MastraMessageContentV2 } from '@mastra/core/agent';

/**
 * 从 MastraMessageContentV2 中提取文本内容（以 parts 为权威）
 */
export function extractTextFromMastraContent(content: unknown): string {
  if (!content || typeof content !== 'object') {
    return typeof content === 'string' ? content : '';
  }

  const v2 = content as Partial<MastraMessageContentV2>;

  // 1. V2 规范：以 parts 数组为第一权威事实源
  if (Array.isArray(v2.parts) && v2.parts.length > 0) {
    const textSegments: string[] = [];
    for (const part of v2.parts) {
      if (part && typeof part === 'object') {
        const p = part as { type?: string; text?: unknown };
        if (p.type === 'text' && typeof p.text === 'string') {
          textSegments.push(p.text);
        }
      }
    }
    if (textSegments.length > 0) {
      return textSegments.join('\n');
    }
  }

  // 2. 兜底旧格式或顶层 content 字段
  if (typeof v2.content === 'string') {
    return v2.content;
  }

  return '';
}

/**
 * 替换 MastraMessageContentV2 中的文本正文：
 * 移除已有 text parts，插入唯一新的 text part，并完整保留所有非文本/来源/工具等 parts。
 */
export function replaceMastraContentText(
  content: MastraMessageContentV2,
  newText: string
): MastraMessageContentV2 {
  const existingParts = Array.isArray(content.parts) ? content.parts : [];
  // 保留所有非文本 part (如 source, source-document, tool-invocation 等)
  const nonTextParts = existingParts.filter(p => p && typeof p === 'object' && p.type !== 'text');

  const newTextPart = {
    type: 'text' as const,
    text: newText,
    createdAt: Date.now(),
  };

  return {
    ...content,
    content: newText,
    parts: [newTextPart, ...nonTextParts],
  };
}
