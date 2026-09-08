import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool } from '../../src/db/pool.js';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import type {
  ContextScope,
  NoticeKey,
  RawMessageInput,
} from '../../src/modules/private-chat-core/types.js';

const databaseUrl = process.env.KAIRO_TEST_DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error('缺少 KAIRO_TEST_DATABASE_URL，不能执行 T18 真实 PostgreSQL 集成测试');
}

const databaseName = `kairo_t18_${randomUUID().replaceAll('-', '')}`;
const temporaryUrl = new URL(databaseUrl);
temporaryUrl.pathname = `/${databaseName}`;
const temporaryDatabaseUrl = temporaryUrl.toString();
const admin = createPostgresPool(databaseUrl, { max: 1 });
const observedAt = Date.UTC(2026, 8, 8, 10, 0, 0, 123);
let createdDatabase = false;
let poolA: Pool;
let poolB: Pool;
let storeA: PostgresPrivateChatStore;
let storeB: PostgresPrivateChatStore;

function scopeFor(name: string): ContextScope {
  return { employeeId: name, botId: `bot-${name}`, sessionId: `0-${name}` };
}

function rawMessage(
  scope: ContextScope,
  messageId: string,
  overrides: Partial<RawMessageInput> = {}
): RawMessageInput {
  return {
    sessionId: scope.sessionId,
    messageId,
    direction: 'inbound',
    observedAt,
    text: '员工发来的原始正文',
    messageType: 'text',
    attachments: {},
    ...overrides,
  };
}

async function insertAssociated(scope: ContextScope, message: RawMessageInput) {
  const inserted = await storeA.insertRawMessage(message);
  expect(inserted.inserted).toBe(true);
  expect(await storeA.associateEmployee(message, scope.employeeId)).toBe(true);
}

async function collectingBatch(scope: ContextScope, batchId: string) {
  const context = await storeA.createContext(scope, observedAt - 1_000);
  const firstMessage = rawMessage(scope, `${batchId}-first`);
  await insertAssociated(scope, firstMessage);
  const batch = await storeA.createBatch({
    batchId,
    threadId: context.threadId,
    firstMessage,
    quietDeadline: observedAt + 5_000,
    maxDeadline: observedAt + 30_000,
  });
  return { context, firstMessage, batch };
}

beforeAll(async () => {
  // 管理连接只创建本次随机库；任何迁移之前先核实两个业务连接的真实目标。
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  createdDatabase = true;
  poolA = createPostgresPool(temporaryDatabaseUrl, { max: 1 });
  poolB = createPostgresPool(temporaryDatabaseUrl, { max: 1 });
  const [connectionA, connectionB] = await Promise.all([
    poolA.query<{ name: string; pid: number }>(
      'SELECT current_database() AS name, pg_backend_pid() AS pid'
    ),
    poolB.query<{ name: string; pid: number }>(
      'SELECT current_database() AS name, pg_backend_pid() AS pid'
    ),
  ]);
  expect(connectionA.rows[0]?.name).toBe(databaseName);
  expect(connectionB.rows[0]?.name).toBe(databaseName);
  expect(connectionA.rows[0]?.pid).toBeTypeOf('number');
  expect(connectionB.rows[0]?.pid).toBeTypeOf('number');
  expect(connectionA.rows[0]?.pid).not.toBe(connectionB.rows[0]?.pid);
  await migrateDatabase({ databaseUrl: temporaryDatabaseUrl });
  storeA = new PostgresPrivateChatStore(poolA);
  storeB = new PostgresPrivateChatStore(poolB);
}, 30_000);

afterAll(async () => {
  try {
    await Promise.all([poolA?.end(), poolB?.end()]);
    // 只删除已成功创建的自有随机库，不强制断开其他连接，不重置配置中的数据库。
    if (createdDatabase) await admin.query(`DROP DATABASE "${databaseName}"`);
  } finally {
    await admin.end();
  }
}, 30_000);

