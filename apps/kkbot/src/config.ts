import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';
import { z } from 'zod';
import { ConfigValidationError, type ConfigFieldError } from './errors.js';

// ==========================================
// Zod Schema 定义（全部严格模式，禁止未知字段）
// ==========================================

const cdpConfigSchema = z
  .object({
    url: z.string().min(1, 'CDP URL 不能为空').url('CDP URL 必须是合法的 URL 格式'),
  })
  .strict();

const kkConfigSchema = z
  .object({
    cdp: cdpConfigSchema,
    debounceMs: z.number().int('必须为非负整数').min(0, '防抖等待时间必须大于或等于 0'),
    maxWaitMs: z.number().int('必须为正整数').min(1, '最大等待时间必须大于 0'),
    takeoverMinutes: z.number().int('必须为正整数').min(1, '人工接管超时时长必须大于 0'),
  })
  .strict();

const storageConfigSchema = z
  .object({
    url: z.string().min(1, '数据库存储 URL 不能为空'),
  })
  .strict();

const mastraObservabilitySchema = z
  .object({
    enabled: z.boolean(),
    redactSensitiveData: z.boolean(),
  })
  .strict();

const mastraConfigSchema = z
  .object({
    observability: mastraObservabilitySchema,
  })
  .strict();

const mcpServerItemSchema = z
  .object({
    required: z.boolean().default(true),
  })
  .strict();

const mcpConfigSchema = z
  .object({
    perServerTimeoutMs: z.number().int('必须为正整数').min(1, 'MCP 服务超时时间必须大于 0'),
    servers: z.record(z.string(), mcpServerItemSchema),
  })
  .strict();

const agentMemorySchema = z
  .object({
    lastMessages: z.number().int('必须为正整数').min(1, '保留历史消息数必须大于 0'),
    observationalMemory: z.boolean(),
  })
  .strict();

const agentConfigSchema = z
  .object({
    id: z.string().min(1, 'Agent ID 不能为空'),
    soulPath: z.string().min(1, '人设配置文件路径 soulPath 不能为空'),
    maxSteps: z.number().int('必须为正整数').min(1, 'Agent 最大步骤数必须大于 0'),
    memory: agentMemorySchema,
  })
  .strict();

const knowledgeLexicalSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const knowledgeEmbeddingSchema = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().nullable().optional(),
    apiKey: z.string().nullable().optional(),
    model: z.string().nullable().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.enabled) {
      if (!val.apiKey || typeof val.apiKey !== 'string' || val.apiKey.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Embedding 启用时 apiKey 不能为空',
          path: ['apiKey'],
        });
      }
      if (!val.baseUrl || typeof val.baseUrl !== 'string' || val.baseUrl.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Embedding 启用时 baseUrl 不能为空',
          path: ['baseUrl'],
        });
      } else {
        try {
          const parsedUrl = new URL(val.baseUrl);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: 'Embedding baseUrl 协议必须是 http: 或 https:',
              path: ['baseUrl'],
            });
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'Embedding baseUrl 必须是合法的 URL 格式 (如 https://api.openai.com/v1)',
            path: ['baseUrl'],
          });
        }
      }
      if (!val.model || typeof val.model !== 'string' || val.model.trim().length === 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Embedding 启用时 model 不能为空',
          path: ['model'],
        });
      }
    }
  });

const knowledgeRerankSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();

const knowledgeConfigSchema = z
  .object({
    sources: z.string().min(1, '知识源目录 sources 不能为空'),
    normalized: z.string().min(1, '归一化知识目录 normalized 不能为空'),
    lexical: knowledgeLexicalSchema,
    embedding: knowledgeEmbeddingSchema,
    rerank: knowledgeRerankSchema,
  })
  .strict();

const limitsConfigSchema = z
  .object({
    timezone: z.string().min(1, '时区设置不能为空'),
    globalDailyTokens: z.number().int('必须为正整数').min(1, '全局每日 Token 限额必须大于 0'),
    userDailyTokens: z.number().int('必须为正整数').min(1, '单用户每日 Token 限额必须大于 0'),
    userDailyRequests: z.number().int('必须为正整数').min(1, '单用户每日请求限额必须大于 0'),
  })
  .strict();

const retentionConfigSchema = z
  .object({
    mediaDays: z.number().int('必须为正整数').min(1, '媒体保留天数必须大于 0'),
    deliverableDays: z.number().int('必须为正整数').min(1, '交付物保留天数必须大于 0'),
    logDays: z.number().int('必须为正整数').min(1, '日志保留天数必须大于 0'),
  })
  .strict();

