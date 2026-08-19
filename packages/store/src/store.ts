import type Database from 'better-sqlite3';
import { closeDatabase, createDatabase } from './database/connection.js';
import { OrgRepository } from './repository/org-repository.js';
import { SessionRepository } from './repository/session-repository.js';
import type { DatabaseOptions } from './types/index.js';

/**
 * KKBot 存储层统一门面
 * 集中管理 SQLite 数据库连接及各领域仓储实例
 */
export class KKBotStore {
  public readonly db: Database.Database;
  public readonly sessions: SessionRepository;
  public readonly org: OrgRepository;

  constructor(dbOrOptions?: Database.Database | DatabaseOptions) {
    if (dbOrOptions && typeof (dbOrOptions as Database.Database).prepare === 'function') {
      this.db = dbOrOptions as Database.Database;
    } else {
      this.db = createDatabase(dbOrOptions as DatabaseOptions | undefined);
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
