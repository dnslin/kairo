import { createClient, type Client, type Config as LibsqlConfig } from '@libsql/client';
export { createClient, type Client, type LibsqlConfig };
import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { DatabaseOptions } from '../types/index.js';
import { DatabaseConnectionError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import { initSchema } from './schema.js';

const log = createChildLogger('connection');

const tempDbFiles = new WeakMap<Client, string>();

/**
 * 默认数据库连接参数
 */
export const DEFAULT_DATABASE_OPTIONS: Required<DatabaseOptions> = {
  path: ':memory:',
  wal: true,
  busyTimeout: 5000,
  foreignKeys: true,
  synchronous: 'NORMAL',
  cacheSize: -64000,
  readOnly: false,
};

/**
 * 判定指定路径是否为内存数据库
 */
export function isMemoryDatabase(path: string): boolean {
  return (
    path === ':memory:' ||
    path === 'file::memory:' ||
    path.startsWith(':memory:') ||
    path.startsWith('file::memory:') ||
    path.includes(':memory:') ||
    path === ''
  );
}

/**
 * 将路径转换为 @libsql/client 支持的 URL
 */
export function resolveDatabaseUrl(path: string): {
  url: string;
  isMemory: boolean;
  tempFile?: string;
} {
  if (isMemoryDatabase(path)) {
    const tempFile = join(tmpdir(), `kkbot_mem_${Date.now()}_${randomUUID()}.db`);
    return {
      url: `file:${tempFile}`,
      isMemory: true,
      tempFile,
    };
  }

  if (
    path.startsWith('file:') ||
    path.startsWith('libsql:') ||
    path.startsWith('http:') ||
    path.startsWith('https:') ||
    path.startsWith('ws:') ||
    path.startsWith('wss:')
  ) {
    return {
      url: path,
      isMemory: false,
    };
  }

  return {
    url: `file:${path}`,
    isMemory: false,
  };
}

/**
 * 创建并初始化 LibSQL 数据库异步连接实例
 * 默认启用 WAL 模式、外键约束与预设 Pragma 性能调优
 *
 * @param options 数据库配置项
 * @returns 初始化完成且已执行 DDL 建表的 Client 实例
 */
export async function createDatabaseClient(options?: DatabaseOptions): Promise<Client> {
  const mergedOptions: Required<DatabaseOptions> = {
    ...DEFAULT_DATABASE_OPTIONS,
    ...options,
  };

  const { path, wal, busyTimeout, foreignKeys, synchronous, cacheSize } = mergedOptions;
  const { url, isMemory, tempFile } = resolveDatabaseUrl(path);

  try {
    if (!isMemory && url.startsWith('file:')) {
      const rawFilePath = url.slice(5).split('?')[0] || '';
      const dir = dirname(rawFilePath);
      if (dir && dir !== '.' && !existsSync(dir)) {
        log.info({ dir }, '创建数据库存储目录');
        mkdirSync(dir, { recursive: true });
      }
    }

    log.info({ path, url, isMemory, wal }, '正在建立 LibSQL 数据库连接...');

    const client = createClient({
      url,
    });

    if (tempFile) {
      tempDbFiles.set(client, tempFile);
    }

    // 启用外键约束
    if (foreignKeys) {
      await client.execute('PRAGMA foreign_keys = ON;');
    }

    // 设置繁忙超时等待
    if (busyTimeout > 0) {
      await client.execute(`PRAGMA busy_timeout = ${busyTimeout};`);
    }

    // 非内存数据库配置 WAL 模式与同步策略
    if (!isMemory) {
      if (wal) {
        await client.execute('PRAGMA journal_mode = WAL;');
        log.debug('SQLite 日志模式已设置为 WAL');
      }
      if (synchronous) {
        await client.execute(`PRAGMA synchronous = ${synchronous};`);
      }
      if (cacheSize) {
        await client.execute(`PRAGMA cache_size = ${cacheSize};`);
      }
      await client.execute('PRAGMA temp_store = MEMORY;');
    }

    // 异步初始化表结构与索引 DDL
    await initSchema(client);

    log.info({ path, url }, 'LibSQL 数据库连接与结构初始化成功');
    return client;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err, path, url }, '创建 LibSQL 数据库连接失败');
    throw new DatabaseConnectionError(`连接数据库失败 [${path}]: ${err.message}`, err);
  }
}

/**
 * 别名导出，保持向后兼容
 */
export const createDatabase = createDatabaseClient;

/**
 * 优雅关闭数据库连接
 *
 * @param client LibSQL 客户端实例
 */
export function closeDatabase(client: Client): void {
  try {
    log.info('正在关闭 LibSQL 数据库连接...');
    const tempFile = tempDbFiles.get(client);
    client.close();
    if (tempFile) {
      try {
        if (existsSync(tempFile)) unlinkSync(tempFile);
        const wal = `${tempFile}-wal`;
        if (existsSync(wal)) unlinkSync(wal);
        const shm = `${tempFile}-shm`;
        if (existsSync(shm)) unlinkSync(shm);
      } catch {
        // 忽略 Windows 暂缓删除异常
      }
    }
    log.info('LibSQL 数据库连接已安全关闭');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.warn({ err }, '关闭数据库连接时发生异常');
  }
}
