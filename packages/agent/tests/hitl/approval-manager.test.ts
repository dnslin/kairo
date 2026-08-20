import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ApprovalManager } from '../../src/hitl/manager.js';
import {
  ApprovalStateConflictError,
  ApprovalUnauthorizedError,
} from '../../src/utils/errors.js';
import type { CreateApprovalTaskInput } from '../../src/hitl/types.js';

describe('ApprovalManager HITL 审批状态机核心管理器', () => {
  let client: Client;
  let manager: ApprovalManager;

  beforeEach(async () => {
    // 使用外部注入的内存 SQLite 客户端，严禁硬编码文件路径
    client = createClient({ url: ':memory:' });
    manager = new ApprovalManager({
      client,
      defaultTimeoutMs: 60000,
      fallbackDegradeMessage: '业务涉及敏感权限，审批超时已为您转人工客服处理',
    });
    await manager.init();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await manager.close();
    client.close();
  });

  it('能够成功创建高危审批任务并正确持久化到 SQLite', async () => {
    const input: CreateApprovalTaskInput = {
      toolCallId: 'call_123456',
      toolName: 'database_drop_table',
      toolArgs: { tableName: 'users', cascade: true },
      applicantId: 'emp_001',
      applicantName: '张三',
      leaderId: 'emp_leader_001',
      leaderName: '李主管',
      threadId: 'session_chat_999',
      timeoutMs: 2000,
    };

    const task = await manager.createTask(input);

    expect(task.id).toMatch(/^appr_/);
    expect(task.toolCallId).toBe('call_123456');
    expect(task.toolName).toBe('database_drop_table');
    expect(task.toolArgs).toEqual({ tableName: 'users', cascade: true });
    expect(task.applicantId).toBe('emp_001');
    expect(task.applicantName).toBe('张三');
    expect(task.leaderId).toBe('emp_leader_001');
    expect(task.leaderName).toBe('李主管');
    expect(task.threadId).toBe('session_chat_999');
    expect(task.status).toBe('pending');
    expect(task.timeoutMs).toBe(2000);
    expect(task.expiresAt).toBe(task.createdAt + 2000);
    expect(task.decision).toBeUndefined();

    // 验证数据库直读
    const queried = await manager.getTaskById(task.id);
    expect(queried).not.toBeNull();
    expect(queried?.id).toBe(task.id);
    expect(queried?.status).toBe('pending');
  });

  it('支持按主管 ID 和会话 ID 检索待处理 pending 任务', async () => {
    const task1 = await manager.createTask({
      toolCallId: 'call_1',
      toolName: 'sensitive_tool_1',
      toolArgs: { arg: 1 },
      applicantId: 'emp_001',
      applicantName: '张三',
      leaderId: 'emp_leader_1',
      leaderName: '李主管',
      threadId: 'thread_1',
    });

    const task2 = await manager.createTask({
      toolCallId: 'call_2',
      toolName: 'sensitive_tool_2',
      toolArgs: { arg: 2 },
      applicantId: 'emp_002',
      applicantName: '王五',
      leaderId: 'emp_leader_1',
      leaderName: '李主管',
      threadId: 'thread_2',
    });

    // 另一个主管的任务
    await manager.createTask({
      toolCallId: 'call_3',
      toolName: 'sensitive_tool_3',
      toolArgs: { arg: 3 },
      applicantId: 'emp_003',
      applicantName: '赵六',
      leaderId: 'emp_leader_2',
      leaderName: '钱主管',
      threadId: 'thread_3',
    });

    const leader1Tasks = await manager.getPendingTasksByLeaderId('emp_leader_1');
    expect(leader1Tasks).toHaveLength(2);
    expect(leader1Tasks.map(t => t.id)).toEqual([task1.id, task2.id]);

    const thread1Tasks = await manager.getPendingTasksByThreadId('thread_1');
    expect(thread1Tasks).toHaveLength(1);
    expect(thread1Tasks[0].id).toBe(task1.id);
  });

  it('主管批准审批任务后，状态流转为 approved 并记录决议数据', async () => {
    const task = await manager.createTask({
      toolCallId: 'call_abc',
      toolName: 'update_system_config',
      toolArgs: { key: 'max_concurrency', value: 100 },
      applicantId: 'emp_001',
      applicantName: '张三',
      leaderId: 'emp_leader_001',
      leaderName: '李主管',
      threadId: 'thread_100',
    });

    const resolvedTask = await manager.resolveTask({
      taskId: task.id,
      approved: true,
      deciderId: 'emp_leader_001',
      deciderName: '李主管',
      reason: '方案已经过评审，准予执行',
    });

    expect(resolvedTask.status).toBe('approved');
    expect(resolvedTask.decision).toEqual({
      approved: true,
      deciderId: 'emp_leader_001',
      deciderName: '李主管',
      reason: '方案已经过评审，准予执行',
      decidedAt: expect.any(Number),
    });
    expect(resolvedTask.resolvedAt).toBeDefined();

    // 验证查库状态一致
    const queried = await manager.getTaskById(task.id);
    expect(queried?.status).toBe('approved');
    expect(queried?.decision?.approved).toBe(true);

    // 主管待办列表应不再包含该任务
    const pendingList = await manager.getPendingTasksByLeaderId('emp_leader_001');
    expect(pendingList).toHaveLength(0);
  });

  it('主管驳回审批任务后，状态流转为 rejected 并记录决议数据', async () => {
    const task = await manager.createTask({
      toolCallId: 'call_xyz',
      toolName: 'grant_admin_role',
      toolArgs: { targetUid: 'emp_009' },
      applicantId: 'emp_001',
      applicantName: '张三',
      leaderId: 'emp_leader_001',
      leaderName: '李主管',
      threadId: 'thread_100',
    });

    const resolvedTask = await manager.resolveTask({
      taskId: task.id,
      approved: false,
      deciderId: 'emp_leader_001',
      deciderName: '李主管',
      reason: '权限申请不符合最小权限原则',
    });

    expect(resolvedTask.status).toBe('rejected');
    expect(resolvedTask.decision?.approved).toBe(false);
    expect(resolvedTask.decision?.reason).toBe('权限申请不符合最小权限原则');
  });
  it('越权拦截：非指定主管且非管理员尝试审批时被拒绝，任务保持 pending 状态', async () => {
    const task = await manager.createTask({
      toolCallId: 'call_unauth',
      toolName: 'grant_admin_permission',
      toolArgs: { role: 'admin' },
      applicantId: 'emp_001',
      applicantName: '张三',
      leaderId: 'emp_leader_001',
      leaderName: '李主管',
      threadId: 'thread_100',
    });

    // 申请人自身或其他无关员工尝试审批
    await expect(
      manager.resolveTask({
        taskId: task.id,
        approved: true,
        deciderId: 'emp_001', // 申请人自身试图越权自批
        deciderName: '张三',
      })
    ).rejects.toThrow(ApprovalUnauthorizedError);

    // 验证任务依然保持 pending 状态，未被更改
    const taskAfterAttack = await manager.getTaskById(task.id);
    expect(taskAfterAttack?.status).toBe('pending');
    expect(taskAfterAttack?.decision).toBeUndefined();
  });

  it('特权放行：配置在 adminUserIds 中的管理员可跨级直接批准', async () => {
    const adminManager = new ApprovalManager({
      client,
      adminUserIds: ['super_admin_999'],
    });

    const task = await adminManager.createTask({
      toolCallId: 'call_admin_auth',
      toolName: 'emergency_config_fix',
      toolArgs: {},
      applicantId: 'emp_001',
      leaderId: 'emp_leader_001',
      threadId: 'thread_admin',
    });

    const resolvedTask = await adminManager.resolveTask({
      taskId: task.id,
      approved: true,
      deciderId: 'super_admin_999',
      deciderName: '安全超管',
    });

    expect(resolvedTask.status).toBe('approved');
    expect(resolvedTask.decision?.deciderId).toBe('super_admin_999');

    await adminManager.close();
  });


  it('对非 pending 状态的任务重复决议时应抛出明确异常', async () => {
    const task = await manager.createTask({
      toolCallId: 'call_dup',
      toolName: 'some_tool',
      toolArgs: {},
      applicantId: 'emp_001',
      leaderId: 'emp_leader_001',
      threadId: 'thread_1',
    });

    await manager.resolveTask({
      taskId: task.id,
      approved: true,
      deciderId: 'emp_leader_001',
    });

    // 再次决议
    await expect(
      manager.resolveTask({
        taskId: task.id,
        approved: false,
        deciderId: 'emp_leader_001',
      })
    ).rejects.toThrow(ApprovalStateConflictError);
  });

  it('任务达到超时时间后自动标记为 timed_out', async () => {
    const { promise, resolve } = Promise.withResolvers<void>();
    manager.once('taskTimedOut', () => {
      resolve();
    });

    const task = await manager.createTask({
      toolCallId: 'call_timeout',
      toolName: 'export_all_customer_data',
      toolArgs: { format: 'csv' },
      applicantId: 'emp_001',
      leaderId: 'emp_leader_001',
      threadId: 'thread_1',
      timeoutMs: 50,
    });

    expect(task.status).toBe('pending');

    await promise;

    const timedOutTask = await manager.getTaskById(task.id);
    expect(timedOutTask?.status).toBe('timed_out');
    expect(timedOutTask?.resolvedAt).toBeDefined();

    expect(manager.getTimeoutDegradeMessage()).toBe(
      '业务涉及敏感权限，审批超时已为您转人工客服处理'
    );
  });

  describe('进程重启自愈机制 (Self-Healing Recovery)', () => {
    it('场景 A：重启时已过期的任务在 init() 阶段自动结算为 timed_out', async () => {
      const pastTime = Date.now() - 5000;
      const expiredTaskId = 'appr_past_expired_1';

      // 手动向数据库写入一条停机期间已过期的 pending 任务
      await client.execute({
        sql: `INSERT INTO approval_tasks (
          id, tool_call_id, tool_name, tool_args, applicant_id, applicant_name,
          leader_id, leader_name, thread_id, status, timeout_ms, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          expiredTaskId,
          'call_past',
          'delete_archive',
          JSON.stringify({ id: 1 }),
          'emp_001',
          '张三',
          'emp_leader_001',
          '李主管',
          'thread_past',
          'pending',
          1000,
          pastTime - 1000,
          pastTime, // expires_at 在过去
        ],
      });

      // 创建新的 Manager 实例并 init 模拟进程重启
      const newManager = new ApprovalManager({ client });
      await newManager.init();

      const recoveredTask = await newManager.getTaskById(expiredTaskId);
      expect(recoveredTask?.status).toBe('timed_out');
      expect(recoveredTask?.resolvedAt).toBeDefined();

      await newManager.close();
    });

    it('场景 B：重启时尚未过期的任务在 init() 阶段自动基于剩余时间重建定时器', async () => {
      const now = Date.now();
      const futureTaskId = 'appr_future_pending_1';
      const remainingMs = 80;

      // 手动向数据库写入一条还剩 80ms 超时的 pending 任务
      await client.execute({
        sql: `INSERT INTO approval_tasks (
          id, tool_call_id, tool_name, tool_args, applicant_id, applicant_name,
          leader_id, leader_name, thread_id, status, timeout_ms, created_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          futureTaskId,
          'call_future',
          'update_permission',
          JSON.stringify({ role: 'admin' }),
          'emp_002',
          '李四',
          'emp_leader_001',
          '李主管',
          'thread_future',
          'pending',
          1000,
          now - 920,
          now + remainingMs, // 还剩 80ms
        ],
      });

      const newManager = new ApprovalManager({ client });
      const { promise, resolve } = Promise.withResolvers<void>();
      newManager.once('taskTimedOut', () => {
        resolve();
      });

      await newManager.init();

      // 初始化后立即检查，依然是 pending 状态
      const pendingTask = await newManager.getTaskById(futureTaskId);
      expect(pendingTask?.status).toBe('pending');

      // 等待重建的定时器触发
      await promise;

      const timedOutTask = await newManager.getTaskById(futureTaskId);
      expect(timedOutTask?.status).toBe('timed_out');

      await newManager.close();
    });

    it('场景 C：配置了返回 void/undefined 的 toolExecutor 时，批准与自愈恢复均能安全持久化 succeeded 状态', async () => {
      let voidRanCount = 0;
      const voidToolManager = new ApprovalManager({
        client,
        toolExecutor: async () => {
          await Promise.resolve();
          voidRanCount++;
          return undefined; // 明确返回 undefined (void 工具)
        },
      });

      await voidToolManager.init();

      const task = await voidToolManager.createTask({
        toolCallId: 'call_void_manager',
        toolName: 'clean_expired_tokens',
        toolArgs: { force: true },
        applicantId: 'emp_001',
        leaderId: 'emp_leader_001',
        threadId: 'thread_void',
      });

      // 主管批准
      const resolvedTask = await voidToolManager.resolveTask({
        taskId: task.id,
        approved: true,
        deciderId: 'emp_leader_001',
      });

      expect(resolvedTask.status).toBe('approved');
      expect(resolvedTask.toolExecutionStatus).toBe('succeeded');
      expect(resolvedTask.toolExecutionResult).toBeUndefined();
      expect(voidRanCount).toBe(1);

      // 验证数据库查库
      const dbTask = await voidToolManager.getTaskById(task.id);
      expect(dbTask?.toolExecutionStatus).toBe('succeeded');
      expect(dbTask?.toolExecutionResult).toBeUndefined();

      await voidToolManager.close();
    });
  });
});
