import { createTool, type Tool } from '@mastra/core/tools';
import type { z } from 'zod';
import type { AgentTool, RegisterToolOptions, ToolExecutionContext } from './types.js';
import { ToolError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('tool-registry');

/**
 * 创建 KKBot Agent 工具定义工厂函数
 * 底层基于 Mastra createTool 驱动，赋予 Zod Schema 强类型约束与 readOnly 读写分流元数据
 */
export function createAgentTool<TInput = unknown, TOutput = unknown>(config: {
  id: string;
  description: string;
  inputSchema: z.ZodType<TInput>;
  outputSchema?: z.ZodType<TOutput>;
  readOnly?: boolean;
  execute: (input: TInput, context?: ToolExecutionContext) => Promise<TOutput>;
  metadata?: Record<string, unknown>;
}): AgentTool<TInput, TOutput> {
  const readOnly = config.readOnly ?? false;

  // 构造底层 Mastra 原生 Tool 实例
  let mastraTool: Tool<TInput, TOutput> | undefined;
  try {
    mastraTool = createTool({
      id: config.id,
      description: config.description,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      execute: async (inputData) => {
        return config.execute(inputData);
      },
    });
  } catch (err) {
    log.warn({ toolId: config.id, err }, '构造底层 Mastra Tool 实例发生告警，将使用纯净包装模式');
  }

  return {
    id: config.id,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    readOnly,
    execute: config.execute,
    mastraTool,
    metadata: config.metadata,
  };
}

/**
 * KKBot 统一工具注册中心
 * 统一纳管所有内置企业工具与外部动态 MCP 工具，支持读写分流过滤与检索
 */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool<unknown, unknown>>();

  /**
   * 注册一个工具到注册中心
   * @param tool Agent 工具实体
   * @param options 注册配置选项 (如 override 覆盖或显式指定 readOnly)
   */
  public register<TIn = unknown, TOut = unknown>(
    tool: AgentTool<TIn, TOut>,
    options?: RegisterToolOptions
  ): void {
    if (!tool || !tool.id) {
      throw new ToolError('无法注册无效的工具：tool.id 不能为空', undefined, 'INVALID_TOOL');
    }

    const toolId = tool.id.trim();
    if (!toolId) {
      throw new ToolError('无法注册无效的工具：tool.id 不能为空字符串', undefined, 'INVALID_TOOL');
    }

    if (this.tools.has(toolId) && !options?.override) {
      throw new ToolError(
        `工具 "${toolId}" 已存在于注册中心中。如需覆盖请设置 { override: true }`,
        toolId,
        'TOOL_ALREADY_EXISTS'
      );
    }

    if (!options) {
      this.tools.set(toolId, tool as unknown as AgentTool<unknown, unknown>);
      log.debug({ toolId, readOnly: tool.readOnly }, '成功注册工具到注册中心');
      return;
    }

    const effectiveReadOnly = options.readOnly !== undefined ? options.readOnly : tool.readOnly;
    const effectiveMetadata = {
      ...(tool.metadata ?? {}),
      ...(options.metadata ?? {}),
    };

    const registeredTool: AgentTool<unknown, unknown> = {
      id: toolId,
      description: tool.description,
      inputSchema: tool.inputSchema as z.ZodType<unknown>,
      outputSchema: tool.outputSchema as z.ZodType<unknown> | undefined,
      readOnly: effectiveReadOnly,
      execute: (input: unknown, ctx?: ToolExecutionContext) => tool.execute(input as TIn, ctx),
      mastraTool: tool.mastraTool as Tool<unknown, unknown> | undefined,
      metadata: Object.keys(effectiveMetadata).length > 0 ? effectiveMetadata : undefined,
    };

    this.tools.set(toolId, registeredTool);
    log.debug(
      { toolId, readOnly: effectiveReadOnly },
      '成功注册工具到注册中心'
    );
  }
  /**
   * 按工具名称注销工具
   * @param id 工具 ID
   * @returns 是否成功注销 (若不存在返回 false)
   */
  public unregister(id: string): boolean {
    const deleted = this.tools.delete(id.trim());
    if (deleted) {
      log.debug({ toolId: id }, '成功从注册中心注销工具');
    }
    return deleted;
  }

  /**
   * 获取指定名称的工具
   * @param id 工具 ID
   */
  public get(id: string): AgentTool<unknown, unknown> | undefined {
    return this.tools.get(id.trim());
  }

  /**
   * 判断是否存在指定工具
   * @param id 工具 ID
   */
  public has(id: string): boolean {
    return this.tools.has(id.trim());
  }

  /**
   * 获取所有已注册工具列表
   */
  public getAll(): AgentTool<unknown, unknown>[] {
    return Array.from(this.tools.values());
  }

  /**
   * 筛选所有只读工具 (readOnly: true)
   */
  public getReadOnlyTools(): AgentTool<unknown, unknown>[] {
    return this.getAll().filter(t => t.readOnly === true);
  }

  /**
   * 筛选所有写操作工具 (readOnly: false)
   */
  public getWriteTools(): AgentTool<unknown, unknown>[] {
    return this.getAll().filter(t => t.readOnly !== true);
  }

  /**
   * 获取当前已注册工具总数
   */
  public get size(): number {
    return this.tools.size;
  }

  /**
   * 清空注册中心所有工具
   */
  public clear(): void {
    this.tools.clear();
    log.debug('注册中心已清空所有工具');
  }

  /**
   * 将当前所有工具导出为 Mastra 原生 Tool 字典 (供 Mastra Agent 绑定)
   */
  public toMastraTools(): Record<string, Tool<unknown, unknown>> {
    const result: Record<string, Tool<unknown, unknown>> = {};
    for (const [id, tool] of this.tools.entries()) {
      if (tool.mastraTool) {
        result[id] = tool.mastraTool;
      } else {
        result[id] = createTool({
          id: tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          execute: async (inputData) => {
            return tool.execute(inputData);
          },
        });
      }
    }
    return result;
  }
}
