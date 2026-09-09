import type { PoolClient } from 'pg';

/** 所有批次、任务与交付操作先锁 context，切换后等待者不能继续使用旧版本。 */
export async function lockCurrentContext(
  client: PoolClient,
  threadId: string
): Promise<number | null> {
  const result = await client.query<{ version: number }>(
    'SELECT version FROM kairo.contexts WHERE thread_id = $1 AND invalidated_at IS NULL FOR UPDATE',
    [threadId]
  );
  return result.rows[0]?.version ?? null;
}
