import { performance } from 'node:perf_hooks';
import { ModelRouterLanguageModel } from '@mastra/core/llm';
import type { BotConfig } from '../../config/schema.js';
import { AppError, getErrorType } from './errors.js';
import type { HealthDependencies } from './health.js';
import type { AppLogger } from './logger.js';

export type ExternalHealth = Pick<HealthDependencies, 'model' | 'ragflow'>;
export interface DependencyChecks {
  read(): ExternalHealth;
  close(): Promise<void>;
}

export function startDependencyChecks(config: BotConfig, logger: AppLogger): DependencyChecks {
  const state: ExternalHealth = { model: 'unknown', ragflow: 'unknown' };
  const lifetime = new AbortController();
  const modelKey = process.env.KAIRO_T12_MODEL_API_KEY;
  const ragflowKey = process.env.RAGFLOW_API_KEY;
  const ragflowUrl = process.env.RAGFLOW_API_URL ?? 'http://rag.union.com/';
  const pending = new Map<keyof ExternalHealth, Promise<void>>();

  async function checkModel(signal: AbortSignal): Promise<void> {
    const model = new ModelRouterLanguageModel({
      id: config.model.id as `${string}/${string}`,
      ...(config.model.url ? { url: config.model.url } : {}),
      apiKey: modelKey,
    });
    const result = await model.doGenerate({
      prompt: [{ role: 'user', content: [{ type: 'text', text: '请仅回答“正常”。' }] }],
      maxOutputTokens: 128,
      abortSignal: signal,
    });
    let hasText = false;
    const reader = result.stream.getReader();
    try {
      while (true) {
        const { value: chunk, done } = await reader.read();
        if (done) break;
        if (chunk.type === 'error') throw new AppError('model', { cause: chunk.error });
        if (chunk.type === 'text-delta' && chunk.delta.trim()) hasText = true;
      }
    } finally {
      reader.releaseLock();
    }
    if (!hasText) throw new AppError('model');
  }

  async function checkRagflow(signal: AbortSignal): Promise<void> {
    const response = await fetch(new URL('/api/v1/retrieval', ragflowUrl), {
      method: 'POST',
      headers: { Authorization: `Bearer ${ragflowKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '如何查询采购订单？', dataset_ids: [config.datasetId] }),
      signal,
    });
    if (!response.ok) throw new AppError('knowledge');
    const body: unknown = await response.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('code' in body) ||
      body.code !== 0 ||
      !('data' in body) ||
      typeof body.data !== 'object' ||
      body.data === null ||
      !('chunks' in body.data) ||
      !Array.isArray(body.data.chunks)
    )
      throw new AppError('knowledge');
    // 空检索结果是正常结果；仅验证片段合同，不记录或保存正文。
    for (const chunk of body.data.chunks as unknown[]) {
      if (
        typeof chunk !== 'object' ||
        chunk === null ||
        !('content' in chunk) ||
        typeof chunk.content !== 'string'
      ) {
        throw new AppError('knowledge');
      }
    }
  }

  function run(name: keyof ExternalHealth): void {
    if (lifetime.signal.aborted || pending.has(name)) return;
    const configured = name === 'model' ? Boolean(modelKey) : Boolean(ragflowKey && ragflowUrl);
    if (!configured) {
      logger.warn({ event: '依赖检查失败', status: 'unknown', errorType: 'configuration' });
      return;
    }
    const startedAt = performance.now();
    const timeout = AbortSignal.timeout(name === 'model' ? 60000 : 30000);
    const signal = AbortSignal.any([lifetime.signal, timeout]);
    const checking = (async (): Promise<void> => {
      try {
        await (name === 'model' ? checkModel(signal) : checkRagflow(signal));
        signal.throwIfAborted();
        state[name] = 'up';
      } catch (error) {
        if (lifetime.signal.aborted) return;
        state[name] = 'down';
        logger.warn({
          event: '依赖检查失败',
          status: 'down',
          errorType: timeout.aborted
            ? 'timeout'
            : getErrorType(error, name === 'model' ? 'model' : 'knowledge'),
          durationMs: performance.now() - startedAt,
        });
      } finally {
        pending.delete(name);
      }
    })();
    pending.set(name, checking);
  }

  function tick(): void {
    run('model');
    run('ragflow');
  }
  const timer = setInterval(tick, 300000);
  timer.unref();
  tick();
  let closing: Promise<void> | undefined;
  return {
    read(): ExternalHealth {
      return { ...state };
    },
    close(): Promise<void> {
      closing ??= (async (): Promise<void> => {
        clearInterval(timer);
        lifetime.abort();
        await Promise.all(pending.values());
      })();
      return closing;
    },
  };
}
