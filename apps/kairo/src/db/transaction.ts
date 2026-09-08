import type { Pool, PoolClient } from 'pg';

/** 事务仅使用同一连接；回滚成功保留原错误，回滚失败同时保留两次错误。 */
export async function withTransaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let destroyClient = true;
  try {
    await client.query('BEGIN');
    destroyClient = false;
    try {
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        destroyClient = true;
        throw new AggregateError([error, rollbackError], '数据库事务操作及回滚均失败');
      }
      throw error;
    }
  } finally {
    // BEGIN 或回滚失败后事务状态不明，按 pg 公开协议销毁连接，不交回池复用。
    client.release(destroyClient);
  }
}
