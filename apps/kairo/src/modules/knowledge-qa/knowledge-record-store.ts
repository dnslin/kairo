import type { Pool, PoolClient } from 'pg';
import type { AgentAnswer } from './answer-schema.js';

/** 原始 Tool 结果仅用于业务审计，不传入普通日志或正式 Memory。 */
export type KnowledgeJson =
  | null
  | boolean
  | number
  | string
  | KnowledgeJson[]
  | { [key: string]: KnowledgeJson };
export type KnowledgeResultCategory =
  | 'found'
  | 'empty'
  | 'format_error'
  | 'service_error'
  | 'auth_error'
  | 'parameter_error'
  | 'cancelled'
  | 'timeout';

export interface RecordPage {
  limit: number;
  offset: number;
}

export interface KnowledgeEvidenceInput {
  evidenceId: string;
  documentId: string;
  documentName: string;
  chunkId: string;
  content: string;
  /** 未知物理页码必须为 null，不能从 DOCX positions 推算。 */
  pageNumbers: number[] | null;
  positions: number[][] | null;
  similarity: number | null;
  conflict: boolean;
}

export interface KnowledgeEvidence extends KnowledgeEvidenceInput {
  taskId: string;
  queryId: string;
  position: number;
}

export interface KnowledgeQuery {
  queryId: string;
  taskId: string;
  attemptId: string;
  bootId: string;
  toolId: string;
  /** 同 task 内的调用次序，由 Tool 调用方分配，不由完成先后决定。 */
  callIndex: number;
  query: string;
  datasetId: string;
  startedAt: number;
  durationMs: number;
  resultCategory: KnowledgeResultCategory;
  rawResult: KnowledgeJson;
}

export interface KnowledgeQueryInput extends KnowledgeQuery {
  evidence: KnowledgeEvidenceInput[];
}

export interface FormalAnswer {
  taskId: string;
  operationId: string;
  bootId: string;
  nativeMessageId: string;
  question: string;
  answer: string;
  deliveredAt: number;
}

export interface FormalAnswerInput extends Omit<FormalAnswer, 'nativeMessageId'> {
  evidenceIds: string[];
}

export interface AnswerCheck {
  taskId: string;
  attemptId: string;
  inputVersion: number;
  answer: AgentAnswer | null;
  diagnostics: string[];
}

export interface PendingFormalAnswer {
  taskId: string;
  attemptId: string;
  inputVersion: number;
  operationId: string;
  batchId: string;
}

export interface FeedbackInput {
  feedbackId: string;
  taskId: string;
  text: string;
  suggestedAnswer: string | null;
  createdAt: number;
}

export interface Feedback extends FeedbackInput {
  verification: 'unverified';
}

type QueryRow = Omit<KnowledgeQuery, 'startedAt'> & { startedAt: Date };
type AnswerRow = Omit<FormalAnswer, 'deliveredAt'> & { deliveredAt: Date };
type FeedbackRow = Omit<Feedback, 'createdAt'> & { createdAt: Date };

const queryColumns = `query_id AS "queryId", task_id AS "taskId", attempt_id AS "attemptId",
  boot_id AS "bootId", tool_id AS "toolId", call_index AS "callIndex", query,
  dataset_id AS "datasetId", started_at AS "startedAt", duration_ms AS "durationMs",
  result_category AS "resultCategory", raw_result AS "rawResult"`;
const evidenceColumns = `e.evidence_id AS "evidenceId", e.task_id AS "taskId", e.query_id AS "queryId",
  e.position, e.document_id AS "documentId", e.document_name AS "documentName",
  e.chunk_id AS "chunkId", e.content, e.page_numbers AS "pageNumbers", e.positions,
  e.similarity, e.conflict`;
const answerColumns = `task_id AS "taskId", operation_id AS "operationId", boot_id AS "bootId",
  native_message_id AS "nativeMessageId", question, answer, delivered_at AS "deliveredAt"`;
const feedbackColumns = `feedback_id AS "feedbackId", task_id AS "taskId", text,
  suggested_answer AS "suggestedAnswer", verification, created_at AS "createdAt"`;

function mapQuery(row: QueryRow): KnowledgeQuery {
  return { ...row, startedAt: row.startedAt.getTime() };
}
function mapFeedback(row: FeedbackRow): Feedback {
  return { ...row, createdAt: row.createdAt.getTime() };
}

