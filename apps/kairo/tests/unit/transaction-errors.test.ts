import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { PostgresPrivateChatStore } from '../../src/modules/private-chat-core/store.js';
import { PostgresTaskStore } from '../../src/modules/task-lifecycle/store.js';

// 只在数据库错误边界注入失败，不模拟业务结果；调用方必须能诊断原操作与回滚两次失败。
function failingPool(operationError: Error, rollbackError: Error | null): Pool {
  const client = {
    query: vi.fn((sql: string) => {
      if (sql === 'BEGIN') return Promise.resolve({ rows: [], rowCount: 0 });
      if (sql === 'ROLLBACK') {
        return rollbackError
          ? Promise.reject(rollbackError)
          : Promise.resolve({ rows: [], rowCount: 0 });
      }
      return Promise.reject(operationError);
    }),
    release: vi.fn(),
  } as unknown as PoolClient;
  return { connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
}

const operations = [
  {
    name: '私聊账本',
    execute: (pool: Pool): Promise<unknown> =>
      new PostgresPrivateChatStore(pool).createBatch({
        batchId: '回滚测试批次',
        threadId: '回滚测试上下文',
        firstMessage: { sessionId: '0-测试员工', messageId: '回滚测试消息' },
        quietDeadline: 1000,
        maxDeadline: 2000,
      }),
  },
  {
    name: '任务账本',
    execute: (pool: Pool): Promise<unknown> =>
      new PostgresTaskStore(pool).startAttempt({
        taskId: '回滚测试任务',
        inputVersion: 1,
        now: 1000,
        attemptId: '回滚测试尝试',
        runId: '回滚测试运行',
        configDigest: '回滚测试配置',
        expectedAttemptId: null,
      }),
  },
];

describe('业务账本事务错误保留', () => {
  it.each(operations)('$name 同时保留操作失败与回滚失败', async ({ execute }) => {
    const operationError = new Error('原始数据库操作失败');
    const rollbackError = new Error('回滚时连接已断开');
    const failure: unknown = await execute(failingPool(operationError, rollbackError)).catch(
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('调用方未收到聚合错误');
    expect(failure.errors).toHaveLength(2);
    expect(failure.errors[0]).toBe(operationError);
    expect(failure.errors[1]).toBe(rollbackError);
  });

  it.each(operations)('$name 回滚成功时原样传播原始错误', async ({ execute }) => {
    const operationError = new Error('原始数据库操作失败');
    await expect(execute(failingPool(operationError, null))).rejects.toBe(operationError);
  });
});
