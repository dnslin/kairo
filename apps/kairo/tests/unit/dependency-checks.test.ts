import { ModelRouterLanguageModel } from '@mastra/core/llm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadBotConfig } from '../../src/config/load.js';
import { startDependencyChecks } from '../../src/modules/operability/dependency-checks.js';
import type { DependencyChecks } from '../../src/modules/operability/dependency-checks.js';
import type { AppLogger } from '../../src/modules/operability/logger.js';

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
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ code: 0, data: { chunks: [] } })))
  );
});
afterEach(async () => {
  await Promise.all(running.splice(0).map(checks => checks.close()));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
    expect(fetch).toHaveBeenCalledTimes(1);
    vi.mocked(ModelRouterLanguageModel.prototype.doGenerate).mockRejectedValueOnce(
      new Error('不应进入日志的上游异常')
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ code: 102, message: '不应进入日志的知识片段' })
    );
    await vi.advanceTimersByTimeAsync(299999);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
    await vi.advanceTimersByTimeAsync(1);
    expect(checks.read()).toEqual({ model: 'down', ragflow: 'down' });
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'model' }));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'knowledge' }));
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain('不应进入日志');
    await vi.advanceTimersByTimeAsync(300000);
    expect(checks.read()).toEqual({ model: 'up', ragflow: 'up' });
  });

  it('缺少凭证保持未知，不访问服务', async () => {
    vi.stubEnv('KAIRO_T12_MODEL_API_KEY', '');
    vi.stubEnv('RAGFLOW_API_KEY', '');
    const checks = start();
    await vi.advanceTimersByTimeAsync(600000);
    expect(checks.read()).toEqual({ model: 'unknown', ragflow: 'unknown' });
    expect(fetch).not.toHaveBeenCalled();
    expect(ModelRouterLanguageModel.prototype.doGenerate).not.toHaveBeenCalled();
  });

  it('没有文本的模型响应和畸形片段不能标为正常', async () => {
    vi.mocked(ModelRouterLanguageModel.prototype.doGenerate).mockResolvedValueOnce({
      stream: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({ code: 0, data: { chunks: [{ content: 42 }] } })
    );
    const checks = start();
    await vi.waitFor(() => expect(checks.read()).toEqual({ model: 'down', ragflow: 'down' }));
  });

  it('超时归类明确，不立即重试', async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(new DOMException('检查取消', 'AbortError')),
            {
              once: true,
            }
          );
        })
    );
    const checks = start();
    timeout.abort(new DOMException('不应进入日志的超时正文', 'TimeoutError'));
    await vi.waitFor(() => expect(checks.read().ragflow).toBe('down'));
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'timeout' }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('关闭中止在途请求并等待退出，重复关闭不再发起检查', async () => {
    let cancelled = false;
    vi.mocked(fetch).mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(new DOMException('检查取消', 'AbortError'));
            },
            { once: true }
          );
        })
    );
    const checks = start();
    const closing = checks.close();
    expect(checks.close()).toBe(closing);
    await closing;
    expect(cancelled).toBe(true);
    await vi.advanceTimersByTimeAsync(900000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
