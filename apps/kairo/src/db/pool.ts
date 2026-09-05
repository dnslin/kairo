import { Pool, type PoolConfig } from 'pg';

export function createPostgresPool(
  databaseUrl = process.env.DATABASE_URL,
  options: Omit<PoolConfig, 'connectionString'> = {}
): Pool {
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error('缺少 PostgreSQL 连接地址，请设置 DATABASE_URL');
  }

  return new Pool({
    connectionString: databaseUrl,
    ...options,
  });
}
