import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBotConfig } from '../../src/config/load.js';
import { startDependencyChecks } from '../../src/modules/operability/dependency-checks.js';
import type { DependencyChecks } from '../../src/modules/operability/dependency-checks.js';
import type { AppLogger } from '../../src/modules/operability/logger.js';
import type { RetrievalRun } from '../../src/modules/tool-integration/knowledge-contract.js';
import { retrieveKnowledge } from '../../src/modules/tool-integration/python-retrieval.js';

vi.mock('../../src/modules/tool-integration/python-retrieval.js', () => ({
  retrieveKnowledge: vi.fn(),
}));

type RetrievalFailureKind = Exclude<RetrievalRun['result']['kind'], 'found' | 'empty'>;
const { config } = await loadBotConfig();
const running: DependencyChecks[] = [];
const logger: AppLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
function modelResult() {
  return {
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'text-delta', id: '检测', delta: '不应进入日志的回答' });
        controller.close();
      },
    }),
  };
}
function retrievalSuccess(kind: 'found' | 'empty' = 'empty'): RetrievalRun {
  const chunks =
    kind === 'empty'
      ? []
      : [
          {
            chunkId: '健康检查片段',
            documentId: '健康检查文档',
            documentName: '不应进入日志的文档名称',
            datasetId: config.datasetId,
            content: '不应进入日志的知识片段',
            positions: [],
            similarity: 0.9,
          },
        ];
  return {
    result: { kind, chunks, total: chunks.length, httpStatus: 200, apiCode: 0, raw: null },
    attempts: [],
  };
}
function retrievalFailure(kind: RetrievalFailureKind): RetrievalRun {
  return {
    result: {
      kind,
      httpStatus: null,
      apiCode: null,
      raw: { message: '不应进入日志的上游正文' },
      error: { reason: kind === 'service_error' ? 'network' : kind, message: '不应进入日志的错误' },
      retryable: kind === 'service_error',
    },
    attempts: [],
  };
}
function start() {
  const checks = startDependencyChecks(config, logger);
  running.push(checks);
  return checks;
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  vi.stubEnv('KAIRO_T12_MODEL_API_KEY', '不应进入日志的模型密钥');
  vi.stubEnv('RAGFLOW_API_KEY', '不应进入日志的检索密钥');
  vi.stubEnv('RAGFLOW_API_URL', 'http://127.0.0.1:1');
  vi.spyOn(ModelRouterLanguageModel.prototype, 'doGenerate').mockImplementation(() =>
    Promise.resolve(modelResult())
  );
  vi.mocked(retrieveKnowledge).mockReset().mockResolvedValue(retrievalSuccess());
});
afterEach(async () => {
  await Promise.all(running.splice(0).map(checks => checks.close()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('真实依赖后台检查合同', () => {
  it('完成前未知，空检索成功；读取不执行调用，五分钟后失败再恢复', async () => {
    const checks = start();
    expect(checks.read()).toEqual({ model: 'unknown', ragflow: 'unknown' });
    await vi.advanceTimersByTimeAsync(0);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
    for (let i = 0; i < 20; i++) checks.read();
    expect(ModelRouterLanguageModel.prototype.doGenerate).toHaveBeenCalledTimes(1);
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
    vi.mocked(ModelRouterLanguageModel.prototype.doGenerate).mockRejectedValueOnce(
      new Error('不应进入日志的上游异常')
    );
    vi.mocked(retrieveKnowledge).mockResolvedValueOnce(retrievalFailure('service_error'));
    await vi.advanceTimersByTimeAsync(299999);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
    await vi.advanceTimersByTimeAsync(1);
    expect(checks.read()).toEqual({ model: 'down', ragflow: 'down' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'model' }));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'knowledge' }));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('不应进入日志');
    expect(retrieveKnowledge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300000);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
  });

  it('有资料同样正常，固定配置与三十秒期限交给 Python 入口且禁止立即重试', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1800000000000);
    vi.mocked(retrieveKnowledge).mockResolvedValueOnce(retrievalSuccess('found'));
    const checks = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
    expect(retrieveKnowledge).toHaveBeenCalledWith(
      '如何查询采购订单？',
      {
        apiUrl: 'http://127.0.0.1:1',
        apiKey: '不应进入日志的检索密钥',
        datasetId: config.datasetId,
      },
      { deadline: 1800000030000, signal: expect.any(AbortSignal), retry: false }
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('缺少凭证保持未知，不访问服务', async () => {
    vi.stubEnv('KAIRO_T12_MODEL_API_KEY', '');
    vi.stubEnv('RAGFLOW_API_KEY', '');
    const checks = start();
    await vi.advanceTimersByTimeAsync(600000);
    expect(checks.read()).toEqual({ model: 'unknown', ragflow: 'unknown' });
    expect(retrieveKnowledge).not.toHaveBeenCalled();
    expect(ModelRouterLanguageModel.prototype.doGenerate).not.toHaveBeenCalled();
  });

  it('没有文本的模型响应和 Python 报告的畸形片段不能标为正常', async () => {
    vi.mocked(ModelRouterLanguageModel.prototype.doGenerate).mockResolvedValueOnce({
      stream: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });
    vi.mocked(retrieveKnowledge).mockResolvedValueOnce(retrievalFailure('format_error'));
    const checks = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks.read()).toEqual({ model: 'down', ragflow: 'down' });
  });

  it.each([
    ['auth_error', 'knowledge'],
    ['parameter_error', 'knowledge'],
    ['cancelled', 'cancelled'],
    ['timeout', 'timeout'],
  ] as const)('Python 返回 %s 时明确归类为 %s，不伪报正常', async (kind, errorType) => {
    vi.mocked(retrieveKnowledge).mockResolvedValueOnce(retrievalFailure(kind));
    const checks = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'down' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType }));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('不应进入日志');
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
  });

  it('外层超时信号传入 Python 调用并保留超时归类，不立即重试', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.mocked(retrieveKnowledge).mockImplementation(
      (_query, _settings, options) =>
        new Promise<RetrievalRun>(resolve => {
          options.signal!.addEventListener('abort', () => resolve(retrievalFailure('cancelled')), {
            once: true,
          });
        })
    );
    const checks = start();
    timeout.abort(new DOMException('不应进入日志的超时正文', 'TimeoutError'));
    await vi.advanceTimersByTimeAsync(0);
    expect(checks.read().ragflow).toBe('down');
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'timeout' }));
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
  });

  it('同项在途不重叠，模型周期不受检索等待影响，结束后下一周期恢复检查', async () => {
    let finish!: (result: RetrievalRun) => void;
    vi.mocked(retrieveKnowledge).mockReturnValueOnce(
      new Promise(resolve => {
        finish = resolve;
      })
    );
    const checks = start();
    await vi.advanceTimersByTimeAsync(600000);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'unknown' });
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
    expect(ModelRouterLanguageModel.prototype.doGenerate).toHaveBeenCalledTimes(3);
    finish(retrievalSuccess());
    await vi.advanceTimersByTimeAsync(0);
    expect(checks.read().ragflow).toBe('up');
    await vi.advanceTimersByTimeAsync(300000);
    expect(retrieveKnowledge).toHaveBeenCalledTimes(2);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
  });

  it('关闭中止在途请求并等待退出，重复关闭不再发起检查', async () => {
    let cancelled = false;
    let finish!: (result: RetrievalRun) => void;
    vi.mocked(retrieveKnowledge).mockImplementation(
      (_query, _settings, options) =>
        new Promise<RetrievalRun>(resolve => {
          finish = resolve;
          options.signal!.addEventListener(
            'abort',
            () => {
              cancelled = true;
            },
            { once: true }
          );
        })
    );
    const checks = start();
    await vi.advanceTimersByTimeAsync(0);
    const closing = checks.close();
    expect(checks.close()).toBe(closing);
    expect(cancelled).toBe(true);
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(closed).toBe(false);
    finish(retrievalFailure('cancelled'));
    await closing;
    expect(closed).toBe(true);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'unknown' });
    await vi.advanceTimersByTimeAsync(900000);
    expect(retrieveKnowledge).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
