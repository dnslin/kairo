import type { Client } from '@libsql/client';
import { createChildLogger } from '../utils/logger.js';
import { runKKBotMigrations } from './migrations.js';

const log = createChildLogger('schema');

/**
 * 数据库完整 DDL 建表与索引脚本
 * 包含组织架构三表与会话消息历史表
 */
export const SCHEMA_SQL = `
-- 部门表（支持树形层级与路径索引）
CREATE TABLE IF NOT EXISTS org_departments (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  parent_id TEXT,
  leader_id TEXT,
  path TEXT,
  level INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES org_departments(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_org_departments_parent_id ON org_departments(parent_id);
CREATE INDEX IF NOT EXISTS idx_org_departments_path ON org_departments(path);
CREATE INDEX IF NOT EXISTS idx_org_departments_level ON org_departments(level);

-- 员工档案表（支持工号、姓名、拼音首字母、手机号等多维度检索）
CREATE TABLE IF NOT EXISTS org_employees (
  id TEXT PRIMARY KEY,
  login_name TEXT NOT NULL,
  name TEXT NOT NULL,
  pinyin_abbr TEXT,
  phone TEXT,
  email TEXT,
  region TEXT,
  leader_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_employees_login_name ON org_employees(login_name);
CREATE INDEX IF NOT EXISTS idx_org_employees_name ON org_employees(name);
CREATE INDEX IF NOT EXISTS idx_org_employees_pinyin_abbr ON org_employees(pinyin_abbr);
CREATE INDEX IF NOT EXISTS idx_org_employees_phone ON org_employees(phone);
CREATE INDEX IF NOT EXISTS idx_org_employees_email ON org_employees(email);
CREATE INDEX IF NOT EXISTS idx_org_employees_region ON org_employees(region);

-- 员工与部门任职关系中间表（支持主职、多部门兼职与部门负责人关系）
CREATE TABLE IF NOT EXISTS org_employee_departments (
  employee_id TEXT NOT NULL,
  dept_id TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0,
  is_leader INTEGER NOT NULL DEFAULT 0,
  position TEXT,
  PRIMARY KEY (employee_id, dept_id),
  FOREIGN KEY (employee_id) REFERENCES org_employees(id) ON DELETE CASCADE,
  FOREIGN KEY (dept_id) REFERENCES org_departments(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_org_emp_dept_dept_id ON org_employee_departments(dept_id);
CREATE INDEX IF NOT EXISTS idx_org_emp_dept_emp_id ON org_employee_departments(employee_id);
CREATE INDEX IF NOT EXISTS idx_org_emp_dept_primary ON org_employee_departments(employee_id, is_primary);

-- 会话持久化状态表（支持状态元数据、人工退避时间戳、收发时间与工作模式）
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'private',
  employee_id TEXT,
  mode TEXT NOT NULL DEFAULT 'auto',
  human_takeover_until INTEGER NOT NULL DEFAULT 0,
  last_message_at INTEGER NOT NULL DEFAULT 0,
  last_reply_at INTEGER NOT NULL DEFAULT 0,
  daily_reply_count INTEGER NOT NULL DEFAULT 0,
  daily_count_reset_date TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (employee_id) REFERENCES org_employees(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_employee ON sessions(employee_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_msg ON sessions(last_message_at);
CREATE INDEX IF NOT EXISTS idx_sessions_mode ON sessions(mode);

-- 会话消息历史持久化表（支持原生 ID 精准撤回与多模态载荷，(session_id, message_id) 数据库唯一约束保护幂等）
CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,
  sender TEXT NOT NULL,
  sender_id TEXT,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  origin TEXT NOT NULL DEFAULT 'external',
  raw_payload TEXT,
  reply_target_id TEXT,
  is_from_self INTEGER NOT NULL DEFAULT 0,
  is_recalled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_message_id ON session_messages(message_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_message_id ON session_messages(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_created ON session_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_recalled ON session_messages(session_id, is_recalled, created_at);

-- Delivery 交付生命周期事实表（generated / sending / sent / failed / unknown / aborted）
CREATE TABLE IF NOT EXISTS message_deliveries (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  mastra_message_id TEXT NOT NULL,
  kk_message_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  memory_committed_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_message_deliveries_session_id ON message_deliveries(session_id);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_run_id ON message_deliveries(run_id);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_status ON message_deliveries(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_deliveries_run_content ON message_deliveries(run_id, content_hash);
`;

/**
 * 异步初始化数据库表结构与索引
 * @param client LibSQL 客户端实例
 */
export async function initSchema(client: Client): Promise<void> {
  log.debug('执行数据库表结构与版本化迁移初始化...');
  await runKKBotMigrations(client);
}
