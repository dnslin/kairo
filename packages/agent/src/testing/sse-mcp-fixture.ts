import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer } from 'node:net';
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

export async function getAvailableMcpFixturePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolveProbe, rejectProbe) => {
    probe.once('error', rejectProbe);
    probe.listen(0, '127.0.0.1', () => resolveProbe());
  });
  const address = probe.address();
  await new Promise<void>(resolveClose => probe.close(() => resolveClose()));
  if (!address || typeof address === 'string') {
    throw new Error('无法取得动态 MCP Fixture 端口');
  }
  return address.port;
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

  for (const toolDefinition of options.tools ?? []) {
    mcpServer.tool(toolDefinition.name, toolDefinition.description ?? 'Test tool', {}, () => {
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
