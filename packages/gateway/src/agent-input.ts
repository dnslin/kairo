import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { MessageInput } from '@mastra/core/agent/message-list';
import type { KK9FileInfo, KK9ImageInfo } from '@kkbot/driver';
import type { MastraAgentInput, NormalizedAttachmentFact } from '@kkbot/agent';
import type { MediaFileInfo, MediaStorage } from '@kkbot/store';
import type { ConsolidatedMessage } from './types/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('agent-input');

type MastraTextPart = {
  type: 'text';
  text: string;
};

type MastraImagePart = {
  type: 'image';
  image: string;
  mediaType?: string;
};

interface ImagePartResult {
  part?: MastraImagePart;
  label: string;
  mediaType?: string;
}

function extractDataUriMimeType(source: string): string | undefined {
  const match = source.match(/^data:([^;,]+)(?:;[^,]*)?,/i);
  const mediaType = match?.[1]?.trim().toLowerCase();
  return mediaType?.startsWith('image/') ? mediaType : undefined;
}

function resolveImageMimeType(
  image: KK9ImageInfo,
  source: string,
  mediaStorage: MediaStorage
): string | undefined {
  const dataUriMimeType = extractDataUriMimeType(source);
  if (dataUriMimeType) {
    return dataUriMimeType;
  }

  const explicitMimeType = image.mimeType?.trim().toLowerCase();
  if (explicitMimeType?.startsWith('image/')) {
    return explicitMimeType;
  }
  return mediaStorage.getImageMimeType(source);
}

function resolveImageSources(image: KK9ImageInfo): string[] {
  return Array.from(
    new Set(
      [image.filePath, image.url, image.uri].filter(
        (source): source is string => typeof source === 'string' && source.length > 0
      )
    )
  );
}

function resolveImageLabel(source: string | undefined): string {
  if (!source || source.startsWith('data:image/')) {
    return '图片附件';
  }
  const cleanSource = source.split(/[?#]/, 1)[0] ?? source;
  return cleanSource.split(/[\\/]/).pop() || '图片附件';
}

function resolveLocalImagePath(source: string): string | null {
  if (!source.startsWith('file://')) {
    return source;
  }

  try {
    return fileURLToPath(new URL(source));
  } catch {
    return null;
  }
}
async function deleteTemporaryMedia(
  mediaStorage: MediaStorage,
  relativePath: string,
  label: string
): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await mediaStorage.deleteMedia(relativePath)) {
      return;
    }
    if (attempt < 2) {
      await delay(25);
    }
  }
  throw new Error(`临时图片附件清理失败: ${label} (${relativePath})`);
}

interface ImageInputBudget {
  usedBytes: number;
  maxBytes: number;
}

