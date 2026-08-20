import { describe, expect, it, vi } from 'vitest';
import {
  AllModelsFailedError,
  ModelFailoverManager,
} from '../../src/routing/failover.js';
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

  it('当所有候选模型均失败时，应抛出 AllModelsFailedError 异常', async () => {
    const manager = new ModelFailoverManager();

    const failed1: LLMProvider = {
      chat() {
        return Promise.reject(new Error('500 Internal Error'));
      },
    };
    const failed2: LLMProvider = {
      chat() {
        return Promise.reject(new Error('429 Rate Limit Exceeded'));
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'm1', name: 'Model-1', provider: failed1 },
      { id: 'm2', name: 'Model-2', provider: failed2 },
    ];

    await expect(
      manager.executeChat(chain, [{ role: 'user', content: '全挂测试' }])
    ).rejects.toThrowError(AllModelsFailedError);
  });

  it('当外部主动传入 AbortSignal 打断时，严禁 Failover 重试，应立即抛出 AbortError', async () => {
    const manager = new ModelFailoverManager();
    const backupFn = vi.fn();

    const controller = new AbortController();
    controller.abort(); // 事先打断

    const primaryLLM: LLMProvider = {
      chat() {
        return Promise.resolve({ content: '不应执行' });
      },
    };

    const backupLLM: LLMProvider = {
      chat() {
        backupFn();
        return Promise.resolve({ content: '备用节点' });
      },
    };

    const chain: ModelEndpointConfig[] = [
      { id: 'm1', name: 'Model-1', provider: primaryLLM },
      { id: 'm2', name: 'Model-2', provider: backupLLM },
    ];

    await expect(
      manager.executeChat(chain, [{ role: 'user', content: 'test' }], {
        signal: controller.signal,
      })
    ).rejects.toThrow();

    expect(backupFn).not.toHaveBeenCalled();
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
});
