import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { DatabaseOptions } from '../types/index.js';
import { DatabaseConnectionError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import { initSchema } from './schema.js';

const log = createChildLogger('connection');

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
 * 创建并初始化 SQLite 数据库连接实例
 * 默认启用 WAL 模式、外键约束与预设 Pragma 性能调优
 *
 * @param options 数据库配置项
 * @returns 初始化完成的 better-sqlite3 数据库实例
 */
export function createDatabase(options?: DatabaseOptions): Database.Database {
  const mergedOptions: Required<DatabaseOptions> = {
    ...DEFAULT_DATABASE_OPTIONS,
    ...options,
  };

  const { path, wal, busyTimeout, foreignKeys, synchronous, cacheSize, readOnly } = mergedOptions;

  try {
    const isMemory = path === ':memory:' || path === '';

    if (!isMemory) {
      const dir = dirname(path);
      if (dir && dir !== '.' && !existsSync(dir)) {
        log.info({ dir }, '创建数据库存储目录');
        mkdirSync(dir, { recursive: true });
      }
    }

    log.info({ path, isMemory, wal, readOnly }, '正在建立 SQLite 数据库连接...');

    const db = new Database(path, {
      readonly: readOnly,
      fileMustExist: false,
      timeout: busyTimeout,
    });

    // 启用外键约束
    if (foreignKeys) {
      db.pragma('foreign_keys = ON');
    }

    // 设置繁忙超时等待
    db.pragma(`busy_timeout = ${busyTimeout}`);

    // 非内存数据库配置 WAL 模式与同步策略
    if (!isMemory) {
      if (wal) {
        const journalMode = db.pragma('journal_mode = WAL', { simple: true });
        log.debug({ journalMode }, 'SQLite 日志模式已设置为 WAL');
      }
      db.pragma(`synchronous = ${synchronous}`);
      db.pragma(`cache_size = ${cacheSize}`);
      db.pragma('temp_store = MEMORY');
    }

    // 初始化三表 DDL 结构
    initSchema(db);

    log.info({ path }, 'SQLite 数据库连接与结构初始化成功');
    return db;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err, path }, '创建 SQLite 数据库连接失败');
    throw new DatabaseConnectionError(`连接数据库失败 [${path}]: ${err.message}`, err);
  }
}

/**
 * 优雅关闭数据库连接
 *
 * @param db 数据库实例
 */
export function closeDatabase(db: Database.Database): void {
  try {
    if (db.open) {
      log.info('正在关闭 SQLite 数据库连接...');
      db.close();
      log.info('SQLite 数据库连接已安全关闭');
    }
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.warn({ err }, '关闭数据库连接时发生异常');
  }
}
