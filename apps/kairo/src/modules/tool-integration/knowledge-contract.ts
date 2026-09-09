import { z } from 'zod';
import type { KnowledgeJson } from '../knowledge-qa/knowledge-record-store.js';

export const knowledgeInputSchema = z.object({ query: z.string().trim().min(1) }).strict();

export const knowledgeChunkSchema = z
  .object({
    chunkId: z.string().min(1),
    documentId: z.string().min(1),
    documentName: z.string().min(1),
    datasetId: z.string().min(1),
    content: z.string().min(1),
    positions: z.array(z.array(z.number().finite())),
    similarity: z.number().finite(),
    vectorSimilarity: z.number().finite().optional(),
    termSimilarity: z.number().finite().optional(),
  })
  .strict();
export type KnowledgeChunk = z.infer<typeof knowledgeChunkSchema>;

const metadata = {
  httpStatus: z.number().int().min(100).max(599).nullable(),
  apiCode: z.number().int().nullable(),
  raw: z.json(),
};
export const retrievalResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      ...metadata,
      kind: z.literal('found'),
      chunks: z.array(knowledgeChunkSchema).min(1),
      total: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...metadata,
      kind: z.literal('empty'),
      chunks: z.array(knowledgeChunkSchema).length(0),
      total: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      ...metadata,
      kind: z.enum([
        'auth_error',
        'parameter_error',
        'service_error',
        'format_error',
        'cancelled',
        'timeout',
      ]),
      error: z.object({ reason: z.string().min(1), message: z.string().min(1) }).strict(),
      retryable: z.boolean(),
    })
    .strict(),
]);
export type RetrievalResult = z.infer<typeof retrievalResultSchema>;
export type RetrievalFailure = Extract<RetrievalResult, { error: unknown }>;

export interface RetrievalSettings {
  apiUrl: string;
  apiKey: string;
  datasetId: string;
}
export interface RetrievalAttempt {
  index: number;
  startedAt: number;
  durationMs: number;
  pid: number | null;
  exitCode: number | null;
  result: RetrievalResult;
}
export interface RetrievalRun {
  result: RetrievalResult;
  attempts: RetrievalAttempt[];
}
export interface RetrievalOptions {
  /** 使用任务原有绝对截止；重试和后续查询不能刷新。 */
  deadline: number;
  signal?: AbortSignal;
  /** 健康检查保留原合同，不立即重试；业务调用使用一次重试。 */
  retry?: boolean;
}

export function retrievalFailure(
  kind: RetrievalFailure['kind'],
  reason: string,
  message: string,
  raw: KnowledgeJson = null
): RetrievalFailure {
  return {
    kind,
    httpStatus: null,
    apiCode: null,
    raw,
    error: { reason, message },
    retryable: false,
  };
}
