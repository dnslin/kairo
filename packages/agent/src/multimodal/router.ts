import { promises as fsPromises, existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { KK9ImageInfo } from '@kkbot/driver';
import type { ConsolidatedMessage } from '../types/index.js';
import type {
  ImageMediaSource,
  MultiModalContentPart,
  MultiModalProcessResult,
  MultiModalRouterOptions,
  OcrEngine,
} from './types.js';
import { FileCardAwareness } from './file-card.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('multimodal-router');

/**
 * 常见图片扩展名与 MIME 类型映射
 */
const IMAGE_MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
};

/**
 * 多模态附件感知与动态路由分流器
 * 负责识别图片媒体、Vision 格式转换、纯文本模型前置 OCR 降级以及办公文件卡片注入
 */
export class MultiModalRouter {
  private fileCardAwareness: FileCardAwareness;
  private defaultOcrEngine?: OcrEngine;
  private defaultVisionDetail: 'auto' | 'low' | 'high';
  private injectImagePlaceholder: boolean;
  private mediaRootDir: string;

  constructor(options?: MultiModalRouterOptions & { mediaRootDir?: string }) {
    this.fileCardAwareness = new FileCardAwareness();
    this.defaultOcrEngine = options?.ocrEngine;
    this.defaultVisionDetail = options?.defaultVisionDetail ?? 'auto';
    this.injectImagePlaceholder = options?.injectImagePlaceholder ?? true;
    this.mediaRootDir = options?.mediaRootDir
      ? path.resolve(options.mediaRootDir)
      : path.resolve(process.cwd(), 'data', 'media');
  }

  /**
   * 推断图片 MIME 类型
   */
  public static inferMimeType(filePathOrUrl: string): string {
    const clean = filePathOrUrl.split('?')[0]?.split('#')[0] ?? filePathOrUrl;
    const lastDotIndex = clean.lastIndexOf('.');
    if (lastDotIndex > 0) {
      const ext = clean.slice(lastDotIndex + 1).toLowerCase();
      if (ext in IMAGE_MIME_MAP) {
        return IMAGE_MIME_MAP[ext]!;
      }
    }
    return 'image/png';
  }

  /**
   * 从驱动结构化图片信息构建 ImageMediaSource
   */
  public static normalizeImageInfo(img: KK9ImageInfo): ImageMediaSource {
    if (img.filePath) {
      return {
        type: 'file_path',
        data: img.filePath,
        mimeType: img.mimeType || MultiModalRouter.inferMimeType(img.filePath),
        width: img.width,
        height: img.height,
        size: img.size,
        fileName: img.filePath.split(/[/\\]/).pop(),
      };
    }
    if (img.url) {
      const isBase64 = img.url.startsWith('data:image/');
      return {
        type: isBase64 ? 'base64' : 'url',
        data: img.url,
        mimeType:
          img.mimeType ||
          (isBase64
            ? img.url.split(';')[0]?.replace('data:', '')
            : MultiModalRouter.inferMimeType(img.url)),
        width: img.width,
        height: img.height,
        size: img.size,
        fileName: isBase64
          ? 'image.png'
          : img.url.split(/[/\\]/).pop()?.split('?')[0],
      };
    }
    if (img.uri) {
      return {
        type: 'uri',
        data: img.uri,
        mimeType: img.mimeType || 'image/png',
        width: img.width,
        height: img.height,
        size: img.size,
        fileName: img.uri.split(/[/\\]/).pop(),
      };
    }
    return {
      type: 'url',
      data: '',
      mimeType: 'image/png',
    };
  }

  /**
   * 将本地文件、Base64 或远程 URL 转换为 Vision API 安全可用的 Data URI 或公开 URL
   * 若本地文件不存在或读取失败，返回 null，严禁将未转化的裸本地路径直接提交给远端 Vision API
   */
  public static async toDataUri(
    img: ImageMediaSource
  ): Promise<string | null> {
    if (!img.data) return null;

    // 1. 已经是 Base64 Data URI
    if (img.data.startsWith('data:image/')) {
      return img.data;
    }
    if (img.type === 'base64') {
      const mime = img.mimeType || 'image/png';
      return `data:${mime};base64,${img.data}`;
    }

    // 2. HTTP / HTTPS 远程公开 URL，直接使用
    if (
      img.type === 'url' ||
      img.data.startsWith('http://') ||
      img.data.startsWith('https://')
    ) {
      return img.data;
    }

    // 3. 本地文件路径 (如结构化 filePath 或受控 data/media/...)
    let localPath = img.data;
    if (localPath.startsWith('file://')) {
      try {
        localPath = fileURLToPath(localPath);
      } catch {
        localPath = localPath.replace(/^file:\/\/\/?/, '');
      }
    }

    try {
      if (existsSync(localPath)) {
        const buffer = await fsPromises.readFile(localPath);
        const mime = img.mimeType || MultiModalRouter.inferMimeType(localPath);
        return `data:${mime};base64,${buffer.toString('base64')}`;
      }
    } catch (err) {
      log.warn(
        { path: localPath, err: err instanceof Error ? err.message : String(err) },
        '读取本地图片文件转 Base64 失败'
      );
    }

    return null;
  }

