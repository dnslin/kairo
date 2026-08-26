import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('generate-file-deliverable');
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAgentTool } from '../registry.js';
import type { AgentTool, ToolExecutionContext } from '../types.js';
import { ToolValidationError } from '../../utils/errors.js';
import { createKkTool, type KkMastraTool } from '../create-tool.js';
import { MASTRA_THREAD_ID_KEY, MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
/**
 * 文件交付物生成工具入参 Schema
 */
export const GenerateFileDeliverableInputSchema = z.object({
  fileType: z
    .enum(['csv', 'md', 'markdown'])
    .describe('生成的文件交付物类型：csv 结构化表格 或 md/markdown Markdown 文本报告'),
  fileName: z
    .string()
    .min(1, '文件名不能为空')
    .describe('目标文件名（如 organization_roster.csv 或 weekly_report.md）'),
  content: z.string().optional().describe('针对 md/markdown 报告的文本内容'),
  data: z
    .array(z.record(z.string(), z.unknown()))
    .optional()
    .describe('针对 csv 表格的行数据数组（对象数组，每个对象的 key 将自动提取为 CSV 表头）'),
  subDir: z.string().default('files').optional().describe('媒体受控存储子目录，默认 files'),
  idempotencyKey: z
    .string()
    .min(1, '幂等键 idempotencyKey 不能为空')
    .describe('稳定业务幂等键，防止单会话内重复产生文件写入副作用'),
});
export type GenerateFileDeliverableInput = z.infer<typeof GenerateFileDeliverableInputSchema>;

export const GenerateFileDeliverableOutputSchema = z.object({
  success: z.boolean(),
  fileName: z.string(),
  filePath: z.string(),
  relativePath: z.string(),
  sizeBytes: z.number(),
  format: z.enum(['csv', 'md']),
  lineCount: z.number(),
  idempotencyKey: z.string(),
  sessionId: z.string(),
  operatorId: z.string(),
  alreadyExisted: z.boolean().optional(),
});

/**
 * 文件交付物生成工具输出契约
 */
export type GenerateFileDeliverableOutput = z.infer<typeof GenerateFileDeliverableOutputSchema>;

export interface GenerateFileDeliverableExecutionContext {
  sessionId?: string;
  operatorId?: string;
}
/**
 * 工具构造配置选项
 */
export interface GenerateFileDeliverableOptions {
  /** 本地文件存储根目录，默认 'data/media' */
  baseDir?: string;
}

function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) {
    return '';
  }
  const str =
    typeof val === 'string'
      ? val
      : typeof val === 'number' || typeof val === 'boolean' || typeof val === 'bigint'
        ? String(val)
        : JSON.stringify(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * 将结构化对象数组转换为带 UTF-8 BOM 的标准 CSV 字符串
 */
function convertToCsv(data: Array<Record<string, unknown>>): {
  csvText: string;
  lineCount: number;
} {
  if (data.length === 0) {
    return { csvText: '\uFEFF', lineCount: 0 };
  }

  const headerKeys: string[] = [];
  const keySet: Record<string, true> = {};

  for (const row of data) {
    for (const key of Object.keys(row)) {
      if (!keySet[key]) {
        keySet[key] = true;
        headerKeys.push(key);
      }
    }
  }

  const lines: string[] = [];
  lines.push(headerKeys.map(escapeCsvCell).join(','));

  for (const row of data) {
    const rowCells = headerKeys.map(key => escapeCsvCell(row[key]));
    lines.push(rowCells.join(','));
  }

  const csvText = `\uFEFF${lines.join('\r\n')}`;
  return { csvText, lineCount: lines.length };
}

/**
 * 执行 generate_file_deliverable 的核心文件生成逻辑
 */
export function executeGenerateFileDeliverableCore(
  input: GenerateFileDeliverableInput,
  baseDir: string,
  seenIdempotencyKeys?: Record<string, string>,
  execCtx?: GenerateFileDeliverableExecutionContext
): GenerateFileDeliverableOutput {
  const { fileType, fileName, content, data, subDir = 'files', idempotencyKey } = input;
  const cleanFileName = fileName.trim();
  const normalizedFormat: 'csv' | 'md' = fileType === 'csv' ? 'csv' : 'md';

  if (!idempotencyKey || typeof idempotencyKey !== 'string' || idempotencyKey.trim().length === 0) {
    throw new ToolValidationError(
      'generate_file_deliverable',
      '低风险写操作必须提供有效的 idempotencyKey 幂等键'
    );
  }

  const effectiveSessionId = execCtx?.sessionId;
  const effectiveOperatorId = execCtx?.operatorId;

  if (!effectiveSessionId || effectiveSessionId.trim().length === 0) {
    throw new ToolValidationError(
      'generate_file_deliverable',
      '低风险写操作缺少明确的 sessionId 会话边界'
    );
  }

  if (!effectiveOperatorId || effectiveOperatorId.trim().length === 0) {
    throw new ToolValidationError(
      'generate_file_deliverable',
      '低风险写操作缺少明确的 operatorId 操作者身份'
    );
  }
  const normalizedBaseDir = resolve(baseDir);
  const targetDir = resolve(normalizedBaseDir, subDir, effectiveSessionId.trim());
  const relTargetDir = relative(normalizedBaseDir, targetDir);
  if (relTargetDir.startsWith('..') || isAbsolute(relTargetDir)) {
    throw new ToolValidationError(
      'generate_file_deliverable',
      `非法子目录路径: '${subDir}/${effectiveSessionId}' 试图逃逸出受管媒体根目录`
    );
  }
  if (cleanFileName.includes('..') || cleanFileName.includes('/') || cleanFileName.includes('\\')) {
    throw new ToolValidationError(
      'generate_file_deliverable',
      `非法文件名: '${cleanFileName}' 不能包含路径分隔符或父目录引用 (..)，试图逃逸出受管媒体根目录`
    );
  }

  const fullFilePath = resolve(targetDir, cleanFileName);
  const relFilePath = relative(normalizedBaseDir, fullFilePath);
  if (relFilePath.startsWith('..') || isAbsolute(relFilePath)) {
    throw new ToolValidationError(
      'generate_file_deliverable',
      `非法文件路径: '${cleanFileName}' 试图逃逸出受管媒体根目录`
    );
  }

  let fileBuffer: Buffer;
  let lineCount = 0;

  if (normalizedFormat === 'csv') {
    if (!data || !Array.isArray(data)) {
      throw new ToolValidationError(
        'generate_file_deliverable',
        '生成 CSV 文件必须提供 data 数组（结构化行数据）'
      );
    }
    const { csvText, lineCount: count } = convertToCsv(data);
    fileBuffer = Buffer.from(csvText, 'utf-8');
    lineCount = count;
  } else {
    if (content === undefined || content === null) {
      throw new ToolValidationError(
        'generate_file_deliverable',
        '生成 Markdown 文件必须提供 content 文本内容'
      );
    }
    fileBuffer = Buffer.from(content, 'utf-8');
    lineCount = content.split('\n').length;
  }

  mkdirSync(targetDir, { recursive: true });

  const relPath = relative(normalizedBaseDir, fullFilePath).replace(/\\/g, '/');

  // 2. 单会话作用域幂等防重检查
  const idempotencyScopeKey = `${effectiveSessionId}:${idempotencyKey.trim()}`;
  const contentHash = createHash('sha256').update(fileBuffer).digest('hex');
  const isKeyReplay = Boolean(
    seenIdempotencyKeys && seenIdempotencyKeys[idempotencyScopeKey] === fullFilePath
  );

  if (existsSync(fullFilePath)) {
    try {
      const existingBuffer = readFileSync(fullFilePath);
      const existingHash = createHash('sha256').update(existingBuffer).digest('hex');
      if (existingHash === contentHash || isKeyReplay) {
        return {
          success: true,
          fileName: cleanFileName,
          filePath: fullFilePath,
          relativePath: relPath,
          sizeBytes: fileBuffer.length,
          format: normalizedFormat,
          lineCount,
          idempotencyKey: idempotencyKey.trim(),
          sessionId: effectiveSessionId,
          operatorId: effectiveOperatorId,
          alreadyExisted: true,
        };
      }
    } catch (readErr) {
      log.warn({ err: readErr, fullFilePath }, '读取既有文件哈希失败，将重新写入文件');
    }
  }

  writeFileSync(fullFilePath, fileBuffer);
  if (seenIdempotencyKeys) {
    seenIdempotencyKeys[idempotencyScopeKey] = fullFilePath;
  }

  return {
    success: true,
    fileName: cleanFileName,
    filePath: fullFilePath,
    relativePath: relPath,
    sizeBytes: fileBuffer.length,
    format: normalizedFormat,
    lineCount,
    idempotencyKey: idempotencyKey.trim(),
    sessionId: effectiveSessionId,
    operatorId: effectiveOperatorId,
    alreadyExisted: false,
  };
}

/**
 * 创建 generate_file_deliverable 内置工具 (旧 ToolRegistry 兼容)
 */
export function createGenerateFileDeliverableTool(
  options: GenerateFileDeliverableOptions = {}
): AgentTool<GenerateFileDeliverableInput, GenerateFileDeliverableOutput> {
  const baseDir = resolve(options.baseDir ?? 'data/media');
  const seenIdempotencyKeys: Record<string, string> = {};

  return createAgentTool<GenerateFileDeliverableInput, GenerateFileDeliverableOutput>({
    id: 'generate_file_deliverable',
    description:
      '将结构化数据或文本整理生成为 .csv 花名册/表格或 .md Markdown 文档，并持久化保存至本地受控媒体目录。写操作工具。',
    readOnly: false,
    inputSchema: GenerateFileDeliverableInputSchema,
    execute: async (
      input,
      context?: ToolExecutionContext
    ): Promise<GenerateFileDeliverableOutput> => {
      await Promise.resolve();
      const sessionId = context?.threadId;
      const operatorId = context?.senderId ?? context?.resourceId;

      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        throw new ToolValidationError(
          'generate_file_deliverable',
          '低风险写操作工具缺少权威 threadId 会话身份，已阻断执行以防安全逃逸'
        );
      }

      if (!operatorId || typeof operatorId !== 'string' || operatorId.trim().length === 0) {
        throw new ToolValidationError(
          'generate_file_deliverable',
          '低风险写操作工具缺少权威 senderId/resourceId 操作者身份，已阻断执行以防安全逃逸'
        );
      }

      return executeGenerateFileDeliverableCore(input, baseDir, seenIdempotencyKeys, {
        sessionId: sessionId.trim(),
        operatorId: operatorId.trim(),
      });
    },
  });
}

