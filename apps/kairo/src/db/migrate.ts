import { fileURLToPath } from 'node:url';
import { runner } from 'node-pg-migrate';
import type { RunnerOption } from 'node-pg-migrate';

export const KAIRO_SCHEMA = 'kairo';
export const MIGRATIONS_TABLE = 'pgmigrations';

export interface MigrateDatabaseOptions {
  databaseUrl?: string;
  migrationsDir?: string;
}
export interface MigrationRun {
  readonly path: string;
  readonly name: string;
  readonly timestamp: number;
}

export function getMigrationsDirectory(): string {
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

export async function migrateDatabase(
  options: MigrateDatabaseOptions = {}
): Promise<MigrationRun[]> {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl || databaseUrl.trim().length === 0) {
    throw new Error('缺少 PostgreSQL 连接地址，请设置 DATABASE_URL');
  }

  const runnerOptions: RunnerOption = {
    databaseUrl,
    dir: options.migrationsDir ?? getMigrationsDirectory(),
    direction: 'up',
    schema: KAIRO_SCHEMA,
    createSchema: true,
    migrationsSchema: KAIRO_SCHEMA,
    createMigrationsSchema: true,
    migrationsTable: MIGRATIONS_TABLE,
    migrationLoaderStrategies: [{ extensions: ['.sql'], loader: 'sql' }],
    singleTransaction: true,
    noLock: false,
    advisoryLockMode: 'wait',
  };

  return runner(runnerOptions);
}