/** 连接池属于调用方；本模块不执行检索、答案裁决、发送、Memory 或清理任务。 */
export class PostgresKnowledgeRecordStore {
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
          throw new AggregateError([error, rollbackError], '知识账本操作及回滚均失败');
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  public async recordQuery(input: KnowledgeQueryInput): Promise<void> {
    await this.transaction(async client => {
      await client.query(
        `INSERT INTO kairo.knowledge_queries
         (query_id, task_id, attempt_id, boot_id, tool_id, call_index, query, dataset_id, started_at,
          duration_ms, result_category, raw_result)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
        [
          input.queryId,
          input.taskId,
          input.attemptId,
          input.bootId,
          input.toolId,
          input.callIndex,
          input.query,
          input.datasetId,
          new Date(input.startedAt),
          input.durationMs,
          input.resultCategory,
          JSON.stringify(input.rawResult),
        ]
      );
      for (const [position, evidence] of input.evidence.entries()) {
        await client.query(
          `INSERT INTO kairo.knowledge_evidence
           (evidence_id,task_id,query_id,position,document_id,document_name,chunk_id,content,page_numbers,positions,similarity,conflict)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
          [
            evidence.evidenceId,
            input.taskId,
            input.queryId,
            position,
            evidence.documentId,
            evidence.documentName,
            evidence.chunkId,
            evidence.content,
            evidence.pageNumbers,
            JSON.stringify(evidence.positions),
            evidence.similarity,
            evidence.conflict,
          ]
        );
      }
    });
  }

  public async getQuery(queryId: string): Promise<KnowledgeQuery | null> {
    const result = await this.pool.query<QueryRow>(
      `SELECT ${queryColumns} FROM kairo.knowledge_queries WHERE query_id=$1`,
      [queryId]
    );
    return result.rows[0] ? mapQuery(result.rows[0]) : null;
  }

  public async listQueries(taskId: string, page: RecordPage): Promise<KnowledgeQuery[]> {
    const result = await this.pool.query<QueryRow>(
      `SELECT ${queryColumns} FROM kairo.knowledge_queries WHERE task_id=$1
       ORDER BY call_index LIMIT $2 OFFSET $3`,
      [taskId, page.limit, page.offset]
    );
    return result.rows.map(mapQuery);
  }

  /** 调用方保证同 task 的旧执行已经 settled；恢复 attempt 不重置查询次序。 */
  public async getLastCallIndex(taskId: string): Promise<number> {
    const result = await this.pool.query<{ callIndex: number }>(
      `SELECT COALESCE(MAX(call_index), 0) AS "callIndex"
       FROM kairo.knowledge_queries WHERE task_id=$1`,
      [taskId]
    );
    return result.rows[0]!.callIndex;
  }

  public async getEvidence(evidenceId: string): Promise<KnowledgeEvidence | null> {
    const result = await this.pool.query<KnowledgeEvidence>(
      `SELECT ${evidenceColumns} FROM kairo.knowledge_evidence e WHERE e.evidence_id=$1`,
      [evidenceId]
    );
    return result.rows[0] ?? null;
  }

  public async listEvidence(taskId: string, page: RecordPage): Promise<KnowledgeEvidence[]> {
    const result = await this.pool.query<KnowledgeEvidence>(
      `SELECT ${evidenceColumns} FROM kairo.knowledge_queries q
       JOIN kairo.knowledge_evidence e ON e.query_id=q.query_id
       WHERE q.task_id=$1 ORDER BY q.call_index,e.position LIMIT $2 OFFSET $3`,
      [taskId, page.limit, page.offset]
    );
    return result.rows;
  }

  /** 一次尝试只保存一次裁决；拒绝时仅保存固定诊断，不保存可恢复的模型原文。 */
  public async recordAnswerCheck(input: AnswerCheck): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.task_attempts SET answer_result=$4::jsonb, answer_diagnostics=$5
       WHERE task_id=$1 AND attempt_id=$2 AND input_version=$3
         AND finished_at IS NULL AND answer_diagnostics IS NULL`,
      [
        input.taskId,
        input.attemptId,
        input.inputVersion,
        input.answer === null ? null : JSON.stringify(input.answer),
        input.diagnostics,
      ]
    );
    return result.rowCount === 1;
  }

  public async getAnswerCheck(attemptId: string): Promise<AnswerCheck | null> {
    const result = await this.pool.query<AnswerCheck>(
      `SELECT task_id AS "taskId", attempt_id AS "attemptId", input_version AS "inputVersion",
         answer_result AS answer, answer_diagnostics AS diagnostics
       FROM kairo.task_attempts WHERE attempt_id=$1 AND answer_diagnostics IS NOT NULL`,
      [attemptId]
    );
    return result.rows[0] ?? null;
  }

  /** 只补已经确认完成的业务记录，不重新执行任务或发送消息。 */
  public async listPendingFormalAnswers(
    botId: string,
    page: RecordPage
  ): Promise<PendingFormalAnswer[]> {
    const result = await this.pool.query<PendingFormalAnswer>(
      `SELECT t.task_id AS "taskId", t.current_attempt_id AS "attemptId",
         t.input_version AS "inputVersion", t.batch_id AS "batchId", d.operation_id AS "operationId"
       FROM kairo.tasks t JOIN kairo.task_attempts a ON a.attempt_id=t.current_attempt_id
       JOIN kairo.send_dispatches d ON d.task_id=t.task_id AND d.purpose='final'
       WHERE t.bot_id=$1 AND t.status='completed' AND a.adopted AND a.answer_result IS NOT NULL
         AND d.status='delivered' AND NOT EXISTS
           (SELECT 1 FROM kairo.formal_answers f WHERE f.task_id=t.task_id)
       ORDER BY t.created_at,t.task_id LIMIT $2 OFFSET $3`,
      [botId, page.limit, page.offset]
    );
    return result.rows;
  }

  /** T21 已确认送达后，按当前采用链落正式回答；重复收尾不覆盖首次事实。 */
  public async recordCheckedDelivery(input: {
    taskId: string;
    attemptId: string;
    inputVersion: number;
    operationId: string;
    bootId: string;
    question: string;
  }): Promise<boolean> {
    return this.transaction(async client => {
      const identity = await client.query<{ threadId: string }>(
        'SELECT thread_id AS "threadId" FROM kairo.tasks WHERE task_id=$1',
        [input.taskId]
      );
      const threadId = identity.rows[0]?.threadId;
      if (!threadId) return false;
      // completed 是 T21 在有效context内确认的不可变事实；之后/new不能删除这段历史。
      // 此处仅补业务回答，不向IM发送、不提交Memory，仍遵循context→task锁顺序。
      await client.query('SELECT thread_id FROM kairo.contexts WHERE thread_id=$1 FOR UPDATE', [
        threadId,
      ]);
      const result = await client.query<{
        answer: AgentAnswer;
        deliveredAt: Date;
        messageId: string;
      }>(
        `SELECT a.answer_result AS answer, d.result_at AS "deliveredAt", s.message_id AS "messageId"
         FROM kairo.tasks t
         JOIN kairo.task_attempts a ON a.task_id=t.task_id AND a.attempt_id=t.current_attempt_id
           AND a.input_version=t.input_version
         JOIN kairo.send_dispatches d ON d.task_id=t.task_id AND d.purpose='final'
         JOIN kairo.send_operations s ON s.operation_id=d.operation_id
           AND s.target_session_id=t.session_id
         WHERE t.task_id=$1 AND a.attempt_id=$2 AND t.input_version=$3 AND d.operation_id=$4
           AND t.status='completed' AND a.adopted AND a.error_type IS NULL
           AND a.answer_result IS NOT NULL AND a.answer_result->>'answer'=t.answer_text
           AND d.status='delivered' AND d.result_at IS NOT NULL
           AND s.status='delivered' AND s.message_id IS NOT NULL
         FOR UPDATE OF t`,
        [input.taskId, input.attemptId, input.inputVersion, input.operationId]
      );
      const delivered = result.rows[0];
      if (!delivered) return false;
      const inserted = await client.query(
        `INSERT INTO kairo.formal_answers
         (task_id,operation_id,boot_id,native_message_id,question,answer,delivered_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (task_id) DO NOTHING`,
        [
          input.taskId,
          input.operationId,
          input.bootId,
          delivered.messageId,
          input.question,
          delivered.answer.answer,
          delivered.deliveredAt,
        ]
      );
      if (inserted.rowCount === 0) {
        const previous = await client.query(
          'SELECT 1 FROM kairo.formal_answers WHERE task_id=$1 AND operation_id=$2 AND answer=$3',
          [input.taskId, input.operationId, delivered.answer.answer]
        );
        if (previous.rowCount !== 1) throw new Error('正式回答与首次送达记录不一致');
        return true;
      }
      for (const [position, evidenceId] of delivered.answer.evidenceIds.entries()) {
        const linked = await client.query(
          `INSERT INTO kairo.formal_answer_evidence (task_id,evidence_id,position)
           SELECT e.task_id,e.evidence_id,$4 FROM kairo.knowledge_evidence e
           JOIN kairo.knowledge_queries q ON q.query_id=e.query_id AND q.task_id=e.task_id
           WHERE e.task_id=$1 AND q.attempt_id=$2 AND e.evidence_id=$3
             AND q.result_category='found' AND q.tool_id='knowledge-search' AND btrim(e.content)<>''`,
          [input.taskId, input.attemptId, evidenceId, position]
        );
        if (linked.rowCount !== 1) throw new Error('正式回答证据不属于当前采用尝试');
      }
      return true;
    });
  }

  /** 正式内容由调用方检查和清洗；这里只核对已有发送事实与任务会话，不执行 T29 策略。 */
  public async recordFormalAnswer(input: FormalAnswerInput): Promise<boolean> {
    return this.transaction(async client => {
      const inserted = await client.query(
        `INSERT INTO kairo.formal_answers
         (task_id,operation_id,boot_id,native_message_id,question,answer,delivered_at)
         SELECT t.task_id,s.operation_id,$3,s.message_id,$4,$5,$6
         FROM kairo.tasks t JOIN kairo.send_operations s ON s.target_session_id=t.session_id
         WHERE t.task_id=$1 AND s.operation_id=$2 AND s.status='delivered' AND s.message_id IS NOT NULL`,
        [
          input.taskId,
          input.operationId,
          input.bootId,
          input.question,
          input.answer,
          new Date(input.deliveredAt),
        ]
      );
      if (inserted.rowCount === 0) return false;
      for (const [position, evidenceId] of input.evidenceIds.entries()) {
        await client.query(
          `INSERT INTO kairo.formal_answer_evidence (task_id,evidence_id,position) VALUES ($1,$2,$3)`,
          [input.taskId, evidenceId, position]
        );
      }
      return true;
    });
  }

  public async getFormalAnswer(taskId: string): Promise<FormalAnswer | null> {
    const result = await this.pool.query<AnswerRow>(
      `SELECT ${answerColumns} FROM kairo.formal_answers WHERE task_id=$1`,
      [taskId]
    );
    const row = result.rows[0];
    return row ? { ...row, deliveredAt: row.deliveredAt.getTime() } : null;
  }

  public async listAnswerEvidence(taskId: string, page: RecordPage): Promise<KnowledgeEvidence[]> {
    const result = await this.pool.query<KnowledgeEvidence>(
      `SELECT ${evidenceColumns} FROM kairo.formal_answer_evidence a
       JOIN kairo.knowledge_evidence e ON e.evidence_id=a.evidence_id
       WHERE a.task_id=$1 ORDER BY a.position LIMIT $2 OFFSET $3`,
      [taskId, page.limit, page.offset]
    );
    return result.rows;
  }

  /** 反馈只引用已记录正式回答，其证据由 formal_answer_evidence 保留，不复制进知识或 Memory。 */
  public async recordFeedback(input: FeedbackInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO kairo.feedback (feedback_id,task_id,text,suggested_answer,created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [input.feedbackId, input.taskId, input.text, input.suggestedAnswer, new Date(input.createdAt)]
    );
  }

  public async getFeedback(feedbackId: string): Promise<Feedback | null> {
    const result = await this.pool.query<FeedbackRow>(
      `SELECT ${feedbackColumns} FROM kairo.feedback WHERE feedback_id=$1`,
      [feedbackId]
    );
    return result.rows[0] ? mapFeedback(result.rows[0]) : null;
  }

  public async listFeedback(taskId: string, page: RecordPage): Promise<Feedback[]> {
    const result = await this.pool.query<FeedbackRow>(
      `SELECT ${feedbackColumns} FROM kairo.feedback WHERE task_id=$1
       ORDER BY created_at,feedback_id LIMIT $2 OFFSET $3`,
      [taskId, page.limit, page.offset]
    );
    return result.rows.map(mapFeedback);
  }
}
