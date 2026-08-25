import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DatabaseLocation {
  /** 是否为纯内存数据库 */
  isMemory: boolean;
  /** 规范化绝对文件系统路径（内存数据库为 :memory:） */
  absolutePath: string;
  /** 用于 @libsql/client 与 LibSQLStore 的规范化 file: URL */
  fileUrl: string;
}

/**
 * 判定输入是否为内存数据库
 */
export function isMemoryDbUrl(raw: string): boolean {
  if (!raw) return false;
  const trimmed = raw.trim();
  return (
    trimmed === ':memory:' ||
    trimmed.startsWith('file::memory:') ||
    trimmed.includes('mode=memory') ||
    trimmed.includes(':memory:?')
  );
}

/**
 * 将任意形式的数据库配置路径/URL 规范化为唯一绝对路径与唯一 file: URL
 * 确保不同相对路径写法解析为同一个物理文件，绝不产生第二个数据库文件。
 *
 * @param rawPathOrUrl 原始路径或 URL 配置（如 ./data/kkbot.db, file:./data/kkbot.db, :memory: 等）
 * @param baseDir 基准工作目录（默认为 process.cwd()）
 */
export function resolveDatabaseLocation(
  rawPathOrUrl: string,
  baseDir?: string
): DatabaseLocation {
  const trimmed = rawPathOrUrl.trim();

  if (isMemoryDbUrl(trimmed)) {
    return {
      isMemory: true,
      absolutePath: ':memory:',
      fileUrl: trimmed.startsWith('file:') ? trimmed : `file:${trimmed}`,
    };
  }
  const effectiveBase = baseDir ? path.resolve(baseDir) : process.cwd();
  let absolutePath: string;

  if (trimmed.startsWith('file:')) {
    try {
      // 处理标准绝对 file:// URL
      const parsed = fileURLToPath(trimmed);
      absolutePath = path.normalize(path.resolve(effectiveBase, parsed));
    } catch {
      // 处理非标准/相对 file:./... 路径
      const rawSub = trimmed.slice(5);
      absolutePath = path.normalize(path.resolve(effectiveBase, rawSub));
    }
  } else {
    absolutePath = path.normalize(path.resolve(effectiveBase, trimmed));
  }

  const fileUrl = `file:${absolutePath}`;
  return {
    isMemory: false,
    absolutePath,
    fileUrl,
  };
}
