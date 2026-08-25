import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';
import {
  createClient,
  type Client,
  runKKBotMigrations,
  KKBotStore,
} from '@kkbot/store';
import { loadConfigFromYaml, type AppConfig } from './config.js';
import { resolveDatabaseLocation, type DatabaseLocation } from './path-resolver.js';
import { InstanceLock } from './instance-lock.js';
import { WorkAdmissionGate } from './gate.js';
import {
  AcquisitionLedger,
  executeReverseShutdown,
  type ShutdownResult,
} from './ledger.js';
import { ConfigValidationError } from './errors.js';

export interface BootstrapperHooks {
  beforeAcquire?: (stage: string) => Promise<void> | void;
  afterAcquire?: (stage: string, resource: unknown) => Promise<void> | void;
  beforeFinalizer?: (resourceId: string) => Promise<void> | void;
  afterFinalizer?: (resourceId: string) => Promise<void> | void;
}

export interface BootstrapperOptions {
  /** YAML 配置文件路径 */
  configPath: string;
  /** 测试与故障注入钩子 */
  hooks?: BootstrapperHooks;
}

export interface PreflightReport {
  startupGenerationId: string;
  dbConnectivity: boolean;
  migrationsApplied: boolean;
  storageReady: boolean;
  mcpClientReady: boolean;
}

/**
 * KKBot 唯一统一启动器与装配根（UnifiedBootstrapper / Composition Root）
 *
 * 核心职责：
 * 1. 分配当前启动代次唯一 startupGenerationId。
 * 2. 执行纯静态无资源副作用的 Static Validation。
 * 3. 取得数据目录单实例锁，防御同一数据目录并发双写。
 * 4. 规范化唯一数据库文件路径与 file: URL。
 * 5. 创建唯一 KKBot Client 并提交 KKBot 数据库迁移。
 * 6. 创建唯一 LibSQLStore 及其自有 Client，显式调用 storage.init()。
 * 7. 创建唯一 Mastra 实例并完成 Storage 关闭所有权安全转移。
 * 8. 创建唯一进程级 MCPClient（若配置）。
 * 9. 执行无业务事实副作用的真实 Preflight。
 * 10. Ready Barrier 成功后唯一一次打开 Work Admission Gate。
 * 11. 汇聚启动失败、信号与关键失效至同一条逆拓扑幂等 Shutdown 路径。
 */
export class UnifiedBootstrapper {
  readonly startupGenerationId: string;
  private readonly configPath: string;
  private readonly hooks: BootstrapperHooks;

  private config: AppConfig | null = null;
  private dbLocation: DatabaseLocation | null = null;
  private readonly gate: WorkAdmissionGate;
  private readonly ledger: AcquisitionLedger;

  private instanceLock: InstanceLock | null = null;
  private kkbotClient: Client | null = null;
  private kkbotStore: KKBotStore | null = null;
  private libSqlStore: LibSQLStore | null = null;
  private mastra: Mastra | null = null;
  private mcpClient: MCPClient | null = null;

  private shutdownPromise: Promise<ShutdownResult> | null = null;

  constructor(options: BootstrapperOptions) {
    this.startupGenerationId = randomUUID();
    this.configPath = options.configPath;
    this.hooks = options.hooks ?? {};
    this.gate = new WorkAdmissionGate(this.startupGenerationId);
    this.ledger = new AcquisitionLedger(this.startupGenerationId);
  }

  /**
   * Static Validation：仅读取 YAML 配置与环境变量，不占用进程资源或网络连接。
   */
  async staticValidate(): Promise<AppConfig> {
    const loadedConfig = await loadConfigFromYaml(this.configPath);
    this.config = loadedConfig;
    return loadedConfig;
  }

