import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabaseClient, OrgRepository } from '@kkbot/store';
import { Mastra } from '@mastra/core';
import type { Client } from '@libsql/client';
import {
  ApprovalManager,
  LeaderApprovalRouter,
  StatefulApprovalMatcher,
  createHitlWorkflow,
  createHitlStorage,
  APPROVAL_STEP_ID,
  resumeApprovalWorkflow,
} from '../../src/hitl/index.js';

describe('双通道 HITL 人工在环审批端到端全链路集成测试 (E2E Full Flow)', () => {
  let client: Client;
  let orgRepo: OrgRepository;
  let workflow: ReturnType<typeof createHitlWorkflow>;
  let manager: ApprovalManager;
  let router: LeaderApprovalRouter;
  let matcher: StatefulApprovalMatcher;

  beforeEach(async () => {
    // 注入内存 LibSQL 数据库连接池，严禁硬编码路径
    client = await createDatabaseClient({ url: ':memory:' });
    orgRepo = new OrgRepository(client);

    // 1. 初始化组织架构数据
    await orgRepo.syncOrganization({
      departments: [
        { id: 'dept_dev', name: '研发中心', parent_id: null, leader_id: 'emp_leader_1' },
      ],
      employees: [
        {
          id: 'emp_dev_1',
          loginName: 'dev1',
          name: '小明工程师',
          leaderId: 'emp_leader_1',
          appointments: [{ deptId: 'dept_dev', isPrimary: true, isLeader: false }],
        },
        {
          id: 'emp_leader_1',
          loginName: 'leader1',
          name: '李总监',
          leaderId: null,
          appointments: [{ deptId: 'dept_dev', isPrimary: true, isLeader: true }],
        },
      ],
    });

    // 2. 初始化 Mastra Workflow 与 LibSQL 持久化存储
    const storage = createHitlStorage(client);
    await storage.init();

    workflow = createHitlWorkflow();
    new Mastra({
      storage,
      workflows: {
        hitlWorkflow: workflow,
      },
    });

    // 3. 初始化 ApprovalManager、Router 与 Matcher
    manager = new ApprovalManager({
      client,
      workflow,
      defaultTimeoutMs: 60000,
      fallbackDegradeMessage: '业务涉及敏感权限，审批超时已为您转人工客服处理',
    });
    await manager.init();

    router = new LeaderApprovalRouter({ orgRepository: orgRepo });
    matcher = new StatefulApprovalMatcher({
      approvalManager: manager,
      router,
    });
  });

  afterEach(async () => {
    await manager.close();
    client.close();
  });

  it('场景 1 (批准闭环)：创建 Run -> 挂起 -> 生成任务 -> 主管私聊回复“同意” -> 自动恢复 Workflow 输出 approved', async () => {
    // 1. 主管路由解析
    const { leaderId, leaderName } = await router.resolveLeader('emp_dev_1');
    expect(leaderId).toBe('emp_leader_1');
    expect(leaderName).toBe('李总监');

    // 2. 启动审批工作流并挂起，生成待办任务
    const { task, runId } = await manager.startApprovalWorkflow({
      toolCallId: 'call_drop_table_001',
      toolName: 'drop_database_table',
      toolArgs: { table: 'orders_2025' },
      applicantId: 'emp_dev_1',
      applicantName: '小明工程师',
      leaderId,
      leaderName,
      threadId: 'session_chat_emp1',
      timeoutMs: 60000,
    });

    expect(task.status).toBe('pending');
    expect(task.workflowRunId).toBe(runId);
    expect(runId).toBeDefined();

    // 3. 生成并发送主管私聊审批通知卡片 (通道 2)
    const notification = router.formatApprovalNotification(task);
    expect(notification.leaderId).toBe('emp_leader_1');
    expect(notification.text).toContain('drop_database_table');
    expect(notification.text).toContain('小明工程师');

    // 4. 主管在私聊窗口中回复“同意”
    const matchRes = await matcher.match('emp_leader_1', '同意');
    expect(matchRes.matched).toBe(true);
    expect(matchRes.action).toBe('approve');
    expect(matchRes.task?.id).toBe(task.id);

    // 5. 决议流转：调用 resolveTask (内部自动触发 Workflow resume)
    const resolvedTask = await manager.resolveTask({
      taskId: task.id,
      approved: true,
      deciderId: 'emp_leader_1',
      deciderName: '李总监',
      reason: '方案符合安全标准，同意操作',
    });

    expect(resolvedTask.status).toBe('approved');
    expect(resolvedTask.decision?.approved).toBe(true);
    expect(resolvedTask.workflowResumed).toBe(true);

    // 6. 验证底层的 Mastra Workflow Run 状态已自动恢复并产生终态输出
    const queriedTask = await manager.getTaskById(task.id);
    expect(queriedTask?.workflowResumed).toBe(true);
  });

  it('场景 2 (驳回闭环)：创建 Run -> 挂起 -> 主管私聊回复“驳回” -> 自动恢复 Workflow 输出 rejected', async () => {
    const { leaderId, leaderName } = await router.resolveLeader('emp_dev_1');

    const { task, runId } = await manager.startApprovalWorkflow({
      toolCallId: 'call_export_002',
      toolName: 'export_customer_pii',
      toolArgs: { limit: 10000 },
      applicantId: 'emp_dev_1',
      applicantName: '小明工程师',
      leaderId,
      leaderName,
      threadId: 'session_chat_emp1',
    });

    expect(runId).toBeDefined();

    // 主管在私聊窗口中回复“驳回”
    const matchRes = await matcher.match('emp_leader_1', '驳回');
    expect(matchRes.matched).toBe(true);
    expect(matchRes.action).toBe('reject');

    // 执行决议
    const resolvedTask = await manager.resolveTask({
      taskId: task.id,
      approved: false,
      deciderId: 'emp_leader_1',
      deciderName: '李总监',
      reason: '涉及客户隐私高密数据，暂不开放批量导出',
    });

    expect(resolvedTask.status).toBe('rejected');
    expect(resolvedTask.workflowResumed).toBe(true);
  });

  it('场景 3 (超时降级闭环)：创建 Run -> 挂起 -> 倒计时结束 -> 任务结算为 timed_out -> Workflow 恢复输出降级决议', async () => {
    const { leaderId } = await router.resolveLeader('emp_dev_1');
    const { promise, resolve } = Promise.withResolvers<void>();
    manager.once('taskTimedOut', () => {
      resolve();
    });
    const { task, runId } = await manager.startApprovalWorkflow({
      toolCallId: 'call_timeout_003',
      toolName: 'grant_super_admin',
      toolArgs: { uid: 'emp_dev_1' },
      applicantId: 'emp_dev_1',
      leaderId,
      threadId: 'session_chat_emp1',
      timeoutMs: 50, // 50ms 快速超时
    });

    expect(task.status).toBe('pending');
    expect(runId).toBeDefined();

    // 等待超时触发
    await promise;

    const timedOutTask = await manager.getTaskById(task.id);
    expect(timedOutTask?.status).toBe('timed_out');
    expect(timedOutTask?.workflowResumed).toBe(true);
    expect(timedOutTask?.decision?.reason).toBe(
      '业务涉及敏感权限，审批超时已为您转人工客服处理'
    );
  });

  it('场景 4 (崩溃自愈与重试恢复)：决议后未恢复的任务在进程重启 init() 时自动自愈恢复', async () => {
    // 1. 创建并启动一个挂起的 Workflow Run
    const run = await workflow.createRun();
    const runId = run.runId;
    await run.start({
      inputData: {
        toolCallId: 'call_crash_001',
        toolName: 'truncate_table',
        toolArgs: { table: 'logs' },
        applicantId: 'emp_dev_1',
        applicantName: '小明工程师',
        leaderId: 'emp_leader_1',
        leaderName: '李总监',
        threadId: 'session_crash',
        timeoutMs: 60000,
      },
    });

    const taskId = 'appr_unresumed_crash_task';
    const now = Date.now();

    // 2. 向数据库写入一条已批准但 workflow_resumed = 0 的记录（模拟在两步之间崩溃）
    await client.execute({
      sql: `INSERT INTO approval_tasks (
        id, tool_call_id, tool_name, tool_args, applicant_id, applicant_name,
        leader_id, leader_name, thread_id, workflow_run_id, workflow_step_id,
        workflow_resumed, status, decision, timeout_ms, created_at, expires_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        taskId,
        'call_crash_001',
        'truncate_table',
        JSON.stringify({ table: 'logs' }),
        'emp_dev_1',
        '小明工程师',
        'emp_leader_1',
        '李总监',
        'session_crash',
        runId,
        APPROVAL_STEP_ID,
        0, // 未恢复
        'approved',
        JSON.stringify({
          approved: true,
          deciderId: 'emp_leader_1',
          deciderName: '李总监',
          reason: '日志归档完毕，允许清理',
          decidedAt: now,
        }),
        60000,
        now - 1000,
        now + 59000,
        now,
      ],
    });

    // 3. 创建新的 Manager 实例并 init 模拟进程重启
    const newManager = new ApprovalManager({
      client,
      workflow,
    });

    await newManager.init();

    // 4. 验证任务在自愈扫描后已被成功标记为 workflow_resumed = 1
    const recoveredTask = await newManager.getTaskById(taskId);
    expect(recoveredTask?.status).toBe('approved');
    expect(recoveredTask?.workflowResumed).toBe(true);

    await newManager.close();
  });

  it('场景 5 (已完成终态幂等探测)：实际已 resume 成功但写 flag 前宕机，init() 自动探测并补齐标记', async () => {
    // 1. 创建并启动一个挂起的 Workflow Run
    const run = await workflow.createRun();
    const runId = run.runId;
    await run.start({
      inputData: {
        toolCallId: 'call_already_resumed_001',
        toolName: 'alter_table',
        toolArgs: { table: 'users' },
        applicantId: 'emp_dev_1',
        leaderId: 'emp_leader_1',
        threadId: 'session_probe',
        timeoutMs: 60000,
      },
    });

    // 2. 真实调用 resume 完成恢复
    await resumeApprovalWorkflow(workflow, {
      runId,
      stepId: APPROVAL_STEP_ID,
      decision: {
        approved: true,
        deciderId: 'emp_leader_1',
        decidedAt: Date.now(),
      },
    });

    const taskId = 'appr_probe_already_success_task';
    const now = Date.now();

    // 3. 手工在数据库中保持 workflow_resumed = 0 (模拟写 DB 前宕机)
    await client.execute({
      sql: `INSERT INTO approval_tasks (
        id, tool_call_id, tool_name, tool_args, applicant_id, applicant_name,
        leader_id, leader_name, thread_id, workflow_run_id, workflow_step_id,
        workflow_resumed, status, decision, timeout_ms, created_at, expires_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        taskId,
        'call_already_resumed_001',
        'alter_table',
        JSON.stringify({ table: 'users' }),
        'emp_dev_1',
        '小明工程师',
        'emp_leader_1',
        '李总监',
        'session_probe',
        runId,
        APPROVAL_STEP_ID,
        0, // 手工保持 0
        'approved',
        JSON.stringify({
          approved: true,
          deciderId: 'emp_leader_1',
          decidedAt: now,
        }),
        60000,
        now - 1000,
        now + 59000,
        now,
      ],
    });

    // 4. 重启 Manager 进行自愈探测
    const probeManager = new ApprovalManager({
      client,
      workflow,
    });

    // 这一步必须幂等探测并更新 workflow_resumed = 1，绝不能抛出 "was not suspended" 异常！
    await probeManager.init();

    const probedTask = await probeManager.getTaskById(taskId);
    expect(probedTask?.workflowResumed).toBe(true);

    await probeManager.close();
  });
});
