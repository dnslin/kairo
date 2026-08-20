import { z } from 'zod';
import type { Client } from '@libsql/client';
import { createWorkflow, createStep } from '@mastra/core/workflows';
import { LibSQLStore } from '@mastra/libsql';
import type { ResumeApprovalWorkflowInput } from './types.js';
import { createChildLogger } from '../utils/logger.js';
import { ApprovalError } from '../utils/errors.js';

const log = createChildLogger('hitl-workflow');

/**
 * 审批 Step 唯一标识符
 */
export const APPROVAL_STEP_ID = 'approval-step';

/**
 * 审批 Step 输入参数 Zod Schema
 */
export const ApprovalStepInputSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  toolArgs: z.record(z.string(), z.unknown()).default({}),
  applicantId: z.string(),
  applicantName: z.string().optional(),
  leaderId: z.string(),
  leaderName: z.string().optional(),
  threadId: z.string(),
  timeoutMs: z.number().default(60000),
});

/**
 * 审批 Step 挂起载荷 (SuspendPayload) Zod Schema
 */
export const ApprovalStepSuspendSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  toolArgs: z.record(z.string(), z.unknown()).default({}),
  applicantId: z.string(),
  applicantName: z.string().optional(),
  leaderId: z.string(),
  leaderName: z.string().optional(),
  threadId: z.string(),
  timeoutMs: z.number().default(60000),
  suspendedAt: z.number(),
});

/**
 * 审批 Step 恢复数据 (ResumeData) Zod Schema
 */
export const ApprovalStepResumeSchema = z.object({
  approved: z.boolean(),
  deciderId: z.string(),
  deciderName: z.string().optional(),
  reason: z.string().optional(),
  decidedAt: z.number().default(() => Date.now()),
});

/**
 * 审批 Step 输出结果 Zod Schema
 */
export const ApprovalStepOutputSchema = z.object({
  toolCallId: z.string(),
  toolName: z.string(),
  approved: z.boolean(),
  status: z.enum(['approved', 'rejected', 'timed_out']),
  decision: ApprovalStepResumeSchema,
  toolArgs: z.record(z.string(), z.unknown()).default({}),
});

export type ApprovalStepInput = z.infer<typeof ApprovalStepInputSchema>;
export type ApprovalStepSuspend = z.infer<typeof ApprovalStepSuspendSchema>;
export type ApprovalStepResume = z.infer<typeof ApprovalStepResumeSchema>;
export type ApprovalStepOutput = z.infer<typeof ApprovalStepOutputSchema>;

/**
 * 创建原生 Mastra HITL 审批 Step
 */
export function createApprovalStep() {
  return createStep({
    id: APPROVAL_STEP_ID,
    inputSchema: ApprovalStepInputSchema,
    outputSchema: ApprovalStepOutputSchema,
    resumeSchema: ApprovalStepResumeSchema,
    suspendSchema: ApprovalStepSuspendSchema,
    execute: async ({ inputData, resumeData, suspendData, suspend }) => {
      // 1. 无 resumeData 时触发工作流原生挂起并持久化上下文
      if (!resumeData) {
        log.info(
          {
            toolCallId: inputData.toolCallId,
            toolName: inputData.toolName,
            leaderId: inputData.leaderId,
          },
          '高危工具触发 Mastra Workflow 原生挂起 (suspend)'
        );
        return await suspend({
          ...inputData,
          suspendedAt: Date.now(),
        });
      }

      // 2. 携带 resumeData 时恢复执行，支持 approved / rejected / timed_out 精确状态映射
      let status: 'approved' | 'rejected' | 'timed_out';
      if (resumeData.approved) {
        status = 'approved';
      } else if (
        resumeData.deciderId === 'system_timeout' ||
        resumeData.reason?.includes('超时')
      ) {
        status = 'timed_out';
      } else {
        status = 'rejected';
      }
      const toolCallId = inputData?.toolCallId ?? suspendData?.toolCallId ?? '';
      const toolName = inputData?.toolName ?? suspendData?.toolName ?? '';
      const toolArgs = inputData?.toolArgs ?? suspendData?.toolArgs ?? {};

      log.info(
        {
          toolCallId,
          status,
          deciderId: resumeData.deciderId,
        },
        'Mastra Workflow HITL 审批收到决议并恢复执行 (resume)'
      );

      return {
        toolCallId,
        toolName,
        approved: resumeData.approved,
        status,
        decision: resumeData,
        toolArgs,
      };
    },
  });
}

/**
 * 构建 Mastra HITL 人工在环审批原生工作流
 */
export function createHitlWorkflow(options?: { id?: string }) {
  const step = createApprovalStep();
  return createWorkflow({
    id: options?.id ?? 'kkbot-hitl-workflow',
    inputSchema: ApprovalStepInputSchema,
    outputSchema: ApprovalStepOutputSchema,
  })
    .then(step)
    .commit();
}

/**
 * 强类型 HITL Workflow 实例契约
 */
export type HitlWorkflow = ReturnType<typeof createHitlWorkflow>;

/**
 * 基于外部注入的 LibSQL Client 创建 Mastra LibSQLStore 持久化存储
 *
 * @param client 外部注入的 LibSQL Client (严禁硬编码路径)
 * @param storeId 存储 ID
 */
export function createHitlStorage(
  client: Client,
  storeId = 'kkbot-hitl-storage'
): LibSQLStore {
  if (!client) {
    throw new ApprovalError(
      'createHitlStorage 失败: 必须提供有效的 LibSQL Client 实例'
    );
  }
  return new LibSQLStore({ id: storeId, client });
}

/**
 * 恢复挂起的 Mastra HITL 工作流执行
 *
 * @param workflow 已绑定 Storage 的 HitlWorkflow 实例
 * @param input 恢复入参
 */
export async function resumeApprovalWorkflow(
  workflow: HitlWorkflow,
  input: ResumeApprovalWorkflowInput
): Promise<unknown> {
  const step = input.stepId ?? APPROVAL_STEP_ID;
  log.info(
    { runId: input.runId, step, approved: input.decision.approved },
    '正在调用 Workflow.resume 恢复审批流'
  );

  const run = await workflow.createRun({ runId: input.runId });
  const result = await run.resume({
    step,
    resumeData: input.decision,
  });

  log.info(
    { runId: input.runId, status: result.status },
    'Workflow.resume 恢复执行完毕'
  );

  return result;
}
