import { describe, expect, it, vi } from 'vitest';
import {
  AllModelsFailedError,
  ModelFailoverManager,
  ModelTimeoutError,
} from '../../src/routing/failover.js';
import { AgentError } from '../../src/utils/errors.js';
import type { ModelEndpointConfig } from '../../src/routing/types.js';
import type { LLMProvider } from '../../src/types/index.js';

describe('ModelFailoverManager 模型高可用故障转移与熔断测试', () => {
  it('当主模型正常返回时，无需 Failover 直接返回结果', async () => {
    const primaryLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: 'Primary 成功回复', finishReason: 'stop' });
      },
    };

    const backupLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: 'Backup 回复' });
      },
    };

    const manager = new ModelFailoverManager();
    const chain: ModelEndpointConfig[] = [
      { id: 'primary', name: 'Primary-Model', provider: primaryLLM },
      { id: 'backup', name: 'Backup-Model', provider: backupLLM },
    ];

    const result = await manager.executeChat(chain, [
      { role: 'user', content: 'hello' },
    ]);
    expect(result.content).toBe('Primary 成功回复');
    expect(result.executedModel.id).toBe('primary');
  });

  it('当主模型抛出 503/429/网络异常时，应毫秒级无感切换至备用模型', async () => {
    const onFailover = vi.fn();
    const manager = new ModelFailoverManager({ onFailover });

    const failedPrimaryLLM: LLMProvider = {
      chat() {
        const err = new Error('503 Service Unavailable: server overloaded');
        Object.assign(err, { status: 503 });
        return Promise.reject(err);
      },
    };

    const workingBackupLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: 'Backup 模型成功救援', finishReason: 'stop' });
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'primary', name: 'Primary-Model', provider: failedPrimaryLLM },
      { id: 'backup', name: 'Backup-Model', provider: workingBackupLLM },
    ];

    const result = await manager.executeChat(chain, [
      { role: 'user', content: '测试 503 救援' },
    ]);

    expect(result.content).toBe('Backup 模型成功救援');
    expect(result.executedModel.id).toBe('backup');
    expect(onFailover).toHaveBeenCalledTimes(1);
    expect(onFailover).toHaveBeenCalledWith(
      expect.objectContaining({
        fromModel: 'Primary-Model',
        toModel: 'Backup-Model',
        attempt: 1,
      })
    );
  });

  it('当主模型超时 (15s / 自定义超时) 时，应自动中断并 Failover 到下一个模型', async () => {
    const manager = new ModelFailoverManager();

    const hangingLLM: LLMProvider = {
      chat(_messages, options): Promise<{ content: string }> {
        return new Promise<{ content: string }>((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => {
            const err = new Error('Aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      },
    };

    const quickBackupLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: '快速备用节点回复' });
      },
    };

    const chain: ModelEndpointConfig[] = [
      {
        id: 'hanging',
        name: 'Hanging-Model',
        provider: hangingLLM,
        timeoutMs: 30, // 30ms 超时
      },
      { id: 'backup', name: 'Quick-Backup', provider: quickBackupLLM },
    ];

    const result = await manager.executeChat(chain, [
      { role: 'user', content: '测试超时转移' },
    ]);

    expect(result.content).toBe('快速备用节点回复');
    expect(result.executedModel.id).toBe('backup');
  });

  it('ModelTimeoutError 应当继承 AgentError 并完整保留 originalCause 底层异常与 code', () => {
    const rootErr = new Error('Socket timeout in 30ms');
    const timeoutErr = new ModelTimeoutError('Test-Model', 30, rootErr);

    expect(timeoutErr).toBeInstanceOf(AgentError);
    expect(timeoutErr.code).toBe('MODEL_TIMEOUT_ERROR');
    expect(timeoutErr.originalCause).toBe(rootErr);
    expect(timeoutErr.stack).toContain('Socket timeout in 30ms');
  });
  it('当所有候选模型均失败时，应记录完整审计事件(含终局未切换状态)并抛出 AllModelsFailedError 异常', async () => {
    const onFailover = vi.fn();
    const manager = new ModelFailoverManager({ onFailover });

    const failed1: LLMProvider = {
      chat() {
        const err = new Error('500 Internal Error');
        Object.assign(err, { status: 500 });
        return Promise.reject(err);
      },
    };
    const failed2: LLMProvider = {
      chat() {
        const err = new Error('503 Service Unavailable');
        Object.assign(err, { status: 503 });
        return Promise.reject(err);
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'm1', name: 'Model-1', provider: failed1 },
      { id: 'm2', name: 'Model-2', provider: failed2 },
    ];

    try {
      await manager.executeChat(chain, [{ role: 'user', content: '全挂测试' }]);
      expect.unreachable('应抛出 AllModelsFailedError');
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(AllModelsFailedError);
      expect(err).toBeInstanceOf(AgentError);
      const allErr = err as AllModelsFailedError;
      expect(allErr.code).toBe('ALL_MODELS_FAILED_ERROR');
      expect(allErr.originalCause).toBeDefined();
      expect((allErr.originalCause as Error).message).toBe('503 Service Unavailable');
    }

    // 验证审计事件记录：第 1 次切换至 Model-2，第 2 次候选耗尽 (toModel 为 undefined)
    expect(onFailover).toHaveBeenCalledTimes(2);
    expect(onFailover).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        fromModel: 'Model-1',
        toModel: 'Model-2',
        attempt: 1,
      })
    );
    expect(onFailover).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        fromModel: 'Model-2',
        toModel: undefined,
        attempt: 2,
      })
    );
  });
  it('当主模型遭遇 400/401/Invalid API Key 等不可重试客户端错误时，严禁 Failover，应立即向外抛出且不调用备用模型', async () => {
    const manager = new ModelFailoverManager();
    const backupFn = vi.fn();

    const authFailedLLM: LLMProvider = {
      chat() {
        const err = new Error('401 Unauthorized: Invalid API Key');
        Object.assign(err, { status: 401 });
        return Promise.reject(err);
      },
    };

    const backupLLM: LLMProvider = {
      chat() {
        backupFn();
        return Promise.resolve({ content: '备用节点' });
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'm1', name: 'Auth-Failed-Model', provider: authFailedLLM },
      { id: 'm2', name: 'Backup-Model', provider: backupLLM },
    ];

    await expect(
      manager.executeChat(chain, [{ role: 'user', content: 'test auth failure' }])
    ).rejects.toThrowError('401 Unauthorized');

    // 确认备用模型未被调用
    expect(backupFn).not.toHaveBeenCalled();
  });

  it('isRetryableError 应精准识别可恢复异常与不可恢复客户端异常', () => {
    const manager = new ModelFailoverManager();

    // 可重试异常
    expect(manager.isRetryableError(new Error('503 Service Unavailable'))).toBe(true);
    expect(manager.isRetryableError(new Error('429 Too Many Requests (rate limit)'))).toBe(true);
    expect(manager.isRetryableError(new Error('500 Internal Server Error'))).toBe(true);
    expect(manager.isRetryableError(new Error('fetch failed: ECONNRESET'))).toBe(true);
    expect(manager.isRetryableError(new Error('request timed out'))).toBe(true);

    // 不可重试异常
    expect(manager.isRetryableError(new Error('400 Bad Request: missing field'))).toBe(false);
    expect(manager.isRetryableError(new Error('401 Unauthorized: invalid_api_key'))).toBe(false);
    expect(manager.isRetryableError(new Error('403 Forbidden: permission_denied'))).toBe(false);
    expect(manager.isRetryableError(new Error('404 Not Found'))).toBe(false);
    const abortErr = new Error('aborted');
    abortErr.name = 'AbortError';
    expect(manager.isRetryableError(abortErr)).toBe(false);
  });

  it('在流式调用首个 Chunk 产出前发生异常，应无感 Failover 到备用模型流式生成', async () => {
    const manager = new ModelFailoverManager();

    const failedStreamLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: '' });
      },
      chatStream() {
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                return Promise.reject(new Error('503 Service Unavailable on stream init'));
              },
            };
          },
        };
      },
    };

    const backupStreamLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: '' });
      },
      async *chatStream() {
        yield await Promise.resolve({ delta: '备用模型' });
        yield await Promise.resolve({ delta: '流式响应' });
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'm1', name: 'Failed-Stream-Model', provider: failedStreamLLM },
      { id: 'm2', name: 'Backup-Stream-Model', provider: backupStreamLLM },
    ];

    const stream = manager.executeChatStream(chain, [
      { role: 'user', content: 'test stream' },
    ]);

    const chunks: string[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk.delta);
    }

    expect(chunks.join('')).toBe('备用模型流式响应');
  });

  it('在流式调用已输出部分 Chunk 后发生异常，严禁 Failover，应立即中断抛出异常', async () => {
    const manager = new ModelFailoverManager();
    const backupStreamFn = vi.fn();

    const brokenMidStreamLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: '' });
      },
      async *chatStream() {
        yield await Promise.resolve({ delta: '已经输出前半截文本...' });
        throw new Error('Mid-stream network disconnection');
      },
    };

    const backupStreamLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: '' });
      },
      async *chatStream() {
        backupStreamFn();
        yield await Promise.resolve({ delta: '备用模型完整回答' });
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'm1', name: 'Broken-Mid-Stream-Model', provider: brokenMidStreamLLM },
      { id: 'm2', name: 'Backup-Stream-Model', provider: backupStreamLLM },
    ];

    const stream = manager.executeChatStream(chain, [
      { role: 'user', content: 'test broken stream' },
    ]);

    const chunks: string[] = [];
    await expect(async () => {
      for await (const chunk of stream) {
        chunks.push(chunk.delta);
      }
    }).rejects.toThrowError('Mid-stream network disconnection');

    expect(chunks.join('')).toBe('已经输出前半截文本...');
    // 确认备用模型没有被错误调用
    expect(backupStreamFn).not.toHaveBeenCalled();
  });

  describe('maxRetries 重试次数边界与非法值校验', () => {
    const createErrorLLM = (name: string): LLMProvider => ({
      chat() {
        const err = new Error(`503 from ${name}`);
        Object.assign(err, { status: 503 });
        return Promise.reject(err);
      },
    });

    const createSuccessLLM = (name: string): LLMProvider => ({
      chat() {
        return Promise.resolve({ content: `${name} 成功响应` });
      },
    });

    it('当 maxRetries 为 0 时，仅尝试主模型 1 次，失败后严禁切换至备用模型', async () => {
      const manager = new ModelFailoverManager({ maxRetries: 0 });
      const chain: ModelEndpointConfig[] = [
        { id: 'm1', name: 'Model-1', provider: createErrorLLM('Model-1') },
        { id: 'm2', name: 'Model-2', provider: createSuccessLLM('Model-2') },
      ];

      await expect(
        manager.executeChat(chain, [{ role: 'user', content: 'test' }])
      ).rejects.toThrowError(AllModelsFailedError);
    });

    it('当 maxRetries 为 1 时，最多尝试主模型 + 1 个备用模型，第 2 个备用模型不被调用', async () => {
      const manager = new ModelFailoverManager({ maxRetries: 1 });
      const m3Fn = vi.fn();
      const chain: ModelEndpointConfig[] = [
        { id: 'm1', name: 'Model-1', provider: createErrorLLM('Model-1') },
        { id: 'm2', name: 'Model-2', provider: createErrorLLM('Model-2') },
        {
          id: 'm3',
          name: 'Model-3',
          provider: {
            chat() {
              m3Fn();
              return Promise.resolve({ content: 'Model-3' });
            },
          },
        },
      ];

      await expect(
        manager.executeChat(chain, [{ role: 'user', content: 'test' }])
      ).rejects.toThrowError(AllModelsFailedError);

      expect(m3Fn).not.toHaveBeenCalled();
    });

    it('当 maxRetries 为非法值 (负数、小数、NaN 或 Infinity) 时，构造函数必须抛出 RangeError 异常', () => {
      expect(() => new ModelFailoverManager({ maxRetries: -1 })).toThrowError(
        RangeError
      );
      expect(() => new ModelFailoverManager({ maxRetries: 1.5 })).toThrowError(
        RangeError
      );
      expect(() => new ModelFailoverManager({ maxRetries: Number.NaN })).toThrowError(
        RangeError
      );
      expect(
        () => new ModelFailoverManager({ maxRetries: Number.POSITIVE_INFINITY })
      ).toThrowError(RangeError);
    });
  });
});