export const appConfigSchema = z
  .object({
    kk: kkConfigSchema,
    storage: storageConfigSchema,
    mastra: mastraConfigSchema,
    mcp: mcpConfigSchema,
    agent: agentConfigSchema,
    knowledge: knowledgeConfigSchema,
    limits: limitsConfigSchema,
    retention: retentionConfigSchema,
  })
  .strict();

export type AppConfig = z.infer<typeof appConfigSchema>;

// ==========================================
// 环境变量插值
// ==========================================

const ENV_VAR_REGEX = /\$\{([A-Za-z0-9_]+)(?::-([^}]*))?\}/g;

/**
 * 对原始字符串进行单行或纯文本环境变量插值（辅助工具函数）。
 */
export function interpolateEnv(rawText: string): string {
  const missingVars: Array<{ varName: string }> = [];

  const replaced = rawText.replace(
    ENV_VAR_REGEX,
    (_match, varName: string, defaultValue?: string) => {
      const envVal = process.env[varName];
      if (envVal !== undefined) {
        return envVal;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      missingVars.push({ varName });
      return '';
    }
  );

  if (missingVars.length > 0) {
    const errors: ConfigFieldError[] = missingVars.map(item => ({
      path: `env.${item.varName}`,
      reason: `未解析的环境变量 \${${item.varName}}：系统环境变量中未设置该变量且配置未提供默认值`,
      hint: `请在系统环境变量中设置 ${item.varName}，或在配置中指定默认值 \${${item.varName}:-默认值}`,
      message: `缺少环境变量 ${item.varName}`,
    }));
    throw new ConfigValidationError(errors);
  }

  return replaced;
}

const CREDENTIAL_FIELD_PATHS: Record<string, true> = {
  'knowledge.embedding.apiKey': true,
};

/**
 * 递归对已解析的 YAML 对象结构进行环境变量插值，精确绑定字段路径并拦截明文硬编码凭据。
 */
function interpolateNodeEnv(
  node: unknown,
  currentPath: string[],
  errors: ConfigFieldError[]
): unknown {
  if (typeof node === 'string') {
    const fieldPath = currentPath.join('.') || 'root';
    if (CREDENTIAL_FIELD_PATHS[fieldPath]) {
      const hasEnvSyntax = ENV_VAR_REGEX.test(node);
      ENV_VAR_REGEX.lastIndex = 0;
      if (!hasEnvSyntax && node.trim().length > 0) {
        errors.push({
          path: fieldPath,
          reason:
            '凭据禁止在配置文件中明文硬编码：根据安全规范（Spec §4.29），所有凭据只能通过环境变量插值传入',
          hint: `请将 '${fieldPath}' 修改为环境变量插值形式，例如: apiKey: \${EMBEDDING_API_KEY}`,
          message: `字段 '${fieldPath}' 禁止硬编码明文凭据`,
        });
        return '';
      }
    }

    return node.replace(ENV_VAR_REGEX, (_match, varName: string, defaultValue?: string) => {
      if (CREDENTIAL_FIELD_PATHS[fieldPath] && defaultValue !== undefined) {
        errors.push({
          path: fieldPath,
          reason: '凭据禁止在配置文件中声明默认值回退：根据安全规范，凭据不能包含明文 fallback',
          hint: `请将 '${fieldPath}' 声明为纯环境变量引用，例如: apiKey: \${${varName}}`,
          message: `字段 '${fieldPath}' 禁止声明默认值回退`,
        });
        return '';
      }
      const envVal = process.env[varName];
      if (envVal !== undefined) {
        return envVal;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      errors.push({
        path: fieldPath,
        reason: `未解析的环境变量 \${${varName}}：系统环境变量中未设置该变量且配置未提供默认值`,
        hint: `请在系统环境变量中设置 ${varName}，或在配置中指定默认值 \${${varName}:-默认值}`,
        message: `字段 '${fieldPath}' 缺少环境变量 ${varName}`,
      });
      return '';
    });
  }

  if (Array.isArray(node)) {
    return node.map((item, idx) => interpolateNodeEnv(item, [...currentPath, String(idx)], errors));
  }

  if (typeof node === 'object' && node !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      result[key] = interpolateNodeEnv(value, [...currentPath, key], errors);
    }
    return result;
  }

  return node;
}

// ==========================================
// Zod 校验与中文错误映射
// ==========================================

function translateZodIssue(issue: z.ZodIssue): ConfigFieldError {
  const fieldPath = issue.path.join('.') || 'root';

  switch (issue.code) {
    case 'invalid_type': {
      if (issue.input === undefined || issue.input === null) {
        return {
          path: fieldPath,
          reason: '必填配置项缺失或值为空',
          hint: `请在配置文件中为 '${fieldPath}' 提供有效的 ${issue.expected} 值`,
          message: `字段 '${fieldPath}' 不能为空`,
        };
      }
      return {
        path: fieldPath,
        reason: `字段类型错误：期望为 ${issue.expected}，实际收到 ${typeof issue.input}`,
        hint: `请检查并修改 '${fieldPath}' 的值，确保其类型为 ${issue.expected}`,
        message: `字段 '${fieldPath}' 类型错误`,
      };
    }
    case 'unrecognized_keys': {
      const keys = issue.keys.join("', '");
      return {
        path:
          fieldPath === 'root' ? issue.keys.join(', ') : `${fieldPath}.${issue.keys.join(', ')}`,
        reason: `未识别的配置字段: '${keys}'（严格模式不允许未知字段）`,
        hint: `请从配置文件中删除未定义的配置项 '${keys}'`,
        message: `存在未知配置字段 '${keys}'`,
      };
    }
    case 'too_small': {
      return {
        path: fieldPath,
        reason: `数值或长度越界：必须大于或等于 ${issue.minimum}`,
        hint: `请将 '${fieldPath}' 调整为 >= ${issue.minimum} 的合法数值`,
        message: issue.message || `字段 '${fieldPath}' 小于允许的最小值`,
      };
    }
    case 'too_big': {
      return {
        path: fieldPath,
        reason: `数值或长度越界：必须小于或等于 ${issue.maximum}`,
        hint: `请将 '${fieldPath}' 调整为 <= ${issue.maximum} 的合法数值`,
        message: issue.message || `字段 '${fieldPath}' 超过允许的最大值`,
      };
    }
    case 'invalid_format': {
      return {
        path: fieldPath,
        reason: `字符串格式不合法：${issue.message}`,
        hint: `请检查 '${fieldPath}' 的格式，确保符合规范要求`,
        message: issue.message,
      };
    }
    case 'custom': {
      let hint = '请按照配置规范提供合法的值';
      if (fieldPath.includes('apiKey')) {
        hint = '请提供有效的 API 凭据（可通过环境变量插值传入，如 ${EMBEDDING_API_KEY}）';
      }
      return {
        path: fieldPath,
        reason: issue.message,
        hint,
        message: issue.message,
      };
    }
    default: {
      return {
        path: fieldPath,
        reason: issue.message,
        hint: `请检查 '${fieldPath}' 的配置值是否符合规范`,
        message: issue.message,
      };
    }
  }
}

/**
 * 解析并校验 YAML 字符串为强类型 AppConfig。
 */
export function parseAndValidateConfig(rawYaml: string): AppConfig {
  // 1. YAML 语法解析
  let parsedObject: unknown;
  try {
    parsedObject = yaml.parse(rawYaml);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(
      [
        {
          path: 'yaml.syntax',
          reason: `YAML 语法解析错误: ${errorMsg}`,
          hint: '请检查 YAML 格式缩进与语法是否规范',
          message: errorMsg,
        },
      ],
      { cause: err }
    );
  }

  if (typeof parsedObject !== 'object' || parsedObject === null) {
    throw new ConfigValidationError([
      {
        path: 'root',
        reason: '配置文件内容不能为空或非对象格式',
        hint: '请提供包含完整配置项的 YAML 文档',
        message: '配置文件内容为空',
      },
    ]);
  }

  // 2. 基于精确字段路径的环境变量插值
  const envErrors: ConfigFieldError[] = [];
  const interpolatedObject = interpolateNodeEnv(parsedObject, [], envErrors);

  if (envErrors.length > 0) {
    throw new ConfigValidationError(envErrors);
  }

  // 3. Zod 严格校验
  const result = appConfigSchema.safeParse(interpolatedObject);
  if (!result.success) {
    const errors = result.error.issues.map(translateZodIssue);
    throw new ConfigValidationError(errors);
  }

  return result.data;
}

/**
 * 从指定文件路径读取并加载 YAML 配置。
 */
export async function loadConfigFromYaml(filePath: string): Promise<AppConfig> {
  const resolvedPath = path.resolve(filePath);
  let rawContent: string;
  try {
    rawContent = await fs.readFile(resolvedPath, 'utf-8');
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new ConfigValidationError(
      [
        {
          path: 'file.read',
          reason: `无法读取配置文件 '${resolvedPath}': ${errorMsg}`,
          hint: '请确保配置文件路径正确且进程具备读取权限',
          message: errorMsg,
        },
      ],
      { cause: err }
    );
  }

  return parseAndValidateConfig(rawContent);
}

export { ConfigValidationError };
