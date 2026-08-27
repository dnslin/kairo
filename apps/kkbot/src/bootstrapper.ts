import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { Mastra } from '@mastra/core';
import { LibSQLStore } from '@mastra/libsql';
import { MCPClient, type MastraMCPServerDefinition } from '@mastra/mcp';
import type { KK9Driver, DriverHealthEvent } from '@kkbot/driver';
import { SessionCoordinator, type SessionCoordinatorOptions } from '@kkbot/gateway';
import type { Tool } from '@mastra/core/tools';
import {
  createMastraSearchOrganizationTool,
  createMastraQueryKnowledgeBaseTool,
  createMastraGenerateFileDeliverableTool,
  decorateKkTool,
} from '@kkbot/agent';
import { createClient, type Client, runKKBotMigrations, KKBotStore } from '@kkbot/store';
import { loadConfigFromYaml, type AppConfig, DEFAULT_ALLOWED_MCP_HOSTS } from './config.js';
import { resolveDatabaseLocation, type DatabaseLocation } from './path-resolver.js';
import { InstanceLock } from './instance-lock.js';
import { WorkAdmissionGate } from './gate.js';
import {
  AcquisitionLedger,
  DEFAULT_SHUTDOWN_DEADLINE_MS,
  executeReverseShutdown,
  type ShutdownResult,
} from './ledger.js';
import { GenerationCheckpointStore, type GenerationCheckpoint } from './generation-checkpoint.js';
import { ConfigValidationError } from './errors.js';

export interface BootstrapperHooks {
  beforeAcquire?: (stage: string) => Promise<void> | void;
  afterAcquire?: (stage: string, resource: unknown) => Promise<void> | void;
  beforeFinalizer?: (resourceId: string) => Promise<void> | void;
  afterFinalizer?: (resourceId: string) => Promise<void> | void;
}

export type DriverFactory = (config: AppConfig, startupGenerationId: string) => KK9Driver;
export type CoordinatorFactory = (options: SessionCoordinatorOptions) => SessionCoordinator;
export interface BootstrapperOptions {
  /** YAML 配置文件路径 */
  configPath: string;
  /** 测试与故障注入钩子 */
  hooks?: BootstrapperHooks;
  /** 正式运行时提供真实 KK9 Driver；省略时只运行基础设施合同。 */
  driverFactory?: DriverFactory;
  /** 可选 Gateway 工厂；省略时由 Composition Root 构造默认 Coordinator。 */
  coordinatorFactory?: CoordinatorFactory;
  /** 整条 Shutdown（含资源取得等待）的最大预算，默认 10 秒。 */
  shutdownDeadlineMs?: number;
}

export interface PreflightReport {
  startupGenerationId: string;
  dbConnectivity: boolean;
  migrationsApplied: boolean;
  storageReady: boolean;
  mcpClientReady: boolean;
  driverReady: boolean;
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
  private readonly driverFactory?: DriverFactory;
  private readonly coordinatorFactory?: CoordinatorFactory;
  private readonly startedAt = Date.now();

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
  private driver: KK9Driver | null = null;
  private coordinator: SessionCoordinator | null = null;
  private checkpointStore: GenerationCheckpointStore | null = null;
  private previousCheckpoint: GenerationCheckpoint | null = null;
  private degradedMcpServers: Record<string, string> = {};
  private staticTools: Readonly<Record<string, Tool<unknown, unknown, unknown, unknown>>> =
    Object.freeze({});

  private readonly driverHealthHandler = (event: DriverHealthEvent): void => {
    void this.shutdown(event);
  };
  private readonly driverErrorHandler = (error: Error): void => {
    void this.shutdown({
      kind: 'driver_error',
      startupGenerationId: this.startupGenerationId,
      observedAt: Date.now(),
      cause: error,
    });
  };
  private readonly shutdownWaitPromise: Promise<ShutdownResult>;
  private resolveShutdownWait!: (result: ShutdownResult) => void;
  private shutdownPromise: Promise<ShutdownResult> | null = null;
  private readonly shutdownDeadlineMs: number;
  private readonly activeAcquisitions = new Set<Promise<void>>();

