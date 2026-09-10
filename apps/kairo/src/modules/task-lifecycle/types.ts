import type { AppErrorType } from '../operability/errors.js';
import type { ContextScope, MessageKey } from '../private-chat-core/types.js';

/** collecting 只属于 message batch；五个终态没有出边。 */
export const TASK_TRANSITIONS = {
  queued: ['running', 'cancelled', 'timed_out'],
  running: ['waiting_for_user', 'ready_to_send', 'failed', 'cancelled', 'timed_out'],
  waiting_for_user: ['running', 'cancelled', 'timed_out'],
  ready_to_send: ['sending', 'cancelled', 'timed_out'],
  sending: ['completed', 'failed', 'cancelled', 'send_unconfirmed'],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
  send_unconfirmed: [],
} as const;

export type TaskStatus = keyof typeof TASK_TRANSITIONS;
export type TaskTerminalStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'timed_out'
  | 'send_unconfirmed';

export interface Task extends ContextScope {
  taskId: string;
  batchId: string;
  threadId: string;
  inputVersion: number;
  configDigest: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  queueDeadline: number;
  executionBudgetMs: number | null;
  queueNoticeRequired: boolean;
  executionStartedAt: number | null;
  executionDeadline: number | null;
  currentAttemptId: string | null;
  currentWaitId: string | null;
  endedAt: number | null;
}

export interface CreateTaskInput {
  taskId: string;
  batchId: string;
  configDigest: string;
  now: number;
  queueDeadline: number;
}

export interface EnqueueTaskInput extends CreateTaskInput {
  queueLimit: number;
}

export type EnqueueTaskResult =
  | { status: 'accepted'; task: Task }
  | { status: 'full' }
  | { status: 'stale' };

export interface TaskVersion {
  taskId: string;
  inputVersion: number;
  now: number;
}

export interface ClaimTaskInput extends Omit<TaskVersion, 'now'> {
  now: number | (() => number);
  executionMs: number;
}

export interface ResumeTaskInput extends Omit<TaskVersion, 'now'> {
  now: number | (() => number);
}

/** 领取、采用结果和员工等待必须走专用接口，不能用普通状态更新绕过。 */
export type TransitionTaskInput = TaskVersion & { idleSince?: number } & (
    | { from: 'running'; to: 'failed'; expectedAttemptId: string }
    | { from: TaskStatus; to: 'sending' | Exclude<TaskTerminalStatus, 'failed'> }
    | { from: Exclude<TaskStatus, 'running'>; to: 'failed' }
  );

export interface TaskAttempt {
  attemptId: string;
  taskId: string;
  inputVersion: number;
  runId: string;
  configDigest: string;
  startedAt: number;
  finishedAt: number | null;
  errorType: AppErrorType | null;
  adopted: boolean;
}

export interface StartAttemptInput extends TaskVersion {
  attemptId: string;
  runId: string;
  configDigest: string;
  /** 比较旧指针，防止两个 worker 同时创建替代尝试。 */
  expectedAttemptId: string | null;
}

export interface FinishAttemptInput {
  attemptId: string;
  finishedAt: number;
  errorType: AppErrorType | null;
}

export interface AdoptAttemptInput extends TaskVersion {
  attemptId: string;
}

export interface TaskOutputScope {
  taskId: string;
  inputVersion: number;
  contextVersion?: number;
  attemptId?: string;
  userWaitId?: string;
}

export type UserWaitResolution = 'accepted' | 'declined' | 'cancelled' | 'timed_out';

export interface UserWait {
  waitId: string;
  taskId: string;
  inputVersion: number;
  question: string;
  /** 由调用方指定的当前问题/缺失子问题标识，不是允许回答的词语列表。 */
  allowedQuestionIds: string[];
  createdAt: number;
  deadline: number;
  remainingExecutionMs: number;
  closedAt: number | null;
  resolution: UserWaitResolution | null;
  answerMessage: MessageKey | null;
}

export interface WaitForUserInput extends Omit<AdoptAttemptInput, 'now'> {
  now: number | (() => number);
  waitId: string;
  question: string;
  allowedQuestionIds: string[];
}

export interface ResolveUserWaitInput extends TaskVersion {
  waitId: string;
  answerMessage: MessageKey;
  decision: 'accepted' | 'declined';
}

/** 时间均为 Unix 毫秒；调用方传入时刻，存储不启动定时器或调度业务。 */
export interface TaskStore {
  /** 只从有效上下文内的非空 ready batch 创建；同一 batch 只能形成一个任务。 */
  createTask(input: CreateTaskInput): Promise<Task | null>;
  /** context 锁内裁决队列容量；重复批次返回首次任务或持久拒绝。 */
  enqueueTask(input: EnqueueTaskInput): Promise<EnqueueTaskResult>;
  listActiveTasks(): Promise<Task[]>;
  getTask(taskId: string): Promise<Task | null>;
  claimTask(input: ClaimTaskInput): Promise<Task | null>;
  /** 已同意的等待只有实际取得执行名额后才恢复预算。 */
  resumeTask(input: ResumeTaskInput): Promise<Task | null>;
  transitionTask(input: TransitionTaskInput): Promise<boolean>;
  /** 仅 queued/running 可改版本；不改变截止时间，不自动重跑任务。 */
  updateInputVersion(input: TaskVersion): Promise<boolean>;
  startAttempt(input: StartAttemptInput): Promise<TaskAttempt | null>;
  /** 即使任务已终止仍允许补记执行结束，但不能因此采用结果。 */
  finishAttempt(input: FinishAttemptInput): Promise<boolean>;
  getAttempt(attemptId: string): Promise<TaskAttempt | null>;
  adoptAttempt(input: AdoptAttemptInput): Promise<boolean>;
  waitForUser(input: WaitForUserInput): Promise<boolean>;
  getUserWait(waitId: string): Promise<UserWait | null>;
  getTaskWait(taskId: string): Promise<UserWait | null>;
  /** 同意只保存回答并关闭等待；拒绝取消任务，不进行自然语言同意判断。 */
  resolveUserWait(input: ResolveUserWaitInput): Promise<boolean>;
  /** 先锁有效 context 再锁 task；指定 userWaitId 时只交付当前未关闭且未到期的等待。 */
  withTaskOutput<T>(
    input: TaskOutputScope,
    output: (task: Task) => T
  ): Promise<{ value: T } | null>;
}
