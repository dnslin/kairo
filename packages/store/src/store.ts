import type Database from 'better-sqlite3';
import { closeDatabase, createDatabase } from './database/connection.js';
import { MediaStorage } from './media/media-storage.js';
import { MessageRepository } from './repository/message-repository.js';
import { OrgRepository } from './repository/org-repository.js';
import { SessionRepository } from './repository/session-repository.js';
import type { StoreOptions } from './types/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('store-facade');

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
 * KKBot 统一存储持久化中枢 (Store Facade)
 * 聚合组织架构仓储、会话状态仓储、消息历史仓储与本地媒体存储，提供单点访问与生命周期管理
 */
export class KKBotStore {
  /** 底层 SQLite 数据库连接实例 */
  public readonly db: Database.Database;
  /** 组织架构仓储 */
  public readonly org: OrgRepository;
  /** 会话状态仓储 */
  public readonly sessions: SessionRepository;
  /** 会话消息历史仓储 */
  public readonly messages: MessageRepository;
  /** 多模态本地转存管理器 */
  public readonly media: MediaStorage;

  constructor(dbOrOptions?: Database.Database | StoreOptions) {
    if (isDatabaseInstance(dbOrOptions)) {
      this.db = dbOrOptions;
      this.media = new MediaStorage();
    } else {
      this.db = createDatabase(dbOrOptions);
      this.media = new MediaStorage(dbOrOptions?.media);
    }

    this.org = new OrgRepository(this.db);
    this.sessions = new SessionRepository(this.db);
    this.messages = new MessageRepository(this.db);

    log.debug('KKBotStore 存储中枢初始化完成');
  }

  /**
   * 优雅关闭数据库连接与释放资源
   */
  public close(): void {
    log.debug('正在关闭 KKBotStore...');
    closeDatabase(this.db);
    log.debug('KKBotStore 已关闭');
  }
}

/**
 * 工厂函数：创建并初始化 KKBot 存储门面
 * @param options 数据库与媒体配置项
 */
export function createKKBotStore(options?: StoreOptions): KKBotStore {
  return new KKBotStore(options);
}

/**
 * 别名导出，支持直接通过 Store 使用
 */
export { KKBotStore as Store };
