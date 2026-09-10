import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../../db/transaction.js';
import { TASK_TRANSITIONS } from './types.js';
import { lockCurrentContext } from '../private-chat-core/context-lock.js';
import type {
  AdoptAnswerInput,
  AdoptAttemptInput,
  ClaimTaskInput,
  CreateTaskInput,
  EnqueueTaskInput,
  EnqueueTaskResult,
  FailRecoveryInput,
  FinishAttemptInput,
  ResolveUserWaitInput,
  ResumeTaskInput,
  StartAttemptInput,
  Task,
  TaskAttempt,
  TaskStatus,
  TaskStore,
  TaskVersion,
  TaskOutputScope,
  TransitionTaskInput,
  UserWait,
  WaitForUserInput,
} from './types.js';

type TaskRow = {
  task_id: string;
  batch_id: string;
  thread_id: string;
  employee_id: string;
  bot_id: string;
  session_id: string;
  input_version: number;
  config_digest: string;
  status: TaskStatus;
  created_at: Date;
  updated_at: Date;
  queue_deadline: Date;
  execution_budget_ms: string | null;
  queue_notice_required: boolean;
  execution_started_at: Date | null;
  execution_deadline: Date | null;
  current_attempt_id: string | null;
  current_wait_id: string | null;
  answer_text: string | null;
  recovery_used: boolean;
  ended_at: Date | null;
};

type AttemptRow = {
  attempt_id: string;
  task_id: string;
  input_version: number;
  run_id: string;
  config_digest: string;
  started_at: Date;
  finished_at: Date | null;
  error_type: TaskAttempt['errorType'];
  adopted: boolean;
};

type WaitRow = {
  wait_id: string;
  task_id: string;
  input_version: number;
  question: string;
  allowed_question_ids: string[];
  created_at: Date;
  deadline: Date;
  remaining_execution_ms: string;
  closed_at: Date | null;
  resolution: UserWait['resolution'];
  session_id: string;
  answer_message_id: string | null;
};

function mapTask(row: TaskRow): Task {
  return {
    taskId: row.task_id,
    batchId: row.batch_id,
    threadId: row.thread_id,
    employeeId: row.employee_id,
    botId: row.bot_id,
    sessionId: row.session_id,
    inputVersion: row.input_version,
    configDigest: row.config_digest,
    status: row.status,
    createdAt: row.created_at.getTime(),
    updatedAt: row.updated_at.getTime(),
    queueDeadline: row.queue_deadline.getTime(),
    executionBudgetMs: row.execution_budget_ms === null ? null : Number(row.execution_budget_ms),
    queueNoticeRequired: row.queue_notice_required,
    executionStartedAt: row.execution_started_at?.getTime() ?? null,
    executionDeadline: row.execution_deadline?.getTime() ?? null,
    currentAttemptId: row.current_attempt_id,
    currentWaitId: row.current_wait_id,
    answerText: row.answer_text,
    recoveryUsed: row.recovery_used,
    endedAt: row.ended_at?.getTime() ?? null,
  };
}

function mapAttempt(row: AttemptRow): TaskAttempt {
  return {
    attemptId: row.attempt_id,
    taskId: row.task_id,
    inputVersion: row.input_version,
    runId: row.run_id,
    configDigest: row.config_digest,
    startedAt: row.started_at.getTime(),
    finishedAt: row.finished_at?.getTime() ?? null,
    errorType: row.error_type,
    adopted: row.adopted,
  };
}

function mapWait(row: WaitRow): UserWait {
  return {
    waitId: row.wait_id,
    taskId: row.task_id,
    inputVersion: row.input_version,
    question: row.question,
    allowedQuestionIds: row.allowed_question_ids,
    createdAt: row.created_at.getTime(),
    deadline: row.deadline.getTime(),
    remainingExecutionMs: Number(row.remaining_execution_ms),
    closedAt: row.closed_at?.getTime() ?? null,
    resolution: row.resolution,
    answerMessage:
      row.answer_message_id === null
        ? null
        : {
            sessionId: row.session_id,
            messageId: row.answer_message_id,
          },
  };
}

