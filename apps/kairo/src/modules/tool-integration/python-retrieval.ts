import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import {
  retrievalFailure,
  retrievalResultSchema,
  type RetrievalAttempt,
  type RetrievalFailure,
  type RetrievalOptions,
  type RetrievalResult,
  type RetrievalRun,
  type RetrievalSettings,
} from './knowledge-contract.js';

const script = fileURLToPath(
  new URL('../../../../../config/bots/default/skills/erp-search/scripts/search.py', import.meta.url)
);

export function loadRetrievalSettings(datasetId: string): RetrievalSettings {
  const apiKey = process.env.RAGFLOW_API_KEY;
  if (!apiKey?.trim()) throw new Error('缺少 RAGFLOW_API_KEY，无法启动知识检索');
  const apiUrl = process.env.RAGFLOW_API_URL ?? 'http://rag.union.com/';
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error('RAGFLOW_API_URL 不是有效地址');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('RAGFLOW_API_URL 必须为不含凭证的 HTTP 地址');
  }
  return { apiUrl, apiKey, datasetId };
}

function cancelled(signal: AbortSignal): RetrievalFailure {
  const reason: unknown = signal.reason;
  const timeout = reason instanceof Error && reason.name === 'TimeoutError';
  return retrievalFailure(
    timeout ? 'timeout' : 'cancelled',
    timeout ? 'deadline' : 'abort',
    timeout ? '知识检索已到任务截止时间' : '知识检索已取消，本地 Python 已结束'
  );
}

function environment(settings: RetrievalSettings): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  // 只传解释器启动所需的操作系统字段，不把数据库或模型凭证继承给 Python。
  for (const [key, value] of Object.entries(process.env)) {
    if (
      ['path', 'systemroot', 'windir', 'temp', 'tmp', 'home', 'lang', 'lc_all'].includes(
        key.toLowerCase()
      )
    )
      env[key] = value;
  }
  env.RAGFLOW_API_URL = settings.apiUrl;
  env.RAGFLOW_API_KEY = settings.apiKey;
  env.RAGFLOW_DATASET_ID = settings.datasetId;
  return env;
}

async function invokePython(
  query: string,
  settings: RetrievalSettings,
  signal: AbortSignal,
  index: number
): Promise<RetrievalAttempt> {
  const startedAt = Date.now();
  const started = performance.now();
  return new Promise(resolve => {
    const child = spawn('python', ['-I', '-B', script], {
      shell: false,
      windowsHide: true,
      env: environment(settings),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: RetrievalFailure | undefined;
    let spawned = false;
    const stop = (): void => {
      child.kill('SIGKILL');
    };
    const fail = (reason: string, message: string, error: unknown): void => {
      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : null;
      failure ??= retrievalFailure('service_error', reason, message, { code });
      stop();
    };
    child.stdout.on('data', (data: Buffer) => {
      stdout.push(data);
    });
    child.stderr.on('data', (data: Buffer) => {
      stderr.push(data);
    });
    child.stdout.on('error', error => {
      fail('stdout_read', 'Python 标准输出读取失败', error);
    });
    child.stderr.on('error', error => {
      fail('stderr_read', 'Python 错误输出读取失败', error);
    });
    child.stdin.on('error', error => {
      fail('stdin_write', 'Python 查询输入写入失败', error);
    });
    child.on('error', error => {
      fail(
        spawned ? 'process_error' : 'python_start',
        spawned ? 'Python 进程操作失败' : 'Python 不存在或进程无法启动',
        error
      );
    });
    child.once('spawn', () => {
      spawned = true;
      if (signal.aborted) stop();
      else child.stdin.end(query, 'utf8');
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    // close 晚于进程退出和管道关闭；取消也必须等待这里，不能提前 resolve。
    child.once('close', exitCode => {
      signal.removeEventListener('abort', stop);
      let result: RetrievalResult;
      if (signal.aborted) result = cancelled(signal);
      else if (failure) result = failure;
      else {
        let text = '';
        const diagnostic = Buffer.concat(stderr)
          .toString('utf8')
          .replaceAll(settings.apiKey, '[凭证已移除]');
        try {
          text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(stdout));
          // 即使服务或解释器意外回显凭证，也不能进入账本或模型。
          text = text.replaceAll(settings.apiKey, '[凭证已移除]');
          const payload: unknown = JSON.parse(text);
          const parsed = retrievalResultSchema.safeParse(payload);
          if (!parsed.success) {
            result = retrievalFailure(
              'format_error',
              'output_contract',
              'Python 输出不符合检索结果合同',
              { output: text, stderr: diagnostic }
            );
          } else if (
            (exitCode === 0 && ['found', 'empty'].includes(parsed.data.kind)) ||
            (exitCode === 1 && !['found', 'empty'].includes(parsed.data.kind))
          ) {
            result = parsed.data;
            if (
              (result.kind === 'found' || result.kind === 'empty') &&
              (result.httpStatus !== 200 ||
                result.apiCode !== 0 ||
                result.chunks.some(chunk => chunk.datasetId !== settings.datasetId))
            ) {
              result = retrievalFailure(
                'format_error',
                'output_scope',
                'Python 成功结果状态或 Dataset 不符合固定范围',
                result.raw
              );
            }
          } else
            result = retrievalFailure('service_error', 'python_exit', 'Python 退出码与结果不一致', {
              exitCode,
              output: text,
              stderr: diagnostic,
            });
        } catch {
          result = retrievalFailure(
            exitCode === 0 ? 'format_error' : 'service_error',
            exitCode === 0 ? 'output_json' : 'python_exit',
            exitCode === 0
              ? 'Python 输出不是有效 UTF-8 JSON'
              : 'Python 非零退出且没有有效结构化结果',
            { exitCode, output: text, stderr: diagnostic }
          );
        }
      }
      resolve({
        index,
        startedAt,
        durationMs: performance.now() - started,
        pid: child.pid ?? null,
        exitCode,
        result,
      });
    });
  });
}

export async function retrieveKnowledge(
  query: string,
  settings: RetrievalSettings,
  options: RetrievalOptions
): Promise<RetrievalRun> {
  const attempts: RetrievalAttempt[] = [];
  const remaining = options.deadline - Date.now();
  if (!Number.isFinite(remaining)) throw new Error('知识检索必须提供任务绝对截止时间');
  if (options.signal?.aborted) return { result: cancelled(options.signal), attempts };
  if (remaining <= 0)
    return {
      result: retrievalFailure('timeout', 'deadline', '知识检索已到任务截止时间'),
      attempts,
    };
  const deadline = new AbortController();
  const timer = setTimeout(() => {
    deadline.abort(new DOMException('任务执行截止', 'TimeoutError'));
  }, remaining);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadline.signal])
    : deadline.signal;
  try {
    for (;;) {
      if (signal.aborted) return { result: cancelled(signal), attempts };
      const attempt = await invokePython(query, settings, signal, attempts.length + 1);
      attempts.push(attempt);
      const result = attempt.result;
      const canRetry =
        result.kind === 'service_error' &&
        result.retryable &&
        (result.error.reason === 'network' ||
          result.httpStatus === 429 ||
          (result.httpStatus !== null && result.httpStatus >= 500));
      if (!canRetry || options.retry === false || attempts.length === 2 || signal.aborted)
        return { result, attempts };
    }
  } finally {
    clearTimeout(timer);
  }
}