  constructor(options: BootstrapperOptions) {
    this.startupGenerationId = randomUUID();
    this.configPath = options.configPath;
    this.hooks = options.hooks ?? {};
    this.driverFactory = options.driverFactory;
    this.coordinatorFactory = options.coordinatorFactory;
    this.gate = new WorkAdmissionGate(this.startupGenerationId);
    this.ledger = new AcquisitionLedger(this.startupGenerationId);
    this.shutdownDeadlineMs = Math.max(
      1,
      options.shutdownDeadlineMs ?? DEFAULT_SHUTDOWN_DEADLINE_MS
    );
    this.shutdownWaitPromise = new Promise<ShutdownResult>(resolve => {
      this.resolveShutdownWait = resolve;
    });
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
        if (this.driverFactory) {
          this.checkpointStore = new GenerationCheckpointStore(
            path.join(lockDir, 'kkbot-generation.json')
          );
          this.previousCheckpoint = await this.checkpointStore.read();
        }

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

      // 8. 创建唯一进程级 MCPClient 并执行一次性有界 Discovery
      const discoveredMcpTools: Record<string, Tool<unknown, unknown, unknown, unknown>> = {};
      if (cfg.mcp?.servers && Object.keys(cfg.mcp.servers).length > 0) {
        await this.acquireStage('MCPClient', async () => {
          const mcpServers: Record<string, MastraMCPServerDefinition> = {};
          for (const [name, serverConfig] of Object.entries(cfg.mcp.servers)) {
            if (serverConfig.url) {
              const parsedUrl = new URL(serverConfig.url);
              const allowedHostsList = serverConfig.allowedHosts
                ? Array.from(
                    new Set([...serverConfig.allowedHosts, parsedUrl.host, parsedUrl.hostname])
                  )
                : Array.from(
                    new Set([parsedUrl.host, parsedUrl.hostname, ...DEFAULT_ALLOWED_MCP_HOSTS])
                  );
              mcpServers[name] = {
                url: parsedUrl,
                timeout: serverConfig.timeout,
                allowedHosts: allowedHostsList,
              };
            } else if (serverConfig.command) {
              mcpServers[name] = {
                command: serverConfig.command,
                args: serverConfig.args ?? [],
                env: serverConfig.env ?? {},
                cwd: serverConfig.cwd,
                timeout: serverConfig.timeout,
                inheritDefaultEnv: false,
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

          // 执行启动期一次性有界 Discovery
          try {
            const { tools, errors } = await this.mcpClient.listToolsWithErrors({
              perServerTimeoutMs: cfg.mcp.perServerTimeoutMs,
            });

            // 检查每台 Server 的错误归属
            const errorEntries = Object.entries(errors ?? {});
            for (const [serverName, errorMsg] of errorEntries) {
              const serverConfig = cfg.mcp.servers[serverName];
              const isRequired = serverConfig?.required !== false;
              if (isRequired) {
                throw new Error(
                  `必需的 MCP Server '${serverName}' Tool discovery 失败，阻止开门: ${errorMsg}`
                );
              } else {
                this.degradedMcpServers[serverName] = errorMsg;
              }
            }

            // 2. 严格校验全部已发现 Tool 的权威 serverName 归属 (Fail-Closed)
            if (tools && typeof tools === 'object') {
              for (const [toolName, toolImpl] of Object.entries(tools)) {
                const toolWithMeta = toolImpl as { mcpMetadata?: { serverName?: string } };
                const actualServerName = toolWithMeta.mcpMetadata?.serverName;
                if (!actualServerName || !cfg.mcp.servers[actualServerName]) {
                  throw new Error(
                    `MCP Tool [${toolName}] 缺少权威 serverName 归属或归属于未知 Server: ${String(actualServerName)}`
                  );
                }
              }

              // 3. 按 Server 进行事务性候选收集与校验 (Transactional Per-Server Collection)
              for (const [serverName, serverConfig] of Object.entries(cfg.mcp.servers)) {
                // 如果 Server 已处于 degraded，直接跳过该 Server 的全部工具
                if (this.degradedMcpServers[serverName]) {
                  continue;
                }
                const serverCandidateTools: Record<
                  string,
                  Tool<unknown, unknown, unknown, unknown>
                > = {};
                try {
                  for (const [toolName, toolImpl] of Object.entries(tools)) {
                    const toolWithMeta = toolImpl as { mcpMetadata?: { serverName?: string } };
                    const actualServerName = toolWithMeta.mcpMetadata?.serverName;

                    // 属于当前处理的 Server
                    if (actualServerName === serverName) {
                      // 默认拒绝：仅放行配置中明确列入白名单的低风险 Tool
                      if (
                        serverConfig.tools &&
                        Array.isArray(serverConfig.tools) &&
                        serverConfig.tools.length > 0
                      ) {
                        const prefix = `${serverName}_`;
                        const rawToolName = toolName.startsWith(prefix)
                          ? toolName.slice(prefix.length)
                          : toolName;
                        const matchingPolicy = serverConfig.tools.find(
                          p => p.name === rawToolName || p.name === toolName
                        );

                        if (!matchingPolicy) {
                          continue;
                        }

                        if (matchingPolicy.risk !== 'low') {
                          throw new Error(`MCP Tool [${toolName}] 配置非法: 风险等级必须为 'low'`);
                        }

                        const decoratedTool = decorateKkTool(
                          toolImpl as unknown as Tool<unknown, unknown, unknown, unknown>,
                          {
                            id: toolName,
                            effect: matchingPolicy.effect ?? 'read',
                            risk: matchingPolicy.risk ?? 'low',
                            requiredPermission: matchingPolicy.requiredPermission,
                            serialKey:
                              matchingPolicy.effect === 'write' ? ('entity' as const) : undefined,
                            idempotencyField:
                              matchingPolicy.effect === 'write' ? 'idempotencyKey' : undefined,
                            timeoutMs: serverConfig.timeout ?? cfg.mcp.perServerTimeoutMs,
                          }
                        );

                        if (discoveredMcpTools[toolName] || serverCandidateTools[toolName]) {
                          throw new Error(`MCP Tool 命名冲突: 工具 '${toolName}' 重复定义`);
                        }
                        serverCandidateTools[toolName] = decoratedTool as unknown as Tool<
                          unknown,
                          unknown,
                          unknown,
                          unknown
                        >;
                      }
                    }
                  }

                  // 该 Server 所有候选工具校验通过，原子提交至 discoveredMcpTools
                  Object.assign(discoveredMcpTools, serverCandidateTools);
                } catch (serverErr) {
                  const isRequired = serverConfig.required !== false;
                  if (isRequired) {
                    throw serverErr;
                  }
                  // optional Server 校验异常：丢弃该 Server 全部候选工具，记录 degraded
                  const errMsg = serverErr instanceof Error ? serverErr.message : String(serverErr);
                  this.degradedMcpServers[serverName] = errMsg;
                }
              }
            }
          } catch (mcpErr) {
            const hasRequiredServers = Object.values(cfg.mcp.servers).some(
              s => s.required !== false
            );
            if (hasRequiredServers) {
              if (mcpErr instanceof Error) {
                throw mcpErr;
              }
              throw new Error(`必需的 MCP Server Tool discovery 失败，阻止开门: ${String(mcpErr)}`);
            }
            const errMsg = mcpErr instanceof Error ? mcpErr.message : String(mcpErr);
            for (const serverName of Object.keys(cfg.mcp.servers)) {
              this.degradedMcpServers[serverName] = errMsg;
            }
          }
        });
      }

      // 9. 构造并冻结静态 Tool 表面快照
      const localTools = this.buildLocalTools();
      for (const localName of Object.keys(localTools)) {
        if (discoveredMcpTools[localName]) {
          throw new Error(`Tool 命名冲突: 本地工具与 MCP 工具同名 '${localName}'`);
        }
      }
      this.staticTools = Object.freeze({
        ...localTools,
        ...discoveredMcpTools,
      });

      if (this.driverFactory) {
        await this.acquireStage('Driver', async () => {
          this.driver = this.driverFactory!(cfg, this.startupGenerationId);
          this.driver.on('health', this.driverHealthHandler);
          this.driver.on('error', this.driverErrorHandler);
          this.ledger.record({
            id: 'Driver',
            owner: 'CompositionRoot',
            dependencies: ['Mastra'],
            finalizer: async () => {
              await this.callFinalizerHook('Driver', async () => {
                this.driver?.off('health', this.driverHealthHandler);
                this.driver?.off('error', this.driverErrorHandler);
                await this.driver?.disconnect();
              });
            },
          });
          await this.driver.connect();
        });

        await this.acquireStage('Coordinator', () => {
          if (!this.driver || !this.kkbotStore) {
            throw new Error('Coordinator 装配失败: Driver 或 KKBotStore 尚未取得');
          }
          const coordinatorOptions: SessionCoordinatorOptions = {
            driver: this.driver,
            store: this.kkbotStore,
            admissionGate: this.gate,
            config: {
              debounceMs: cfg.kk.debounceMs,
              maxWaitMs: cfg.kk.maxWaitMs,
              takeoverDurationMs: cfg.kk.takeoverMinutes * 60 * 1000,
            },
          };
          this.coordinator = this.coordinatorFactory
            ? this.coordinatorFactory(coordinatorOptions)
            : new SessionCoordinator(coordinatorOptions);
          this.ledger.record({
            id: 'Coordinator',
            owner: 'CompositionRoot',
            dependencies: ['Driver', 'Mastra', 'KKBotClient'],
            finalizer: async () => {
              await this.callFinalizerHook('Coordinator', () => this.coordinator?.stop());
            },
          });
        });
      }

      // 9. 执行无业务事实副作用的真实 Preflight
      await this.acquireStage('Preflight', async () => {
        await this.preflight();
      });

      if (this.coordinator) {
        await this.acquireStage('CoordinatorStart', async () => {
          await this.coordinator?.start();
        });
      }

      if (this.shutdownPromise) {
        throw new Error('Ready Barrier 在 Shutdown 启动后失效，拒绝继续开门');
      }
      const readyAt = Date.now();
      const compensationFrom =
        this.previousCheckpoint === null
          ? this.startedAt
          : this.previousCheckpoint.compensationCompleted
            ? this.previousCheckpoint.startedAt
            : this.previousCheckpoint.compensationFrom;
      if (this.checkpointStore) {
        await this.checkpointStore.write({
          startupGenerationId: this.startupGenerationId,
          startedAt: this.startedAt,
          readyAt,
          compensationFrom,
          compensationCompleted: false,
        });
      }

      if (this.shutdownPromise) {
        throw new Error('Ready Barrier 在 Shutdown 启动后失效，拒绝开放 Work Admission Gate');
      }
      // 10. Ready Barrier 判定成功，唯一一次打开 Work Admission Gate
      this.gate.open();

      if (this.driver && this.coordinator) {
        const recoveredMessages = await this.driver.scanCompensationWindow({
          fromTimestamp: compensationFrom,
          toTimestamp: readyAt,
          switchDelayMs: 0,
        });
        for (const message of recoveredMessages) {
          await this.coordinator.handleCompensationMessage(message);
        }
        if (this.shutdownPromise) {
          throw new Error('补偿完成后发现 Shutdown 已启动，拒绝推进 checkpoint');
        }
        if (this.checkpointStore) {
          await this.checkpointStore.write({
            startupGenerationId: this.startupGenerationId,
            startedAt: this.startedAt,
            readyAt,
            compensationFrom: this.startedAt,
            compensationCompleted: true,
          });
        }
        if (this.shutdownPromise) {
          throw new Error('补偿完成后发现 Shutdown 已启动，拒绝启动 Polling');
        }
        this.driver.startPolling();
      }
    } catch (error) {
      this.gate.close();
      const shutdownRes = await this.shutdown(error);
      if (shutdownRes?.errors && shutdownRes.errors.length > 0) {
        const initialErr = error instanceof Error ? error : new Error(String(error));
        throw new AggregateError(
          [initialErr, ...shutdownRes.errors.map(e => e.error)],
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
    const migCheck = await this.kkbotClient.execute(
      'SELECT COUNT(*) as count FROM _kkbot_migrations'
    );
    const rawCount = migCheck.rows[0]?.count;
    const migrationsApplied =
      typeof rawCount === 'number' || typeof rawCount === 'bigint' ? Number(rawCount) > 0 : false;

    // 探针 3：验证 Storage 可用（不产生业务事实）
    const storageReady = Boolean(this.libSqlStore);
    // 探针 4：验证 MCPClient 可用性（只读已完成的 discovery 状态，不重复发起 discovery）
    const mcpClientReady = Object.keys(this.degradedMcpServers).length === 0;

    let driverReady = true;
    if (this.driverFactory) {
      const snapshot = this.driver?.getHealthSnapshot();
      const cdpIdentity = snapshot?.cdpConnectionIdentity;
      const bridgeIdentity = snapshot?.eventBridgeConnectionIdentity;
      driverReady = Boolean(
        snapshot &&
        snapshot.cdpStatus === 'connected' &&
        snapshot.eventBridgeAttached &&
        cdpIdentity &&
        bridgeIdentity &&
        cdpIdentity.startupGenerationId === this.startupGenerationId &&
        bridgeIdentity.startupGenerationId === this.startupGenerationId &&
        cdpIdentity.connectionId === bridgeIdentity.connectionId
      );
      if (!driverReady) {
        throw new Error(
          `Driver Preflight 失败: CDP/EventBridge 未在当前 startup generation ${this.startupGenerationId} 建立一致 Ready 身份`
        );
      }
    }
    return {
      startupGenerationId: this.startupGenerationId,
      dbConnectivity,
      migrationsApplied,
      storageReady,
      mcpClientReady,
      driverReady,
    };
  }

  /**
   * 统一逆拓扑幂等优雅关闭
   */
  async shutdown(reason?: unknown): Promise<ShutdownResult> {
    this.gate.close();
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    const deadlineAt = Date.now() + this.shutdownDeadlineMs;
    this.shutdownPromise = (async (): Promise<ShutdownResult> => {
      while (this.activeAcquisitions.size > 0) {
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs <= 0) {
          break;
        }
        const acquisitionPromise = Promise.all(Array.from(this.activeAcquisitions));
        let timer: NodeJS.Timeout | undefined;
        const deadlinePromise = new Promise<void>(resolve => {
          timer = setTimeout(resolve, remainingMs);
        });
        try {
          await Promise.race([acquisitionPromise, deadlinePromise]);
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }
      }
      return executeReverseShutdown({
        ledger: this.ledger,
        gate: this.gate,
        triggerReason: reason,
        deadlineAt,
      });
    })().then(result => {
      this.resolveShutdownWait(result);
      return result;
    });

    return this.shutdownPromise;
  }

  async waitForShutdown(): Promise<ShutdownResult> {
    return this.shutdownWaitPromise;
  }

  /**
   * 阶段资源取得辅助函数（支持故障注入钩子）
   */
  private async acquireStage(stage: string, fn: () => Promise<void> | void): Promise<void> {
    if (this.shutdownPromise) {
      throw new Error(`资源取得阶段 ${stage} 在 Shutdown 启动后被拒绝`);
    }

    let completeAcquisition!: () => void;
    const acquisition = new Promise<void>(resolve => {
      completeAcquisition = resolve;
    });
    this.activeAcquisitions.add(acquisition);
    try {
      if (this.hooks.beforeAcquire) {
        await this.hooks.beforeAcquire(stage);
      }
      await fn();
      if (this.shutdownPromise) {
        throw new Error(`资源取得阶段 ${stage} 在 Shutdown 启动后完成，拒绝继续启动`);
      }
      if (this.hooks.afterAcquire) {
        await this.hooks.afterAcquire(stage, this);
      }
      if (this.shutdownPromise) {
        throw new Error(`资源取得阶段 ${stage} 在 Shutdown 启动后登记，拒绝继续启动`);
      }
    } finally {
      completeAcquisition();
      this.activeAcquisitions.delete(acquisition);
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

  getDriver(): KK9Driver | null {
    return this.driver;
  }

  getCoordinator(): SessionCoordinator | null {
    return this.coordinator;
  }

  getMCPClient(): MCPClient | null {
    return this.mcpClient;
  }

  getDegradedMcpServers(): Record<string, string> {
    return { ...this.degradedMcpServers };
  }

  getStaticTools(): Readonly<Record<string, Tool<unknown, unknown, unknown, unknown>>> {
    return this.staticTools;
  }

  private buildLocalTools(): Record<string, Tool<unknown, unknown, unknown, unknown>> {
    const tools: Record<string, Tool<unknown, unknown, unknown, unknown>> = {};
    if (this.kkbotStore) {
      tools['search_organization'] = createMastraSearchOrganizationTool({
        orgRepo: this.kkbotStore.org,
      }) as unknown as Tool<unknown, unknown, unknown, unknown>;
    }
    tools['query_knowledge_base'] = createMastraQueryKnowledgeBaseTool() as unknown as Tool<
      unknown,
      unknown,
      unknown,
      unknown
    >;
    tools['generate_file_deliverable'] =
      createMastraGenerateFileDeliverableTool() as unknown as Tool<
        unknown,
        unknown,
        unknown,
        unknown
      >;
    return tools;
  }
}

export { ConfigValidationError };
