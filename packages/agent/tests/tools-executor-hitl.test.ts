import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createClient, type Client } from '@libsql/client';
import { ToolRegistry, createAgentTool } from '../src/tools/registry.js';
import { ReadWriteSplitExecutor } from '../src/tools/executor.js';
import { ApprovalManager } from '../src/hitl/manager.js';
import { LeaderApprovalRouter } from '../src/hitl/router.js';

describe('ToolExecutor 高危工具审批拦截与零信任防篡改防重放验证', () => {
  let client: Client;
  let registry: ToolRegistry;
  let manager: ApprovalManager;
  let router: LeaderApprovalRouter;
  let executor: ReadWriteSplitExecutor;
  let mockDangerousExecute: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    manager = new ApprovalManager({
      client,
      defaultTimeoutMs: 60000,
    });
    await manager.init();

    router = new LeaderApprovalRouter({
      orgRepository: {
        async getEmployeeById(id) {
          await Promise.resolve();
          return { id: String(id), name: '员工' + id, leaderId: 'leader_1' };
        },
        async getReportingChain() {
          await Promise.resolve();
          return [];
        },
      },
    });

    registry = new ToolRegistry();
    mockDangerousExecute = vi.fn().mockImplementation(async (input: { table: string }) => {
      await Promise.resolve();
      return { dropped: true, table: input.table };
    });

    // 注册高危工具
    const dangerousTool = createAgentTool({
      id: 'drop_database_table',
      description: '高危删表操作',
      inputSchema: z.object({ table: z.string().min(1, '表名不能为空') }),
      readOnly: false,
      requireApproval: true,
      execute: mockDangerousExecute,
    });

    registry.register(dangerousTool);

    executor = new ReadWriteSplitExecutor(registry, {
      approvalManager: manager,
      leaderRouter: router,
    });
  });

  afterEach(async () => {
    await manager.close();
    client.close();
  });

  it('审批前：高危工具调用被自动挂起拦截，底层 tool.execute 调用次数严格为 0', async () => {
    const result = await executor.executeSingle(
      {
        callId: 'call_danger_1',
        toolName: 'drop_database_table',
        args: { table: 'customers' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    expect(result.success).toBe(true);
    expect(result.suspended).toBe(true);
    expect(result.approvalStatus).toBe('pending');
    expect(result.approvalTaskId).toMatch(/^appr_/);
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);

    const task = await manager.getTaskById(result.approvalTaskId!);
    expect(task?.status).toBe('pending');
    expect(task?.toolName).toBe('drop_database_table');
    expect(task?.toolArgs).toEqual({ table: 'customers' });
  });

  it('参数校验先于审批挂起：非法入参在挂起前即被校验拦截，不创建持久化待办', async () => {
    const result = await executor.executeSingle(
      {
        callId: 'call_invalid_args',
        toolName: 'drop_database_table',
        args: { table: '' }, // 非法参数 (min 1)
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    expect(result.success).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.suspended).toBeUndefined();
    expect(result.error).toContain('输入参数校验失败');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);

    const pendingTasks = await manager.getPendingTasksByLeaderId('leader_1');
    expect(pendingTasks).toHaveLength(0);
  });

  it('批准后：携带真实有效的 approvedTaskId，底层 tool.execute 恰好执行 1 次', async () => {
    // 1. 触发挂起
    const suspendResult = await executor.executeSingle(
      {
        callId: 'call_danger_2',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    const taskId = suspendResult.approvalTaskId!;
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);

    // 2. 主管批准
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 3. 再次传入 approvedTaskId 执行
    const execResult = await executor.executeSingle(
      {
        callId: 'call_danger_2_resume',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );

    expect(execResult.success).toBe(true);
    expect(execResult.suspended).toBeUndefined();
    expect(execResult.output).toEqual({ dropped: true, table: 'users' });
    expect(mockDangerousExecute).toHaveBeenCalledTimes(1);
  });

  it('防参数篡改攻击拦截：批准后若尝试替换入参 (如改成 drop prod)，立即被拒绝执行且调用次数为 0', async () => {
    // 1. 申请并批准操作 table: 'test_table'
    const suspendResult = await executor.executeSingle(
      {
        callId: 'call_tamper_1',
        toolName: 'drop_database_table',
        args: { table: 'test_table' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    const taskId = suspendResult.approvalTaskId!;
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 2. 攻击者尝试篡改参数执行：将 table 改为 'production_core_db'
    const tamperResult = await executor.executeSingle(
      {
        callId: 'call_tamper_attack',
        toolName: 'drop_database_table',
        args: { table: 'production_core_db' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );

    expect(tamperResult.success).toBe(false);
    expect(tamperResult.isError).toBe(true);
    expect(tamperResult.error).toContain('防篡改校验失败');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);
  });

  it('防重放复用攻击拦截：同一个 approvedTaskId 被消费执行后，二次调用直接返回持久化结果，不重复产生副作用', async () => {
    // 1. 申请并批准
    const suspendResult = await executor.executeSingle(
      {
        callId: 'call_replay_1',
        toolName: 'drop_database_table',
        args: { table: 'orders' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    const taskId = suspendResult.approvalTaskId!;
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 2. 第一次合法执行
    const firstExec = await executor.executeSingle(
      {
        callId: 'call_replay_1_run1',
        toolName: 'drop_database_table',
        args: { table: 'orders' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );
    expect(firstExec.success).toBe(true);
    expect(mockDangerousExecute).toHaveBeenCalledTimes(1);

    // 3. 第二次尝试重放相同的 taskId
    const secondExec = await executor.executeSingle(
      {
        callId: 'call_replay_1_run2',
        toolName: 'drop_database_table',
        args: { table: 'orders' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );

    // 核心断言：第二次调用直接返回持久化结果，底层 execute 绝不执行第 2 次！
    expect(secondExec.success).toBe(true);
    expect(secondExec.output).toEqual({ dropped: true, table: 'orders' });
    expect(mockDangerousExecute).toHaveBeenCalledTimes(1);
  });

  it('并发互斥锁防双重执行：任务正处于 executing 时，第二个并发调用立即被拒绝', async () => {
    // 1. 申请并批准
    const suspendResult = await executor.executeSingle(
      {
        callId: 'call_concurrent_1',
        toolName: 'drop_database_table',
        args: { table: 'logs' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    const taskId = suspendResult.approvalTaskId!;
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 2. 手动将状态模拟为 executing (被 worker 1 抢占中)
    await client.execute({
      sql: `UPDATE approval_tasks SET tool_execution_status = 'executing' WHERE id = ?`,
      args: [taskId],
    });

    // 3. worker 2 尝试并发消费
    const concurrentExec = await executor.executeSingle(
      {
        callId: 'call_concurrent_worker2',
        toolName: 'drop_database_table',
        args: { table: 'logs' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );

    expect(concurrentExec.success).toBe(false);
    expect(concurrentExec.isError).toBe(true);
    expect(concurrentExec.error).toContain('正在由其他进程执行中');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);
  });
  it('安全处理 void / undefined 返回值的高危工具，成功执行并持久化 succeeded 状态', async () => {
    let voidSideEffectRan = false;

    const voidTool = createAgentTool({
      id: 'purge_cache_all',
      description: '清除所有缓存 (返回 void)',
      inputSchema: z.object({ scope: z.string() }),
      readOnly: false,
      requireApproval: true,
      execute: async _input => {
        await Promise.resolve();
        voidSideEffectRan = true;
        // 明确返回 undefined (void 函数标准行为)
        return undefined;
      },
    });

    registry.register(voidTool);

    // 1. 挂起拦截
    const suspendRes = await executor.executeSingle(
      {
        callId: 'call_void_1',
        toolName: 'purge_cache_all',
        args: { scope: 'all' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    const taskId = suspendRes.approvalTaskId!;
    expect(voidSideEffectRan).toBe(false);

    // 2. 主管批准
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 3. 执行工具 (返回 void)
    const execRes = await executor.executeSingle(
      {
        callId: 'call_void_resume',
        toolName: 'purge_cache_all',
        args: { scope: 'all' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );

    expect(execRes.success).toBe(true);
    expect(execRes.output).toBeUndefined();
    expect(voidSideEffectRan).toBe(true);

    // 核心安全断言：数据库中任务状态为 succeeded，绝不因 JSON.stringify(undefined) 崩溃误标 failed
    const task = await manager.getTaskById(taskId);
    expect(task?.toolExecutionStatus).toBe('succeeded');
  });
  it('防跨用户冒名盗用攻击拦截：非原申请人携带他人 approvedTaskId 调用直接被拒绝，调用次数仍为 0', async () => {
    // 1. 员工 emp_001 申请并获得批准
    const suspendResult = await executor.executeSingle(
      {
        callId: 'call_victim_task',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    const taskId = suspendResult.approvalTaskId!;
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 2. 恶意员工 emp_attacker_999 尝试使用该 taskId 执行
    const impersonateResult = await executor.executeSingle(
      {
        callId: 'call_attacker_run',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_attacker_999', // 冒用者
        threadId: 'session_1',
        approvedTaskId: taskId,
      }
    );

    expect(impersonateResult.success).toBe(false);
    expect(impersonateResult.isError).toBe(true);
    expect(impersonateResult.error).toContain('禁止冒用他人审批授权');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);
  });

  it('防跨会话重放攻击拦截：在非原申请会话中携带 approvedTaskId 调用直接被拒绝', async () => {
    const suspendResult = await executor.executeSingle(
      {
        callId: 'call_orig_session',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_secure_private',
      }
    );

    const taskId = suspendResult.approvalTaskId!;
    await manager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'leader_1',
    });

    // 尝试在公共群聊 session_public_group 中重放消费该任务
    const replayResult = await executor.executeSingle(
      {
        callId: 'call_replay_session',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_public_group', // 跨会话
        approvedTaskId: taskId,
      }
    );

    expect(replayResult.success).toBe(false);
    expect(replayResult.isError).toBe(true);
    expect(replayResult.error).toContain('禁止跨会话使用审批授权');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);
  });
  it('Fail-Closed 防安全逃逸：未配置 ApprovalManager 时调用高危工具直接阻断，调用次数严格为 0', async () => {
    // 实例化未配置 approvalManager 的执行器
    const noManagerExecutor = new ReadWriteSplitExecutor(registry, {});

    const blockedResult = await noManagerExecutor.executeSingle(
      {
        callId: 'call_no_manager',
        toolName: 'drop_database_table',
        args: { table: 'customers' },
      },
      {
        senderId: 'emp_001',
        threadId: 'session_1',
      }
    );

    expect(blockedResult.success).toBe(false);
    expect(blockedResult.isError).toBe(true);
    expect(blockedResult.error).toContain('未配置 ApprovalManager');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);
  });

  it('超时主动 AbortSignal 级联取消：工具超时时收到 signal.aborted，绝不滞后产生副作用', async () => {
    let sideEffectOccurred = false;

    // 注册一个模拟慢速异步操作的工具
    const slowTool = createAgentTool({
      id: 'slow_dangerous_op',
      description: '慢速高危操作',
      inputSchema: z.object({ id: z.string() }),
      readOnly: false,
      execute: async (_input, ctx) => {
        await new Promise(resolve => setTimeout(resolve, 50));
        // 若在超时中止后仍继续执行，则标记副作用发生
        if (!ctx?.signal?.aborted) {
          sideEffectOccurred = true;
        }
        return { success: true };
      },
    });

    registry.register(slowTool);

    const fastTimeoutExecutor = new ReadWriteSplitExecutor(registry, {
      timeoutMs: 10, // 10ms 快速超时
    });

    const timeoutRes = await fastTimeoutExecutor.executeSingle({
      callId: 'call_slow',
      toolName: 'slow_dangerous_op',
      args: { id: 'test' },
    });

    expect(timeoutRes.success).toBe(false);
    expect(timeoutRes.error).toContain('执行超时');

    // 等待 80ms 确保底层慢速 Promise 跑完
    await new Promise(resolve => setTimeout(resolve, 80));

    // 核心安全断言：超时中止后，副作用未发生
    expect(sideEffectOccurred).toBe(false);
  });

  it('零信任拦截：伪造或未获批准的 approvedTaskId 立即被拒绝执行，调用次数仍为 0', async () => {
    const fakeResult = await executor.executeSingle(
      {
        callId: 'call_fake',
        toolName: 'drop_database_table',
        args: { table: 'users' },
      },
      {
        senderId: 'emp_001',
        approvedTaskId: 'appr_fake_nonexistent',
      }
    );

    expect(fakeResult.success).toBe(false);
    expect(fakeResult.isError).toBe(true);
    expect(fakeResult.error).toContain('审批任务不存在');
    expect(mockDangerousExecute).toHaveBeenCalledTimes(0);
  });

  it('Mastra 原生 Tool 导出：toMastraTools 同步保留 requireApproval 标记', () => {
    const mastraTools = registry.toMastraTools();
    expect(mastraTools.drop_database_table).toBeDefined();
    expect(mastraTools.drop_database_table.requireApproval).toBe(true);
  });
});
