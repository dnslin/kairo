import { createRequire } from 'node:module';

export interface PostgresQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number | null;
}

export interface PostgresQueryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<PostgresQueryResult<Row>>;
}

export interface PostgresPool extends PostgresQueryExecutor {
  end(): Promise<void>;
}

export interface PostgresPoolOptions {
  allowExitOnIdle?: boolean;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
  max?: number;
  maxLifetimeSeconds?: number;
  maxUses?: number;
  min?: number;
}

interface PgModule {
  Pool: new (options: { connectionString: string } & PostgresPoolOptions) => PostgresPool;
}

const require = createRequire(import.meta.url);
const pg = require('pg') as unknown as PgModule;

export function createPostgresPool(
  databaseUrl = process.env.DATABASE_URL,
  options: PostgresPoolOptions = {}
): PostgresPool {
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error('缺少 PostgreSQL 连接地址，请设置 DATABASE_URL');
  }

  return new pg.Pool({
    connectionString: databaseUrl,
    ...options,
  });
}
