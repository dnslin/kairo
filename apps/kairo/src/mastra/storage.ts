import { PostgresStore } from '@mastra/pg';

const MASTRA_SCHEMA_NAME = 'mastra';
const MASTRA_STORAGE_ID = 'kairo-mastra-storage';

export function createMastraStorage(databaseUrl = process.env.DATABASE_URL): PostgresStore {
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error('缺少 PostgreSQL 连接地址，请设置 DATABASE_URL');
  }

  return new PostgresStore({
    id: MASTRA_STORAGE_ID,
    connectionString: databaseUrl,
    schemaName: MASTRA_SCHEMA_NAME,
    disableInit: true,
  });
}
