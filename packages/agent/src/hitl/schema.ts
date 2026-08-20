import type { Client } from '@libsql/client';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('hitl-schema');

/**
 * HITL 审批流核心数据表 SQLite DDL
 * 包含 workflow_resumed、tool_execution_status 状态追踪与 idempotencyKey 幂等支持
 */
export const APPROVAL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS approval_tasks (
  id TEXT PRIMARY KEY,
  tool_call_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  tool_args TEXT NOT NULL,
  applicant_id TEXT NOT NULL,
  applicant_name TEXT,
  leader_id TEXT NOT NULL,
  leader_name TEXT,
  thread_id TEXT NOT NULL,
  workflow_run_id TEXT,
  workflow_step_id TEXT,
  workflow_resumed INTEGER NOT NULL DEFAULT 0,
  tool_execution_status TEXT NOT NULL DEFAULT 'not_started' CHECK (tool_execution_status IN ('not_started', 'executing', 'succeeded', 'failed')),
  tool_execution_result TEXT,
  tool_execution_error TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'timed_out')),
  decision TEXT,
  timeout_ms INTEGER NOT NULL DEFAULT 60000,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_approval_leader_status ON approval_tasks(leader_id, status);
CREATE INDEX IF NOT EXISTS idx_approval_status ON approval_tasks(status);
CREATE INDEX IF NOT EXISTS idx_approval_thread ON approval_tasks(thread_id);
CREATE INDEX IF NOT EXISTS idx_approval_unresumed ON approval_tasks(workflow_resumed, status);
`;

/**
 * 初始化 HITL 审批流相关 SQLite 表结构与索引
 *
 * @param client 外部注入的 LibSQL 客户端实例
 */
export async function initApprovalSchema(client: Client): Promise<void> {
  try {
    log.debug('正在初始化 HITL 审批状态机 SQLite 表结构...');
    await client.executeMultiple(APPROVAL_SCHEMA_SQL);
    log.info('HITL 审批状态机 SQLite 表结构初始化完成');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err }, 'HITL 审批数据表结构初始化失败');
    throw err;
  }
}
