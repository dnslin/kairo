import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeKK9Driver,
  createSendOperationFingerprint,
  type SendOperationFingerprint,
  type SendOperationStore,
} from '@kairo/driver';
import { MIGRATIONS_TABLE, migrateDatabase } from '../../src/db/migrate.js';
import { createPostgresPool, type PostgresPool } from '../../src/db/pool.js';
import { PostgresSendOperationStore } from '../../src/modules/im-transport/postgres-send-operation-store.js';

const databaseUrl = process.env.KAIRO_TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;

let verificationPool: PostgresPool;

function newOperationId(): string {
  return `integration-${randomUUID()}`;
}

function newFingerprint(
  content: string,
  targetSessionId = 'session-integration'
): SendOperationFingerprint {
  return createSendOperationFingerprint({
    targetSessionId,
    messageType: 'text',
    content,
  });
}

function createStore(pool: PostgresPool): SendOperationStore {
  return new PostgresSendOperationStore(pool);
}

describePostgres('PostgresSendOperationStore 真实 PostgreSQL 集成合同', () => {
  beforeAll(async () => {
    await migrateDatabase({ databaseUrl });
    verificationPool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 2,
    });
  });

  afterAll(async () => {
    await verificationPool?.end();
  });

  it('新库迁移可重复执行且只记录一次迁移', async () => {
    const applied = await migrateDatabase({ databaseUrl });
    expect(applied).toHaveLength(0);

    const result = await verificationPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM kairo.${MIGRATIONS_TABLE}`
    );
    expect(result.rows[0]?.count).toBe('1');

    const table = await verificationPool.query<{ table_name: string }>(
      `
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'kairo'
          AND table_name = 'send_operations'
      `
    );
    expect(table.rows).toHaveLength(1);
  });

  it('两个真实连接并发 claim 同一 operation 只允许一个声明者', async () => {
    const firstPool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const secondPool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const firstStore = createStore(firstPool);
    const secondStore = createStore(secondPool);
    const operationId = newOperationId();
    const fingerprint = newFingerprint('并发 claim 内容');

    try {
      const firstConnection = await firstPool.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid'
      );
      const secondConnection = await secondPool.query<{ pid: number }>(
        'SELECT pg_backend_pid() AS pid'
      );
      expect(firstConnection.rows[0]?.pid).toBeDefined();
      expect(secondConnection.rows[0]?.pid).toBeDefined();
      expect(firstConnection.rows[0]?.pid).not.toBe(secondConnection.rows[0]?.pid);

      const results = await Promise.all([
        firstStore.claim({ operationId, fingerprint }),
        secondStore.claim({ operationId, fingerprint }),
      ]);

      expect(results.filter(result => result.claimed)).toHaveLength(1);
      expect(results.filter(result => !result.claimed)).toHaveLength(1);
      const nativeKey = await verificationPool.query<{ native_key: string }>(
        `
          SELECT native_key
          FROM kairo.send_operations
          WHERE operation_id = $1
        `,
        [operationId]
      );
      expect(nativeKey.rows[0]?.native_key).toBe(
        `kairo:operation:${encodeURIComponent(operationId)}`
      );
      expect(await firstStore.get(operationId)).toMatchObject({
        operationId,
        fingerprint,
        status: 'unknown',
      });
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });

  it('相同意图重放复用原记录，不同 fingerprint 拒绝且不覆盖', async () => {
    const firstPool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const secondPool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const firstStore = createStore(firstPool);
    const secondStore = createStore(secondPool);
    const operationId = newOperationId();
    const fingerprint = newFingerprint('原始内容');

    try {
      await expect(firstStore.claim({ operationId, fingerprint })).resolves.toMatchObject({
        claimed: true,
        operation: { status: 'unknown' },
      });
      await expect(
        firstStore.update(operationId, {
          status: 'delivered',
          messageId: 'native-integration-1',
          isPreTrigger: false,
          verifyLatencyMs: 17,
        })
      ).resolves.toMatchObject({
        operationId,
        status: 'delivered',
        messageId: 'native-integration-1',
      });

      await expect(secondStore.claim({ operationId, fingerprint })).resolves.toMatchObject({
        claimed: false,
        operation: {
          status: 'delivered',
          messageId: 'native-integration-1',
        },
      });

      const conflictingFingerprint = newFingerprint('不同内容');
      await expect(
        secondStore.claim({
          operationId,
          fingerprint: conflictingFingerprint,
        })
      ).rejects.toThrow(/fingerprint/);
      await expect(firstStore.get(operationId)).resolves.toMatchObject({
        operationId,
        status: 'delivered',
        messageId: 'native-integration-1',
        fingerprint,
      });
    } finally {
      await Promise.all([firstPool.end(), secondPool.end()]);
    }
  });

  it('确定的前置失败可原子重试，未知和已送达不会再次声明', async () => {
    const pool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const store = createStore(pool);
    const operationId = newOperationId();
    const fingerprint = newFingerprint('可安全重试内容');

    try {
      await store.claim({ operationId, fingerprint });
      await store.update(operationId, {
        status: 'failed',
        error: '连接尚未触发发送',
        isPreTrigger: true,
      });

      await expect(store.claim({ operationId, fingerprint })).resolves.toMatchObject({
        claimed: true,
        operation: {
          status: 'unknown',
          messageId: undefined,
          error: undefined,
        },
      });
      await expect(store.claim({ operationId, fingerprint })).resolves.toMatchObject({
        claimed: false,
        operation: { status: 'unknown' },
      });
    } finally {
      await pool.end();
    }
  });

  it('新 FakeDriver 实例可查询 PostgreSQL 中旧的三态结果', async () => {
    const pool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const store = createStore(pool);
    const driver = new FakeKK9Driver(store);
    const cases = [
      {
        status: 'delivered' as const,
        messageId: 'native-delivered',
        update: {
          status: 'delivered' as const,
          messageId: 'native-delivered',
          isPreTrigger: false,
        },
      },
      {
        status: 'failed' as const,
        update: {
          status: 'failed' as const,
          error: '发送前拒绝',
          isPreTrigger: true,
        },
      },
      {
        status: 'unknown' as const,
        update: {
          status: 'unknown' as const,
          error: '触发后失去响应',
          isPreTrigger: false,
        },
      },
    ];

    try {
      for (const testCase of cases) {
        const operationId = newOperationId();
        const fingerprint = newFingerprint(`状态 ${testCase.status}`);
        await store.claim({ operationId, fingerprint });
        await store.update(operationId, testCase.update);

        await expect(driver.getSendStatus(operationId)).resolves.toMatchObject({
          operationId,
          status: testCase.status,
          success: testCase.status === 'delivered',
          ...(testCase.messageId ? { messageId: testCase.messageId } : {}),
        });
      }
    } finally {
      await pool.end();
    }
  });

  it('数据库错误向上抛出，不转换成发送失败结果', async () => {
    const pool = createPostgresPool(databaseUrl, {
      allowExitOnIdle: true,
      max: 1,
    });
    const store = createStore(pool);
    const driver = new FakeKK9Driver(store);
    await pool.end();

    await expect(
      driver.sendText('数据库错误不应伪装成发送失败', {
        operationId: newOperationId(),
        targetSessionId: 'session-integration',
      })
    ).rejects.toThrow();
  });
});
