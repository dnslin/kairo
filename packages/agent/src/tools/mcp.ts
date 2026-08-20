import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import { createAgentTool } from './registry.js';
import type { AgentTool, McpServerConfig, McpServerStatus } from './types.js';
import { McpClientError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('mcp-client-manager');

/**
 * MCP 通用工具调用内容块
 */
interface McpContentBlock {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/**
 * MCP callTool 返回结果结构
 */
interface McpCallToolResult {
  content?: McpContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
}

/**
 * MCP 客户端实例接口抽象
 */
interface McpClientInstance {
  connect: (transport?: unknown) => Promise<void>;
  close: () => Promise<void>;
  listTools: (params?: Record<string, unknown>) => Promise<{
    tools: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
  }>;
  callTool: (params: {
    name: string;
    arguments?: Record<string, unknown>;
  }) => Promise<McpCallToolResult>;
}

/**
 * 内部记录的 MCP Server 连接实体
 */
interface ManagedMcpServer {
  config: McpServerConfig;
  client: McpClientInstance;
  tools: string[];
  status: McpServerStatus;
}

/**
 * 将 MCP callTool 返回的 content 块解析为语义化 JavaScript 数据对象
 */
function parseMcpContent(result: McpCallToolResult): unknown {
  if (!result.content || result.content.length === 0) {
    return result;
  }

  // 若只有一个 text 块，尝试优先反序列化 JSON，否则返回纯文本
  const firstBlock = result.content[0];
  if (result.content.length === 1 && firstBlock && firstBlock.type === 'text') {
    const text = firstBlock.text ?? '';
    const trimmed = text.trim();
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return text;
      }
    }
    return text;
  }

  return result.content.map(block => {
    if (block.type === 'text' && block.text) {
      try {
        const parsed: unknown = JSON.parse(block.text);
        return parsed;
      } catch {
        return block.text;
      }
    }
    return block;
  });
}

/**
 * 从 MCP 错误 content 块中提取错误文案
 */
function extractMcpErrorMessage(result: McpCallToolResult, defaultMsg = 'MCP 工具执行失败'): string {
  if (result.content && result.content.length > 0) {
    const textBlocks = result.content
      .filter(c => c.type === 'text' && c.text)
      .map(c => c.text!)
      .join('; ');
    if (textBlocks) {
      return textBlocks;
    }
  }
  return defaultMsg;
}

/**
 * 企业外部 MCP 客户端管理器 (Dual-Track MCP)
 * 支持基于标准 Model Context Protocol (stdio/sse) 动态连接外部系统 (ERP/CRM/工单)
 * 并自动发现、转换与挂载远程工具至本地 ToolRegistry
 */
export class McpClientManager {
  private readonly registry: ToolRegistry;
  private readonly servers = new Map<string, ManagedMcpServer>();

  constructor(options: { registry: ToolRegistry }) {
    this.registry = options.registry;
  }

  /**
   * 连接并动态注册一个外部 MCP Server
   * @param config MCP Server 连接配置
   * @returns 注册完成后的服务连接状态
   */
  public async registerServer(config: McpServerConfig): Promise<McpServerStatus> {
    if (!config || !config.id) {
      throw new McpClientError('MCP Server 配置无效：缺少 id 标识');
    }

    const serverId = config.id.trim();
    if (this.servers.has(serverId)) {
      await this.disconnectServer(serverId);
    }

    log.info(
      { serverId, transport: config.transport, name: config.name },
      '开始连接并挂载外部 MCP Server...'
    );

    let client: McpClientInstance;

    try {
      if (config.customClient) {
        client = config.customClient as McpClientInstance;
        await client.connect();
      } else if (config.transport === 'stdio') {
        if (!config.command) {
          throw new McpClientError(`stdio 传输协议必须提供 command 配置: ${serverId}`, serverId);
        }

        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args ?? [],
          env: config.env ?? (process.env as Record<string, string>),
          cwd: config.cwd,
        });

        const sdkClient = new Client(
          {
            name: `kkbot-mcp-client-${serverId}`,
            version: '2.0.0',
          },
          {
            capabilities: {},
          }
        );

        await sdkClient.connect(transport);
        client = sdkClient as unknown as McpClientInstance;
      } else if (config.transport === 'sse') {
        if (!config.url) {
          throw new McpClientError(`sse 传输协议必须提供 url 配置: ${serverId}`, serverId);
        }

        const transport = new SSEClientTransport(new URL(config.url), {
          requestInit: {
            headers: config.headers,
          },
        });

        const sdkClient = new Client(
          {
            name: `kkbot-mcp-client-${serverId}`,
            version: '2.0.0',
          },
          {
            capabilities: {},
          }
        );

        await sdkClient.connect(transport);
        client = sdkClient as unknown as McpClientInstance;
      } else {
        throw new McpClientError(`不支持的 MCP 传输协议类型: ${config.transport}`, serverId);
      }

