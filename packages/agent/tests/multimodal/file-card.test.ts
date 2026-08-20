import { describe, expect, it } from 'vitest';
import { FileCardAwareness } from '../../src/multimodal/file-card.js';
import type { ConsolidatedMessage } from '../../src/types/index.js';
import type { KK9FileInfo } from '@kkbot/driver';

describe('FileCardAwareness 办公文件卡片解析测试', () => {
  const awareness = new FileCardAwareness();

  it('应准确按扩展名进行文件业务分类与可读标签映射', () => {
    expect(FileCardAwareness.categorize('xlsx')).toEqual({
      category: 'spreadsheet',
      label: '电子表格/数据分析',
    });
    expect(FileCardAwareness.categorize('.pdf')).toEqual({
      category: 'pdf',
      label: 'PDF 版面文档',
    });
    expect(FileCardAwareness.categorize('docx')).toEqual({
      category: 'document',
      label: '文本文档/报告',
    });
    expect(FileCardAwareness.categorize('pptx')).toEqual({
      category: 'presentation',
      label: '演示文稿/幻灯片',
    });
    expect(FileCardAwareness.categorize('zip')).toEqual({
      category: 'archive',
      label: '压缩数据包',
    });
    expect(FileCardAwareness.categorize('json')).toEqual({
      category: 'code',
      label: '代码/配置文件',
    });
    expect(FileCardAwareness.categorize('unknownext')).toEqual({
      category: 'other',
      label: '常规文件',
    });
  });

  it('应准确格式化文件字节大小与反向解析字符串体积', () => {
    expect(FileCardAwareness.formatBytes(500)).toBe('500 B');
    expect(FileCardAwareness.formatBytes(1536)).toBe('1.5 KB');
    expect(FileCardAwareness.formatBytes(2.5 * 1024 * 1024)).toBe('2.5 MB');
    expect(FileCardAwareness.formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.00 GB');

    expect(FileCardAwareness.parseSizeToBytes('1.2MB')).toBe(1258291);
    expect(FileCardAwareness.parseSizeToBytes('512KB')).toBe(524288);
    expect(FileCardAwareness.parseSizeToBytes('100 B')).toBe(100);
    expect(FileCardAwareness.parseSizeToBytes('invalid')).toBeUndefined();
  });

  it('应从 KK9FileInfo 实体中解析文件卡片元数据', () => {
    const fileInfo: KK9FileInfo = {
      fileName: '2026年Q3考勤表.xlsx',
      fileSize: '1.2MB',
      filePath: 'C:\\Users\\kk\\Downloads\\2026年Q3考勤表.xlsx',
    };

    const card = awareness.parseFileCard(fileInfo);
    expect(card).not.toBeNull();
    expect(card?.fileName).toBe('2026年Q3考勤表.xlsx');
    expect(card?.fileExt).toBe('xlsx');
    expect(card?.category).toBe('spreadsheet');
    expect(card?.categoryLabel).toBe('电子表格/数据分析');
    expect(card?.filePath).toBe('C:\\Users\\kk\\Downloads\\2026年Q3考勤表.xlsx');
    expect(card?.fileSizeBytes).toBe(1258291);
  });

  it('应从纯文本或卡片语法字符串中解析文件卡片', () => {
    const text1 = '[文件] 架构设计说明书.pdf (3.5MB)';
    const card1 = awareness.parseFileCard(text1);
    expect(card1?.fileName).toBe('架构设计说明书.pdf');
    expect(card1?.fileExt).toBe('pdf');
    expect(card1?.category).toBe('pdf');
    expect(card1?.fileSize).toBe('3.5MB');

    const text2 = '收到文件: 数据库备份.zip';
    const card2 = awareness.parseFileCard(text2);
    expect(card2?.fileName).toBe('数据库备份.zip');
    expect(card2?.category).toBe('archive');

    const jsonText = JSON.stringify({
      fileName: 'package.json',
      fileSize: '2KB',
    });
    const card3 = awareness.parseFileCard(jsonText);
    expect(card3?.fileName).toBe('package.json');
    expect(card3?.category).toBe('code');
  });

  it('应从 ConsolidatedMessage 中提取所有不重复的文件卡片', () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '项目协同组',
      sessionType: 'group',
      sender: '张三',
      content: '请大家查收本周报表\n[文件] 8月第3周报.xlsx (800KB)',
      messageCount: 2,
      messages: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          sessionName: '项目协同组',
          sessionType: 'group',
          sender: '张三',
          content: '请大家查收本周报表',
          time: '10:00',
          isMe: false,
          timestamp: 1787200000000,
          fileInfo: {
            fileName: '8月第3周报.xlsx',
            fileSize: '800KB',
            filePath: 'C:\\files\\8月第3周报.xlsx',
          },
        },
        {
          id: 'm2',
          sessionId: 'sess_1',
          sessionName: '项目协同组',
          sessionType: 'group',
          sender: '李四',
          content: '还有这份项目纪要.docx',
          time: '10:01',
          isMe: false,
          timestamp: 1787200001000,
          fileInfo: {
            fileName: '项目纪要.docx',
            fileSize: '1.5MB',
          },
        },
      ],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200001000,
      messageIds: ['m1', 'm2'],
    };

    const cards = awareness.extractFileCards(msg);
    expect(cards.length).toBe(2);
    expect(cards[0]?.fileName).toBe('8月第3周报.xlsx');
    expect(cards[1]?.fileName).toBe('项目纪要.docx');
  });

  it('应生成结构化提示词并注入到消息上下文中', () => {
    const fileCards = [
      {
        fileName: '需求分析.docx',
        fileSize: '2.1MB',
        fileExt: 'docx',
        filePath: '/tmp/需求分析.docx',
        category: 'document' as const,
        categoryLabel: '文本文档/报告',
      },
    ];

    const prompt = awareness.formatFileCardPrompt(fileCards);
    expect(prompt).toContain('[用户附件数据 - 文件卡片] 收到 1 个办公文件卡片附件:');
    expect(prompt).toContain('需求分析.docx (2.1MB) [文本文档/报告]');
    expect(prompt).not.toContain('/tmp/需求分析.docx');

    const enhanced = awareness.enhanceMessageContent('帮我看看这个需求', fileCards);
    expect(enhanced).toContain('帮我看看这个需求');
    expect(enhanced).toContain('[用户附件数据 - 文件卡片] 收到 1 个办公文件卡片附件:');
  });
});
