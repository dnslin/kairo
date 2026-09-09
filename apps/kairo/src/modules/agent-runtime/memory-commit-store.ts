import type { Pool } from 'pg';

export type MemoryCommitStatus = 'pending' | 'saved' | 'observed';

export interface MemoryCommit {
  taskId: string;
  threadId: string;
  employeeId: string;
  question: string;
  answer: string;
  deliveredAt: number;
  userMessageId: string;
  assistantMessageId: string;
  status: MemoryCommitStatus;
  createdAt: number;
  savedAt: number | null;
  observedAt: number | null;
}

type MemoryCommitRow = {
  task_id: string;
  thread_id: string;
  employee_id: string;
  question: string;
  answer: string;
  delivered_at: Date;
  status: MemoryCommitStatus;
  created_at: Date;
  saved_at: Date | null;
  observed_at: Date | null;
};

function mapCommit(row: MemoryCommitRow): MemoryCommit {
  return {
    taskId: row.task_id,
    threadId: row.thread_id,
    employeeId: row.employee_id,
    question: row.question,
    answer: row.answer,
    deliveredAt: row.delivered_at.getTime(),
    userMessageId: JSON.stringify([row.thread_id, row.task_id, 'user']),
    assistantMessageId: JSON.stringify([row.thread_id, row.task_id, 'assistant']),
    status: row.status,
    createdAt: row.created_at.getTime(),
    savedAt: row.saved_at?.getTime() ?? null,
    observedAt: row.observed_at?.getTime() ?? null,
  };
}

/** 连接池由调用方持有；只保存提交进度，不调用 Memory、不调度、不记录正文。 */
export class PostgresMemoryCommitStore {
  public constructor(private readonly pool: Pool) {}

  public async createCommit(taskId: string, now: number): Promise<MemoryCommit | null> {
    await this.pool.query(
      `INSERT INTO kairo.memory_commits (task_id, status, created_at)
       SELECT task_id, 'pending', $2 FROM kairo.formal_answers WHERE task_id = $1
       ON CONFLICT (task_id) DO NOTHING`,
      [taskId, new Date(now)]
    );
    // 独立语句取得新快照，保证并发首次插入提交后，冲突方仍能读到完整原记录。
    return this.getCommit(taskId);
  }

  public async getCommit(taskId: string): Promise<MemoryCommit | null> {
    const result = await this.pool.query<MemoryCommitRow>(
      `SELECT c.task_id, t.thread_id, t.employee_id, a.question, a.answer, a.delivered_at,
         c.status, c.created_at, c.saved_at, c.observed_at
       FROM kairo.memory_commits c
       JOIN kairo.formal_answers a ON a.task_id = c.task_id
       JOIN kairo.tasks t ON t.task_id = a.task_id
       WHERE c.task_id = $1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? mapCommit(row) : null;
  }

  public async advanceCommit(
    taskId: string,
    from: 'pending' | 'saved',
    to: 'saved' | 'observed',
    now: number
  ): Promise<boolean> {
    if (!((from === 'pending' && to === 'saved') || (from === 'saved' && to === 'observed'))) {
      return false;
    }
    const result = await this.pool.query(
      `UPDATE kairo.memory_commits
       SET status = $3,
         saved_at = CASE WHEN $3 = 'saved' THEN $4 ELSE saved_at END,
         observed_at = CASE WHEN $3 = 'observed' THEN $4 ELSE observed_at END
       WHERE task_id = $1 AND status = $2`,
      [taskId, from, to, new Date(now)]
    );
    return result.rowCount === 1;
  }
}
