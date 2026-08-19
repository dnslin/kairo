import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import type { MediaFileInfo, MediaStorageOptions } from '../types/index.js';
import { InvalidPathError, MediaStorageError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('media-storage');

/**
 * 默认多模态存储参数
 */
export const DEFAULT_MEDIA_STORAGE_OPTIONS: Required<MediaStorageOptions> = {
  baseDir: 'data/media',
  imagesSubDir: 'images',
  filesSubDir: 'files',
  maxFileSize: 100 * 1024 * 1024, // 100 MB
};

/**
 * 常见文件扩展名与 MIME 类型的映射表
 */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
};

/**
 * 多模态本地化转存管理器
 * 负责接收外部图片与文件，安全转存至本地受控目录，计算 SHA-256 去重指纹并持久化相对路径
 */
export class MediaStorage {
  private readonly baseDir: string;
  private readonly imagesSubDir: string;
  private readonly filesSubDir: string;
  private readonly maxFileSize: number;

  constructor(options?: MediaStorageOptions) {
    const opts = { ...DEFAULT_MEDIA_STORAGE_OPTIONS, ...options };
    this.baseDir = resolve(process.cwd(), opts.baseDir);
    this.imagesSubDir = opts.imagesSubDir;
    this.filesSubDir = opts.filesSubDir;
    this.maxFileSize = opts.maxFileSize;

    this.ensureDirectorySync(this.baseDir);
  }

  /**
   * 获取基础存储绝对路径
   */
  public getBaseDir(): string {
    return this.baseDir;
  }

  /**
   * 将受控相对路径安全转换为绝对路径，并校验路径防遍历越界
   * @param relativePath 相对路径 (如 `images/2026-08/sample.png`)
   */
  public getMediaAbsolutePath(relativePath: string): string {
    if (!relativePath || typeof relativePath !== 'string') {
      throw new InvalidPathError('媒体相对路径不能为空');
    }

    // 检查非法字符或跨目录字符
    const normalizedInput = normalize(relativePath).replace(/^[/\\]+/, '');
    const absoluteTarget = resolve(this.baseDir, normalizedInput);
    const rel = relative(this.baseDir, absoluteTarget);

    if (rel.startsWith('..') || isAbsolute(rel)) {
      log.warn({ relativePath, absoluteTarget }, '检测到越界或非法的路径遍历访问');
      throw new InvalidPathError(`非法路径访问，目标超出受控目录: ${relativePath}`);
    }

    return absoluteTarget;
  }

  /**
   * 同步检查指定相对路径的媒体文件是否存在
   * @param relativePath 相对路径
   */
  public mediaExists(relativePath: string): boolean {
    try {
      const absPath = this.getMediaAbsolutePath(relativePath);
      return existsSync(absPath);
    } catch {
      return false;
    }
  }