  /**
   * 完整启动流程：Static Validation -> 资源取得 -> Preflight -> Ready Barrier -> 开放工作准入门
   */
  async start(): Promise<void> {
    try {
      // 1. 静态配置校验
      await this.staticValidate();
      const cfg = this.getConfig();

      // 2. 规范化数据库位置
      const baseDir = path.dirname(path.resolve(this.configPath));
      this.dbLocation = resolveDatabaseLocation(cfg.storage.url, baseDir);

      // 3. 取得数据目录单实例锁
      await this.acquireStage('InstanceLock', async () => {
        const lockDir = this.dbLocation?.isMemory
          ? path.resolve(baseDir, 'data')
          : path.dirname(this.dbLocation!.absolutePath);

        this.instanceLock = new InstanceLock({
          lockDir,
          startupGenerationId: this.startupGenerationId,
        });

        await this.instanceLock.acquire();

        this.ledger.record({
          id: 'InstanceLock',
          owner: 'CompositionRoot',
          dependencies: [],
          finalizer: async () => {
            await this.callFinalizerHook('InstanceLock', () => this.instanceLock?.release());
          },
        });
      });

      // 4. 创建 KKBot Client 并立即登记账本，再配置 WAL / busy_timeout
      await this.acquireStage('KKBotClient', async () => {
        this.kkbotClient = createClient({ url: this.dbLocation!.fileUrl });

        this.ledger.record({
          id: 'KKBotClient',
          owner: 'CompositionRoot',
          dependencies: ['InstanceLock'],
          finalizer: async () => {
            await this.callFinalizerHook('KKBotClient', () => this.kkbotClient?.close());
          },
        });

        if (!this.dbLocation!.isMemory) {
          await this.kkbotClient.execute('PRAGMA journal_mode = WAL;');
          await this.kkbotClient.execute('PRAGMA busy_timeout = 5000;');
        }
      });
      // 5. 执行并提交 KKBot 数据库迁移（必须先于 Mastra storage.init 完成）
      await this.acquireStage('KKBotMigrations', async () => {
        await runKKBotMigrations(this.kkbotClient!);
        this.kkbotStore = new KKBotStore(this.kkbotClient!);
      });

      // 6. 创建唯一 LibSQLStore 及其自有 Client，并显式执行 storage.init()
      await this.acquireStage('LibSQLStore', async () => {
        this.libSqlStore = new LibSQLStore({
          id: 'mastra-storage',
          url: this.dbLocation!.fileUrl,
        });

        // 在 Mastra 接管前，由 Composition Root 负责关闭 Storage
        this.ledger.record({
          id: 'LibSQLStore',
          owner: 'CompositionRoot',
          dependencies: ['InstanceLock'],
          finalizer: async () => {
            await this.callFinalizerHook('LibSQLStore', () => {
              if (
                this.libSqlStore &&
                typeof (this.libSqlStore as { close?: () => void }).close === 'function'
              ) {
                (this.libSqlStore as { close: () => void }).close();
              }
            });
          },
        });

        await this.libSqlStore.init();
      });

      // 7. 创建唯一 Mastra 实例，完成 Storage 所有权安全转移
      await this.acquireStage('Mastra', () => {
        this.mastra = new Mastra({
          storage: this.libSqlStore!,
        });

        // 关键所有权转移：Storage 由 Mastra 接管，移除直接 finalizer，避免重复关闭
        this.ledger.transferOwnership('LibSQLStore', 'Mastra', null);

        this.ledger.record({
          id: 'Mastra',
          owner: 'CompositionRoot',
          dependencies: ['LibSQLStore', 'KKBotClient'],
          finalizer: async () => {
            await this.callFinalizerHook('Mastra', async () => {
              const mastraLifecycle = this.mastra as { shutdown?: () => Promise<void> } | null;
              if (mastraLifecycle && typeof mastraLifecycle.shutdown === 'function') {
                await mastraLifecycle.shutdown();
              }
            });
          },
        });
      });

      // 8. 创建唯一进程级 MCPClient（若配置）
      if (cfg.mcp?.servers && Object.keys(cfg.mcp.servers).length > 0) {
        await this.acquireStage('MCPClient', () => {
          const mcpServers: Record<string, MastraMCPServerDefinition> = {};
          for (const [name, serverConfig] of Object.entries(cfg.mcp.servers)) {
            if (serverConfig.url) {
              mcpServers[name] = {
                url: new URL(serverConfig.url),
                timeout: serverConfig.timeout,
              };
            } else if (serverConfig.command) {
              mcpServers[name] = {
                command: serverConfig.command,
                args: serverConfig.args ?? [],
                env: serverConfig.env,
                cwd: serverConfig.cwd,
                timeout: serverConfig.timeout,
              };
            }
          }
          this.mcpClient = new MCPClient({
            id: this.startupGenerationId,
            servers: mcpServers,
            timeout: cfg.mcp?.perServerTimeoutMs,
          });

          this.ledger.record({
            id: 'MCPClient',
            owner: 'CompositionRoot',
            dependencies: [],
            finalizer: async () => {
              await this.callFinalizerHook('MCPClient', async () => {
                if (this.mcpClient && typeof this.mcpClient.disconnect === 'function') {
                  await this.mcpClient.disconnect();
                }
              });
            },
          });
        });
      }

      // 9. 执行无业务事实副作用的真实 Preflight
      await this.acquireStage('Preflight', async () => {
        await this.preflight();
      });

      // 10. Ready Barrier 判定成功，唯一一次打开 Work Admission Gate
      this.gate.open();
    } catch (error) {
      this.gate.close();
      const shutdownRes = await this.shutdown(error);
      if (shutdownRes?.errors && shutdownRes.errors.length > 0) {
        const initialErr = error instanceof Error ? error : new Error(String(error));
        throw new AggregateError(
          [initialErr, ...shutdownRes.errors.map((e) => e.error)],
          `启动失败且逆拓扑回滚清理中产生 ${shutdownRes.errors.length} 处错误: ${initialErr.message}`
        );
      }
      throw error;
    }
  }

