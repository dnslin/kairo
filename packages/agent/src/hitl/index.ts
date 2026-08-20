/**
 * @kkbot/agent/hitl: 双通道 HITL 人工在环审批状态机
 */

export { ApprovalManager } from './manager.js';
export { LeaderApprovalRouter } from './router.js';
export { StatefulApprovalMatcher } from './matcher.js';
export {
  createApprovalStep,
  createHitlWorkflow,
  createHitlStorage,
  resumeApprovalWorkflow,
  APPROVAL_STEP_ID,
  ApprovalStepInputSchema,
  ApprovalStepSuspendSchema,
  ApprovalStepResumeSchema,
  ApprovalStepOutputSchema,
  type HitlWorkflow,
} from './workflow.js';
export { initApprovalSchema, APPROVAL_SCHEMA_SQL } from './schema.js';
export type {
  ApprovalDecision,
  ApprovalManagerOptions,
  ApprovalMatcherResult,
  ApprovalNotification,
  ApprovalStatus,
  ApprovalTask,
  CreateApprovalTaskInput,
  LeaderApprovalRouterOptions,
  MatcherActionType,
  OrgRepositoryLike,
  ResolveApprovalTaskInput,
  ResumeApprovalWorkflowInput,
  StartApprovalWorkflowResult,
  StatefulApprovalMatcherOptions,
} from './types.js';
export type {
  ApprovalStepInput,
  ApprovalStepSuspend,
  ApprovalStepResume,
  ApprovalStepOutput,
} from './workflow.js';
