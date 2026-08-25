import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { runCli } from '../src/main.js';

describe('正式应用命令行入口 (CLI)', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-cli-test-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const validYaml = `
kk:
  cdp:
    url: http://127.0.0.1:9222
  debounceMs: 1500
  maxWaitMs: 5000
  takeoverMinutes: 10

storage:
  url: file:./data/kkbot.db

mastra:
  observability:
    enabled: true
    redactSensitiveData: true

mcp:
  perServerTimeoutMs: 5000
  servers:
    enterprise-search:
      required: true

agent:
  id: kk-assistant
  soulPath: ./config/soul.md
  maxSteps: 5
  memory:
    lastMessages: 20
    observationalMemory: true

knowledge:
  sources: ./data/knowledge/sources
  normalized: ./data/knowledge/normalized
  lexical:
    enabled: true
  embedding:
    enabled: true
    baseUrl: \${EMBEDDING_BASE_URL}
    apiKey: \${EMBEDDING_API_KEY}
    model: \${EMBEDDING_MODEL}
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

  it('doctor 命令在配置合法时成功返回 0 并输出中文通过信息', async () => {
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_API_KEY = 'sk-test-valid-key';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYaml, 'utf-8');

    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(['doctor', '--config', configPath], {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    });

    expect(exitCode).toBe(0);
    expect(logs.some(l => l.includes('配置静态校验通过') || l.includes('通过'))).toBe(true);
    expect(errors.length).toBe(0);
  });

  it('doctor 命令在配置非法时返回非 0 并输出中文错误、路径与修复提示', async () => {
    delete process.env.EMBEDDING_API_KEY;
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYaml, 'utf-8');

    const logs: string[] = [];
    const errors: string[] = [];
    const exitCode = await runCli(['doctor', '--config', configPath], {
      log: (msg: string) => logs.push(msg),
      error: (msg: string) => errors.push(msg),
    });

    expect(exitCode).toBe(1);
    expect(errors.some(e => e.includes('字段路径: knowledge.embedding.apiKey'))).toBe(true);
    expect(errors.some(e => e.includes('修复建议: 请在系统环境变量中设置 EMBEDDING_API_KEY'))).toBe(
      true
    );
  });
});
