import type Database from 'better-sqlite3';
import { closeDatabase, createDatabase } from './database/connection.js';
import { MediaStorage } from './media/media-storage.js';
import { MessageRepository } from './repository/message-repository.js';
import { OrgRepository } from './repository/org-repository.js';
import type { ExportRosterOptions, StoreOptions } from './types/index.js';
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
   * 快捷导出企业组织花名册 CSV 文件（支持 Windows Excel 独占锁防御）
   *
   * @param targetPathOrOptions 目标文件路径或导出选项（默认: data/organization_roster.csv）
   * @param options 补充导出选项
   * @returns 实际生成的文件路径
   */
  public async exportRosterCsv(
    targetPathOrOptions?: string | ExportRosterOptions,
    options?: ExportRosterOptions
  ): Promise<string> {
    return this.org.exportRosterCsv(targetPathOrOptions, options);
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
