import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/tools/registry.js';
import { McpClientManager } from '../src/tools/mcp.js';
import type { McpServerConfig } from '../src/tools/types.js';
import { McpClientError } from '../src/utils/errors.js';

describe('McpClientManager 外部 MCP 客户端管理器与动态工具挂载 (TDD Red -> Green)', () => {
  // 创建一个轻量 Mock MCP Client 用于测试
  const createMockMcpClient = (options?: {
    tools?: Array<{
      name: string;
      description?: string;
      inputSchema?: Record<string, unknown>;
    }>;
    callToolHandler?: (name: string, args: Record<string, unknown>) => Promise<{
      content: Array<{ type: string; text?: string; data?: string }>;
      isError?: boolean;
    }>;
  }) => {
    const mockTools = options?.tools ?? [
      {
        name: 'query_erp_order',
        description: '查询 ERP 订单详情',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: '订单号' },
          },
          required: ['orderId'],
        },
      },
      {
        name: 'update_order_status',
        description: '更新 ERP 订单状态',
        inputSchema: {
          type: 'object',
          properties: {
            orderId: { type: 'string' },
            status: { type: 'string', enum: ['PAID', 'SHIPPED', 'CANCELLED'] },
          },
          required: ['orderId', 'status'],
        },
      },
    ];

    const callTool = options?.callToolHandler ?? (async (name: string, args: Record<string, unknown>) => {
      await Promise.resolve();
      if (name === 'query_erp_order') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ orderId: args.orderId, amount: 998, status: 'PAID' }),
            },
          ],
        };
      }
      if (name === 'update_order_status') {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: true, newStatus: args.status }),
            },
          ],
        };
      }
      throw new Error(`未知 MCP 工具: ${name}`);
    });

    return {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      listTools: vi.fn().mockResolvedValue({ tools: mockTools }),
      callTool: vi.fn().mockImplementation(async ({ name, arguments: args }: { name: string; arguments?: Record<string, unknown> }) => {
        return callTool(name, args ?? {});
      }),
    };
  };

  it('应当能连接 MCP Server 并将远程工具动态挂载到 ToolRegistry 中', async () => {
    const registry = new ToolRegistry();
    const manager = new McpClientManager({ registry });

    const mockClient = createMockMcpClient();
    const config: McpServerConfig = {
      id: 'erp_server',
      name: '企业 ERP 系统',
      transport: 'custom',
      customClient: mockClient,
      toolPrefix: 'erp_',
      readOnlyTools: ['query_erp_order'], // 明确标记为只读
      defaultReadOnly: false,
    };

    await manager.registerServer(config);

    expect(registry.has('erp_query_erp_order')).toBe(true);
    expect(registry.has('erp_update_order_status')).toBe(true);

    const queryTool = registry.get('erp_query_erp_order');
    expect(queryTool).toBeDefined();
    expect(queryTool?.description).toBe('查询 ERP 订单详情');
    expect(queryTool?.readOnly).toBe(true); // 声明在 readOnlyTools 中

    const updateTool = registry.get('erp_update_order_status');
    expect(updateTool).toBeDefined();
    expect(updateTool?.readOnly).toBe(false); // 未在 readOnlyTools 中，遵循 defaultReadOnly: false

    const status = manager.getServerStatus('erp_server');
    expect(status?.status).toBe('connected');
    expect(status?.toolsCount).toBe(2);
    expect(status?.tools).toEqual(['erp_query_erp_order', 'erp_update_order_status']);
  });

  it('通过 ToolRegistry 执行动态挂载的 MCP 工具时应当正确转发并解析返回值', async () => {
    const registry = new ToolRegistry();
    const manager = new McpClientManager({ registry });

    const mockClient = createMockMcpClient();
    await manager.registerServer({
      id: 'erp_server',
      transport: 'custom',
      customClient: mockClient,
      toolPrefix: 'erp_',
    });

    const queryTool = registry.get('erp_query_erp_order');
    expect(queryTool).toBeDefined();

    const output = await queryTool!.execute({ orderId: 'ORD_2026_001' });

    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: 'query_erp_order',
      arguments: { orderId: 'ORD_2026_001' },
    });

    expect(output).toEqual({
      orderId: 'ORD_2026_001',
      amount: 998,
      status: 'PAID',
    });
  });

  it('当 MCP Server 执行返回错误或异常时应当正确抛出 McpClientError', async () => {
    const registry = new ToolRegistry();
    const manager = new McpClientManager({ registry });

    const mockClient = createMockMcpClient({
      callToolHandler: async () => {
        await Promise.resolve();
        return {
          isError: true,
          content: [{ type: 'text', text: '订单不存在或已被删除' }],
        };
      },
    });

    await manager.registerServer({
      id: 'erp_server',
      transport: 'custom',
      customClient: mockClient,
      toolPrefix: 'erp_',
    });

    const queryTool = registry.get('erp_query_erp_order');
    await expect(queryTool!.execute({ orderId: 'ORD_NOT_EXIST' })).rejects.toThrowError(McpClientError);
    await expect(queryTool!.execute({ orderId: 'ORD_NOT_EXIST' })).rejects.toThrowError(/订单不存在或已被删除/);
  });

  it('断开 MCP Server 连接时应当从 ToolRegistry 中自动注销卸载对应的工具', async () => {
    const registry = new ToolRegistry();
    const manager = new McpClientManager({ registry });

    const mockClient = createMockMcpClient();
    await manager.registerServer({
      id: 'erp_server',
      transport: 'custom',
      customClient: mockClient,
      toolPrefix: 'erp_',
    });

    expect(registry.has('erp_query_erp_order')).toBe(true);

    await manager.disconnectServer('erp_server');

    expect(registry.has('erp_query_erp_order')).toBe(false);
    expect(registry.has('erp_update_order_status')).toBe(false);
    expect(mockClient.close).toHaveBeenCalled();

    const status = manager.getServerStatus('erp_server');
    expect(status?.status).toBe('disconnected');
    expect(status?.toolsCount).toBe(0);
  });

  it('调用 close() 时应当注销并关闭所有已连接的 MCP Server', async () => {
    const registry = new ToolRegistry();
    const manager = new McpClientManager({ registry });

    const mockClient1 = createMockMcpClient();
    const mockClient2 = createMockMcpClient();

    await manager.registerServer({
      id: 'srv1',
      transport: 'custom',
      customClient: mockClient1,
      toolPrefix: 's1_',
    });

    await manager.registerServer({
      id: 'srv2',
      transport: 'custom',
      customClient: mockClient2,
      toolPrefix: 's2_',
    });

    expect(registry.has('s1_query_erp_order')).toBe(true);
    expect(registry.has('s2_query_erp_order')).toBe(true);

    await manager.close();

    expect(registry.has('s1_query_erp_order')).toBe(false);
    expect(registry.has('s2_query_erp_order')).toBe(false);
    expect(mockClient1.close).toHaveBeenCalled();
    expect(mockClient2.close).toHaveBeenCalled();
  });
});
