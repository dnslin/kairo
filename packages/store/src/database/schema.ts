import type Database from 'better-sqlite3';
import { SchemaInitError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('schema');

/**
 * 组织架构三表 DDL 建表脚本
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

-- 员工档案表（支持工号、姓名、手机号等维度检索）
CREATE TABLE IF NOT EXISTS org_employees (
  id TEXT PRIMARY KEY,
  login_name TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  region TEXT,
  leader_id TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_org_employees_login_name ON org_employees(login_name);
CREATE INDEX IF NOT EXISTS idx_org_employees_name ON org_employees(name);
CREATE INDEX IF NOT EXISTS idx_org_employees_phone ON org_employees(phone);
CREATE INDEX IF NOT EXISTS idx_org_employees_email ON org_employees(email);

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
`;

/**
 * 初始化数据库表结构与索引
 * @param db better-sqlite3 数据库实例
 */
export function initSchema(db: Database.Database): void {
  try {
    log.debug('开始执行数据库表结构与索引 DDL 初始化...');
    db.exec(SCHEMA_SQL);
    log.debug('数据库表结构与索引 DDL 初始化完成');
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err }, '初始化数据库表结构失败');
    throw new SchemaInitError('初始化数据库表结构失败', err);
  }
}
