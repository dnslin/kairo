import type { KK9FileInfo, KK9Message } from '@kkbot/driver';
import type { ConsolidatedMessage } from '../types/index.js';
import type { FileCardInfo, FileCategory } from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('file-card-awareness');

/**
 * 文件扩展名与业务分类映射表
 */
const EXTENSION_CATEGORY_MAP: Record<string, { category: FileCategory; label: string }> = {
  // 电子表格
  xlsx: { category: 'spreadsheet', label: '电子表格/数据分析' },
  xls: { category: 'spreadsheet', label: '电子表格/数据分析' },
  csv: { category: 'spreadsheet', label: '电子表格/数据分析' },
  tsv: { category: 'spreadsheet', label: '电子表格/数据分析' },
  ods: { category: 'spreadsheet', label: '电子表格/数据分析' },

  // 文本文档
  docx: { category: 'document', label: '文本文档/报告' },
  doc: { category: 'document', label: '文本文档/报告' },
  wps: { category: 'document', label: '文本文档/报告' },
  txt: { category: 'document', label: '文本文档/报告' },
  md: { category: 'document', label: '文本文档/报告' },
  markdown: { category: 'document', label: '文本文档/报告' },
  rtf: { category: 'document', label: '文本文档/报告' },
  odt: { category: 'document', label: '文本文档/报告' },

  // 演示文稿
  pptx: { category: 'presentation', label: '演示文稿/幻灯片' },
  ppt: { category: 'presentation', label: '演示文稿/幻灯片' },
  dps: { category: 'presentation', label: '演示文稿/幻灯片' },
  key: { category: 'presentation', label: '演示文稿/幻灯片' },
  odp: { category: 'presentation', label: '演示文稿/幻灯片' },

  // PDF
  pdf: { category: 'pdf', label: 'PDF 版面文档' },

  // 压缩数据包
  zip: { category: 'archive', label: '压缩数据包' },
  rar: { category: 'archive', label: '压缩数据包' },
  '7z': { category: 'archive', label: '压缩数据包' },
  tar: { category: 'archive', label: '压缩数据包' },
  gz: { category: 'archive', label: '压缩数据包' },
  tgz: { category: 'archive', label: '压缩数据包' },
  bz2: { category: 'archive', label: '压缩数据包' },

  // 代码与配置文件
  json: { category: 'code', label: '代码/配置文件' },
  yaml: { category: 'code', label: '代码/配置文件' },
  yml: { category: 'code', label: '代码/配置文件' },
  xml: { category: 'code', label: '代码/配置文件' },
  sql: { category: 'code', label: '代码/配置文件' },
  py: { category: 'code', label: '代码/配置文件' },
  ts: { category: 'code', label: '代码/配置文件' },
  js: { category: 'code', label: '代码/配置文件' },
  java: { category: 'code', label: '代码/配置文件' },
  go: { category: 'code', label: '代码/配置文件' },
  c: { category: 'code', label: '代码/配置文件' },
  cpp: { category: 'code', label: '代码/配置文件' },
  rs: { category: 'code', label: '代码/配置文件' },
  html: { category: 'code', label: '代码/配置文件' },
  css: { category: 'code', label: '代码/配置文件' },
  sh: { category: 'code', label: '代码/配置文件' },

  // 音频与视频
  mp3: { category: 'audio', label: '音频文件' },
  wav: { category: 'audio', label: '音频文件' },
  flac: { category: 'audio', label: '音频文件' },
  mp4: { category: 'video', label: '视频文件' },
  mov: { category: 'video', label: '视频文件' },
  mkv: { category: 'video', label: '视频文件' },

  // 图片
  png: { category: 'image', label: '图片文件' },
  jpg: { category: 'image', label: '图片文件' },
  jpeg: { category: 'image', label: '图片文件' },
  gif: { category: 'image', label: '图片文件' },
  webp: { category: 'image', label: '图片文件' },
  bmp: { category: 'image', label: '图片文件' },
  svg: { category: 'image', label: '图片文件' },
};

