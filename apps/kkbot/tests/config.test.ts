import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { loadConfigFromYaml, interpolateEnv, ConfigValidationError } from '../src/config.js';

describe('统一 YAML 配置加载与静态校验', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-config-test-'));
  });

  afterEach(async () => {
    process.env = originalEnv;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const validYamlContent = `
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

  it('AC5: 正确读取合法 YAML 配置并完成环境变量插值', async () => {
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_API_KEY = 'sk-test-valid-key';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYamlContent, 'utf-8');

    const config = await loadConfigFromYaml(configPath);

    expect(config.kk.cdp.url).toBe('http://127.0.0.1:9222');
    expect(config.kk.debounceMs).toBe(1500);
    expect(config.storage.url).toBe('file:./data/kkbot.db');
    expect(config.mastra.observability.enabled).toBe(true);
    expect(config.knowledge.embedding.apiKey).toBe('sk-test-valid-key');
    expect(config.knowledge.embedding.baseUrl).toBe('https://api.openai.com/v1');
    expect(config.knowledge.embedding.model).toBe('text-embedding-3-small');
    expect(config.limits.timezone).toBe('Asia/Shanghai');
  });

  it('AC6/AC7: 存在未解析变量时在取得资源前失败，并提供中文错误、字段路径与修复提示', async () => {
    delete process.env.EMBEDDING_API_KEY;
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYamlContent, 'utf-8');

    let thrownError: ConfigValidationError | null = null;
    try {
      await loadConfigFromYaml(configPath);
    } catch (err) {
      thrownError = err as ConfigValidationError;
    }

    expect(thrownError).toBeInstanceOf(ConfigValidationError);
    expect(thrownError?.errors.length).toBeGreaterThan(0);
    const apiError = thrownError?.errors.find((e) => e.path === 'knowledge.embedding.apiKey');
    expect(apiError).toBeDefined();
    expect(apiError?.reason).toMatch(/未解析的环境变量|缺少环境变量/);
    expect(apiError?.hint).toMatch(/设置环境变量|EMBEDDING_API_KEY/);
  });

  it('AC6/AC7: 必填凭据为空时报错，并提示字段路径、原因和修复建议', async () => {
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_API_KEY = '   '; // 空白字符
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYamlContent, 'utf-8');

    let thrownError: ConfigValidationError | null = null;
    try {
      await loadConfigFromYaml(configPath);
    } catch (err) {
      thrownError = err as ConfigValidationError;
    }

    expect(thrownError).toBeInstanceOf(ConfigValidationError);
    const apiError = thrownError?.errors.find(e => e.path === 'knowledge.embedding.apiKey');
    expect(apiError).toBeDefined();
    expect(apiError?.reason).toMatch(/不能为空/);
    expect(apiError?.hint).toMatch(/请提供有效的 API 凭据/);
  });

  it('AC6/AC7: 存在未知字段时严格模式拦截，并提供中文错误与修复提示', async () => {
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_API_KEY = 'sk-test-valid-key';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const yamlWithUnknownField = validYamlContent + '\nunknown_top_level_field: 12345\n';
    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, yamlWithUnknownField, 'utf-8');

    let thrownError: ConfigValidationError | null = null;
    try {
      await loadConfigFromYaml(configPath);
    } catch (err) {
      thrownError = err as ConfigValidationError;
    }

    expect(thrownError).toBeInstanceOf(ConfigValidationError);
    const unknownError = thrownError?.errors.find(e => e.path.includes('unknown_top_level_field'));
    expect(unknownError).toBeDefined();
    expect(unknownError?.reason).toMatch(/未识别的配置字段|未知字段/);
    expect(unknownError?.hint).toMatch(/删除未定义的配置项/);
  });

  it('AC6/AC7: 非法值（如负数超时、非法 URL 等）在取得资源前失败', async () => {
    process.env.EMBEDDING_BASE_URL = 'not-a-valid-url';
    process.env.EMBEDDING_API_KEY = 'sk-test';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const invalidYaml = validYamlContent.replace('debounceMs: 1500', 'debounceMs: -100');
    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, invalidYaml, 'utf-8');

    let thrownError: ConfigValidationError | null = null;
    try {
      await loadConfigFromYaml(configPath);
    } catch (err) {
      thrownError = err as ConfigValidationError;
    }

    expect(thrownError).toBeInstanceOf(ConfigValidationError);
    const debounceError = thrownError?.errors.find(e => e.path === 'kk.debounceMs');
    expect(debounceError).toBeDefined();
    expect(debounceError?.reason).toMatch(/必须大于或等于 0|必须为非负整数/);
  });

  it('AC8: 单一数据库位置约束 - 配置只声明 storage.url，无第二个数据库入口', async () => {
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_API_KEY = 'sk-test-valid-key';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYamlContent, 'utf-8');

    const config = await loadConfigFromYaml(configPath);
    expect(config.storage.url).toBeDefined();
    const configRecord = config as unknown as Record<string, unknown>;
    const agentRecord = configRecord['agent'] as Record<string, unknown> | undefined;
    const knowledgeRecord = configRecord['knowledge'] as Record<string, unknown> | undefined;
    expect(agentRecord?.['database']).toBeUndefined();
    expect(knowledgeRecord?.['database']).toBeUndefined();
  });

  it('环境变量插值支持默认值语法 ${VAR:-default}', () => {
    delete process.env['TEST_OPTIONAL_VAR'];
    process.env['TEST_EXISTING_VAR'] = 'custom-value';

    const raw = 'url: ${TEST_EXISTING_VAR} | default: ${TEST_OPTIONAL_VAR:-fallback-value}';
    const interpolated = interpolateEnv(raw);
    expect(interpolated).toBe('url: custom-value | default: fallback-value');
  });

  it('环境变量包含冒号、井号与换行符等特殊字符时，插值安全且不破坏配置解析', async () => {
    process.env.EMBEDDING_BASE_URL = 'https://api.openai.com/v1';
    process.env.EMBEDDING_API_KEY = 'sk-test#with:special\nchars"and\'quotes';
    process.env.EMBEDDING_MODEL = 'text-embedding-3-small';

    const configPath = path.join(tempDir, 'kkbot.yaml');
    await fs.writeFile(configPath, validYamlContent, 'utf-8');

    const config = await loadConfigFromYaml(configPath);
    expect(config.knowledge.embedding.apiKey).toBe('sk-test#with:special\nchars"and\'quotes');
  });
});