/** 连接池由调用方持有；只做账本读写，保存已检查答案但不迁移、不发送、不写正式 Memory。 */
export class PostgresTaskStore implements TaskStore {
  public constructor(private readonly pool: Pool) {}

  /** 固定锁顺序为 context → task → attempt/wait，避免切换与状态推进交叉。 */
  private async lockTask(
    client: PoolClient,
    input: Pick<TaskVersion, 'taskId' | 'inputVersion'> & { contextVersion?: number },
    statuses: TaskStatus[],
    allowInvalid = false
  ): Promise<Task | null> {
    const context = await client.query<{ version: number; invalidated_at: Date | null }>(
      `SELECT c.version, c.invalidated_at FROM kairo.contexts c
       JOIN kairo.tasks t USING (thread_id) WHERE t.task_id = $1 FOR UPDATE OF c`,
      [input.taskId]
    );
    const row = context.rows[0];
    if (
      !row ||
      (!allowInvalid && row.invalidated_at !== null) ||
      (input.contextVersion !== undefined && input.contextVersion !== row.version)
    )
      return null;
    const result = await client.query<TaskRow>(
      `SELECT * FROM kairo.tasks
       WHERE task_id = $1 AND input_version = $2 AND status = ANY($3::text[])
       FOR UPDATE`,
      [input.taskId, input.inputVersion, statuses]
    );
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  private async lockAdoptableTask(
    client: PoolClient,
    input: AdoptAttemptInput,
    lockedTask?: Task
  ): Promise<Task | null> {
    const task = lockedTask ?? (await this.lockTask(client, input, ['running']));
    if (
      !task ||
      task.currentAttemptId !== input.attemptId ||
      task.executionDeadline === null ||
      input.now >= task.executionDeadline
    )
      return null;
    const result = await client.query(
      `SELECT attempt_id FROM kairo.task_attempts
       WHERE attempt_id = $1 AND task_id = $2 AND input_version = $3
         AND finished_at <= $4 AND error_type IS NULL AND NOT adopted
       FOR UPDATE`,
      [input.attemptId, input.taskId, input.inputVersion, new Date(input.now)]
    );
    return result.rowCount === 1 ? task : null;
  }

  public async createTask(input: CreateTaskInput): Promise<Task | null> {
    return withTransaction(this.pool, async client => {
      const owner = await client.query<{ thread_id: string }>(
        'SELECT thread_id FROM kairo.message_batches WHERE batch_id = $1',
        [input.batchId]
      );
      if (!owner.rows[0] || (await lockCurrentContext(client, owner.rows[0].thread_id)) === null)
        return null;
      const result = await client.query<TaskRow>(
        `INSERT INTO kairo.tasks
         (task_id, batch_id, thread_id, employee_id, bot_id, session_id,
          input_version, config_digest, status, created_at, updated_at, queue_deadline)
       SELECT $1, b.batch_id, b.thread_id, b.employee_id, b.bot_id, b.session_id,
              1, $3, 'queued', $4, $4, $5
       FROM kairo.message_batches b JOIN kairo.contexts c USING (thread_id)
       WHERE b.batch_id = $2 AND b.status = 'ready' AND c.invalidated_at IS NULL
         AND EXISTS (SELECT 1 FROM kairo.batch_messages m WHERE m.batch_id = b.batch_id)
       ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.taskId,
          input.batchId,
          input.configDigest,
          new Date(input.now),
          new Date(input.queueDeadline),
        ]
      );
      return result.rows[0] ? mapTask(result.rows[0]) : null;
    });
  }

  public async enqueueTask(input: EnqueueTaskInput): Promise<EnqueueTaskResult> {
    return withTransaction(this.pool, async client => {
      const owner = await client.query<{ thread_id: string }>(
        'SELECT thread_id FROM kairo.message_batches WHERE batch_id = $1',
        [input.batchId]
      );
      if (!owner.rows[0] || (await lockCurrentContext(client, owner.rows[0].thread_id)) === null)
        return { status: 'stale' };
      const batch = await client.query<{
        status: string;
        rejection_reason: string | null;
        bot_id: string;
        session_id: string;
        nonempty: boolean;
      }>(
        `SELECT b.status, b.rejection_reason, b.bot_id, b.session_id,
           EXISTS (SELECT 1 FROM kairo.batch_messages m WHERE m.batch_id = b.batch_id) AS nonempty
         FROM kairo.message_batches b WHERE b.batch_id = $1 FOR UPDATE`,
        [input.batchId]
      );
      const row = batch.rows[0];
      if (!row || row.status === 'discarded') return { status: 'stale' };
      const existing = await client.query<TaskRow>(
        'SELECT * FROM kairo.tasks WHERE batch_id = $1',
        [input.batchId]
      );
      if (existing.rows[0]) return { status: 'accepted', task: mapTask(existing.rows[0]) };
      if (row.status === 'rejected' && row.rejection_reason === 'queue_full')
        return { status: 'full' };
      if (row.status !== 'ready' || !row.nonempty) return { status: 'stale' };
      const counts = await client.query<{ queued: string; busy: boolean }>(
        `SELECT count(*) FILTER (WHERE status = 'queued') AS queued, count(*) > 0 AS busy
         FROM kairo.tasks WHERE bot_id = $1 AND session_id = $2
           AND status IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending')`,
        [row.bot_id, row.session_id]
      );
      const count = counts.rows[0]!;
      if (Number(count.queued) >= input.queueLimit) {
        await client.query(
          `UPDATE kairo.message_batches SET status = 'rejected', rejection_reason = 'queue_full'
           WHERE batch_id = $1`,
          [input.batchId]
        );
        return { status: 'full' };
      }
      const inserted = await client.query<TaskRow>(
        `INSERT INTO kairo.tasks
           (task_id, batch_id, thread_id, employee_id, bot_id, session_id, input_version,
            config_digest, status, created_at, updated_at, queue_deadline, queue_notice_required)
         SELECT $1, batch_id, thread_id, employee_id, bot_id, session_id, 1,
           $3, 'queued', $4, $4, $5, $6 FROM kairo.message_batches WHERE batch_id = $2
         RETURNING *`,
        [
          input.taskId,
          input.batchId,
          input.configDigest,
          new Date(input.now),
          new Date(input.queueDeadline),
          count.busy,
        ]
      );
      return { status: 'accepted', task: mapTask(inserted.rows[0]!) };
    });
  }

  public async listActiveTasks(): Promise<Task[]> {
    const result = await this.pool.query<TaskRow>(
      `SELECT t.* FROM kairo.tasks t JOIN kairo.contexts c USING (thread_id)
       WHERE c.invalidated_at IS NULL
         AND t.status IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending')
       ORDER BY t.created_at, t.task_id`
    );
    return result.rows.map(mapTask);
  }

  public async getTask(taskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>('SELECT * FROM kairo.tasks WHERE task_id = $1', [
      taskId,
    ]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  public async claimTask(input: ClaimTaskInput): Promise<Task | null> {
    if (input.executionMs <= 0) throw new Error('执行预算必须大于零');
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(client, input, ['queued']);
      if (!task) return null;
      const blocked = await client.query(
        `SELECT task_id FROM kairo.tasks WHERE bot_id = $1 AND session_id = $2
         AND task_id <> $3
         AND status IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending')
         AND (status <> 'queued' OR (created_at, task_id) < ($4, $3)) LIMIT 1`,
        [task.botId, task.sessionId, task.taskId, new Date(task.createdAt)]
      );
      if (blocked.rowCount !== 0) return null;
      const now = typeof input.now === 'function' ? input.now() : input.now;
      const result = await client.query<TaskRow>(
        `UPDATE kairo.tasks SET status = 'running', updated_at = $3,
         execution_started_at = $3, execution_deadline = $4, execution_budget_ms = $5
       WHERE task_id = $1 AND input_version = $2 AND status = 'queued'
         AND queue_deadline > $3 RETURNING *`,
        [
          input.taskId,
          input.inputVersion,
          new Date(now),
          new Date(now + input.executionMs),
          input.executionMs,
        ]
      );
      return result.rows[0] ? mapTask(result.rows[0]) : null;
    });
  }

  public async resumeTask(input: ResumeTaskInput): Promise<Task | null> {
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(client, input, ['waiting_for_user']);
      if (!task) return null;
      const wait = await client.query<WaitRow>(
        `SELECT * FROM kairo.user_waits
         WHERE wait_id = $1 AND task_id = $2 AND input_version = $3 FOR UPDATE`,
        [task.currentWaitId, input.taskId, input.inputVersion]
      );
      const row = wait.rows[0];
      if (!row || row.resolution !== 'accepted' || row.input_version !== input.inputVersion)
        return null;
      const now = typeof input.now === 'function' ? input.now() : input.now;
      const result = await client.query<TaskRow>(
        `UPDATE kairo.tasks SET status = 'running', updated_at = $2,
           execution_deadline = $3, current_attempt_id = NULL WHERE task_id = $1 RETURNING *`,
        [input.taskId, new Date(now), new Date(now + Number(row.remaining_execution_ms))]
      );
      return result.rows[0] ? mapTask(result.rows[0]) : null;
    });
  }

  public async transitionTask(input: TransitionTaskInput): Promise<boolean> {
    const successors: readonly TaskStatus[] = TASK_TRANSITIONS[input.from];
    if (
      !successors?.includes(input.to) ||
      (input.from === 'ready_to_send' && input.to === 'failed') ||
      !['sending', 'completed', 'failed', 'cancelled', 'timed_out', 'send_unconfirmed'].includes(
        input.to
      )
    )
      return false;
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(
        client,
        input,
        [input.from],
        input.to === 'cancelled' || input.to === 'timed_out'
      );
      if (!task) return false;
      // 执行失败只结束发出失败的当前尝试；整任务取消与发送结果不绑定此指针。
      if (
        input.from === 'running' &&
        input.to === 'failed' &&
        (!input.expectedAttemptId || task.currentAttemptId !== input.expectedAttemptId)
      )
        return false;
      let wait: UserWait | null = null;
      if (task.status === 'waiting_for_user') {
        const result = await client.query<WaitRow>(
          `SELECT * FROM kairo.user_waits
           WHERE wait_id = $1 AND task_id = $2 AND input_version = $3 FOR UPDATE`,
          [task.currentWaitId, input.taskId, input.inputVersion]
        );
        if (!result.rows[0]) throw new Error('等待中的任务缺少员工等待记录');
        wait = mapWait(result.rows[0]);
        if (
          wait.resolution !== null &&
          (wait.resolution !== 'accepted' || input.to !== 'cancelled')
        )
          return false;
      }
      const deadline =
        task.status === 'queued'
          ? task.queueDeadline
          : wait
            ? wait.deadline
            : task.executionDeadline;
      if (input.to === 'timed_out' && (deadline === null || input.now < deadline)) return false;
      if (input.to === 'sending' && (deadline === null || input.now >= deadline)) return false;
      if (wait) {
        await client.query(
          `UPDATE kairo.user_waits SET closed_at = $2, resolution = $3
           WHERE wait_id = $1 AND closed_at IS NULL`,
          [wait.waitId, new Date(input.now), input.to]
        );
      }
      const updated = await client.query(
        `UPDATE kairo.tasks SET status = $4, updated_at = $5, ended_at = $6
         WHERE task_id = $1 AND input_version = $2 AND status = $3`,
        [
          input.taskId,
          input.inputVersion,
          input.from,
          input.to,
          new Date(input.now),
          input.to === 'sending' ? null : new Date(input.now),
        ]
      );
      if (updated.rowCount === 1 && input.to !== 'sending') {
        await this.recordIdleSince(client, task.threadId, input.idleSince ?? input.now);
      }
      return updated.rowCount === 1;
    });
  }

  public async cancelUnfinished(botId: string, now: number): Promise<void> {
    await withTransaction(this.pool, async client => {
      // 先按稳定顺序锁住本 Bot 的全部有效 context，再锁任务；不创建或切换 context。
      const contexts = await client.query<{ thread_id: string }>(
        `SELECT thread_id FROM kairo.contexts
         WHERE bot_id = $1 AND invalidated_at IS NULL ORDER BY thread_id FOR UPDATE`,
        [botId]
      );
      if (contexts.rows.length === 0) return;
      const threadIds = contexts.rows.map(row => row.thread_id);
      const tasks = await client.query<{ task_id: string; thread_id: string }>(
        `SELECT task_id, thread_id FROM kairo.tasks
         WHERE thread_id = ANY($1::text[])
           AND status IN ('queued', 'running', 'waiting_for_user', 'ready_to_send', 'sending')
         ORDER BY thread_id, task_id FOR UPDATE`,
        [threadIds]
      );
      const taskIds = tasks.rows.map(row => row.task_id);
      const at = new Date(now);
      if (taskIds.length > 0) {
        await client.query(
          `UPDATE kairo.user_waits SET closed_at = $2, resolution = 'cancelled'
           WHERE task_id = ANY($1::text[]) AND closed_at IS NULL`,
          [taskIds, at]
        );
        await client.query(
          `UPDATE kairo.tasks SET status = 'cancelled', updated_at = $2, ended_at = $2
           WHERE task_id = ANY($1::text[])`,
          [taskIds, at]
        );
      }
      const batches = await client.query<{ thread_id: string }>(
        `UPDATE kairo.message_batches b SET
           status = CASE WHEN b.status = 'rejected' THEN b.status ELSE 'discarded' END,
           settled_at = COALESCE(b.settled_at, $2)
         WHERE b.thread_id = ANY($1::text[]) AND
           (b.status = 'collecting'
             OR (b.status = 'ready' AND NOT EXISTS
               (SELECT 1 FROM kairo.tasks t WHERE t.batch_id = b.batch_id))
             OR (b.status = 'rejected' AND b.settled_at IS NULL))
         RETURNING b.thread_id`,
        [threadIds, at]
      );
      const affected = new Set(tasks.rows.map(row => row.thread_id));
      for (const batch of batches.rows) affected.add(batch.thread_id);
      if (affected.size > 0) {
        await client.query(
          `UPDATE kairo.contexts SET idle_since = GREATEST(idle_since, $2)
           WHERE thread_id = ANY($1::text[]) AND invalidated_at IS NULL`,
          [[...affected], at]
        );
      }
    });
  }

  public async failRecovery(input: FailRecoveryInput): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(client, input, ['running', 'ready_to_send', 'sending']);
      const now = typeof input.now === 'function' ? input.now() : input.now;
      if (!task) return false;
      if (task.status === 'running' ? !task.recoveryUsed : task.answerText !== null) return false;
      // 已触发发送不按执行截止推断结果；缺正文是业务恢复失败，不改 Driver 原生事实。
      if (
        task.status !== 'sending' &&
        (task.executionDeadline === null || now >= task.executionDeadline)
      )
        return false;
      await client.query(
        `UPDATE kairo.tasks SET status = 'failed', updated_at = $2, ended_at = $2
         WHERE task_id = $1`,
        [input.taskId, new Date(now)]
      );
      await this.recordIdleSince(client, task.threadId, now);
      return true;
    });
  }

  public async updateInputVersion(input: TaskVersion): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      if (!(await this.lockTask(client, input, ['queued', 'running']))) return false;
      const result = await client.query(
        `UPDATE kairo.tasks SET input_version = input_version + 1,
         current_attempt_id = NULL, current_wait_id = NULL, answer_text = NULL, updated_at = $3
       WHERE task_id = $1 AND input_version = $2
         AND ((status = 'queued' AND queue_deadline > $3)
           OR (status = 'running' AND execution_deadline > $3))`,
        [input.taskId, input.inputVersion, new Date(input.now)]
      );
      return result.rowCount === 1;
    });
  }

  public async startAttempt(input: StartAttemptInput): Promise<TaskAttempt | null> {
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(client, input, ['running']);
      const now = typeof input.now === 'function' ? input.now() : input.now;
      if (
        !task ||
        task.currentAttemptId !== input.expectedAttemptId ||
        (input.recovery === true && task.recoveryUsed) ||
        task.executionDeadline === null ||
        now >= task.executionDeadline
      )
        return null;
      const inserted = await client.query<AttemptRow>(
        `INSERT INTO kairo.task_attempts
           (attempt_id, task_id, input_version, run_id, config_digest, started_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (attempt_id) DO NOTHING RETURNING *`,
        [
          input.attemptId,
          input.taskId,
          input.inputVersion,
          input.runId,
          input.configDigest,
          new Date(now),
        ]
      );
      if (!inserted.rows[0]) return null;
      await client.query(
        `UPDATE kairo.tasks SET current_attempt_id = $2, updated_at = $3,
           recovery_used = recovery_used OR $4 WHERE task_id = $1`,
        [input.taskId, input.attemptId, new Date(now), input.recovery === true]
      );
      return mapAttempt(inserted.rows[0]);
    });
  }

  public async finishAttempt(input: FinishAttemptInput): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.task_attempts SET finished_at = $2, error_type = $3
       WHERE attempt_id = $1 AND finished_at IS NULL AND started_at <= $2`,
      [input.attemptId, new Date(input.finishedAt), input.errorType]
    );
    return result.rowCount === 1;
  }

  public async getAttempt(attemptId: string): Promise<TaskAttempt | null> {
    const result = await this.pool.query<AttemptRow>(
      'SELECT * FROM kairo.task_attempts WHERE attempt_id = $1',
      [attemptId]
    );
    return result.rows[0] ? mapAttempt(result.rows[0]) : null;
  }

  public async adoptAttempt(input: AdoptAnswerInput): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      if (!(await this.lockAdoptableTask(client, input))) return false;
      await client.query('UPDATE kairo.task_attempts SET adopted = true WHERE attempt_id = $1', [
        input.attemptId,
      ]);
      await client.query(
        `UPDATE kairo.tasks SET status = 'ready_to_send', updated_at = $2,
           answer_text = $3 WHERE task_id = $1`,
        [input.taskId, new Date(input.now), input.answerText]
      );
      return true;
    });
  }

  public async waitForUser(input: WaitForUserInput): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const locked = await this.lockTask(client, input, ['running']);
      if (!locked) return false;
      const now = typeof input.now === 'function' ? input.now() : input.now;
      const task = await this.lockAdoptableTask(client, { ...input, now }, locked);
      if (!task || task.executionDeadline === null) return false;
      const inserted = await client.query(
        `INSERT INTO kairo.user_waits
           (wait_id, task_id, bot_id, session_id, input_version, question,
            allowed_question_ids, created_at, deadline, remaining_execution_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT DO NOTHING`,
        [
          input.waitId,
          input.taskId,
          task.botId,
          task.sessionId,
          input.inputVersion,
          input.question,
          input.allowedQuestionIds,
          new Date(now),
          new Date(now + 600_000),
          task.executionDeadline - now,
        ]
      );
      if (inserted.rowCount !== 1) return false;
      await client.query('UPDATE kairo.task_attempts SET adopted = true WHERE attempt_id = $1', [
        input.attemptId,
      ]);
      await client.query(
        `UPDATE kairo.tasks SET status = 'waiting_for_user', current_attempt_id = NULL,
           current_wait_id = $3, updated_at = $2 WHERE task_id = $1`,
        [input.taskId, new Date(now), input.waitId]
      );
      return true;
    });
  }

  public async getUserWait(waitId: string): Promise<UserWait | null> {
    const result = await this.pool.query<WaitRow>(
      'SELECT * FROM kairo.user_waits WHERE wait_id = $1',
      [waitId]
    );
    return result.rows[0] ? mapWait(result.rows[0]) : null;
  }

  public async getTaskWait(taskId: string): Promise<UserWait | null> {
    const result = await this.pool.query<WaitRow>(
      `SELECT w.* FROM kairo.tasks t JOIN kairo.user_waits w
         ON w.wait_id = t.current_wait_id AND w.task_id = t.task_id
           AND w.input_version = t.input_version
       WHERE t.task_id = $1`,
      [taskId]
    );
    return result.rows[0] ? mapWait(result.rows[0]) : null;
  }

  public async resolveUserWait(input: ResolveUserWaitInput): Promise<boolean> {
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(client, input, ['waiting_for_user']);
      if (!task || task.currentWaitId !== input.waitId) return false;
      // 不同 Bot 的任务行不同；先锁回答，再以新语句快照检查它是否已被消费。
      const answer = await client.query(
        `SELECT message_id FROM kairo.raw_messages
         WHERE session_id = $1 AND message_id = $2 FOR UPDATE`,
        [input.answerMessage.sessionId, input.answerMessage.messageId]
      );
      if (answer.rowCount !== 1) return false;
      const result = await client.query<WaitRow>(
        `SELECT w.* FROM kairo.user_waits w JOIN kairo.raw_messages r
           ON r.session_id = w.session_id AND r.message_id = $5
         WHERE w.wait_id = $1 AND w.task_id = $2 AND w.input_version = $3
           AND w.closed_at IS NULL AND w.deadline > $4
           AND r.session_id = $6 AND r.employee_id = $7 AND r.direction = 'inbound'
           AND r.observed_at >= w.created_at AND r.observed_at <= $4
           AND NOT EXISTS (SELECT 1 FROM kairo.user_waits used
             WHERE used.session_id = r.session_id AND used.answer_message_id = r.message_id)
         FOR UPDATE OF w`,
        [
          input.waitId,
          input.taskId,
          input.inputVersion,
          new Date(input.now),
          input.answerMessage.messageId,
          input.answerMessage.sessionId,
          task.employeeId,
        ]
      );
      const row = result.rows[0];
      if (!row) return false;
      await client.query(
        `UPDATE kairo.user_waits SET closed_at = $2, resolution = $3, answer_message_id = $4
         WHERE wait_id = $1 AND closed_at IS NULL`,
        [input.waitId, new Date(input.now), input.decision, input.answerMessage.messageId]
      );
      const accepted = input.decision === 'accepted';
      await client.query(
        `UPDATE kairo.tasks SET status = $2, updated_at = $3, ended_at = $4,
           current_attempt_id = NULL WHERE task_id = $1`,
        [
          input.taskId,
          accepted ? 'waiting_for_user' : 'cancelled',
          new Date(input.now),
          accepted ? null : new Date(input.now),
        ]
      );
      if (!accepted) await this.recordIdleSince(client, task.threadId, input.now);
      return true;
    });
  }

  private async recordIdleSince(client: PoolClient, threadId: string, now: number): Promise<void> {
    await client.query(
      `UPDATE kairo.contexts SET idle_since = GREATEST(idle_since, $2)
       WHERE thread_id = $1 AND invalidated_at IS NULL`,
      [threadId, new Date(now)]
    );
  }

  public async withTaskOutput<T>(
    input: TaskOutputScope,
    output: (task: Task) => T
  ): Promise<{ value: T } | null> {
    return withTransaction(this.pool, async client => {
      const task = await this.lockTask(
        client,
        input,
        Object.keys(TASK_TRANSITIONS) as TaskStatus[]
      );
      if (!task || (input.attemptId !== undefined && input.attemptId !== task.currentAttemptId))
        return null;
      if (input.userWaitId !== undefined) {
        if (task.status !== 'waiting_for_user' || task.currentWaitId !== input.userWaitId)
          return null;
        const wait = await client.query<Pick<WaitRow, 'deadline'>>(
          `SELECT deadline FROM kairo.user_waits
           WHERE wait_id = $1 AND task_id = $2 AND input_version = $3
             AND closed_at IS NULL FOR UPDATE`,
          [input.userWaitId, input.taskId, input.inputVersion]
        );
        // 在全部锁和数据库读取完成后采样，检查到同步交付之间不再 await。
        if (!wait.rows[0] || wait.rows[0].deadline.getTime() <= Date.now()) return null;
      }
      return { value: output(task) };
    });
  }
}
