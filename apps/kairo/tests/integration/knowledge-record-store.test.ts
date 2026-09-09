import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool } from '../../src/db/pool.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type {
  ChatContext,
  ContextScope,
  MessageBatch,
  MessageKey,
} from '../../src/modules/private-chat-core/types.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';
import {
  PostgresKnowledgeRecordStore,
  type KnowledgeQueryInput,
} from '../../src/modules/knowledge-qa/knowledge-record-store.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

const now = Date.UTC(2026, 8, 8, 12, 0, 0, 123);
let database: TaskTestDatabase;
let store: PostgresKnowledgeRecordStore;

interface Fixture {
  chat: PostgresPrivateChatStore;
  tasks: PostgresTaskStore;
  scope: ContextScope;
  original: MessageKey;
  context: ChatContext;
  batch: MessageBatch;
  taskId: string;
  attemptId: string;
  runId: string;
  bootId: string;
}

async function fixture(): Promise<Fixture> {
  const chat = new PostgresPrivateChatStore(database.poolA);
  const tasks = new PostgresTaskStore(database.poolA);
  const employeeId = randomUUID();
  const scope = { employeeId, botId: randomUUID(), sessionId: `0-${employeeId}` };
  const original = { sessionId: scope.sessionId, messageId: randomUUID() };
  await chat.insertRawMessage({
    ...original,
    direction: 'inbound',
    observedAt: now - 1000,
    text: '原始员工问题，仅保存在业务表',
    messageType: 'text',
    attachments: {},
  });
  await chat.associateEmployee(original, employeeId);
  const context = await chat.createContext(scope, now - 1000);
  const batch = await chat.createBatch({
    batchId: randomUUID(),
    threadId: context.threadId,
    firstMessage: original,
    quietDeadline: now,
    maxDeadline: now + 1000,
  });
  await chat.setBatchStatus(batch.batchId, 'ready');
  const taskId = randomUUID();
  await tasks.createTask({
    taskId,
    batchId: batch.batchId,
    configDigest: '任务配置',
    now,
    queueDeadline: now + 10000,
  });
  await tasks.claimTask({ taskId, inputVersion: 1, now, executionMs: 10000 });
  const attemptId = randomUUID();
  const runId = randomUUID();
  await tasks.startAttempt({
    taskId,
    attemptId,
    runId,
    inputVersion: 1,
    now,
    expectedAttemptId: null,
    configDigest: '实际配置',
  });
  const bootId = randomUUID();
  await database.poolA.query(
    `INSERT INTO kairo.runtime_boots (boot_id, git_commit, config_digest, started_at, status)
     VALUES ($1, $2, $3, $4, 'running')`,
    [bootId, 'a'.repeat(40), '实际配置', new Date(now - 2000)]
  );
  return { chat, tasks, scope, original, context, batch, taskId, attemptId, runId, bootId };
}

function queryInput(f: Fixture, callIndex: number): KnowledgeQueryInput {
  return {
    queryId: randomUUID(),
    taskId: f.taskId,
    attemptId: f.attemptId,
    bootId: f.bootId,
    toolId: `tool-${callIndex}`,
    callIndex,
    query: `采购查询正文-${callIndex}`,
    datasetId: '企业数据集',
    startedAt: now + callIndex,
    durationMs: 12.5,
    resultCategory: 'found',
    rawResult: { chunks: [{ content: '原始资料正文' }] },
    evidence: [
      {
        evidenceId: randomUUID(),
        documentId: '内部文档ID',
        documentName: '采购规范.pdf',
        chunkId: `内部片段-${callIndex}`,
        content: '知识片段正文',
        pageNumbers: [2, 3],
        positions: [[2, 10, 20, 30, 40]],
        similarity: 0.87,
        conflict: false,
      },
    ],
  };
}

async function deliveredOperation(
  f: Fixture,
  status = 'delivered'
): Promise<{ operationId: string; nativeMessageId: string }> {
  const operationId = randomUUID();
  const nativeMessageId = randomUUID();
  await database.poolA.query(
    `INSERT INTO kairo.send_operations
     (operation_id, target_session_id, message_type, content_digest, native_key, status, message_id, claim_token)
     VALUES ($1, $2, 'text', '正文摘要', $3, $4, $5, $6)`,
    [
      operationId,
      f.scope.sessionId,
      JSON.stringify([f.scope.sessionId, nativeMessageId]),
      status,
      nativeMessageId,
      randomUUID(),
    ]
  );
  return { operationId, nativeMessageId };
}

beforeAll(async () => {
  database = await createTaskTestDatabase();
  store = new PostgresKnowledgeRecordStore(database.poolA);
});
afterAll(async () => {
  await database?.close();
});

