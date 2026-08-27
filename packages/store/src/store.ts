import type { Client } from '@libsql/client';
import { closeDatabase, createDatabaseClient } from './database/connection.js';
import { MediaStorage } from './media/media-storage.js';
import { MessageRepository } from './repository/message-repository.js';
import { DeliveryRepository } from './repository/delivery-repository.js';
import { OrgRepository } from './repository/org-repository.js';
import { TombstoneRepository } from './repository/tombstone-repository.js';
import { SessionRepository } from './repository/session-repository.js';
import type { DatabaseOptions, ExportRosterOptions, StoreOptions } from './types/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('store-facade');

/**
 * 类型守卫：判断对象是否为 @libsql/client 客户端实例
 * @param value 待检查的值
 */
export function isClientInstance(value: unknown): value is Client {
  return (
    typeof value === 'object' &&
    value !== null &&
    'execute' in value &&
    typeof (value as Client).execute === 'function' &&
    'batch' in value &&
    typeof (value as Client).batch === 'function'
  );
}

/**
 * KKBot 统一存储持久化中枢 (Store Facade)
 * 聚合组织架构仓储、会话状态仓储、消息历史仓储与本地媒体存储，提供单点访问与生命周期管理
 */
export class KKBotStore {
  /** 底层 LibSQL 客户端连接实例 */
  public readonly db: Client;
  /** 组织架构仓储 */
  public readonly org: OrgRepository;
  /** 会话状态仓储 */
  public readonly sessions: SessionRepository;
  /** 会话消息历史仓储 */
  public readonly messages: MessageRepository;
  /** 多模态本地转存管理器 */
  public readonly media: MediaStorage;
  /** 交付生命周期仓储 */
  public readonly deliveries: DeliveryRepository;
  /** 消息墓碑与合规删除仓储 */
  public readonly tombstones: TombstoneRepository;

  constructor(client: Client, mediaOptions?: StoreOptions['media']) {
    this.db = client;
    this.media = new MediaStorage(mediaOptions);
    this.org = new OrgRepository(this.db);
    this.sessions = new SessionRepository(this.db);
    this.messages = new MessageRepository(this.db);
    this.deliveries = new DeliveryRepository(this.db);
    this.tombstones = new TombstoneRepository(this.db);
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
 * 异步工厂函数：创建并初始化 KKBot 存储门面
 * @param optionsOrClient 数据库配置项、Store 配置项或已有的 Client 客户端实例
 */
export async function createKKBotStore(
  optionsOrClient?: DatabaseOptions | StoreOptions | Client
): Promise<KKBotStore> {
  if (isClientInstance(optionsOrClient)) {
    return new KKBotStore(optionsOrClient);
  }

  const client = await createDatabaseClient(optionsOrClient as DatabaseOptions | undefined);
  return new KKBotStore(client, (optionsOrClient as StoreOptions | undefined)?.media);
}