/**
 * 办公文件卡片感知与元数据解析器
 * 解析 .xlsx, .pdf, .docx, .zip 等文件卡片，防止纯文本模型解析失败
 */
export class FileCardAwareness {
  /**
   * 根据文件后缀名进行业务分类
   */
  public static categorize(extension: string): {
    category: FileCategory;
    label: string;
  } {
    const ext = extension.toLowerCase().replace(/^\./, '').trim();
    if (ext in EXTENSION_CATEGORY_MAP) {
      return EXTENSION_CATEGORY_MAP[ext]!;
    }
    return { category: 'other', label: '常规文件' };
  }

  /**
   * 格式化字节大小为可读字符串
   */
  public static formatBytes(bytes: number): string {
    if (Number.isNaN(bytes) || bytes < 0) {
      return '未知大小';
    }
    if (bytes < 1024) {
      return `${bytes} B`;
    }
    if (bytes < 1024 * 1024) {
      return `${(bytes / 1024).toFixed(1)} KB`;
    }
    if (bytes < 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  }

  /**
   * 解析字符串大小为字节数
   */
  public static parseSizeToBytes(sizeStr?: string): number | undefined {
    if (!sizeStr) return undefined;
    const match = sizeStr.trim().match(/^([\d.]+)\s*(B|KB|MB|GB|TB)$/i);
    if (!match) return undefined;
    const value = parseFloat(match[1]!);
    const unit = match[2]!.toUpperCase();
    switch (unit) {
      case 'B':
        return Math.round(value);
      case 'KB':
        return Math.round(value * 1024);
      case 'MB':
        return Math.round(value * 1024 * 1024);
      case 'GB':
        return Math.round(value * 1024 * 1024 * 1024);
      case 'TB':
        return Math.round(value * 1024 * 1024 * 1024 * 1024);
      default:
        return undefined;
    }
  }

  /**
   * 从文件名提取后缀名
   */
  public static getExtension(fileName: string): string {
    const lastDotIndex = fileName.lastIndexOf('.');
    if (lastDotIndex <= 0 || lastDotIndex === fileName.length - 1) {
      return '';
    }
    return fileName.slice(lastDotIndex + 1).toLowerCase();
  }

  /**
   * 解析单一文件卡片实体
   */
  public parseFileCard(input: KK9FileInfo | KK9Message | string): FileCardInfo | null {
    // 1. 处理 KK9Message 实体
    if (typeof input === 'object' && input !== null && 'content' in input && 'id' in input) {
      if (input.fileInfo) {
        return this.parseFileCard(input.fileInfo);
      }
      if (input.content) {
        return this.parseFileCard(input.content);
      }
      return null;
    }

    // 2. 处理 KK9FileInfo 实体
    if (typeof input === 'object' && input !== null && 'fileName' in input) {
      const fileName = input.fileName.trim();
      if (!fileName) return null;

      const ext = input.fileExt || FileCardAwareness.getExtension(fileName);
      const { category, label } = FileCardAwareness.categorize(ext);
      const fileSizeBytes = FileCardAwareness.parseSizeToBytes(input.fileSize);

      return {
        fileName,
        fileSize: input.fileSize,
        fileSizeBytes,
        fileExt: ext,
        filePath: input.filePath,
        category,
        categoryLabel: label,
        raw: input,
      };
    }

    // 3. 处理字符串格式的文件描述
    if (typeof input === 'string') {
      const text = input.trim();
      if (!text) return null;

      // 匹配 JSON 字符串
      if (text.startsWith('{') && text.endsWith('}')) {
        try {
          const parsed = JSON.parse(text) as Record<string, unknown>;
          if (typeof parsed['fileName'] === 'string') {
            return this.parseFileCard({
              fileName: parsed['fileName'],
              fileSize: typeof parsed['fileSize'] === 'string' ? parsed['fileSize'] : undefined,
              fileExt: typeof parsed['fileExt'] === 'string' ? parsed['fileExt'] : undefined,
              filePath: typeof parsed['filePath'] === 'string' ? parsed['filePath'] : undefined,
            });
          }
        } catch {
          // 忽略 JSON 解析错误，回退到正则
        }
      }

      // 匹配常见文件卡片文本格式: [文件] 考勤表.xlsx (1.2MB) 或 收到文件: test.pdf
      const cardPattern =
        /(?:\[(?:文件|附件|File)\]|收到文件[:：]|发送了文件[:：])\s*([^\s()]+\.[a-zA-Z0-9]+)(?:\s*\(([^()]+)\))?/i;
      const match = text.match(cardPattern);
      if (match) {
        const fileName = match[1]!;
        const sizeStr = match[2]?.trim();
        const ext = FileCardAwareness.getExtension(fileName);
        const { category, label } = FileCardAwareness.categorize(ext);
        return {
          fileName,
          fileSize: sizeStr,
          fileSizeBytes: FileCardAwareness.parseSizeToBytes(sizeStr),
          fileExt: ext,
          category,
          categoryLabel: label,
        };
      }
    }

    return null;
  }

  /**
   * 从聚合消息中提取所有文件卡片
   */
  public extractFileCards(message: ConsolidatedMessage): FileCardInfo[] {
    const cardMap = new Map<string, FileCardInfo>();

    const mergeCard = (card: FileCardInfo): void => {
      const key = card.fileName.toLowerCase().trim();
      const existing = cardMap.get(key);
      if (!existing) {
        cardMap.set(key, card);
        return;
      }
      // 合并更丰富的信息
      if (!existing.filePath && card.filePath) {
        existing.filePath = card.filePath;
      }
      if (!existing.fileSize && card.fileSize) {
        existing.fileSize = card.fileSize;
        existing.fileSizeBytes = card.fileSizeBytes;
      }
      if (!existing.raw && card.raw) {
        existing.raw = card.raw;
      }
    };

    // 1. 从各子消息的 fileInfo 字段中提取
    if (Array.isArray(message.messages)) {
      for (const msg of message.messages) {
        if (msg.fileInfo) {
          const card = this.parseFileCard(msg.fileInfo);
          if (card) {
            mergeCard(card);
          }
        }
      }
    }

    // 2. 从消息合并文本中尝试正则匹配文件卡片标记
    if (message.content) {
      const lines = message.content.split('\n');
      for (const line of lines) {
        const card = this.parseFileCard(line);
        if (card) {
          mergeCard(card);
        }
      }
    }

    const cards = Array.from(cardMap.values());
    log.debug({ sessionId: message.sessionId, count: cards.length }, '提取到文件卡片元数据');
    return cards;
  }

  /**
   * 格式化文件卡片为结构化提示词
   */
  public formatFileCardPrompt(fileCards: FileCardInfo[]): string {
    if (fileCards.length === 0) return '';

    const lines: string[] = [];
    lines.push(`[用户附件数据 - 文件卡片] 收到 ${fileCards.length} 个办公文件卡片附件:`);
    for (const card of fileCards) {
      const sizeInfo = card.fileSize ? ` (${card.fileSize})` : '';
      lines.push(`- 文件: ${card.fileName}${sizeInfo} [${card.categoryLabel}]`);
    }
    lines.push(
      `[提示: 以上为用户发送的文件卡片外部附件元数据。如需深度解析文件数据，请结合具体需求或文件工具处理。]`
    );

    return lines.join('\n');
  }

  /**
   * 将文件卡片元数据注入到消息文本中
   */
  public enhanceMessageContent(originalContent: string, fileCards: FileCardInfo[]): string {
    if (fileCards.length === 0) {
      return originalContent;
    }
    const cardPrompt = this.formatFileCardPrompt(fileCards);
    if (!originalContent || originalContent.trim() === '') {
      return cardPrompt;
    }
    return `${originalContent}\n\n${cardPrompt}`;
  }
}
