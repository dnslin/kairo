import type { Client } from '@libsql/client';
import { initSchema as initStoreSchema } from '@kkbot/store';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('memory-schema');

/**
 * 记忆引擎专有数据表结构与索引 DDL
 */
export const MEMORY_SCHEMA_SQL = `
-- L2 会话级增量滚动工作摘要表
CREATE TABLE IF NOT EXISTS agent_working_summaries (
  thread_id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_id TEXT,
  last_summarized_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_working_summaries_thread ON agent_working_summaries(thread_id);

-- L3 员工实体画像与长期协同档案表 (按 resourceId 物理隔离)
CREATE TABLE IF NOT EXISTS agent_colleague_profiles (
  resource_id TEXT PRIMARY KEY,
  name TEXT,
  department TEXT,
  position TEXT,
  preferences TEXT NOT NULL DEFAULT '{}',
  key_facts TEXT NOT NULL DEFAULT '[]',
  recent_topics TEXT NOT NULL DEFAULT '[]',
  raw_summary TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_colleague_profiles_resource ON agent_colleague_profiles(resource_id);
`;

/**
 * 异步初始化记忆模块专属数据表与主库结构
 * @param client LibSQL 客户端实例
 */
export async function initMemorySchema(client: Client): Promise<void> {
  try {
    log.debug('开始初始化 LibSQL 核心库表与记忆引擎专属表结构...');
    // 1. 初始化基础仓储表结构 (session_messages, sessions, org_employees 等)
    await initStoreSchema(client);
    // 2. 初始化记忆引擎专有的 L2 摘要表与 L3 员工画像表
    await client.executeMultiple(MEMORY_SCHEMA_SQL);
    log.debug('记忆引擎专属表结构初始化完成');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err }, '初始化记忆引擎数据表结构失败');
    throw err;
  }
}
