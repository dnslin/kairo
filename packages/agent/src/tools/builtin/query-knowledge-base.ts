import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { z } from 'zod';
import { createAgentTool } from '../registry.js';
import type { AgentTool, KnowledgeChunkResult } from '../types.js';
import { createKkTool, type KkMastraTool } from '../create-tool.js';
import { createChildLogger } from '../../utils/logger.js';
const log = createChildLogger('tool-knowledge-base');

/**
 * 常见中文疑问词与停用词过滤集合
 */
const CHINESE_STOP_WORDS = new Set([
  '请问',
  '怎么',
  '什么',
  '如何',
  '怎样',
  '哪些',
  '可以',
  '这个',
  '那个',
  '一下',
  '是否',
  '吗',
  '呢',
  '了',
  '的',
  '在',
  '是',
  '有',
  '和',
  '与',
  '及',
  '几天',
  '哪天',
  '哪里',
  '谁',
  '多少',
  '一个',
  '没有',
  '规范',
  '制度',
]);

/**
 * 知识库检索入参 Schema
 */
export const QueryKnowledgeBaseInputSchema = z.object({
  query: z
    .string()
    .min(1, '检索查询不能为空')
    .describe('检索问题或关键词（如制度规范、上线流程、请假规则等）'),
  topK: z
    .number()
    .int()
    .min(1)
    .max(20)
    .default(5)
    .optional()
    .describe('返回最相关的知识切片数量，默认 5'),
  category: z
    .string()
    .optional()
    .describe('指定知识库分类/目录过滤（可选，如 hr, tech, security）'),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .optional()
    .describe('最低相关度阈值 (0-1)，默认 0.3'),
});

export type QueryKnowledgeBaseInput = z.infer<typeof QueryKnowledgeBaseInputSchema>;

/**
 * 知识库检索输出契约
 */
export interface QueryKnowledgeBaseOutput {
  success: boolean;
  count: number;
  chunks: KnowledgeChunkResult[];
}

/**
 * 知识库文档源实体定义
 */
export interface KnowledgeDocSource {
  title: string;
  content: string;
  path?: string;
  category?: string;
}

/**
 * 知识库配置选项
 */
export interface QueryKnowledgeBaseOptions {
  /** 本地 Markdown 知识库基础目录 (可选) */
  baseDir?: string;
  /** 预置内存知识库文档列表 (可选) */
  docs?: KnowledgeDocSource[];
}

/**
 * 分词工具：提取中英文关键词与二元语法 (bigram) 特征
 */
function extractSearchTokens(text: string): string[] {
  if (!text) return [];
  const clean = text.toLowerCase().replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, ' ');
  const tokens: string[] = [];

  const rawWords = clean.split(/\s+/).filter(w => w.length > 0);
  for (const word of rawWords) {
    const isPureAlphanumeric = /^[a-zA-Z0-9]+$/.test(word);
    if (isPureAlphanumeric) {
      if (word.length >= 2 && !CHINESE_STOP_WORDS.has(word)) {
        tokens.push(word);
      }
    } else {
      // 提取中文二元词与单字 (过滤停用词)
      for (let i = 0; i < word.length; i++) {
        const char = word[i];
        if (char && !CHINESE_STOP_WORDS.has(char)) {
          tokens.push(char);
        }
        if (i + 1 < word.length) {
          const bigram = word.slice(i, i + 2);
          if (bigram && !CHINESE_STOP_WORDS.has(bigram)) {
            tokens.push(bigram);
          }
        }
      }
    }
  }

  return tokens;
}

/**
 * 计算文档切片与检索查询之间的综合相关度得分 (0.0 ~ 1.0)
 */
