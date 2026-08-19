import type Database from 'better-sqlite3';
import { closeDatabase, createDatabase } from './database/connection.js';
import { MediaStorage } from './media/media-storage.js';
import { MessageRepository } from './repository/message-repository.js';
import { OrgRepository } from './repository/org-repository.js';
import type { StoreOptions } from './types/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('store-facade');

/**
 * KKBot 统一存储持久化中枢 (Store Facade)
 * 聚合组织架构仓储、消息历史仓储与本地媒体存储，提供单点访问与生命周期管理
 */
export class KKBotStore {
  /** 底层 SQLite 数据库连接实例 */
  public readonly db: Database.Database;
  /** 组织架构仓储 */
  public readonly org: OrgRepository;
  /** 会话消息仓储 */
  public readonly messages: MessageRepository;
  /** 多模态本地转存管理器 */
  public readonly media: MediaStorage;

  constructor(options?: StoreOptions) {
    this.db = createDatabase(options);
    this.org = new OrgRepository(this.db);
    this.messages = new MessageRepository(this.db);
    this.media = new MediaStorage(options?.media);

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
 * 别名导出，支持直接通过 Store 使用
 */
export { KKBotStore as Store };
