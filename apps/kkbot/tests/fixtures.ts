import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const STDIO_MCP_SERVER_SCRIPT = path.resolve(__dirname, 'fixtures/stdio-mcp-server.js');

export interface CreateTestConfigOptions {
  dbFilePath: string;
  cdpUrl?: string;
  embeddingEnabled?: boolean;
  mcpRequired?: boolean;
  useStdioMcpServer?: boolean;
  stdioScriptPath?: string;
  mcpCustomServers?: string;
}

/**
 * 生成测试用标准合法 AppConfig YAML 配置字符串
 */
export function createValidTestYaml(options: CreateTestConfigOptions): string {
  const {
    dbFilePath,
    cdpUrl = 'http://127.0.0.1:9222',
    embeddingEnabled = false,
    mcpRequired = false,
    useStdioMcpServer = false,
    stdioScriptPath = STDIO_MCP_SERVER_SCRIPT,
    mcpCustomServers,
  } = options;

  const normalizedDb = dbFilePath.replace(/\\/g, '/');
  const nodeExec = process.execPath.replace(/\\/g, '/');
  const normalizedScript = stdioScriptPath.replace(/\\/g, '/');

  let serverLines = '{}';
  if (mcpCustomServers) {
    serverLines = `\n${mcpCustomServers}`;
  } else if (useStdioMcpServer) {
    serverLines = `
    local:
      command: "${nodeExec}"
      args:
        - "${normalizedScript}"
      required: ${mcpRequired}
      tools:
        - name: echo
          effect: read
          risk: low`;
  }
  const mcpSection = `
mcp:
  perServerTimeoutMs: 5000
  servers: ${serverLines}
`;
  return `
kk:
  cdp:
    url: "${cdpUrl}"
  debounceMs: 1500
  maxWaitMs: 5000
  takeoverMinutes: 10

storage:
  url: "file:${normalizedDb}"

mastra:
  observability:
    enabled: true
    redactSensitiveData: true
${mcpSection}
agent:
  id: kk-assistant
  soulPath: ./config/soul.md
  maxSteps: 5
  memory:
    lastMessages: 10
    observationalMemory: false

knowledge:
  sources: ./data/knowledge/sources
  normalized: ./data/knowledge/normalized
  lexical:
    enabled: true
  embedding:
    enabled: ${embeddingEnabled}
  rerank:
    enabled: false

limits:
  timezone: Asia/Shanghai
  globalDailyTokens: 1000000
  userDailyTokens: 50000
  userDailyRequests: 100

retention:
  mediaDays: 30
  deliverableDays: 30
  logDays: 7
`;
}