  /**
   * 真实 Preflight 探针：利用已取得真实对象证明连通性与结构，严禁创建业务事实
   */
  async preflight(): Promise<PreflightReport> {
    if (!this.kkbotClient) {
      throw new Error('Preflight 失败: KKBotClient 尚未取得');
    }
    if (!this.libSqlStore) {
      throw new Error('Preflight 失败: LibSQLStore 尚未取得');
    }

    // 探针 1：KKBot 数据库连通性与表存在性验证
    const dbPing = await this.kkbotClient.execute('SELECT 1 as ping');
    const dbConnectivity = dbPing.rows.length > 0;

    // 探针 2：验证 migration 事实已提交
    const migCheck = await this.kkbotClient.execute('SELECT COUNT(*) as count FROM _kkbot_migrations');
    const rawCount = migCheck.rows[0]?.count;
    const migrationsApplied =
      typeof rawCount === 'number' || typeof rawCount === 'bigint' ? Number(rawCount) > 0 : false;

    // 探针 3：验证 Storage 可用（不产生业务事实）
    const storageReady = Boolean(this.libSqlStore);
    // 探针 4：验证 MCPClient 可用性与 discovery 探测（若配置）
    let mcpClientReady = true;
    if (this.config?.mcp?.servers && this.mcpClient) {
      try {
        const { errors } = await this.mcpClient.listToolsWithErrors({
          perServerTimeoutMs: this.config.mcp.perServerTimeoutMs,
        });

        const errorEntries = Object.entries(errors);
        if (errorEntries.length > 0) {
          for (const [serverName, errorMsg] of errorEntries) {
            const serverConfig = this.config.mcp.servers[serverName];
            const isRequired = serverConfig?.required !== false;
            if (isRequired) {
              throw new Error(
                `必需的 MCP Server '${serverName}' Tool discovery 失败，阻止开门: ${errorMsg}`
              );
            }
          }
          mcpClientReady = false;
        }
      } catch (mcpErr) {
        if (mcpErr instanceof Error && mcpErr.message.includes('必需的 MCP Server')) {
          throw mcpErr;
        }
        const requiredServers = Object.entries(this.config.mcp.servers).filter(
          ([, s]) => s.required !== false
        );
        if (requiredServers.length > 0) {
          const err = mcpErr instanceof Error ? mcpErr : new Error(String(mcpErr));
          throw new Error(`必需的 MCP Server Tool discovery 失败，阻止开门: ${err.message}`, {
            cause: err,
          });
        }
        mcpClientReady = false;
      }
    }

    return {
      startupGenerationId: this.startupGenerationId,
      dbConnectivity,
      migrationsApplied,
      storageReady,
      mcpClientReady,
    };
  }

  /**
   * 统一逆拓扑幂等优雅关闭
   */
  async shutdown(reason?: unknown): Promise<ShutdownResult> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    this.shutdownPromise = executeReverseShutdown({
      ledger: this.ledger,
      gate: this.gate,
      triggerReason: reason,
    });

    return this.shutdownPromise;
  }

  /**
   * 阶段资源取得辅助函数（支持故障注入钩子）
   */
  private async acquireStage(stage: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.hooks.beforeAcquire) {
      await this.hooks.beforeAcquire(stage);
    }
    await fn();
    if (this.hooks.afterAcquire) {
      await this.hooks.afterAcquire(stage, this);
    }
  }

  /**
   * Finalizer 执行辅助钩子
   */
  private async callFinalizerHook(
    resourceId: string,
    action?: () => Promise<void> | void
  ): Promise<void> {
    if (this.hooks.beforeFinalizer) {
      await this.hooks.beforeFinalizer(resourceId);
    }
    if (action) {
      await action();
    }
    if (this.hooks.afterFinalizer) {
      await this.hooks.afterFinalizer(resourceId);
    }
  }

  // ==========================================
  // 状态与受管对象访问接口
  // ==========================================

  getConfig(): AppConfig {
    if (!this.config) {
      throw new Error('Bootstrapper 尚未完成配置加载与静态校验，请先调用 staticValidate()');
    }
    return this.config;
  }

  getGate(): WorkAdmissionGate {
    return this.gate;
  }

  getLedger(): AcquisitionLedger {
    return this.ledger;
  }

  getKKBotClient(): Client {
    if (!this.kkbotClient) {
      throw new Error('KKBotClient 尚未取得或已释放');
    }
    return this.kkbotClient;
  }

  getKKBotStore(): KKBotStore {
    if (!this.kkbotStore) {
      throw new Error('KKBotStore 尚未取得或已释放');
    }
    return this.kkbotStore;
  }

  getLibSQLStore(): LibSQLStore {
    if (!this.libSqlStore) {
      throw new Error('LibSQLStore 尚未取得或已释放');
    }
    return this.libSqlStore;
  }

  getMastra(): Mastra {
    if (!this.mastra) {
      throw new Error('Mastra 实例尚未取得或已释放');
    }
    return this.mastra;
  }

  getMCPClient(): MCPClient | null {
    return this.mcpClient;
  }
}

export { ConfigValidationError };
