import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createClient } from '@libsql/client';
import { Mastra } from '@mastra/core';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  createHitlWorkflow,
  createHitlStorage,
  resumeApprovalWorkflow,
  APPROVAL_STEP_ID,
} from '../../src/hitl/workflow.js';
import type { ApprovalDecision } from '../../src/hitl/types.js';

describe('Mastra HITL Workflow 原生挂起与恢复流', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-hitl-wf-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Windows 下忽略延迟句柄释放的 EBUSY
    }
  });

  it('高危工具工作流启动时自动挂起 (suspend)，并在收到批准决议后成功恢复 (resume)', async () => {
    const dbPath = path.join(tempDir, 'hitl-1.db');
    const client = createClient({ url: `file:${dbPath}` });
    const storage = createHitlStorage(client);
    await storage.init();
    const workflow = createHitlWorkflow();
    const mastra = new Mastra({
      storage,
      workflows: {
        hitlWorkflow: workflow,
      },
    });

    const wf = mastra.getWorkflow('hitlWorkflow');
    const run = await wf.createRun();
    const runId = run.runId;

    // 1. 启动工作流，预期触发挂起
    const startResult = await run.start({
      inputData: {
        toolCallId: 'call_wf_001',
        toolName: 'drop_production_database',
        toolArgs: { database: 'users_prod' },
        applicantId: 'emp_001',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        leaderName: '李主管',
        threadId: 'session_wf_1',
        timeoutMs: 60000,
      },
    });

    expect(startResult.status).toBe('suspended');
    expect(startResult.runId).toBe(runId);

    // 2. 模拟主管在私聊中同意，通过 resumeApprovalWorkflow 恢复流
    const decision: ApprovalDecision = {
      approved: true,
      deciderId: 'emp_leader_1',
      deciderName: '李主管',
      reason: '已核实发布窗口，准予操作',
      decidedAt: Date.now(),
    };

    const resumeResult = await resumeApprovalWorkflow(wf, {
      runId,
      stepId: APPROVAL_STEP_ID,
      decision,
    });

    expect(resumeResult.status).toBe('success');
    expect(resumeResult.result).toEqual({
      toolCallId: 'call_wf_001',
      toolName: 'drop_production_database',
      approved: true,
      status: 'approved',
      decision: expect.objectContaining({
        approved: true,
        deciderId: 'emp_leader_1',
        reason: '已核实发布窗口，准予操作',
      }),
      toolArgs: { database: 'users_prod' },
    });
    await storage.close();
    client.close();
  });

  it('工作流在收到驳回决议后成功恢复并返回 status: rejected', async () => {
    const dbPath = path.join(tempDir, 'hitl-2.db');
    const client = createClient({ url: `file:${dbPath}` });
    const storage = createHitlStorage(client);
    await storage.init();

    const workflow = createHitlWorkflow();
    const mastra = new Mastra({
      storage,
      workflows: {
        hitlWorkflow: workflow,
      },
    });

    const wf = mastra.getWorkflow('hitlWorkflow');
    const run = await wf.createRun();

    await run.start({
      inputData: {
        toolCallId: 'call_wf_002',
        toolName: 'grant_root_permission',
        toolArgs: { user: 'emp_009' },
        applicantId: 'emp_001',
        leaderId: 'emp_leader_1',
        threadId: 'session_wf_2',
        timeoutMs: 60000,
      },
    });

    const decision: ApprovalDecision = {
      approved: false,
      deciderId: 'emp_leader_1',
      deciderName: '李主管',
      reason: '该操作在业务高峰期存在严重超时风险，主管明确驳回',
      decidedAt: Date.now(),
    };

    const resumeResult = await resumeApprovalWorkflow(wf, {
      runId: run.runId,
      stepId: APPROVAL_STEP_ID,
      decision,
    });

    expect(resumeResult.status).toBe('success');
    expect(resumeResult.result.approved).toBe(false);
    // 核心断言：即使理由包含“超时”字眼，主管明确驳回依然严格映射为 rejected
    expect(resumeResult.result.status).toBe('rejected');
    await storage.close();
    client.close();
  });

  it('工作流在收到系统超时降级决议后成功恢复并返回 status: timed_out', async () => {
    const dbPath = path.join(tempDir, 'hitl-3.db');
    const client = createClient({ url: `file:${dbPath}` });
    const storage = createHitlStorage(client);
    await storage.init();

    const workflow = createHitlWorkflow();
    const mastra = new Mastra({
      storage,
      workflows: {
        hitlWorkflow: workflow,
      },
    });

    const wf = mastra.getWorkflow('hitlWorkflow');
    const run = await wf.createRun();

    await run.start({
      inputData: {
        toolCallId: 'call_wf_timeout',
        toolName: 'emergency_reboot_cluster',
        toolArgs: { clusterId: 'k8s-prod' },
        applicantId: 'emp_001',
        leaderId: 'emp_leader_1',
        threadId: 'session_wf_3',
        timeoutMs: 60000,
      },
    });

    const timeoutDecision: ApprovalDecision = {
      approved: false,
      deciderId: 'system_timeout',
      reason: '业务涉及敏感权限，审批超时已为您转人工客服处理',
      decidedAt: Date.now(),
    };

    const resumeResult = await resumeApprovalWorkflow(wf, {
      runId: run.runId,
      stepId: APPROVAL_STEP_ID,
      decision: timeoutDecision,
    });

    expect(resumeResult.status).toBe('success');
    expect(resumeResult.result.approved).toBe(false);
    // 核心断言：系统超时降级精准映射为 timed_out
    expect(resumeResult.result.status).toBe('timed_out');
    await storage.close();
    client.close();
  });
});