/**
 * 创建 Mastra-native generate_file_deliverable 工具 (低风险写操作，具有幂等性与不可变 policy)
 */
export function createMastraGenerateFileDeliverableTool(
  options: GenerateFileDeliverableOptions = {}
): KkMastraTool<
  typeof GenerateFileDeliverableInputSchema,
  typeof GenerateFileDeliverableOutputSchema
> {
  const baseDir = resolve(options.baseDir ?? 'data/media');
  const seenIdempotencyKeys: Record<string, string> = {};

  return createKkTool({
    id: 'generate_file_deliverable',
    description:
      '将结构化数据或文本整理生成为 .csv 花名册/表格或 .md Markdown 文档，并持久化保存至本地受控媒体目录。低风险写操作。',
    effect: 'write',
    risk: 'low',
    serialKey: 'session',
    idempotencyField: 'idempotencyKey',
    inputSchema: GenerateFileDeliverableInputSchema,
    outputSchema: GenerateFileDeliverableOutputSchema,
    execute: async ({ context, requestContext }) => {
      await Promise.resolve();
      let reqSessionId: string | undefined;
      let reqOperatorId: string | undefined;

      if (requestContext && typeof (requestContext as { getRaw?: unknown }).getRaw === 'function') {
        const rc = requestContext as {
          getRaw: (k: string) => unknown;
          get?: (k: string) => unknown;
        };
        reqSessionId = (rc.getRaw(MASTRA_THREAD_ID_KEY) ?? rc.getRaw('sessionId')) as
          | string
          | undefined;
        reqOperatorId = (rc.getRaw(MASTRA_RESOURCE_ID_KEY) ?? rc.getRaw('operatorId')) as
          | string
          | undefined;
      } else if (requestContext && typeof (requestContext as { get?: unknown }).get === 'function') {
        const rc = requestContext as { get: (k: string) => unknown };
        reqSessionId = (rc.get(MASTRA_THREAD_ID_KEY) ?? rc.get('sessionId')) as string | undefined;
        reqOperatorId = (rc.get(MASTRA_RESOURCE_ID_KEY) ?? rc.get('operatorId')) as
          | string
          | undefined;
      }

      if (!reqSessionId || typeof reqSessionId !== 'string' || reqSessionId.trim().length === 0) {
        throw new ToolValidationError(
          'generate_file_deliverable',
          '低风险写操作工具缺少权威 sessionId 会话身份，已阻断执行以防安全逃逸'
        );
      }

      if (!reqOperatorId || typeof reqOperatorId !== 'string' || reqOperatorId.trim().length === 0) {
        throw new ToolValidationError(
          'generate_file_deliverable',
          '低风险写操作工具缺少权威 operatorId 操作者身份，已阻断执行以防安全逃逸'
        );
      }

      return executeGenerateFileDeliverableCore(context, baseDir, seenIdempotencyKeys, {
        sessionId: reqSessionId.trim(),
        operatorId: reqOperatorId.trim(),
      });
    },
  });
}