      // 2. 动态发现远程 MCP 工具列表
      const toolsResult = await client.listTools();
      const rawTools = toolsResult.tools ?? [];

      const mountedToolNames: string[] = [];
      const toolPrefix = config.toolPrefix ?? '';
      const readOnlyToolsSet = new Set(config.readOnlyTools ?? []);
      const defaultReadOnly = config.defaultReadOnly ?? false;

      for (const mcpTool of rawTools) {
        const registeredToolId = `${toolPrefix}${mcpTool.name}`;
        const isReadOnly = readOnlyToolsSet.has(mcpTool.name) || defaultReadOnly;

        const agentTool: AgentTool<Record<string, unknown>, unknown> = createAgentTool({
          id: registeredToolId,
          description: mcpTool.description ?? `MCP 外部工具: ${mcpTool.name}`,
          readOnly: isReadOnly,
          inputSchema: z.record(z.string(), z.unknown()),
          execute: async (input) => {
            log.debug(
              { serverId, mcpTool: mcpTool.name, registeredId: registeredToolId },
              '调用远程 MCP 工具'
            );

            try {
              const res = await client.callTool({
                name: mcpTool.name,
                arguments: input,
              });

              if (res.isError) {
                const errMsg = extractMcpErrorMessage(res);
                throw new McpClientError(
                  `MCP 工具 "${mcpTool.name}" 执行返回错误: ${errMsg}`,
                  serverId
                );
              }

              return parseMcpContent(res);
            } catch (err) {
              if (err instanceof McpClientError) {
                throw err;
              }
              const message = err instanceof Error ? err.message : String(err);
              throw new McpClientError(
                `调用 MCP 服务 "${serverId}" 工具 "${mcpTool.name}" 发生异常: ${message}`,
                serverId,
                err instanceof Error ? err : undefined
              );
            }
          },
          metadata: {
            serverId,
            mcpOriginalName: mcpTool.name,
            transport: config.transport,
            isMcp: true,
          },
        });

        this.registry.register(agentTool, { override: true });
        mountedToolNames.push(registeredToolId);
      }

      const status: McpServerStatus = {
        id: serverId,
        status: 'connected',
        toolsCount: mountedToolNames.length,
        tools: mountedToolNames,
      };

      this.servers.set(serverId, {
        config,
        client,
        tools: mountedToolNames,
        status,
      });

      log.info(
        { serverId, toolsCount: mountedToolNames.length, tools: mountedToolNames },
        '外部 MCP Server 工具动态挂载就绪'
      );

      return status;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ serverId, err }, '连接或挂载外部 MCP Server 失败');

      if (error instanceof McpClientError) {
        throw error;
      }
      throw new McpClientError(`连接外部 MCP Server "${serverId}" 失败: ${err.message}`, serverId, err);
    }
  }

  /**
   * 断开指定 MCP Server 连接并从 ToolRegistry 注销其动态工具
   * @param serverId 服务 ID
   */
  public async disconnectServer(serverId: string): Promise<boolean> {
    const cleanId = serverId?.trim();
    const entry = this.servers.get(cleanId);
    if (!entry) {
      return false;
    }

    log.info({ serverId: cleanId, toolsCount: entry.tools.length }, '正在断开 MCP Server 并卸载工具...');

    // 1. 从 ToolRegistry 中卸载全部挂载的工具
    for (const toolId of entry.tools) {
      this.registry.unregister(toolId);
    }

    // 2. 关闭底层 MCP 通信客户端
    try {
      await entry.client.close();
    } catch (err) {
      log.warn({ serverId: cleanId, err }, '关闭 MCP 客户端底层连接时发生告警');
    }

    entry.tools = [];
    entry.status = {
      id: cleanId,
      status: 'disconnected',
      toolsCount: 0,
      tools: [],
    };

    log.info({ serverId: cleanId }, 'MCP Server 已安全断开并清理');
    return true;
  }

  /**
   * 获取指定 MCP Server 的运行时连接状态
   */
  public getServerStatus(serverId: string): McpServerStatus | undefined {
    return this.servers.get(serverId?.trim())?.status;
  }

  /**
   * 获取所有已挂载的 MCP Server 状态列表
   */
  public getAllServerStatuses(): McpServerStatus[] {
    return Array.from(this.servers.values()).map(s => s.status);
  }

  /**
   * 关闭所有 MCP Server 连接并注销所有动态工具
   */
  public async close(): Promise<void> {
    const serverIds = Array.from(this.servers.keys());
    log.info({ serverCount: serverIds.length }, '正在关闭所有外部 MCP Server 连接...');

    for (const serverId of serverIds) {
      await this.disconnectServer(serverId);
    }

    this.servers.clear();
    log.info('所有外部 MCP Server 已全部关闭');
  }
}
