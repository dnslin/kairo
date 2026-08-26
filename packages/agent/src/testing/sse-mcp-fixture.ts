import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

export interface SseMcpServerFixtureOptions {
  port: number;
  tools?: Array<{ name: string; description?: string }>;
}

export interface SseMcpServerFixture {
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * createSseMcpServerFixture: 创建真实可运行的 SSE MCP Server 夹具
 */
export function createSseMcpServerFixture(
  options: SseMcpServerFixtureOptions
): SseMcpServerFixture {
  const mcpServer = new McpServer({
    name: 'test-delayed-mcp',
    version: '1.0.0',
  });

  for (const t of options.tools ?? []) {
    mcpServer.tool(t.name, t.description ?? 'Test tool', {}, () => {
      return Promise.resolve({
        content: [{ type: 'text', text: 'delayed tool result' }],
      });
    });
  }

  let transport: SSEServerTransport | null = null;
  const httpServer: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      if (req.url === '/sse') {
        transport = new SSEServerTransport('/messages', res);
        await mcpServer.connect(transport);
      } else if (req.url?.startsWith('/messages') && req.method === 'POST') {
        if (transport) {
          await transport.handlePostMessage(req, res);
        } else {
          res.writeHead(400).end('No active transport');
        }
      } else {
        res.writeHead(404).end('Not found');
      }
    })();
  });

  return {
    start: (): Promise<void> =>
      new Promise<void>(resolveServer => {
        httpServer.listen(options.port, '127.0.0.1', () => resolveServer());
      }),
    close: async (): Promise<void> => {
      await mcpServer.close();
      await new Promise<void>(resolveClose => {
        httpServer.close(() => resolveClose());
      });
    },
  };
}
