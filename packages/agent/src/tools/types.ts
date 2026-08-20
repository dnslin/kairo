import type { z } from 'zod';
import type { Tool } from '@mastra/core/tools';

/**
 * 工具执行环境上下文
 */
export interface ToolExecutionContext {
  /** 会话标识 ID */
  sessionId?: string;
  /** 线程 / 对话流 ID */
  threadId?: string;
  /** 发送人 ID */
  senderId?: string;
  /** 发送人姓名 */
  senderName?: string;
  /** 中断控制信号 */
  signal?: AbortSignal;
  /** 自定义扩展数据载荷 */
  customData?: Record<string, unknown>;
}

/**
 * KKBot Agent 统一工具定义实体契约
 */
export interface AgentTool<TInput = unknown, TOutput = unknown> {
  /** 工具唯一标识符 (如 search_organization) */
  id: string;
  /** 工具功能描述（供 LLM 理解调用意图） */
  description: string;
  /** Zod 输入参数校验 Schema */
  inputSchema: z.ZodType<TInput>;
  /** Zod 输出结果结构 Schema (可选) */
  outputSchema?: z.ZodType<TOutput>;
  /** 是否为只读工具 (只读工具并发执行，写工具严格串行执行) */
  readOnly: boolean;
  /**
   * 工具底层执行核心函数
   * @param input 经过 Zod 校验后的输入参数
   * @param context 运行时上下文
   */
  execute: (input: TInput, context?: ToolExecutionContext) => Promise<TOutput>;
  /** 关联的底层 Mastra Tool 原生实例 (可选) */
  mastraTool?: Tool<TInput, TOutput>;
  /** 自定义元数据标记 (例如来源 'builtin' | 'mcp') */
  metadata?: Record<string, unknown>;
}

/**
 * 工具注册选项
 */
export interface RegisterToolOptions {
  /** 强制覆盖已有同名工具，默认 false */
  override?: boolean;
  /** 是否显式标记为只读工具 (若未传则沿用工具自身的 readOnly 属性) */
  readOnly?: boolean;
  /** 自定义元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * 单个工具调用请求入参结构
 */
export interface ToolCallRequest {
  /** 本次工具调用的唯一标识 ID (如 LLM 产生的 call_xxx) */
  callId: string;
  /** 调用的目标工具名称 */
  toolName: string;
  /** 传入工具的原始参数键值对 */
  args: Record<string, unknown>;
}

/**
 * 单个工具执行结果实体契约
 */
export interface ToolExecutionResult {
  /** 工具调用唯一标识 ID */
  callId: string;
  /** 调用的工具名称 */
  toolName: string;
  /** 是否执行成功 */
  success: boolean;
  /** 工具执行返回值（成功时为正常输出，失败时为包含 error 字段的自愈自纠对象） */
  output: unknown;
  /** 错误描述信息 (若失败) */
  error?: string;
  /** 是否标记为错误结果 */
  isError?: boolean;
  /** 执行耗时毫秒数 */
  durationMs: number;
  /** 是否为只读工具 */
  readOnly: boolean;
}

/**
 * 读写分流批量调度执行结果集
 */
export interface ToolBatchExecutionResult {
  /** 所有工具的执行结果列表 (保持与输入请求顺序或映射一致) */
  results: ToolExecutionResult[];
  /** 批量执行总耗时毫秒数 */
  totalDurationMs: number;
  /** 成功执行的工具总数 */
  successCount: number;
  /** 失败/异常的工具总数 */
  failureCount: number;
  /** 参与并发的只读工具数 */
  readOnlyCount: number;
  /** 串行执行的写工具数 */
  writeCount: number;
}

/**
 * 读写分流调度器配置项
 */
export interface ReadWriteSplitExecutorOptions {
  /** 单轮 ReAct 步数硬性熔断阈值，默认 5 */
  maxSteps?: number;
  /** 单个工具执行超时时间 (毫秒)，默认 30000 (30秒) */
  timeoutMs?: number;
  /** 是否在超步时抛出 StepLimitExceededError，默认 true */
  strictStepLimit?: boolean;
}

/**
 * 外部 MCP Server 传输协议类型
 */
export type McpTransportType = 'stdio' | 'sse' | 'custom';

/**
 * 外部 MCP Server 连接配置契约
 */
export interface McpServerConfig {
  /** MCP Server 唯一标识 ID (如 erp-service) */
  id: string;
  /** MCP Server 友好展示名称 */
  name?: string;
  /** 通信传输类型 */
  transport: McpTransportType;
  /** stdio 进程启动命令 (如 'node', 'python', 'npx') */
  command?: string;
  /** stdio 命令行参数列表 */
  args?: string[];
  /** stdio 环境变量透传 */
  env?: Record<string, string>;
  /** stdio 工作目录 */
  cwd?: string;
  /** SSE 服务端 URL 端点 */
  url?: string;
  /** SSE 请求 Headers (如 Bearer Token 认证) */
  headers?: Record<string, string>;
  /** 注册到 ToolRegistry 时的方法名前缀 (如 'erp_') */
  toolPrefix?: string;
  /** 明确声明为只读的工具名称白名单列表 */
  readOnlyTools?: string[];
  /** 当工具未在白名单中时，默认是否标记为只读，默认 false */
  defaultReadOnly?: boolean;
  /** 自定义客户端实例（用于测试 Mock 或直接注入） */
  customClient?: unknown;
}

/**
 * MCP Server 运行时连接状态
 */
export interface McpServerStatus {
  /** 服务唯一 ID */
  id: string;
  /** 当前连接状态 */
  status: 'connected' | 'disconnected' | 'connecting' | 'error';
  /** 已动态挂载注册的工具数量 */
  toolsCount: number;
  /** 已挂载的工具名称列表 */
  tools: string[];
  /** 异常信息 (若有) */
  error?: string;
}

/**
 * 知识库切片检索结果项
 */
export interface KnowledgeChunkResult {
  /** 切片唯一标识 */
  id: string;
  /** 来源文档标题或相对路径 */
  title: string;
  /** 切片正文内容 */
  content: string;
  /** 来源文件完整或相对路径 */
  filePath?: string;
  /** 所属知识库分类 */
  category?: string;
  /** 检索匹配相关度得分 (0.0 ~ 1.0) */
  score: number;
  /** 附加元数据 */
  metadata?: Record<string, unknown>;
}
