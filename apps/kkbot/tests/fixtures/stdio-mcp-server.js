#!/usr/bin/env node
import readline from 'node:readline';

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'test-mcp-server',
            version: '1.0.0',
          },
        },
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } else if (msg.method === 'tools/list') {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          tools: [
            {
              name: 'echo',
              description: 'Echo message for MCP discovery test',
              inputSchema: {
                type: 'object',
                properties: {
                  message: { type: 'string' },
                },
                required: ['message'],
              },
            },
            {
              name: 'get_env',
              description: 'Get environment variable from child process',
              inputSchema: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                },
                required: ['key'],
              },
            },
          ],
        },
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    } else if (msg.method === 'tools/call') {
      const toolName = msg.params?.name;
      if (toolName === 'get_env') {
        const key = msg.params?.arguments?.key;
        const value = key ? process.env[key] : JSON.stringify(process.env);
        const response = {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: value === undefined ? '__UNDEFINED__' : String(value),
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      } else {
        const response = {
          jsonrpc: '2.0',
          id: msg.id,
          result: {
            content: [
              {
                type: 'text',
                text: `echo: ${msg.params?.arguments?.message ?? ''}`,
              },
            ],
          },
        };
        process.stdout.write(`${JSON.stringify(response)}\n`);
      }
    } else if (msg.id !== undefined) {
      const response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: {},
      };
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch {
    // ignore
  }
});