describe('T20 知识证据与反馈真实 PostgreSQL 合同', () => {
  it('首次及重复迁移保留同任务多次检索与全部五类结果，正文只保存在业务记录', async () => {
    const f = await fixture();
    const found = queryInput(f, 1);
    const empty = {
      ...queryInput(f, 2),
      resultCategory: 'empty' as const,
      rawResult: { chunks: [] },
      evidence: [],
    };
    const malformed = {
      ...queryInput(f, 3),
      resultCategory: 'format_error' as const,
      rawResult: { data: '格式错误正文' },
      evidence: [],
    };
    const unavailable = {
      ...queryInput(f, 4),
      resultCategory: 'service_error' as const,
      rawResult: { code: 503, message: '服务错误诊断' },
      evidence: [],
    };
    const conflict = queryInput(f, 5);
    conflict.evidence[0]!.conflict = true;
    conflict.evidence[0]!.pageNumbers = null;
    conflict.evidence[0]!.positions = [[20, 19, 19, 19, 19]];
    for (const input of [found, empty, malformed, unavailable, conflict])
      await store.recordQuery(input);
    expect(await migrateDatabase({ databaseUrl: database.databaseUrl })).toEqual([]);
    const queries = [];
    for (let offset = 0; offset < 6; offset += 2)
      queries.push(...(await store.listQueries(f.taskId, { limit: 2, offset })));
    expect(queries.map(q => q.queryId)).toEqual(
      [found, empty, malformed, unavailable, conflict].map(q => q.queryId)
    );
    expect(queries.map(q => q.resultCategory)).toEqual([
      'found',
      'empty',
      'format_error',
      'service_error',
      'found',
    ]);
    expect(await store.getQuery(found.queryId)).toEqual({ ...found, evidence: undefined });
    expect(await store.getEvidence(found.evidence[0]!.evidenceId)).toEqual({
      ...found.evidence[0],
      taskId: f.taskId,
      queryId: found.queryId,
      position: 0,
    });
    const evidence = await store.listEvidence(f.taskId, { limit: 1, offset: 1 });
    expect(evidence).toEqual([
      { ...conflict.evidence[0], taskId: f.taskId, queryId: conflict.queryId, position: 0 },
    ]);
    expect(await store.listEvidence(f.taskId, { limit: 1, offset: 2 })).toEqual([]);
  });

  it('两个连接竞争同一调用次序只有一个成功，失败不留下半截证据', async () => {
    const f = await fixture();
    const a = queryInput(f, 1);
    const b = queryInput(f, 1);
    const other = new PostgresKnowledgeRecordStore(database.poolB);
    const results = await Promise.allSettled([store.recordQuery(a), other.recordQuery(b)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const failed = results.find(r => r.status === 'rejected');
    expect(failed).toMatchObject({ status: 'rejected', reason: { code: '23505' } });
    const saved = await store.listQueries(f.taskId, { limit: 10, offset: 0 });
    const evidence = await store.listEvidence(f.taskId, { limit: 10, offset: 0 });
    expect(saved).toHaveLength(1);
    expect(evidence.map(e => e.queryId)).toEqual(saved.map(q => q.queryId));
    const broken = queryInput(f, 2);
    broken.evidence.push({ ...broken.evidence[0]! });
    await expect(store.recordQuery(broken)).rejects.toMatchObject({ code: '23505' });
    expect(await store.getQuery(broken.queryId)).toBeNull();
    expect(await store.getEvidence(broken.evidence[0]!.evidenceId)).toBeNull();
  });

  it('不同任务 attempt 或证据不能串接，SQL 异常原样传播并回滚', async () => {
    const f = await fixture();
    const foreign = await fixture();
    const query = queryInput(f, 1);
    await expect(
      store.recordQuery({ ...query, attemptId: foreign.attemptId })
    ).rejects.toMatchObject({ code: '23503' });
    expect(await store.getQuery(query.queryId)).toBeNull();
    await store.recordQuery(query);
    const operation = await deliveredOperation(foreign);
    await expect(
      store.recordFormalAnswer({
        taskId: foreign.taskId,
        bootId: foreign.bootId,
        operationId: operation.operationId,
        question: '另一个问题',
        answer: '另一个答案',
        deliveredAt: now + 100,
        evidenceIds: [query.evidence[0]!.evidenceId],
      })
    ).rejects.toMatchObject({ code: '23503' });
    expect(await store.getFormalAnswer(foreign.taskId)).toBeNull();
  });

  it('已送达问答关联原问题和全部证据，反馈更正保持未验证且重开连接可按 ID 恢复完整链路', async () => {
    const f = await fixture();
    const first = queryInput(f, 1);
    const second = queryInput(f, 2);
    await store.recordQuery(first);
    await store.recordQuery(second);
    const operation = await deliveredOperation(f);
    const answer = {
      taskId: f.taskId,
      bootId: f.bootId,
      operationId: operation.operationId,
      question: '正式原问题正文',
      answer: '实际送达回答正文',
      deliveredAt: now + 100,
      evidenceIds: [first.evidence[0]!.evidenceId, second.evidence[0]!.evidenceId],
    };
    expect(await store.recordFormalAnswer(answer)).toBe(true);
    const feedbackId = randomUUID();
    await store.recordFeedback({
      feedbackId,
      taskId: f.taskId,
      text: '这个回答不对',
      suggestedAnswer: '员工更正不是企业事实',
      createdAt: now + 200,
    });
    await store.recordFeedback({
      feedbackId: randomUUID(),
      taskId: f.taskId,
      text: '只说不对',
      suggestedAnswer: null,
      createdAt: now + 200,
    });
    const reader = createPostgresPool(database.databaseUrl, { max: 1 });
    try {
      const reloaded = new PostgresKnowledgeRecordStore(reader);
      const feedback = await reloaded.getFeedback(feedbackId);
      expect(feedback).toMatchObject({
        feedbackId,
        taskId: f.taskId,
        suggestedAnswer: '员工更正不是企业事实',
        verification: 'unverified',
        createdAt: now + 200,
      });
      expect(await reloaded.getFormalAnswer(f.taskId)).toEqual({
        ...answer,
        evidenceIds: undefined,
        nativeMessageId: operation.nativeMessageId,
      });
      expect(
        (await reloaded.listAnswerEvidence(f.taskId, { limit: 1, offset: 0 })).map(
          e => e.evidenceId
        )
      ).toEqual([answer.evidenceIds[0]]);
      expect(
        (await reloaded.listAnswerEvidence(f.taskId, { limit: 1, offset: 1 })).map(
          e => e.evidenceId
        )
      ).toEqual([answer.evidenceIds[1]]);
      expect(await reloaded.listAnswerEvidence(f.taskId, { limit: 1, offset: 2 })).toEqual([]);
      const feedbackPages = [
        ...(await reloaded.listFeedback(f.taskId, { limit: 1, offset: 0 })),
        ...(await reloaded.listFeedback(f.taskId, { limit: 1, offset: 1 })),
      ];
      expect(new Set(feedbackPages.map(item => item.feedbackId)).size).toBe(2);
      expect(await reloaded.listFeedback(f.taskId, { limit: 1, offset: 2 })).toEqual([]);
      expect((await f.tasks.getTask(f.taskId))?.batchId).toBe(f.batch.batchId);
      expect(await f.chat.getRawMessage(f.original)).toMatchObject({
        text: '原始员工问题，仅保存在业务表',
      });
      expect((await f.chat.getBatchMessages(f.batch.batchId)).map(m => m.messageId)).toEqual([
        f.original.messageId,
      ]);
      expect(await f.chat.getContext(f.context.threadId)).toMatchObject({
        employeeId: f.scope.employeeId,
      });
      expect((await reloaded.getQuery(first.queryId))?.attemptId).toBe(f.attemptId);
      const linked = await reader.query(
        `SELECT a.run_id, s.message_id, b.config_digest
        FROM kairo.knowledge_queries q JOIN kairo.task_attempts a ON a.attempt_id=q.attempt_id
        JOIN kairo.formal_answers f ON f.task_id=q.task_id JOIN kairo.send_operations s ON s.operation_id=f.operation_id
        JOIN kairo.runtime_boots b ON b.boot_id=f.boot_id WHERE q.query_id=$1`,
        [first.queryId]
      );
      expect(linked.rows).toEqual([
        { run_id: f.runId, message_id: operation.nativeMessageId, config_digest: '实际配置' },
      ]);
      const memory = await reader.query(
        'SELECT task_id FROM kairo.memory_commits WHERE task_id=$1',
        [f.taskId]
      );
      expect(memory.rows).toEqual([]);
      expect(
        (await reloaded.listEvidence(f.taskId, { limit: 10, offset: 0 })).map(e => e.content)
      ).toEqual(['知识片段正文', '知识片段正文']);
    } finally {
      await reader.end();
    }
  });

  it('发送未确认或目标不符不能成为正式回答，反馈不能引用不存在的正式回答', async () => {
    const f = await fixture();
    const unknown = await deliveredOperation(f, 'unknown');
    const other = await fixture();
    const wrongTarget = await deliveredOperation(other);
    for (const operationId of [unknown.operationId, wrongTarget.operationId]) {
      expect(
        await store.recordFormalAnswer({
          taskId: f.taskId,
          bootId: f.bootId,
          operationId,
          question: '问题',
          answer: '未正式送达的草稿',
          deliveredAt: now + 100,
          evidenceIds: [],
        })
      ).toBe(false);
    }
    expect(await store.getFormalAnswer(f.taskId)).toBeNull();
    await expect(
      store.recordFeedback({
        feedbackId: randomUUID(),
        taskId: f.taskId,
        text: '反馈',
        suggestedAnswer: null,
        createdAt: now + 200,
      })
    ).rejects.toMatchObject({ code: '23503' });
  });
});
