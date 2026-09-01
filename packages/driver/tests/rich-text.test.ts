import { describe, expect, it } from 'vitest';
import {
  decodeCliEscapedLineBreaks,
  escapeHtml,
  formatSegmentsToHtml,
  formattedTextToHtml,
  hexToKkBgrColor,
  markdownToKKHtml,
  parseFormattedTextToKK,
  styleToCss,
} from '../src/dom/rich-text.js';
import type { TextSegment, TextStyle } from '../src/types/index.js';

describe('RichText 富文本转换与样式编译测试', () => {
  describe('escapeHtml', () => {
    it('应正确转义特殊 HTML 字符', () => {
      const input = '<script>alert("xss" & \'test\')</script>';
      const expected = '&lt;script&gt;alert(&quot;xss&quot; &amp; &#039;test&#039;)&lt;/script&gt;';
      expect(escapeHtml(input)).toBe(expected);
    });
  });

  describe('hexToKkBgrColor', () => {
    it('应将 #FF0000 (红) 转换为 Windows BGR 整数 255 (0x0000FF)', () => {
      expect(hexToKkBgrColor('#FF0000')).toBe(255);
    });

    it('应将 #1890FF (蓝) 转换为 Windows BGR 整数 16748568 (0xFF9018)', () => {
      expect(hexToKkBgrColor('#1890FF')).toBe(16748568);
    });

    it('应支持常用颜色名称转换', () => {
      expect(hexToKkBgrColor('red')).toBe(255);
      expect(hexToKkBgrColor('blue')).toBe(16748568);
    });
  });

  describe('CLI 转义边界', () => {
    it('仅在 CLI 边界将叠加反斜杠换行序列解码一次', () => {
      const input = String.raw`第一行\\n第二行\\r\\n第三行`;

      expect(decodeCliEscapedLineBreaks(input)).toBe('第一行\n第二行\r\n第三行');
    });
  });

  describe('parseFormattedTextToKK', () => {
    it('应正确解析带 Markdown 标签的字符串为 KK9 结构化消息', () => {
      const input = '**[加粗标题]** [color=#1890ff]蓝色正文[/color] [size=14]14号字[/size]';
      const parsed = parseFormattedTextToKK(input);

      expect(parsed.plainText).toBe('[加粗标题] 蓝色正文 14号字');
      expect(parsed.font.bold).toBe(1);
      expect(parsed.font.size).toBe(14);
      expect(parsed.font.color).toBe(16748568);
      expect(parsed.font.fontfamily).toBe('微软雅黑');
    });

    it('应保留字符串中的字面反斜杠与 Windows 路径', () => {
      const input = String.raw`路径 C:\new\notes 与字面序列 \n 不应被改写`;

      const parsed = parseFormattedTextToKK(input);

      expect(parsed.plainText).toBe(input);
    });

    it('应正确解析 TextSegment 片段数组', () => {
      const segments: TextSegment[] = [
        { text: '警报: ' },
        { text: '系统异常', style: { bold: true, color: 'red', fontSize: 16, underline: true } },
      ];

      const parsed = parseFormattedTextToKK(segments);
      expect(parsed.plainText).toBe('警报: 系统异常');
      expect(parsed.font.bold).toBe(1);
      expect(parsed.font.underline).toBe(1);
      expect(parsed.font.size).toBe(16);
      expect(parsed.font.color).toBe(255);
    });
  });

  describe('styleToCss', () => {
    it('空样式应返回空字符串', () => {
      expect(styleToCss(undefined)).toBe('');
      expect(styleToCss({})).toBe('');
    });

    it('应正确拼装全部样式属性', () => {
      const style: TextStyle = {
        color: '#ff4d4f',
        fontSize: 16,
        bold: true,
        italic: true,
        underline: true,
        strikethrough: true,
        backgroundColor: '#fffbe6',
      };

      const css = styleToCss(style);
      expect(css).toContain('color: #ff4d4f');
      expect(css).toContain('font-size: 16px');
      expect(css).toContain('font-weight: bold');
      expect(css).toContain('font-style: italic');
      expect(css).toContain('text-decoration: underline line-through');
      expect(css).toContain('background-color: #fffbe6');
    });

    it('fontSize 为字符串带单位时应原样保留', () => {
      expect(styleToCss({ fontSize: '18px' })).toBe('font-size: 18px');
    });
  });

  describe('formatSegmentsToHtml', () => {
    it('应将片段数组转换为带样式的 HTML 字符串', () => {
      const segments: TextSegment[] = [
        { text: '普通文本 ' },
        { text: '红色加粗', style: { color: 'red', bold: true } },
        { text: '\n换行斜体', style: { italic: true } },
      ];

      const html = formatSegmentsToHtml(segments);
      expect(html).toContain('普通文本 ');
      expect(html).toContain('<span style="color: red; font-weight: bold">红色加粗</span>');
      expect(html).toContain('<span style="font-style: italic"><br>换行斜体</span>');
    });
  });

  describe('markdownToKKHtml', () => {
    it('应正确解析粗体与斜体语法', () => {
      expect(markdownToKKHtml('**重要通知**')).toContain(
        '<span style="font-weight: bold">重要通知</span>'
      );
      expect(markdownToKKHtml('*提示*')).toContain('<span style="font-style: italic">提示</span>');
    });

    it('应正确解析删除线与下划线语法', () => {
      expect(markdownToKKHtml('~~作废~~')).toContain(
        '<span style="text-decoration: line-through">作废</span>'
      );
      expect(markdownToKKHtml('<u>下划线内容</u>')).toContain(
        '<span style="text-decoration: underline">下划线内容</span>'
      );
    });

    it('应正确解析自定义颜色与字号标签', () => {
      const input = '[color=#ff0000]紧急告警[/color] [size=18]大号标题[/size]';
      const output = markdownToKKHtml(input);
      expect(output).toContain('<span style="color: #ff0000">紧急告警</span>');
      expect(output).toContain('<span style="font-size: 18px">大号标题</span>');
    });

    it('换行符应被替换为 <br>', () => {
      const input = '第一行\n第二行\r\n第三行';
      const output = markdownToKKHtml(input);
      expect(output).toBe('第一行<br>第二行<br>第三行');
    });

    it('潜在的 HTML 标签注入应被安全转义', () => {
      const input = '<b>加粗</b> <script>alert(1)</script>';
      const output = markdownToKKHtml(input);
      expect(output).not.toContain('<script>');
      expect(output).toContain('&lt;script&gt;');
    });
  });

  describe('formattedTextToHtml', () => {
    it('字符串输入走 markdownToKKHtml 转换', () => {
      expect(formattedTextToHtml('**测试**')).toContain(
        '<span style="font-weight: bold">测试</span>'
      );
    });

    it('片段数组走 formatSegmentsToHtml 转换', () => {
      const res = formattedTextToHtml([{ text: '文字', style: { color: 'blue' } }]);
      expect(res).toContain('<span style="color: blue">文字</span>');
    });

    it('包含 html 属性的对象应直接透传原始 HTML', () => {
      const rawHtml = '<div class="custom-kk-card">卡片</div>';
      expect(formattedTextToHtml({ html: rawHtml })).toBe(rawHtml);
    });
  });
});
