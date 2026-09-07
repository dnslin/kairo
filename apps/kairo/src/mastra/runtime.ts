import { Mastra } from '@mastra/core/mastra';
import type { PostgresStore } from '@mastra/pg';
import { createMastraStorage } from './storage.js';

export interface MastraRuntime {
  mastra: Mastra;
  storage: PostgresStore;
  close(): Promise<void>;
}

// 只创建进程内实例；默认 Server 和 Studio 只能由独立开发入口启动。
// 依据：https://mastra.ai/reference/cli/mastra
export function createMastraRuntime(databaseUrl?: string): MastraRuntime {
  const storage = createMastraStorage(databaseUrl);
  const mastra = new Mastra({ storage });
  let closing: Promise<void> | undefined;

  return {
    mastra,
    storage,
    close(): Promise<void> {
      closing ??= mastra.shutdown();
      return closing;
    },
  };
}