function calculateRelevance(query: string, title: string, content: string): number {
  const queryClean = query.toLowerCase().trim();
  const titleClean = title.toLowerCase();
  const contentClean = content.toLowerCase();

  // 1. 精确短语匹配
  if (contentClean.includes(queryClean) || titleClean.includes(queryClean)) {
    return 0.95;
  }

  // 2. Token 特征匹配
  const queryTokens = extractSearchTokens(query);
  if (queryTokens.length === 0) return 0;

  let score = 0;
  let matchedTokens = 0;

  for (const token of queryTokens) {
    const isBigram = token.length >= 2;
    if (titleClean.includes(token)) {
      score += isBigram ? 0.35 : 0.15;
      matchedTokens++;
    } else if (contentClean.includes(token)) {
      score += isBigram ? 0.25 : 0.1;
      matchedTokens++;
    }
  }

  const coverage = matchedTokens / queryTokens.length;
  const finalScore = Math.min(1, score * 0.7 + coverage * 0.3);

  return Number(finalScore.toFixed(3));
}

/**
 * 将 Markdown 文档按标题和段落切片为语义 Chunk
 */
function chunkMarkdownDocument(doc: KnowledgeDocSource): KnowledgeChunkResult[] {
  const chunks: KnowledgeChunkResult[] = [];
  const lines = doc.content.split('\n');

  let currentHeading = doc.title;
  let currentParagraphs: string[] = [];

  const flushChunk = (): void => {
    if (currentParagraphs.length === 0) return;
    const body = currentParagraphs.join('\n').trim();
    if (body.length === 0) return;

    const chunkContent = `# ${doc.title}\n## ${currentHeading}\n${body}`;
    const chunkId = `chunk_${doc.path ?? doc.title}_${chunks.length + 1}`.replace(/[\\/:\s]/g, '_');

    chunks.push({
      id: chunkId,
      title: doc.title,
      content: chunkContent,
      filePath: doc.path,
      category: doc.category,
      score: 0,
      metadata: {
        heading: currentHeading,
      },
    });

    currentParagraphs = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('# ') || trimmed.startsWith('## ') || trimmed.startsWith('### ')) {
      flushChunk();
      currentHeading = trimmed.replace(/^#+\s*/, '');
    } else if (trimmed.length > 0) {
      currentParagraphs.push(line);
    } else {
      if (currentParagraphs.join('\n').length > 500) {
        flushChunk();
      }
    }
  }

  flushChunk();

  if (chunks.length === 0 && doc.content.trim().length > 0) {
    chunks.push({
      id: `chunk_${doc.path ?? doc.title}_1`.replace(/[\\/:\s]/g, '_'),
      title: doc.title,
      content: doc.content.trim(),
      filePath: doc.path,
      category: doc.category,
      score: 0,
    });
  }

  return chunks;
}

/**
 * 递归扫描目录下的所有 .md 文件
 */
