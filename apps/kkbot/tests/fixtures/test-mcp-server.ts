import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'test-mcp-server', version: '1.0.0' });

server.registerTool(
  'echo',
  {
    description: 'Test echo tool for MCP discovery verification',
    inputSchema: { message: z.string() },
  },
  ({ message }) => ({ content: [{ type: 'text', text: message }] })
);

await server.connect(new StdioServerTransport());
