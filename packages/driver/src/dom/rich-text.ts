import type { FormattedText, TextSegment, TextStyle } from '../types/index.js';

export interface KK9FontPayload {
  bold: number;
  fontfamily: string;
  size: number;
  italic: number;
  underline: number;
  color?: number;
}

export interface KK9ParsedRichText {
  plainText: string;
  font: KK9FontPayload;
}

/**
 * 转义基础 HTML 实体
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * 将 16 进制颜色 (#RRGGBB) 或常用颜色名转换为 KK9 BGR 十进制数值
 */
export function hexToKkBgrColor(hex: string): number {
  let clean = hex.trim().toLowerCase().replace(/^#/, '');

  const namedColors: Record<string, string> = {
    red: 'FF0000',
    blue: '1890FF',
    green: '52C41A',
    orange: 'FA8C16',
    yellow: 'FADB14',
    purple: '722ED1',
    black: '000000',
    gray: '8C8C8C',
    white: 'FFFFFF',
  };

  if (namedColors[clean]) {
    clean = namedColors[clean]!;
  } else if (/^[0-9a-f]{3}$/i.test(clean)) {
    clean = clean[0]! + clean[0]! + clean[1]! + clean[1]! + clean[2]! + clean[2]!;
  } else if (!/^[0-9a-f]{6}$/i.test(clean)) {
    clean = '000000';
  }

  const r = clean.substring(0, 2);
  const g = clean.substring(2, 4);
  const b = clean.substring(4, 6);

  // KK9 采用 Windows BGR 字节序: 0xBBGGRR
  return parseInt(b + g + r, 16);
}

/**
 * 将 TextStyle 转换为 CSS 样式内联声明字符串
 */
export function styleToCss(style?: TextStyle): string {
  if (!style) return '';

  const declarations: string[] = [];

  if (style.color) {
    declarations.push(`color: ${style.color}`);
  }

  if (style.fontSize !== undefined) {
    const size = typeof style.fontSize === 'number' ? `${style.fontSize}px` : style.fontSize;
    declarations.push(`font-size: ${size}`);
  }

  if (style.bold) {
    declarations.push('font-weight: bold');
  }

  if (style.italic) {
    declarations.push('font-style: italic');
  }

  const decorations: string[] = [];
  if (style.underline) decorations.push('underline');
  if (style.strikethrough) decorations.push('line-through');
  if (decorations.length > 0) {
    declarations.push(`text-decoration: ${decorations.join(' ')}`);
  }

  if (style.backgroundColor) {
    declarations.push(`background-color: ${style.backgroundColor}`);
  }

  return declarations.join('; ');
}

/**
 * 将 TextSegment 数组格式化为 KK9 输入框兼容的 HTML 片段
 */
export function formatSegmentsToHtml(segments: TextSegment[]): string {
  if (!Array.isArray(segments) || segments.length === 0) {
    return '';
  }

  return segments
    .map(seg => {
      const text = seg.text || '';
      if (!text) return '';

      const escaped = escapeHtml(text).replace(/\r?\n/g, '<br>');
      const css = styleToCss(seg.style);

      if (!css) {
        return escaped;
      }

      return `<span style="${css}">${escaped}</span>`;
    })
    .join('');
}

/**
 * 将简易 Markdown / 自定义标签转换为 HTML
 */
export function markdownToKKHtml(markdown: string): string {
  if (!markdown) return '';

  let parsed = escapeHtml(markdown);

  parsed = parsed.replace(
    /\[color=([#a-zA-Z0-9_-]+)\]([\s\S]*?)\[\/color\]/g,
    (_: string, color: string, content: string): string =>
      `<span style="color: ${color}">${content}</span>`
  );

  parsed = parsed.replace(
    /\[size=([0-9]+(?:px)?)\]([\s\S]*?)\[\/size\]/g,
    (_: string, size: string, content: string): string => {
      const fontSize = size.endsWith('px') ? size : `${size}px`;
      return `<span style="font-size: ${fontSize}">${content}</span>`;
    }
  );

  parsed = parsed.replace(/\*\*(.*?)\*\*/g, '<span style="font-weight: bold">$1</span>');
  parsed = parsed.replace(/__(.*?)__/g, '<span style="font-weight: bold">$1</span>');
  parsed = parsed.replace(/\*(.*?)\*/g, '<span style="font-style: italic">$1</span>');
  parsed = parsed.replace(/_(.*?)_/g, '<span style="font-style: italic">$1</span>');
  parsed = parsed.replace(/~~(.*?)~~/g, '<span style="text-decoration: line-through">$1</span>');
  parsed = parsed.replace(
    /&lt;u&gt;(.*?)&lt;\/u&gt;/g,
    '<span style="text-decoration: underline">$1</span>'
  );
  parsed = parsed.replace(/\r?\n/g, '<br>');

  return parsed;
}

/**
 * 统一将 FormattedText 编译转换为 HTML 字符串
 */
export function formattedTextToHtml(formatted: FormattedText): string {
  if (typeof formatted === 'string') {
    return markdownToKKHtml(formatted);
  }

  if (Array.isArray(formatted)) {
    return formatSegmentsToHtml(formatted);
  }

  if (typeof formatted === 'object' && formatted !== null && 'html' in formatted) {
    return formatted.html;
  }

  return '';
}

/**
 * 将 FormattedText 转换为 KK9 原生消息渲染所需的 plainText 与 fontPayload 结构
 */
export function parseFormattedTextToKK(formatted: FormattedText): KK9ParsedRichText {
  if (typeof formatted === 'string') {
    let raw = formatted.replace(/\\+n/g, '\n').replace(/\\+r/g, '\r');
    let bold = 0;
    let italic = 0;
    let underline = 0;
    let size = 10;
    let color: number | undefined = undefined;

    // 探测 [color=...]
    const colorMatch = /\[color=([#a-zA-Z0-9_-]+)\]/i.exec(raw);
    if (colorMatch && colorMatch[1]) {
      color = hexToKkBgrColor(colorMatch[1]);
      raw = raw.replace(/\[color=[#a-zA-Z0-9_-]+\]([\s\S]*?)\[\/color\]/gi, '$1');
    }

    // 探测 [size=...]
    const sizeMatch = /\[size=([0-9]+)(?:px|pt)?\]/i.exec(raw);
    if (sizeMatch && sizeMatch[1]) {
      size = parseInt(sizeMatch[1], 10);
      raw = raw.replace(/\[size=[0-9]+(?:px|pt)?\]([\s\S]*?)\[\/size\]/gi, '$1');
    }

    // 探测 **粗体** 或 __粗体__
    if (/\*\*(.*?)\*\*/.test(raw) || /__(.*?)__/.test(raw)) {
      bold = 1;
      raw = raw.replace(/\*\*(.*?)\*\*/g, '$1').replace(/__(.*?)__/g, '$1');
    }

    // 探测 *斜体* 或 _斜体_
    if (/\*(.*?)\*/.test(raw) || /_(.*?)_/.test(raw)) {
      italic = 1;
      raw = raw.replace(/\*(.*?)\*/g, '$1').replace(/_(.*?)_/g, '$1');
    }

    // 探测 <u>下划线</u>
    if (/<u>(.*?)<\/u>/i.test(raw)) {
      underline = 1;
      raw = raw.replace(/<u>(.*?)<\/u>/gi, '$1');
    }

    // 探测 ~~删除线~~
    if (/~~(.*?)~~/.test(raw)) {
      raw = raw.replace(/~~(.*?)~~/g, '$1');
    }

    return {
      plainText: raw,
      font: {
        bold,
        fontfamily: '微软雅黑',
        size,
        italic,
        underline,
        color,
      },
    };
  }

  if (Array.isArray(formatted)) {
    const plainText = formatted.map(s => s.text || '').join('');
    let bold = 0;
    let italic = 0;
    let underline = 0;
    let size = 10;
    let color: number | undefined = undefined;

    for (const seg of formatted) {
      if (seg.style) {
        if (seg.style.bold) bold = 1;
        if (seg.style.italic) italic = 1;
        if (seg.style.underline) underline = 1;
        if (seg.style.fontSize !== undefined) {
          size =
            typeof seg.style.fontSize === 'number'
              ? seg.style.fontSize
              : parseInt(seg.style.fontSize, 10);
        }
        if (seg.style.color) {
          color = hexToKkBgrColor(seg.style.color);
        }
      }
    }

    return {
      plainText,
      font: {
        bold,
        fontfamily: '微软雅黑',
        size,
        italic,
        underline,
        color,
      },
    };
  }

  if (typeof formatted === 'object' && formatted !== null && 'html' in formatted) {
    const plainText = formatted.html.replace(/<[^>]*>/g, '');
    return {
      plainText,
      font: {
        bold: 0,
        fontfamily: '微软雅黑',
        size: 10,
        italic: 0,
        underline: 0,
      },
    };
  }

  return {
    plainText: '',
    font: {
      bold: 0,
      fontfamily: '微软雅黑',
      size: 10,
      italic: 0,
      underline: 0,
    },
  };
}