function loadMarkdownFilesFromDir(dirPath: string, baseRoot = dirPath): KnowledgeDocSource[] {
  if (!existsSync(dirPath)) return [];
  const docs: KnowledgeDocSource[] = [];

  const entries = readdirSync(dirPath);
  for (const entry of entries) {
    const fullPath = join(dirPath, entry);
    const stat = statSync(fullPath);

    if (stat.isDirectory()) {
      docs.push(...loadMarkdownFilesFromDir(fullPath, baseRoot));
    } else if (stat.isFile() && extname(entry).toLowerCase() === '.md') {
      const content = readFileSync(fullPath, 'utf-8');
      const relPath = relative(baseRoot, fullPath).replace(/\\/g, '/');
      const category = relPath.includes('/') ? relPath.split('/')[0] : undefined;

      const firstLine = content.split('\n').find(l => l.trim().startsWith('# '));
      const title = firstLine ? firstLine.replace(/^#\s*/, '').trim() : entry.replace(/\.md$/, '');

      docs.push({
        title,
        content,
        path: relPath,
        category,
      });
    }
  }

  return docs;
}

/**
 * 创建 query_knowledge_base 内置工具
 * 基于企业本地 Markdown 制度文档进行语义与切片检索匹配
 */
export function createQueryKnowledgeBaseTool(
  options: QueryKnowledgeBaseOptions = {}
): AgentTool<QueryKnowledgeBaseInput, QueryKnowledgeBaseOutput> {
  return createAgentTool<QueryKnowledgeBaseInput, QueryKnowledgeBaseOutput>({
    id: 'query_knowledge_base',
    description:
      '在企业本地 Markdown 知识库中进行切片语义与关键词检索，获取制度文档、规范指引或业务知识。只读查询。',
    readOnly: true,
    inputSchema: QueryKnowledgeBaseInputSchema,
    execute: async (input): Promise<QueryKnowledgeBaseOutput> => {
      await Promise.resolve();
      const cleanQuery = input.query.trim();
      const topK = input.topK ?? 5;
      const minScore = input.minScore ?? 0.3;
      const targetCategory = input.category?.trim();

      log.debug(
        { query: cleanQuery, topK, minScore, category: targetCategory },
        '执行知识库切片语义匹配检索'
      );

      const allDocs: KnowledgeDocSource[] = [...(options.docs ?? [])];
      if (options.baseDir) {
        allDocs.push(...loadMarkdownFilesFromDir(options.baseDir));
      }

      const allChunks: KnowledgeChunkResult[] = [];
      for (const doc of allDocs) {
        if (targetCategory && doc.category && doc.category !== targetCategory) {
          continue;
        }
        const docChunks = chunkMarkdownDocument(doc);
        for (const chunk of docChunks) {
          if (targetCategory && chunk.category && chunk.category !== targetCategory) {
            continue;
          }
          const score = calculateRelevance(cleanQuery, chunk.title, chunk.content);
          if (score >= minScore) {
            allChunks.push({
              ...chunk,
              score,
            });
          }
        }
      }

      allChunks.sort((a, b) => b.score - a.score);
      const topChunks = allChunks.slice(0, topK);

      return {
        success: true,
        count: topChunks.length,
        chunks: topChunks,
      };
    },
    metadata: {
      category: 'knowledge',
      builtin: true,
    },
  });
}

/**
 * 创建 Mastra-native query_knowledge_base 工具
 */
export function createMastraQueryKnowledgeBaseTool(
  options: QueryKnowledgeBaseOptions = {}
): KkMastraTool<typeof QueryKnowledgeBaseInputSchema> {
  return createKkTool({
    id: 'query_knowledge_base',
    description:
      '在企业本地 Markdown 知识库中进行切片语义与关键词检索，获取制度文档、规范指引或业务知识。只读查询。',
    effect: 'read',
    risk: 'low',
    inputSchema: QueryKnowledgeBaseInputSchema,
    execute: async ({ context }) => {
      await Promise.resolve();
      const cleanQuery = context.query.trim();
      const topK = context.topK ?? 5;
      const minScore = context.minScore ?? 0.3;
      const targetCategory = context.category?.trim();

      const allDocs: KnowledgeDocSource[] = [...(options.docs ?? [])];
      if (options.baseDir) {
        allDocs.push(...loadMarkdownFilesFromDir(options.baseDir));
      }

      const allChunks: KnowledgeChunkResult[] = [];
      for (const doc of allDocs) {
        if (targetCategory && doc.category && doc.category !== targetCategory) {
          continue;
        }
        const docChunks = chunkMarkdownDocument(doc);
        for (const chunk of docChunks) {
          if (targetCategory && chunk.category && chunk.category !== targetCategory) {
            continue;
          }
          const score = calculateRelevance(cleanQuery, chunk.title, chunk.content);
          if (score >= minScore) {
            allChunks.push({
              ...chunk,
              score,
            });
          }
        }
      }

      allChunks.sort((a, b) => b.score - a.score);
      const topChunks = allChunks.slice(0, topK);

      return {
        success: true,
        count: topChunks.length,
        chunks: topChunks,
      };
    },
  });
}