async function createImagePart(
  image: KK9ImageInfo,
  mediaStorage: MediaStorage,
  budget: ImageInputBudget
): Promise<ImagePartResult> {
  const sources = resolveImageSources(image);
  const label = resolveImageLabel(sources[0]);
  if (sources.length === 0) {
    return { label };
  }

  for (const source of sources) {
    const mediaType = resolveImageMimeType(image, source, mediaStorage);
    if (source.startsWith('data:image/')) {
      if (!mediaType) {
        log.warn({ image: label }, '图片 Data URI 缺少可信 MIME 类型，跳过该来源');
        continue;
      }
      const sourceBytes = Buffer.byteLength(source, 'utf8');
      if (budget.usedBytes + sourceBytes > budget.maxBytes) {
        log.warn(
          { image: label, size: sourceBytes, maxSize: budget.maxBytes },
          '图片附件超过本轮输入上限'
        );
        continue;
      }
      budget.usedBytes += sourceBytes;
      return {
        label,
        mediaType,
        part: { type: 'image', image: source, mediaType },
      };
    }

    if (/^https?:\/\//i.test(source)) {
      try {
        const parsedUrl = new URL(source);
        return {
          label,
          mediaType,
          part: { type: 'image', image: parsedUrl.toString(), mediaType },
        };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        log.warn({ err, image: label }, '图片附件 URL 无法解析，尝试下一个来源');
        continue;
      }
    }

    if (!mediaType) {
      log.warn({ image: label }, '图片附件缺少可信 MIME 类型，跳过该来源');
      continue;
    }

    let storedFile: MediaFileInfo | undefined;
    try {
      const localPath = resolveLocalImagePath(source);
      if (!localPath) {
        log.warn({ image: label }, '图片附件本地路径无法解析，尝试下一个来源');
        continue;
      }

      storedFile = await mediaStorage.saveMediaFile(localPath, { subDir: 'images' });
      if (budget.usedBytes + storedFile.size > budget.maxBytes) {
        log.warn(
          { image: label, size: storedFile.size, maxSize: budget.maxBytes },
          '图片附件超过本轮输入上限'
        );
        return { label, mediaType };
      }

      const data = await readFile(storedFile.absolutePath);
      if (budget.usedBytes + data.byteLength > budget.maxBytes) {
        log.warn(
          { image: label, size: data.byteLength, maxSize: budget.maxBytes },
          '图片附件读取后超过本轮输入上限'
        );
        continue;
      }

      const storedMediaType = storedFile.mimeType?.startsWith('image/')
        ? storedFile.mimeType
        : mediaType;
      if (!storedMediaType) {
        log.warn({ image: label }, '转存图片附件缺少可信 MIME 类型，跳过该来源');
        continue;
      }
      budget.usedBytes += data.byteLength;
      return {
        label,
        mediaType: storedMediaType,
        part: {
          type: 'image',
          image: `data:${storedMediaType};base64,${data.toString('base64')}`,
          mediaType: storedMediaType,
        },
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn({ err, image: label }, '转存 KK9 图片附件失败，尝试下一个来源');
    } finally {
      if (storedFile) {
        await deleteTemporaryMedia(mediaStorage, storedFile.relativePath, label);
      }
    }
  }

  return { label };
}

function imageMimeTypeFromFileInfo(
  fileInfo: KK9FileInfo,
  mediaStorage: MediaStorage
): string | undefined {
  const explicitExtension = fileInfo.fileExt?.trim();
  return mediaStorage.getImageMimeType(explicitExtension || fileInfo.fileName);
}

function imageFromFileInfo(fileInfo: KK9FileInfo, mediaStorage: MediaStorage): KK9ImageInfo | null {
  const mediaType = imageMimeTypeFromFileInfo(fileInfo, mediaStorage);
  if (!mediaType || !fileInfo.filePath) {
    return null;
  }
  return { filePath: fileInfo.filePath, mimeType: mediaType };
}

function collectImages(message: ConsolidatedMessage, mediaStorage: MediaStorage): KK9ImageInfo[] {
  const images: KK9ImageInfo[] = [];
  const seen = new Set<string>();

  const addImage = (image: KK9ImageInfo): void => {
    const key = image.filePath ?? image.url ?? image.uri ?? `empty-${images.length}`;
    if (!seen.has(key)) {
      seen.add(key);
      images.push(image);
    }
  };

  for (const item of message.messages) {
    for (const image of item.images ?? []) {
      addImage(image);
    }
    const fileImage = item.fileInfo ? imageFromFileInfo(item.fileInfo, mediaStorage) : null;
    if (fileImage) {
      addImage(fileImage);
    }
  }

  return images;
}

function collectFileNotes(message: ConsolidatedMessage): string[] {
  const notes: string[] = [];
  const seen = new Set<string>();

  for (const item of message.messages) {
    const fileInfo = item.fileInfo;
    if (!fileInfo?.fileName) {
      continue;
    }

    const key = fileInfo.fileName.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    const size = fileInfo.fileSize ? ` (${fileInfo.fileSize})` : '';
    notes.push(`[用户附件数据 - 文件卡片] ${fileInfo.fileName}${size}`);
  }

  return notes;
}
function collectVisualFileFacts(
  message: ConsolidatedMessage,
  images: KK9ImageInfo[],
  mediaStorage: MediaStorage
): NormalizedAttachmentFact[] {
  const facts: NormalizedAttachmentFact[] = [];
  const imagePaths = new Set(images.map(image => image.filePath).filter(Boolean));

  for (const item of message.messages) {
    const fileInfo = item.fileInfo;
    if (!fileInfo?.fileName) {
      continue;
    }

    const mediaType = imageMimeTypeFromFileInfo(fileInfo, mediaStorage);
    if (!mediaType || (fileInfo.filePath && imagePaths.has(fileInfo.filePath))) {
      continue;
    }

    facts.push({
      mediaType,
      filename: fileInfo.fileName,
      isVisual: true,
      hasCompleteTrustedText: false,
    });
  }

  return facts;
}

function createAttachmentFacts(
  images: KK9ImageInfo[],
  imageResults: ImagePartResult[],
  mediaStorage: MediaStorage
): NormalizedAttachmentFact[] {
  return images.map((image, index) => {
    const source = image.filePath ?? image.url ?? image.uri;
    return {
      mediaType:
        imageResults[index]?.mediaType ?? resolveImageMimeType(image, source ?? '', mediaStorage),
      filename: imageResults[index]?.label ?? resolveImageLabel(source),
      isVisual: true,
      hasCompleteTrustedText: false,
    };
  });
}

/**
 * 将 KK9 结构化附件转换为 Mastra Agent 的公开消息输入与 Tier 分类事实。
 */
export async function createMastraAgentInput(
  message: ConsolidatedMessage,
  mediaStorage: MediaStorage
): Promise<MastraAgentInput> {
  const images = collectImages(message, mediaStorage);
  const imageBudget: ImageInputBudget = {
    usedBytes: 0,
    maxBytes: mediaStorage.getMaxFileSize(),
  };
  const imageResults: ImagePartResult[] = [];
  for (const image of images) {
    imageResults.push(await createImagePart(image, mediaStorage, imageBudget));
  }
  const fileNotes = collectFileNotes(message);
  const missingImageNotes = imageResults
    .filter(result => !result.part)
    .map(result => `[用户附件数据 - 图片附件] ${result.label}（图片内容不可用，已跳过视觉输入）`);
  const textSections = [message.content.trim(), ...fileNotes, ...missingImageNotes].filter(Boolean);
  const text = textSections.join('\n\n') || '[图片附件]';
  const imageParts = imageResults.flatMap(result => (result.part ? [result.part] : []));
  const content: string | Array<MastraTextPart | MastraImagePart> =
    imageParts.length > 0 ? [{ type: 'text', text }, ...imageParts] : text;

  const userMessage: MessageInput = {
    role: 'user',
    content,
  };

  const fileFacts = collectVisualFileFacts(message, images, mediaStorage);
  const attachmentFacts = [
    ...(images.length > 0 ? createAttachmentFacts(images, imageResults, mediaStorage) : []),
    ...fileFacts,
  ];
  return {
    kind: 'mastra-message',
    tierInput: {
      text,
      attachments: attachmentFacts.length > 0 ? attachmentFacts : undefined,
    },
    message: userMessage,
  };
}