  /**
   * 从聚合消息与子消息中检测所有图片媒体
   * 严格安全沙箱约束：驱动层结构化 KK9Message.images 允许信任本地路径；
   * 正文纯文本中严禁识别任意绝对路径 (C:\...) 避免外带探测本地文件，
   * 仅接受 HTTP(S) URL、Base64 Data URI 或受控 data/media/ 相对路径。
   */
  public detectImages(message: ConsolidatedMessage): ImageMediaSource[] {
    const images: ImageMediaSource[] = [];
    const seen = new Set<string>();

    const addImage = (source: ImageMediaSource): void => {
      if (!source.data) return;
      const key = `${source.type}_${source.data}`;
      if (!seen.has(key)) {
        seen.add(key);
        images.push(source);
      }
    };

    // 1. 从驱动层结构化 KK9Message.images 字段中提取 (受信任来源)
    if (Array.isArray(message.messages)) {
      for (const msg of message.messages) {
        if (Array.isArray(msg.images)) {
          for (const img of msg.images) {
            const normalized = MultiModalRouter.normalizeImageInfo(img);
            addImage(normalized);
          }
        }
      }
    }

    // 2. 从未受信消息正文中通过严格正则识别安全媒体 (Base64, HTTP/HTTPS URL, 受控 data/media)
    if (message.content) {
      // 2.1 识别 Base64 数据 URI
      const base64Regex =
        /data:image\/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+/g;
      let b64Match: RegExpExecArray | null;
      while ((b64Match = base64Regex.exec(message.content)) !== null) {
        const dataUri = b64Match[0];
        const mime = `image/${b64Match[1] === 'jpg' ? 'jpeg' : b64Match[1]}`;
        addImage({
          type: 'base64',
          data: dataUri,
          mimeType: mime,
          fileName: 'inline-image.png',
        });
      }

      // 2.2 识别 HTTP / HTTPS 网络图片 URL
      const httpRegex =
        /https?:\/\/[^\s<>"'\n]+\.(?:png|jpg|jpeg|gif|webp|bmp)(?:\?[^\s<>"'\n]*)?/gi;
      let httpMatch: RegExpExecArray | null;
      while ((httpMatch = httpRegex.exec(message.content)) !== null) {
        const url = httpMatch[0];
        addImage({
          type: 'url',
          data: url,
          mimeType: MultiModalRouter.inferMimeType(url),
          fileName: url.split(/[/\\]/).pop()?.split('?')[0],
        });
      }

      // 2.3 识别受控 data/media/ 相对路径 (严格路径穿越校验)
      const controlledMediaRegex =
        /(?:data\/media\/|\/data\/media\/)([^\s<>"'\n]+\.(?:png|jpg|jpeg|gif|webp|bmp))/gi;
      let mediaMatch: RegExpExecArray | null;
      while ((mediaMatch = controlledMediaRegex.exec(message.content)) !== null) {
        const subPath = mediaMatch[1]!;
        // 校验是否存在路径穿越 (../)
        const normalizedSubPath = path.normalize(subPath);
        if (!normalizedSubPath.startsWith('..') && !path.isAbsolute(normalizedSubPath)) {
          const resolvedPath = path.resolve(this.mediaRootDir, normalizedSubPath);
          // 必须严格落在 mediaRootDir 内
          if (resolvedPath.startsWith(this.mediaRootDir)) {
            addImage({
              type: 'file_path',
              data: resolvedPath,
              mimeType: MultiModalRouter.inferMimeType(resolvedPath),
              fileName: path.basename(resolvedPath),
            });
          }
        }
      }
    }

    log.debug(
      { sessionId: message.sessionId, count: images.length },
      '检测到消息中的图片媒体'
    );
    return images;
  }

  /**
   * 处理消息中的多模态附件，根据模型能力构建 Vision 格式或执行 OCR 降级
   */
  public async process(
    message: ConsolidatedMessage,
    options?: {
      modelSupportsVision?: boolean;
      ocrEngine?: OcrEngine;
    }
  ): Promise<MultiModalProcessResult> {
    const supportsVision = options?.modelSupportsVision ?? false;
    const ocrEngine = options?.ocrEngine ?? this.defaultOcrEngine;

    // 1. 提取并注入办公文件卡片
    const fileCards = this.fileCardAwareness.extractFileCards(message);
    let enhancedContent = this.fileCardAwareness.enhanceMessageContent(
      message.content,
      fileCards
    );

    // 2. 检测图片媒体
    const images = this.detectImages(message);
    const hasImages = images.length > 0;
    const hasFileCards = fileCards.length > 0;

    let multiModalParts: MultiModalContentPart[] | undefined;
    let ocrPerformed = false;
    const ocrResults: Array<{ source: ImageMediaSource; text: string }> = [];

    if (hasImages) {
      if (supportsVision) {
        // 主模型具备 Vision 能力：构建标准多模态 Content Parts
        const validParts: MultiModalContentPart[] = [];
        const missingImageNotes: string[] = [];

        for (const img of images) {
          const imageUrl = await MultiModalRouter.toDataUri(img);
          if (imageUrl) {
            validParts.push({
              type: 'image_url',
              imageUrl: {
                url: imageUrl,
                detail: this.defaultVisionDetail,
              },
            });
          } else {
            // 本地图片缺失/无法访问，记录提示，严禁将裸本地路径传入 Vision API
            const label = img.fileName || img.data;
            missingImageNotes.push(
              `[用户附件数据 - 图片附件] ${label} (本地图片文件不存在或无法读取，已跳过视觉输入)`
            );
          }
        }

        if (missingImageNotes.length > 0) {
          const missingBlock = missingImageNotes.join('\n');
          enhancedContent = enhancedContent
            ? `${enhancedContent}\n\n${missingBlock}`
            : missingBlock;
        }

        if (validParts.length > 0) {
          multiModalParts = [
            {
              type: 'text',
              text: enhancedContent,
            },
            ...validParts,
          ];
        }

        log.info(
          {
            sessionId: message.sessionId,
            imageCount: images.length,
            validVisionCount: validParts.length,
          },
          '主模型支持 Vision 能力，已构建多模态消息'
        );
      } else {
        // 主模型为纯文本模型：前置执行 OCR 工具降级提取文字，注入上下文
        log.info(
          { sessionId: message.sessionId, imageCount: images.length },
          '主模型为纯文本模型，执行 OCR 降级提取文字'
        );
        ocrPerformed = true;

        const ocrPromptSections: string[] = [];

        for (const img of images) {
          let extractedText = '';
          if (ocrEngine) {
            try {
              const res = await ocrEngine(img);
              if (typeof res === 'string') {
                extractedText = res.trim();
              } else if (res && typeof res.text === 'string') {
                extractedText = res.text.trim();
              }
            } catch (err) {
              log.warn(
                { img: img.fileName || img.data, err },
                'OCR 引擎文字提取异常'
              );
            }
          }

          if (extractedText) {
            ocrResults.push({ source: img, text: extractedText });
            const nameLabel = img.fileName ? `[${img.fileName}]` : '';
            ocrPromptSections.push(
              `[用户附件数据 - 图片文字识别 ${nameLabel}]:\n${extractedText}`
            );
          } else if (this.injectImagePlaceholder) {
            const nameLabel = img.fileName || img.data;
            ocrPromptSections.push(
              `[用户附件数据 - 图片附件] ${nameLabel} (注: 当前推理模型为纯文本模型，OCR 未提取到文字内容)`
            );
          }
        }

        if (ocrPromptSections.length > 0) {
          const ocrTextBlock = ocrPromptSections.join('\n\n');
          enhancedContent = enhancedContent
            ? `${enhancedContent}\n\n${ocrTextBlock}`
            : ocrTextBlock;
        }
      }
    }

    return {
      enhancedContent,
      multiModalParts,
      hasImages,
      hasFileCards,
      images,
      fileCards,
      ocrPerformed,
      ocrResults,
    };
  }

  /**
   * 获取内部文件卡片解析器实例
   */
  public getFileCardAwareness(): FileCardAwareness {
    return this.fileCardAwareness;
  }
}
