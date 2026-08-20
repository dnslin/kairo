import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry, createAgentTool } from '../src/tools/registry.js';
import { ReadWriteSplitExecutor } from '../src/tools/executor.js';
import type { ToolCallRequest } from '../src/tools/types.js';
import { StepLimitExceededError } from '../src/utils/errors.js';

describe('ReadWriteSplitExecutor 读写分流并发调度器 (TDD Red -> Green)', () => {
  const createTestHarness = () => {
    const registry = new ToolRegistry();
    const executor = new ReadWriteSplitExecutor(registry, { maxSteps: 5, timeoutMs: 5000 });
    return { registry, executor };
  };

  describe('1. 只读工具并发与写工具串行调度时序', () => {
    it('多个只读工具应当采用 Promise.allSettled 真正并发执行 (总耗时接近最大单工具耗时而非累加)', async () => {
      const { registry, executor } = createTestHarness();
      const executionTimeline: Array<{ id: string; event: 'start' | 'end'; time: number }> = [];

      // 注册 3 个具有不同延迟的只读工具
      registry.register(
        createAgentTool({
          id: 'read_query_a',
          description: '只读查询 A',
          readOnly: true,
          inputSchema: z.object({ id: z.string() }),
          execute: async ({ id }) => {
            const start = Date.now();
            executionTimeline.push({ id: 'A', event: 'start', time: start });
            await new Promise(r => setTimeout(r, 60));
            executionTimeline.push({ id: 'A', event: 'end', time: Date.now() });
            return { data: `result_a_${id}` };
          },
        })
      );

      registry.register(
        createAgentTool({
          id: 'read_query_b',
          description: '只读查询 B',
          readOnly: true,
          inputSchema: z.object({ id: z.string() }),
          execute: async ({ id }) => {
            const start = Date.now();
            executionTimeline.push({ id: 'B', event: 'start', time: start });
            await new Promise(r => setTimeout(r, 80));
            executionTimeline.push({ id: 'B', event: 'end', time: Date.now() });
            return { data: `result_b_${id}` };
          },
        })
      );

      registry.register(
        createAgentTool({
          id: 'read_query_c',
          description: '只读查询 C',
          readOnly: true,
          inputSchema: z.object({ id: z.string() }),
          execute: async ({ id }) => {
            const start = Date.now();
            executionTimeline.push({ id: 'C', event: 'start', time: start });
            await new Promise(r => setTimeout(r, 50));
            executionTimeline.push({ id: 'C', event: 'end', time: Date.now() });
            return { data: `result_c_${id}` };
          },
        })
      );

      const requests: ToolCallRequest[] = [
        { callId: 'call_1', toolName: 'read_query_a', args: { id: '1' } },
        { callId: 'call_2', toolName: 'read_query_b', args: { id: '2' } },
        { callId: 'call_3', toolName: 'read_query_c', args: { id: '3' } },
      ];

      const startAll = Date.now();
      const batchResult = await executor.executeBatch(requests);
      const totalTime = Date.now() - startAll;

      expect(batchResult.successCount).toBe(3);
      expect(batchResult.failureCount).toBe(0);
      expect(batchResult.readOnlyCount).toBe(3);
      expect(batchResult.writeCount).toBe(0);

      // 并发执行：总耗时应该在 ~80-140ms 之间，远小于串行累加耗时 190ms+
      expect(totalTime).toBeLessThan(170);

      // 验证 3 个任务几乎同时启动 (启动时间差很小)
      const starts = executionTimeline.filter(t => t.event === 'start');
      expect(starts.length).toBe(3);
      const maxStartDiff = Math.max(...starts.map(s => s.time)) - Math.min(...starts.map(s => s.time));
      expect(maxStartDiff).toBeLessThan(30);
    });

    it('写操作工具必须严格串行排队执行，严禁并发引起竞态', async () => {
      const { registry, executor } = createTestHarness();
      const executionLog: string[] = [];
      let activeWrites = 0;
      let maxConcurrentWrites = 0;

      registry.register(
        createAgentTool({
          id: 'write_op_1',
          description: '写操作 1',
          readOnly: false,
          inputSchema: z.object({ val: z.string() }),
          execute: async ({ val }) => {
            activeWrites++;
            maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
            executionLog.push(`start_write_1_${val}`);
            await new Promise(r => setTimeout(r, 40));
            executionLog.push(`end_write_1_${val}`);
            activeWrites--;
            return { saved: val };
          },
        })
      );

      registry.register(
        createAgentTool({
          id: 'write_op_2',
          description: '写操作 2',
          readOnly: false,
          inputSchema: z.object({ val: z.string() }),
          execute: async ({ val }) => {
            activeWrites++;
            maxConcurrentWrites = Math.max(maxConcurrentWrites, activeWrites);
            executionLog.push(`start_write_2_${val}`);
            await new Promise(r => setTimeout(r, 40));
            executionLog.push(`end_write_2_${val}`);
            activeWrites--;
            return { saved: val };
          },
        })
      );

      const requests: ToolCallRequest[] = [
        { callId: 'call_w1', toolName: 'write_op_1', args: { val: 'alpha' } },
        { callId: 'call_w2', toolName: 'write_op_2', args: { val: 'beta' } },
      ];

      const batchResult = await executor.executeBatch(requests);

      expect(batchResult.successCount).toBe(2);
      expect(batchResult.writeCount).toBe(2);
      expect(maxConcurrentWrites).toBe(1); // 严格互斥，最多同时 1 个写操作
      expect(executionLog).toEqual([
        'start_write_1_alpha',
        'end_write_1_alpha',
        'start_write_2_beta',
        'end_write_2_beta',
      ]);
    });

    it('混合调用批次应当实现只读并行优先 + 写操作排队串行', async () => {
      const { registry, executor } = createTestHarness();
      const logs: string[] = [];

      registry.register(
        createAgentTool({
          id: 'tool_read',
          description: '只读工具',
          readOnly: true,
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            await Promise.resolve();
            logs.push(`read_${name}`);
            return { data: name };
          },
        })
      );

      registry.register(
        createAgentTool({
          id: 'tool_write',
          description: '写工具',
          readOnly: false,
          inputSchema: z.object({ name: z.string() }),
          execute: async ({ name }) => {
            await Promise.resolve();
            logs.push(`write_${name}`);
            return { data: name };
          },
        })
      );

      const requests: ToolCallRequest[] = [
        { callId: '1', toolName: 'tool_read', args: { name: 'r1' } },
        { callId: '2', toolName: 'tool_write', args: { name: 'w1' } },
        { callId: '3', toolName: 'tool_read', args: { name: 'r2' } },
        { callId: '4', toolName: 'tool_write', args: { name: 'w2' } },
      ];

      const result = await executor.executeBatch(requests);

      expect(result.results.length).toBe(4);
      expect(result.readOnlyCount).toBe(2);
      expect(result.writeCount).toBe(2);
      expect(result.successCount).toBe(4);
    });
  });

  describe('2. 异常自愈回传与参数校验容错', () => {
    it('当工具内部抛出运行时异常时，不应阻断流程，而应封装 { error: message } 返回给 LLM 进行自愈', async () => {
      const { registry, executor } = createTestHarness();

      registry.register(
        createAgentTool({
          id: 'failing_tool',
          description: '异常模拟工具',
          readOnly: true,
          inputSchema: z.object({ code: z.number() }),
          execute: async ({ code }) => {
            await Promise.resolve();
            if (code === 500) {
              throw new Error('数据库连接超时，请重试');
            }
            return { status: 'ok' };
          },
        })
      );

      const requests: ToolCallRequest[] = [
        { callId: 'call_err', toolName: 'failing_tool', args: { code: 500 } },
      ];

      const result = await executor.executeBatch(requests);

      expect(result.failureCount).toBe(1);
      expect(result.results[0].success).toBe(false);
      expect(result.results[0].isError).toBe(true);
      expect(result.results[0].error).toContain('数据库连接超时');
      // output 中包含自愈错误信息
      expect(result.results[0].output).toEqual({ error: '数据库连接超时，请重试' });
    });

    it('当入参未通过 Zod 校验时，应自动封装格式化校验错误并返回', async () => {
      const { registry, executor } = createTestHarness();

      registry.register(
        createAgentTool({
          id: 'validated_tool',
          description: '带严格校验的工具',
          readOnly: true,
          inputSchema: z.object({
            age: z.number().int().min(18, '必须满18岁'),
            email: z.string().email('邮箱格式不合法'),
          }),
          execute: async input => {
            await Promise.resolve();
            return input;
          },
        })
      );

      const requests: ToolCallRequest[] = [
        {
          callId: 'call_val_err',
          toolName: 'validated_tool',
          args: { age: 16, email: 'not-an-email' },
        },
      ];

      const result = await executor.executeBatch(requests);

      expect(result.results[0].success).toBe(false);
      expect(result.results[0].isError).toBe(true);
      expect(typeof result.results[0].error).toBe('string');
      const errOutput = result.results[0].output;
      expect(errOutput).toBeTypeOf('object');
      expect(errOutput).not.toBeNull();
      expect((errOutput as Record<string, unknown>).error).toContain('必须满18岁');
    });

    it('当调用不存在的工具时，应安全返回未找到工具的自愈提示', async () => {
      const { executor } = createTestHarness();

      const requests: ToolCallRequest[] = [
        { callId: 'call_404', toolName: 'unknown_ghost_tool', args: {} },
      ];

      const result = await executor.executeBatch(requests);

      expect(result.results[0].success).toBe(false);
      const errOutput = result.results[0].output;
      expect((errOutput as Record<string, unknown>).error).toContain('未找到名称为 "unknown_ghost_tool" 的工具');
    });
  });

  describe('3. 单轮 ReAct 步数硬性熔断控制 (maxSteps: 5)', () => {
    it('在步数未超过 maxSteps (<= 5) 时应当正常执行', () => {
      const { executor } = createTestHarness();
      expect(() => executor.recordStep(1)).not.toThrow();
      expect(() => executor.recordStep(5)).not.toThrow();
    });

    it('当 ReAct 步数超过 5 步时，必须立即触发硬性熔断并抛出 StepLimitExceededError', () => {
      const { executor } = createTestHarness();

      executor.recordStep(1);
      executor.recordStep(2);
      executor.recordStep(3);
      executor.recordStep(4);
      executor.recordStep(5);

      // 第 6 步触发熔断
      expect(() => executor.recordStep(6)).toThrowError(StepLimitExceededError);
      expect(() => executor.recordStep(6)).toThrowError(/超过硬性熔断阈值/);
    });

    it('重置执行器步数后应当能重新开始计算', () => {
      const { executor } = createTestHarness();

      executor.recordStep(5);
      executor.resetSteps();
      expect(executor.getCurrentStep()).toBe(0);
      expect(() => executor.recordStep(1)).not.toThrow();
    });
  });
});
