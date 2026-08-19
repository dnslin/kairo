import type Database from 'better-sqlite3';
import { closeDatabase, createDatabase } from './database/connection.js';
import { OrgRepository } from './repository/org-repository.js';
import { SessionRepository } from './repository/session-repository.js';
import type { DatabaseOptions } from './types/index.js';

/**
 * 类型守卫：判断对象是否为 better-sqlite3 数据库实例
 * @param value 待检查的值
 */
export function isDatabaseInstance(value: unknown): value is Database.Database {
  return (
    typeof value === 'object' &&
    value !== null &&
    'prepare' in value &&
    typeof (value as Database.Database).prepare === 'function' &&
    'exec' in value &&
    typeof (value as Database.Database).exec === 'function'
  );
}

/**
 * KKBot 存储层统一门面
 * 集中管理 SQLite 数据库连接及各领域仓储实例
 */
export class KKBotStore {
  public readonly db: Database.Database;
  public readonly sessions: SessionRepository;
  public readonly org: OrgRepository;

  constructor(dbOrOptions?: Database.Database | DatabaseOptions) {
    if (isDatabaseInstance(dbOrOptions)) {
      this.db = dbOrOptions;
    } else {
      this.db = createDatabase(dbOrOptions);
    }
    this.sessions = new SessionRepository(this.db);
    this.org = new OrgRepository(this.db);
  }

  /**
   * 关闭数据库连接并释放资源
   */
  close(): void {
    closeDatabase(this.db);
  }
}

/**
 * 工厂函数：创建并初始化 KKBot 存储门面
 * @param options 数据库配置项
 */
export function createKKBotStore(options?: DatabaseOptions): KKBotStore {
  return new KKBotStore(options);
}
