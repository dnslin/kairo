import type { KK9FileInfo } from '@kkbot/driver';
/**
 * 图片资源来源类型
 */
export type ImageSourceType = 'file_path' | 'base64' | 'url' | 'uri';

/**
 * 结构化图片媒体实体
 */
export interface ImageMediaSource {
  /** 来源类型 */
  type: ImageSourceType;
  /** 路径、URL 或 Base64 数据字符串 */
  data: string;
  /** 图片 MIME 类型 (如 image/png, image/jpeg, image/webp) */
  mimeType?: string;
  /** 图片宽度 */
  width?: number;
  /** 图片高度 */
  height?: number;
  /** 图片字节体积 */
  size?: number;
  /** 原始文件名 */
  fileName?: string;
}

/**
 * 多模态消息内容片段契约
 */
export type MultiModalContentPart =
  | {
      type: 'text';
      text: string;
    }
  | {
      type: 'image_url';
      imageUrl: {
        url: string;
        detail?: 'auto' | 'low' | 'high';
      };
    };

/**
 * OCR 文字提取结果
 */
export interface OcrResult {
  /** 识别出的文字内容 */
  text: string;
  /** 识别置信度 (0 ~ 1) */
  confidence?: number;
  /** 检测到的语言 */
  detectedLanguage?: string;
  /** 原始底层响应备份 */
  raw?: unknown;
}

/**
 * OCR 识别引擎函数类型
 */
export type OcrEngine = (
  image: ImageMediaSource | string
) => Promise<string | OcrResult> | string | OcrResult;

/**
 * 办公文件卡片业务类别
 */
export type FileCategory =
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'pdf'
  | 'archive'
  | 'code'
  | 'audio'
  | 'video'
  | 'image'
  | 'other';

/**
 * 解析后的文件卡片元数据
 */
export interface FileCardInfo {
  /** 文件名称 (含后缀) */
  fileName: string;
  /** 格式化后的文件大小 (如 1.2MB, 512KB) */
  fileSize?: string;
  /** 文件字节数 */
  fileSizeBytes?: number;
  /** 文件扩展名 (小写，不带点，如 xlsx, pdf) */
  fileExt: string;
  /** 本地文件路径 (若存在) */
  filePath?: string;
  /** 文件业务分类 */
  category: FileCategory;
  /** 文件分类中文标签 (如 电子表格/数据分析) */
  categoryLabel: string;
  /** 原始 KK9FileInfo 引用 */
  raw?: KK9FileInfo;
}

/**
 * 多模态路由处理选项
 */
export interface MultiModalRouterOptions {
  /** 默认 OCR 识别引擎 */
  ocrEngine?: OcrEngine;
  /** Vision 模型图片分辨率细节模式 */
  defaultVisionDetail?: 'auto' | 'low' | 'high';
  /** 是否在没有 OCR 时自动注入友好提示占位符 (默认 true) */
  injectImagePlaceholder?: boolean;
}

/**
 * 多模态消息处理最终结果
 */
export interface MultiModalProcessResult {
  /** 增强后的文本内容 (注入了文件卡片摘要或 OCR 降级文字) */
  enhancedContent: string;
  /** 若目标模型具备 Vision 能力，组装的多模态 Content Parts */
  multiModalParts?: MultiModalContentPart[];
  /** 是否检测到图片媒体 */
  hasImages: boolean;
  /** 是否检测到办公文件卡片 */
  hasFileCards: boolean;
  /** 识别到的所有图片媒体列表 */
  images: ImageMediaSource[];
  /** 识别到的所有文件卡片列表 */
  fileCards: FileCardInfo[];
  /** 是否执行了 OCR 降级 */
  ocrPerformed: boolean;
  /** OCR 提取记录明细 */
  ocrResults: Array<{
    source: ImageMediaSource;
    text: string;
  }>;
}
