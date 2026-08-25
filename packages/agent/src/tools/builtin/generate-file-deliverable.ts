import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { z } from 'zod';
import { createAgentTool } from '../registry.js';
import type { AgentTool } from '../types.js';
import { ToolValidationError } from '../../utils/errors.js';
import { createChildLogger } from '../../utils/logger.js';

const log = createChildLogger('tool-file-deliverable');

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
});

export type GenerateFileDeliverableInput = z.infer<typeof GenerateFileDeliverableInputSchema>;

/**
 * 文件交付物生成工具输出契约
 */
export interface GenerateFileDeliverableOutput {
  success: boolean;
  fileName: string;
  filePath: string;
  relativePath: string;
  sizeBytes: number;
  format: 'csv' | 'md';
  lineCount: number;
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
  if (!Array.isArray(data) || data.length === 0) {
    return { csvText: '\uFEFF', lineCount: 0 };
  }

  // 1. 提取所有行的并集表头，保持首行顺序
  const headerSet = new Set<string>();
  for (const row of data) {
    if (row && typeof row === 'object') {
      for (const key of Object.keys(row)) {
        headerSet.add(key);
      }
    }
  }
  const headers = Array.from(headerSet);

  const lines: string[] = [];
  // 表头行
  lines.push(headers.map(h => escapeCsvCell(h)).join(','));

  // 数据行
  for (const row of data) {
    const rowCells = headers.map(header => escapeCsvCell(row?.[header]));
    lines.push(rowCells.join(','));
  }

  // UTF-8 BOM 确保 Windows Excel 打开不乱码
  const csvText = `\uFEFF${lines.join('\r\n')}`;
  return { csvText, lineCount: lines.length };
}

/**
 * 创建 generate_file_deliverable 内置工具
 * 将数据或文本整理生成为 .csv 花名册/表格或 .md Markdown 文档并持久化到本地受控媒体目录
 */
export function createGenerateFileDeliverableTool(
  options: GenerateFileDeliverableOptions = {}
): AgentTool<GenerateFileDeliverableInput, GenerateFileDeliverableOutput> {
  const baseDir = resolve(options.baseDir ?? 'data/media');

  return createAgentTool<GenerateFileDeliverableInput, GenerateFileDeliverableOutput>({
    id: 'generate_file_deliverable',
    description:
      '将结构化数据或文本整理生成为 .csv 花名册/表格或 .md Markdown 文档，并持久化保存至本地受控媒体目录。写操作工具。',
    readOnly: false, // 写操作工具
    inputSchema: GenerateFileDeliverableInputSchema,
    execute: async (input): Promise<GenerateFileDeliverableOutput> => {
      await Promise.resolve();
      const { fileType, fileName, content, data, subDir = 'files' } = input;
      const cleanFileName = fileName.trim();
      const normalizedFormat: 'csv' | 'md' = fileType === 'csv' ? 'csv' : 'md';

      log.debug(
        { fileType: normalizedFormat, fileName: cleanFileName, subDir },
        '开始生成文件交付物'
      );

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

      // 目标存储路径计算与目录确保
      const targetDir = join(baseDir, subDir);
      mkdirSync(targetDir, { recursive: true });

      const fullFilePath = join(targetDir, cleanFileName);
      writeFileSync(fullFilePath, fileBuffer);

      const relPath = relative(baseDir, fullFilePath).replace(/\\/g, '/');

      log.info(
        {
          filePath: fullFilePath,
          relativePath: relPath,
          sizeBytes: fileBuffer.length,
          format: normalizedFormat,
          lineCount,
        },
        '文件交付物已成功持久化落盘'
      );

      return {
        success: true,
        fileName: cleanFileName,
        filePath: fullFilePath,
        relativePath: relPath,
        sizeBytes: fileBuffer.length,
        format: normalizedFormat,
        lineCount,
      };
    },
    metadata: {
      category: 'file',
      builtin: true,
    },
  });
}