describe('T18 私聊 PostgreSQL 账本', () => {
  it('重复迁移不重复登记版本，也不改变已保存的消息', async () => {
    const input = rawMessage(scopeFor('migration'), 'migration-message');
    const saved = await storeA.insertRawMessage(input);
    const before = await poolA.query('SELECT name FROM kairo.pgmigrations ORDER BY name');

    expect(await migrateDatabase({ databaseUrl: temporaryDatabaseUrl })).toEqual([]);

    const after = await poolB.query('SELECT name FROM kairo.pgmigrations ORDER BY name');
    expect(after.rows).toEqual(before.rows);
    expect(await storeB.getRawMessage(input)).toEqual(saved.message);
  }, 30_000);

  it('两个独立连接并发写同一消息仅一个胜出，重投不能覆盖胜出内容', async () => {
    const first = rawMessage(scopeFor('raw-race'), 'same-message', { text: '连接甲的观察' });
    const second = { ...first, text: '连接乙的观察', observedAt: observedAt + 999 };
    const results = await Promise.all([
      storeA.insertRawMessage(first),
      storeB.insertRawMessage(second),
    ]);
    expect(results.filter(result => result.inserted)).toHaveLength(1);
    const winner = results[0].inserted ? first : second;
    const expected = { ...winner, employeeId: null, processingResult: null };
    expect(results.map(result => result.message)).toEqual([expected, expected]);
    expect(await storeB.insertRawMessage({ ...first, text: '后续重投' })).toEqual({
      inserted: false,
      message: expected,
    });
    const rows = await poolA.query(
      'SELECT count(*)::integer AS count FROM kairo.raw_messages WHERE session_id = $1 AND message_id = $2',
      [first.sessionId, first.messageId]
    );
    expect(rows.rows).toEqual([{ count: 1 }]);
  });

  it('同一个 messageId 在不同 session 中分别保存', async () => {
    const first = rawMessage(scopeFor('session-one'), 'shared-native-id', { text: '第一会话' });
    const second = rawMessage(scopeFor('session-two'), 'shared-native-id', { text: '第二会话' });
    const results = await Promise.all([
      storeA.insertRawMessage(first),
      storeB.insertRawMessage(second),
    ]);
    expect(results.map(result => result.inserted)).toEqual([true, true]);
    expect(await storeA.getRawMessage(first)).toMatchObject(first);
    expect(await storeB.getRawMessage(second)).toMatchObject(second);
  });

  it('三个方向、毫秒时间、正文、附件元数据和处理结果均可由新 store 恢复', async () => {
    const scope = scopeFor('raw-recovery');
    const inbound = rawMessage(scope, 'inbound', {
      text: '第一行\n第二行：保留空格  与标点 <原文>',
      messageType: 'file',
      attachments: {
        fileInfo: {
          fileName: '报价单.pdf',
          fileSize: '12345',
          fileExt: 'pdf',
          filePath: 'C:/kk9-cache/报价单.pdf',
        },
        images: [{ uri: 'resource/image-1', width: 640, height: 480, mimeType: 'image/png' }],
      },
    });
    const outbound = rawMessage(scope, 'outbound', {
      direction: 'outbound',
      observedAt: observedAt + 456,
      text: '机器人发送',
      messageType: null,
    });
    const unknown = rawMessage(scope, 'unknown', {
      direction: 'unknown',
      observedAt: observedAt + 789,
      text: '',
      messageType: null,
    });
    await storeA.insertRawMessage(inbound);
    await storeA.insertRawMessage(outbound);
    await storeA.insertRawMessage(unknown);
    expect(await storeA.setProcessingResult(inbound, '已归档：等待员工确认')).toBe(true);
    expect(await storeA.setProcessingResult({ ...inbound, messageId: 'missing' }, '不存在')).toBe(
      false
    );

    const recovered = new PostgresPrivateChatStore(poolB);
    expect(await recovered.getRawMessage(inbound)).toEqual({
      ...inbound,
      employeeId: null,
      processingResult: '已归档：等待员工确认',
    });
    expect(await recovered.getRawMessage(outbound)).toEqual({
      ...outbound,
      employeeId: null,
      processingResult: null,
    });
    expect(await recovered.getRawMessage(unknown)).toEqual({
      ...unknown,
      employeeId: null,
      processingResult: null,
    });
    expect(await recovered.getRawMessage({ ...inbound, messageId: 'missing' })).toBeNull();
  });

  it('身份初始为空，只有匹配私聊 UID 的员工可关联且不能被覆盖', async () => {
    const scope = scopeFor('identity');
    const input = rawMessage(scope, 'identity-message');
    expect((await storeA.insertRawMessage(input)).message.employeeId).toBeNull();
    expect(await storeB.associateEmployee(input, '其他员工')).toBe(false);
    expect(await storeB.associateEmployee(input, scope.sessionId)).toBe(false);
    expect(await storeB.associateEmployee(input, '')).toBe(false);
    expect((await storeA.getRawMessage(input))?.employeeId).toBeNull();
    expect(await storeA.associateEmployee(input, scope.employeeId)).toBe(true);
    expect(await storeB.associateEmployee(input, scope.employeeId)).toBe(true);
    expect(await storeB.associateEmployee(input, '冒用身份')).toBe(false);
    expect(
      await storeA.associateEmployee({ ...input, messageId: 'missing' }, scope.employeeId)
    ).toBe(false);
    await expect(
      poolB.query(
        'UPDATE kairo.raw_messages SET employee_id = $3 WHERE session_id = $1 AND message_id = $2',
        [input.sessionId, input.messageId, '绕过存储的错误身份']
      )
    ).rejects.toMatchObject({ code: '23514' });
    expect((await new PostgresPrivateChatStore(poolB).getRawMessage(input))?.employeeId).toBe(
      scope.employeeId
    );
  });

  it('context 按 employee、bot、session 独立隔离，并发创建只产生一个有效版本', async () => {
    const scope = scopeFor('context-race');
    expect(await storeA.getCurrentContext(scope)).toBeNull();
    const [first, second] = await Promise.all([
      storeA.createContext(scope, observedAt),
      storeB.createContext(scope, observedAt + 1),
    ]);
    expect(second).toEqual(first);
    expect(first.version).toBe(1);
    const employeeScope = { ...scope, employeeId: 'another-employee' };
    const botScope = { ...scope, botId: 'another-bot' };
    const sessionScope = { ...scope, sessionId: '0-another-session' };
    expect(await storeB.getCurrentContext(employeeScope)).toBeNull();
    expect(await storeB.getCurrentContext(botScope)).toBeNull();
    expect(await storeB.getCurrentContext(sessionScope)).toBeNull();
    const employeeContext = await storeA.createContext(employeeScope, observedAt);
    const botContext = await storeA.createContext(botScope, observedAt);
    const sessionContext = await storeA.createContext(sessionScope, observedAt);
    expect(
      new Set([first, employeeContext, botContext, sessionContext].map(item => item.threadId)).size
    ).toBe(4);
    expect(await storeB.getCurrentContext(scope)).toEqual(first);
    expect(await storeB.getCurrentContext(employeeScope)).toEqual(employeeContext);
    expect(await storeB.getCurrentContext(botScope)).toEqual(botContext);
    expect(await storeB.getCurrentContext(sessionScope)).toEqual(sessionContext);
    await expect(
      poolB.query(
        `INSERT INTO kairo.contexts (thread_id, employee_id, bot_id, session_id, version, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
        [randomUUID(), scope.employeeId, scope.botId, scope.sessionId, 2, new Date(observedAt)]
      )
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('context 失效后版本递增并保留旧记录，旧版本更新不能影响新 context', async () => {
    const scope = scopeFor('context-version');
    const first = await storeA.createContext(scope, observedAt);
    expect(await storeA.setContextIdleSince(scope, first.version, observedAt + 1_000)).toBe(true);
    expect(await storeB.getCurrentContext(scope)).toEqual({
      ...first,
      idleSince: observedAt + 1_000,
    });
    expect(await storeA.invalidateContext(scope, first.version, observedAt + 2_000)).toBe(true);
    expect(await storeB.getCurrentContext(scope)).toBeNull();
    const [second, reused] = await Promise.all([
      storeA.createContext(scope, observedAt + 3_000),
      storeB.createContext(scope, observedAt + 3_000),
    ]);
    expect(second.version).toBe(first.version + 1);
    expect(second.threadId).not.toBe(first.threadId);
    expect(reused).toEqual(second);
    expect(await storeB.invalidateContext(scope, first.version, observedAt + 4_000)).toBe(false);
    expect(await storeB.setContextIdleSince(scope, first.version, observedAt + 4_000)).toBe(false);
    expect(await storeB.getCurrentContext(scope)).toEqual(second);
    expect(await storeA.setContextIdleSince(scope, second.version, observedAt + 5_000)).toBe(true);
    expect(await storeA.setContextIdleSince(scope, second.version, null)).toBe(true);
    const recovered = new PostgresPrivateChatStore(poolB);
    expect(await recovered.getCurrentContext(scope)).toEqual(second);
    expect(await recovered.getContext(first.threadId)).toEqual({
      ...first,
      idleSince: observedAt + 1_000,
      invalidatedAt: observedAt + 2_000,
    });
    expect(await recovered.getContext('missing-thread')).toBeNull();
  });

  it('批次按追加顺序恢复消息与绝对截止，quiet 只增加且 max 不变', async () => {
    const scope = scopeFor('batch-order');
    const { batch, firstMessage } = await collectingBatch(scope, 'ordered-batch');
    const second = rawMessage(scope, 'z-second', { observedAt: observedAt + 2_000 });
    const third = rawMessage(scope, 'a-third', { observedAt: observedAt - 1_000 });
    await insertAssociated(scope, second);
    await insertAssociated(scope, third);
    expect(batch).toMatchObject({
      ...scope,
      firstObservedAt: firstMessage.observedAt,
      quietDeadline: observedAt + 5_000,
      maxDeadline: observedAt + 30_000,
      status: 'collecting',
    });
    expect(await storeB.appendBatchMessage(batch.batchId, second, observedAt + 9_000)).toBe(true);
    expect(await storeA.appendBatchMessage(batch.batchId, third, observedAt + 6_000)).toBe(true);
    const recovered = new PostgresPrivateChatStore(poolB);
    expect(await recovered.getBatch(batch.batchId)).toEqual({
      ...batch,
      quietDeadline: observedAt + 9_000,
    });
    expect(await recovered.getBatchMessages(batch.batchId)).toEqual([
      { ...firstMessage, employeeId: scope.employeeId, processingResult: null },
      { ...second, employeeId: scope.employeeId, processingResult: null },
      { ...third, employeeId: scope.employeeId, processingResult: null },
    ]);
    expect(await recovered.listCollectingBatches(scope)).toEqual([
      { ...batch, quietDeadline: observedAt + 9_000 },
    ]);
    expect(await recovered.listCollectingBatches({ ...scope, botId: 'other-bot' })).toEqual([]);
    expect(
      await recovered.listCollectingBatches({ ...scope, employeeId: 'other-employee' })
    ).toEqual([]);
    expect(
      await recovered.listCollectingBatches({ ...scope, sessionId: '0-other-session' })
    ).toEqual([]);
  });

  it('重复追加不重复入批，也不重置 quiet 截止时间', async () => {
    const scope = scopeFor('batch-duplicate');
    const { batch, firstMessage } = await collectingBatch(scope, 'duplicate-batch');
    expect(await storeB.appendBatchMessage(batch.batchId, firstMessage, observedAt + 25_000)).toBe(
      false
    );
    const second = rawMessage(scope, 'second');
    await insertAssociated(scope, second);
    expect(await storeA.appendBatchMessage(batch.batchId, second, observedAt + 8_000)).toBe(true);
    expect(await storeB.appendBatchMessage(batch.batchId, second, observedAt + 29_000)).toBe(false);
    expect(await storeA.getBatch(batch.batchId)).toEqual({
      ...batch,
      quietDeadline: observedAt + 8_000,
    });
    expect(
      (await storeA.getBatchMessages(batch.batchId)).map(message => message.messageId)
    ).toEqual([firstMessage.messageId, second.messageId]);
  });

  it('追加拒绝未关联、出站、未知方向、跨 scope 和不存在的消息且不改变批次', async () => {
    const scope = scopeFor('append-rejection');
    const { batch, firstMessage } = await collectingBatch(scope, 'rejection-batch');
    const unassociated = rawMessage(scope, 'unassociated');
    const outbound = rawMessage(scope, 'outbound', { direction: 'outbound' });
    const unknown = rawMessage(scope, 'unknown', { direction: 'unknown' });
    const foreignScope = scopeFor('foreign-append');
    const foreign = rawMessage(foreignScope, 'foreign');
    await storeA.insertRawMessage(unassociated);
    await insertAssociated(scope, outbound);
    await insertAssociated(scope, unknown);
    await insertAssociated(foreignScope, foreign);
    expect(await storeB.appendBatchMessage(batch.batchId, unassociated, observedAt + 20_000)).toBe(
      false
    );
    expect(await storeB.appendBatchMessage(batch.batchId, outbound, observedAt + 20_000)).toBe(
      false
    );
    expect(await storeB.appendBatchMessage(batch.batchId, unknown, observedAt + 20_000)).toBe(
      false
    );
    expect(await storeB.appendBatchMessage(batch.batchId, foreign, observedAt + 20_000)).toBe(
      false
    );
    expect(
      await storeB.appendBatchMessage(
        batch.batchId,
        { ...firstMessage, messageId: 'missing' },
        observedAt + 20_000
      )
    ).toBe(false);
    expect(
      await storeB.appendBatchMessage('missing-batch', firstMessage, observedAt + 20_000)
    ).toBe(false);
    expect(await storeA.getBatch(batch.batchId)).toEqual(batch);
    expect(
      (await storeA.getBatchMessages(batch.batchId)).map(message => message.messageId)
    ).toEqual([firstMessage.messageId]);
  });

  it('collecting 可分别终结为 ready、rejected、discarded，终结后不能改状态或追加', async () => {
    const scope = scopeFor('batch-status');
    const ready = await collectingBatch(scope, 'status-ready');
    const rejected = await collectingBatch(scope, 'status-rejected');
    const discarded = await collectingBatch(scope, 'status-discarded');
    const pending = await collectingBatch(scope, 'status-pending');
    const late = rawMessage(scope, 'late-message');
    await insertAssociated(scope, late);
    expect(await storeA.setBatchStatus(ready.batch.batchId, 'ready')).toBe(true);
    expect(await storeB.setBatchStatus(rejected.batch.batchId, 'rejected')).toBe(true);
    expect(await storeA.setBatchStatus(discarded.batch.batchId, 'discarded')).toBe(true);
    expect(await storeB.setBatchStatus(ready.batch.batchId, 'rejected')).toBe(false);
    expect(await storeA.setBatchStatus(rejected.batch.batchId, 'ready')).toBe(false);
    expect(await storeB.setBatchStatus(discarded.batch.batchId, 'ready')).toBe(false);
    expect(await storeB.setBatchStatus('missing-batch', 'ready')).toBe(false);
    expect(await storeB.appendBatchMessage(ready.batch.batchId, late, observedAt + 20_000)).toBe(
      false
    );
    expect(await storeB.appendBatchMessage(rejected.batch.batchId, late, observedAt + 20_000)).toBe(
      false
    );
    expect(
      await storeB.appendBatchMessage(discarded.batch.batchId, late, observedAt + 20_000)
    ).toBe(false);
    expect(await storeB.getBatch(ready.batch.batchId)).toEqual({ ...ready.batch, status: 'ready' });
    expect(await storeB.getBatch(rejected.batch.batchId)).toEqual({
      ...rejected.batch,
      status: 'rejected',
    });
    expect(await storeB.getBatch(discarded.batch.batchId)).toEqual({
      ...discarded.batch,
      status: 'discarded',
    });
    expect(await storeB.listCollectingBatches(scope)).toEqual([pending.batch]);
    expect(await storeA.appendBatchMessage(pending.batch.batchId, late, observedAt + 20_000)).toBe(
      true
    );
  });

  it('建批拒绝无效 context、未关联或非入站消息及身份会话不匹配且不留记录', async () => {
    const scope = scopeFor('create-rejection');
    const context = await storeA.createContext(scope, observedAt);
    const unassociated = rawMessage(scope, 'unassociated');
    const outbound = rawMessage(scope, 'outbound', { direction: 'outbound' });
    const unknown = rawMessage(scope, 'unknown', { direction: 'unknown' });
    const valid = rawMessage(scope, 'valid');
    const foreignScope = scopeFor('foreign-create');
    const foreign = rawMessage(foreignScope, 'foreign');
    await storeA.insertRawMessage(unassociated);
    await insertAssociated(scope, outbound);
    await insertAssociated(scope, unknown);
    await insertAssociated(scope, valid);
    await insertAssociated(foreignScope, foreign);
    const input = {
      batchId: 'invalid-create',
      threadId: context.threadId,
      firstMessage: unassociated,
      quietDeadline: observedAt + 5_000,
      maxDeadline: observedAt + 30_000,
    };
    await expect(storeB.createBatch(input)).rejects.toThrow();
    await expect(storeB.createBatch({ ...input, firstMessage: outbound })).rejects.toThrow();
    await expect(storeB.createBatch({ ...input, firstMessage: unknown })).rejects.toThrow();
    await expect(storeB.createBatch({ ...input, firstMessage: foreign })).rejects.toThrow();
    const wrongEmployee = await storeA.createContext(
      { ...scope, employeeId: 'wrong-employee' },
      observedAt
    );
    await expect(
      storeB.createBatch({ ...input, firstMessage: valid, threadId: wrongEmployee.threadId })
    ).rejects.toThrow();
    await expect(
      storeB.createBatch({ ...input, firstMessage: valid, threadId: 'missing-thread' })
    ).rejects.toThrow();
    expect(await storeA.invalidateContext(scope, context.version, observedAt + 1_000)).toBe(true);
    await expect(storeB.createBatch({ ...input, firstMessage: valid })).rejects.toThrow();
    expect(await storeA.getBatch(input.batchId)).toBeNull();
    expect(await storeA.getBatchMessages(input.batchId)).toEqual([]);
    expect(await storeA.listCollectingBatches(scope)).toEqual([]);
  });

  it('原始消息已属于其他批次时建批整体回滚，不遗留空批次或更改原归属', async () => {
    const scope = scopeFor('batch-rollback');
    const { context, firstMessage, batch } = await collectingBatch(scope, 'original-batch');
    await expect(
      storeB.createBatch({
        batchId: 'rolled-back-batch',
        threadId: context.threadId,
        firstMessage,
        quietDeadline: observedAt + 10_000,
        maxDeadline: observedAt + 60_000,
      })
    ).rejects.toMatchObject({ code: '23505' });
    expect(await storeA.getBatch('rolled-back-batch')).toBeNull();
    expect(await storeA.getBatchMessages('rolled-back-batch')).toEqual([]);
    expect(await storeA.getBatch(batch.batchId)).toEqual(batch);
    expect(
      (await storeA.getBatchMessages(batch.batchId)).map(message => message.messageId)
    ).toEqual([firstMessage.messageId]);
    const other = await collectingBatch(scope, 'other-batch');
    expect(
      await storeB.appendBatchMessage(other.batch.batchId, firstMessage, observedAt + 25_000)
    ).toBe(false);
    expect(await storeA.getBatch(other.batch.batchId)).toEqual(other.batch);
    expect(
      (await storeA.getBatchMessages(other.batch.batchId)).map(message => message.messageId)
    ).toEqual([other.firstMessage.messageId]);
    expect(await storeA.listCollectingBatches(scope)).toEqual([batch, other.batch]);
  });

  it('提示限频支持首次、窗口内拒绝、恰好边界与窗口后并发唯一，并按 bot、session、type 隔离', async () => {
    const key: NoticeKey = {
      botId: 'notice-bot',
      sessionId: '0-notice-employee',
      noticeType: 'identity',
    };
    expect(await storeA.claimNotice(key, observedAt, observedAt + 1_000)).toBe(true);
    expect(await storeB.claimNotice(key, observedAt + 999, observedAt + 9_000)).toBe(false);
    const boundary = await Promise.all([
      storeA.claimNotice(key, observedAt + 1_000, observedAt + 2_000),
      storeB.claimNotice(key, observedAt + 1_000, observedAt + 2_000),
    ]);
    expect(boundary.filter(Boolean)).toHaveLength(1);
    const afterWindow = await Promise.all([
      storeA.claimNotice(key, observedAt + 2_001, observedAt + 3_000),
      storeB.claimNotice(key, observedAt + 2_001, observedAt + 3_000),
    ]);
    expect(afterWindow.filter(Boolean)).toHaveLength(1);
    const botKey = { ...key, botId: 'other-notice-bot' };
    const sessionKey = { ...key, sessionId: '0-other-notice-employee' };
    const typeKey = { ...key, noticeType: 'busy' };
    expect(await storeA.claimNotice(botKey, observedAt + 2_001, observedAt + 4_000)).toBe(true);
    expect(await storeA.claimNotice(sessionKey, observedAt + 2_001, observedAt + 4_000)).toBe(true);
    expect(await storeA.claimNotice(typeKey, observedAt + 2_001, observedAt + 4_000)).toBe(true);
    const recovered = new PostgresPrivateChatStore(poolB);
    expect(await recovered.claimNotice(key, observedAt + 2_999, observedAt + 8_000)).toBe(false);
    expect(await recovered.claimNotice(botKey, observedAt + 3_000, observedAt + 8_000)).toBe(false);
    expect(await recovered.claimNotice(sessionKey, observedAt + 3_000, observedAt + 8_000)).toBe(
      false
    );
    expect(await recovered.claimNotice(typeKey, observedAt + 3_000, observedAt + 8_000)).toBe(
      false
    );
    const persisted = await poolA.query(
      `SELECT last_notified_at, next_allowed_at FROM kairo.notice_limits
       WHERE bot_id = $1 AND session_id = $2 AND notice_type = $3`,
      [key.botId, key.sessionId, key.noticeType]
    );
    expect(persisted.rows).toEqual([
      {
        last_notified_at: new Date(observedAt + 2_001),
        next_allowed_at: new Date(observedAt + 3_000),
      },
    ]);
  });

  it('超过两小时的消息、失效 context、终结批次、消息归属和限频历史均不会自动删除', async () => {
    const scope = scopeFor('history');
    const old = Date.now() - 3 * 60 * 60 * 1_000;
    const later = old + 3 * 60 * 60 * 1_000;
    const firstMessage = rawMessage(scope, 'old-message', { observedAt: old });
    await insertAssociated(scope, firstMessage);
    expect(await storeA.setProcessingResult(firstMessage, '历史处理完成')).toBe(true);
    const context = await storeA.createContext(scope, old);
    const batch = await storeA.createBatch({
      batchId: 'history-batch',
      threadId: context.threadId,
      firstMessage,
      quietDeadline: old + 5_000,
      maxDeadline: old + 30_000,
    });
    expect(await storeA.setBatchStatus(batch.batchId, 'discarded')).toBe(true);
    expect(await storeA.invalidateContext(scope, context.version, old + 60_000)).toBe(true);
    const noticeKey = { botId: scope.botId, sessionId: scope.sessionId, noticeType: 'old-notice' };
    expect(await storeA.claimNotice(noticeKey, old, old + 60_000)).toBe(true);

    const recovered = new PostgresPrivateChatStore(poolB);
    const next = await recovered.createContext(scope, later);
    expect(next.version).toBe(context.version + 1);
    const currentMessage = rawMessage(scope, 'current-message', { observedAt: later });
    expect((await recovered.insertRawMessage(currentMessage)).inserted).toBe(true);
    expect(
      await recovered.claimNotice(
        { ...noticeKey, noticeType: 'current-notice' },
        later,
        later + 60_000
      )
    ).toBe(true);
    expect(await recovered.getRawMessage(firstMessage)).toEqual({
      ...firstMessage,
      employeeId: scope.employeeId,
      processingResult: '历史处理完成',
    });
    expect(await recovered.getContext(context.threadId)).toEqual({
      ...context,
      invalidatedAt: old + 60_000,
    });
    expect(await recovered.getBatch(batch.batchId)).toEqual({ ...batch, status: 'discarded' });
    expect(await recovered.getBatchMessages(batch.batchId)).toEqual([
      {
        ...firstMessage,
        employeeId: scope.employeeId,
        processingResult: '历史处理完成',
      },
    ]);
    expect(await recovered.listCollectingBatches(scope)).toEqual([]);
    const oldNotice = await poolA.query(
      `SELECT last_notified_at, next_allowed_at FROM kairo.notice_limits
       WHERE bot_id = $1 AND session_id = $2 AND notice_type = $3`,
      [noticeKey.botId, noticeKey.sessionId, noticeKey.noticeType]
    );
    expect(oldNotice.rows).toEqual([
      {
        last_notified_at: new Date(old),
        next_allowed_at: new Date(old + 60_000),
      },
    ]);
  });
});
