import type { Pool, PoolClient } from 'pg';
import { TASK_TRANSITIONS } from './types.js';
import type {
  AdoptAttemptInput,
  ClaimTaskInput,
  CreateTaskInput,
  FinishAttemptInput,
  ResolveUserWaitInput,
  StartAttemptInput,
  Task,
  TaskAttempt,
  TaskStatus,
  TaskStore,
  TaskVersion,
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
  execution_started_at: Date | null;
  execution_deadline: Date | null;
  current_attempt_id: string | null;
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
    executionStartedAt: row.execution_started_at?.getTime() ?? null,
    executionDeadline: row.execution_deadline?.getTime() ?? null,
    currentAttemptId: row.current_attempt_id,
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

/** 连接池由调用方持有；只做账本读写，不迁移、不发送、不调度、不记录正文。 */
export class PostgresTaskStore implements TaskStore {
  public constructor(private readonly pool: Pool) {}

  private async transaction<T>(operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      try {
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], '任务账本操作及回滚均失败');
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  /** 所有跨表变更先锁同一任务行；等待者读取提交后的状态与版本。 */
  private async lockTask(
    client: PoolClient,
    input: TaskVersion,
    statuses: TaskStatus[]
  ): Promise<Task | null> {
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
    input: AdoptAttemptInput
  ): Promise<Task | null> {
    const task = await this.lockTask(client, input, ['running']);
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
    const result = await this.pool.query<TaskRow>(
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
  }

  public async getTask(taskId: string): Promise<Task | null> {
    const result = await this.pool.query<TaskRow>('SELECT * FROM kairo.tasks WHERE task_id = $1', [
      taskId,
    ]);
    return result.rows[0] ? mapTask(result.rows[0]) : null;
  }

  public async claimTask(input: ClaimTaskInput): Promise<boolean> {
    if (input.executionMs <= 0) throw new Error('执行预算必须大于零');
    const result = await this.pool.query(
      `UPDATE kairo.tasks SET status = 'running', updated_at = $3,
         execution_started_at = $3, execution_deadline = $4
       WHERE task_id = $1 AND input_version = $2 AND status = 'queued'
         AND queue_deadline > $3`,
      [
        input.taskId,
        input.inputVersion,
        new Date(input.now),
        new Date(input.now + input.executionMs),
      ]
    );
    return result.rowCount === 1;
  }

  public async transitionTask(input: TransitionTaskInput): Promise<boolean> {
    const successors: readonly TaskStatus[] = TASK_TRANSITIONS[input.from];
    if (
      !successors?.includes(input.to) ||
      !['sending', 'completed', 'failed', 'cancelled', 'timed_out', 'send_unconfirmed'].includes(
        input.to
      )
    )
      return false;
    return this.transaction(async client => {
      const task = await this.lockTask(client, input, [input.from]);
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
          'SELECT * FROM kairo.user_waits WHERE task_id = $1 AND closed_at IS NULL FOR UPDATE',
          [input.taskId]
        );
        if (!result.rows[0]) throw new Error('等待中的任务缺少未关闭的员工等待记录');
        wait = mapWait(result.rows[0]);
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
      return updated.rowCount === 1;
    });
  }

  public async updateInputVersion(input: TaskVersion): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.tasks SET input_version = input_version + 1,
         current_attempt_id = NULL, updated_at = $3
       WHERE task_id = $1 AND input_version = $2
         AND ((status = 'queued' AND queue_deadline > $3)
           OR (status = 'running' AND execution_deadline > $3))`,
      [input.taskId, input.inputVersion, new Date(input.now)]
    );
    return result.rowCount === 1;
  }

  public async startAttempt(input: StartAttemptInput): Promise<TaskAttempt | null> {
    return this.transaction(async client => {
      const task = await this.lockTask(client, input, ['running']);
      if (
        !task ||
        task.currentAttemptId !== input.expectedAttemptId ||
        task.executionDeadline === null ||
        input.now >= task.executionDeadline
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
          new Date(input.now),
        ]
      );
      if (!inserted.rows[0]) return null;
      await client.query(
        'UPDATE kairo.tasks SET current_attempt_id = $2, updated_at = $3 WHERE task_id = $1',
        [input.taskId, input.attemptId, new Date(input.now)]
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

  public async adoptAttempt(input: AdoptAttemptInput): Promise<boolean> {
    return this.transaction(async client => {
      if (!(await this.lockAdoptableTask(client, input))) return false;
      await client.query('UPDATE kairo.task_attempts SET adopted = true WHERE attempt_id = $1', [
        input.attemptId,
      ]);
      await client.query(
        `UPDATE kairo.tasks SET status = 'ready_to_send', updated_at = $2 WHERE task_id = $1`,
        [input.taskId, new Date(input.now)]
      );
      return true;
    });
  }

  public async waitForUser(input: WaitForUserInput): Promise<boolean> {
    return this.transaction(async client => {
      const task = await this.lockAdoptableTask(client, input);
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
          new Date(input.now),
          new Date(input.now + 600_000),
          task.executionDeadline - input.now,
        ]
      );
      if (inserted.rowCount !== 1) return false;
      await client.query('UPDATE kairo.task_attempts SET adopted = true WHERE attempt_id = $1', [
        input.attemptId,
      ]);
      await client.query(
        `UPDATE kairo.tasks SET status = 'waiting_for_user', current_attempt_id = NULL,
           updated_at = $2 WHERE task_id = $1`,
        [input.taskId, new Date(input.now)]
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

  public async resolveUserWait(input: ResolveUserWaitInput): Promise<boolean> {
    return this.transaction(async client => {
      const task = await this.lockTask(client, input, ['waiting_for_user']);
      if (!task) return false;
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
      const wait = mapWait(row);
      await client.query(
        `UPDATE kairo.user_waits SET closed_at = $2, resolution = $3, answer_message_id = $4
         WHERE wait_id = $1 AND closed_at IS NULL`,
        [input.waitId, new Date(input.now), input.decision, input.answerMessage.messageId]
      );
      const accepted = input.decision === 'accepted';
      await client.query(
        `UPDATE kairo.tasks SET status = $2, updated_at = $3, ended_at = $4,
           execution_deadline = CASE WHEN $2 = 'running' THEN $5 ELSE execution_deadline END,
           current_attempt_id = NULL WHERE task_id = $1`,
        [
          input.taskId,
          accepted ? 'running' : 'cancelled',
          new Date(input.now),
          accepted ? null : new Date(input.now),
          new Date(input.now + wait.remainingExecutionMs),
        ]
      );
      return true;
    });
  }
}