  /**
   * 保存内存中的 Buffer 数据至受控媒体目录
   *
   * @param buffer 二进制 Buffer
   * @param originalName 原始文件名（用于推导扩展名及保留部分文件名）
   * @param options 转存选项
   */
  public async saveMediaBuffer(
    buffer: Buffer | Uint8Array,
    originalName: string,
    options?: { subDir?: string; customFileName?: string }
  ): Promise<MediaFileInfo> {
    try {
      if (buffer.byteLength > this.maxFileSize) {
        throw new MediaStorageError(
          `文件大小 (${buffer.byteLength} 字节) 超过最大限制 (${this.maxFileSize} 字节)`
        );
      }

      const hash = createHash('sha256').update(buffer).digest('hex');
      const ext = extname(originalName).toLowerCase();
      const mimeType = EXT_TO_MIME[ext] || 'application/octet-stream';
      const cleanOriginalName = basename(originalName);

      // 根据文件类型推导子目录
      const defaultSubDir = this.isImageExt(ext) ? this.imagesSubDir : this.filesSubDir;
      const targetSubDir = options?.subDir || defaultSubDir;

      // 生成年月分区子目录 (如 images/2026-08)
      const datePart = this.getCurrentDatePart();
      const relativeFolder = join(targetSubDir, datePart);
      const absoluteFolder = join(this.baseDir, relativeFolder);

      await mkdir(absoluteFolder, { recursive: true });

      // 生成唯一存储文件名
      const finalFileName =
        options?.customFileName ||
        `${hash.slice(0, 16)}_${Date.now()}_${this.sanitizeFileName(cleanOriginalName)}`;
      const relativePath = this.normalizePosixPath(join(relativeFolder, finalFileName));
      const absolutePath = resolve(this.baseDir, relativePath);

      await writeFile(absolutePath, buffer);

      log.debug(
        { originalName, relativePath, size: buffer.byteLength, hash },
        '多模态 Buffer 成功写入受控目录'
      );

      return {
        originalName: cleanOriginalName,
        fileName: finalFileName,
        relativePath,
        absolutePath,
        size: buffer.byteLength,
        extension: ext,
        sha256: hash,
        mimeType,
        createdAt: Date.now(),
      };
    } catch (error) {
      if (error instanceof InvalidPathError || error instanceof MediaStorageError) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, originalName }, '保存多模态 Buffer 失败');
      throw new MediaStorageError(`保存多模态文件失败: ${err.message || '未知异常'}`, err);
    }
  }

  /**
   * 从外部已有文件路径异步复制转存至受控媒体目录
   *
   * @param sourceFilePath 来源文件绝对/相对路径
   * @param options 转存选项
   */
  public async saveMediaFile(
    sourceFilePath: string,
    options?: { subDir?: string; customFileName?: string }
  ): Promise<MediaFileInfo> {
    try {
      const resolvedSource = resolve(process.cwd(), sourceFilePath);
      if (!existsSync(resolvedSource)) {
        throw new MediaStorageError(`源文件不存在: ${sourceFilePath}`);
      }

      const fileStats = await stat(resolvedSource);
      if (fileStats.size > this.maxFileSize) {
        throw new MediaStorageError(
          `文件大小 (${fileStats.size} 字节) 超过最大限制 (${this.maxFileSize} 字节)`
        );
      }

      const fileBuffer = await readFile(resolvedSource);
      const originalName = basename(resolvedSource);

      return await this.saveMediaBuffer(fileBuffer, originalName, options);
    } catch (error) {
      if (error instanceof InvalidPathError || error instanceof MediaStorageError) {
        throw error;
      }
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sourceFilePath }, '转存外部文件失败');
      throw new MediaStorageError(`转存外部文件失败: ${err.message || '未知异常'}`, err);
    }
  }

  /**
   * 安全删除受控目录下的媒体文件
   * @param relativePath 相对路径
   */
  public async deleteMedia(relativePath: string): Promise<boolean> {
    try {
      const absPath = this.getMediaAbsolutePath(relativePath);
      if (!existsSync(absPath)) {
        return false;
      }
      await unlink(absPath);
      log.debug({ relativePath }, '受控媒体文件已删除');
      return true;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.warn({ err, relativePath }, '删除受控媒体文件失败');
      return false;
    }
  }

  /**
   * 确保目录存在
   */
  private ensureDirectorySync(dirPath: string): void {
    if (!existsSync(dirPath)) {
      mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * 判断是否为图片扩展名
   */
  private isImageExt(ext: string): boolean {
    return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp', '.ico'].includes(
      ext.toLowerCase()
    );
  }

  /**
   * 获取当前 YYYY-MM 年月字符串
   */
  private getCurrentDatePart(): string {
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
  }

  /**
   * 净化文件名中的非法特殊字符
   */
  private sanitizeFileName(name: string): string {
    return name.replace(/[/\\?%*:|"<>]/g, '_');
  }

  /**
   * 统一将路径转换为 POSIX 斜杠风格（适用于跨平台相对路径存储）
   */
  private normalizePosixPath(p: string): string {
    return p.replace(/\\/g, '/');
  }
}
