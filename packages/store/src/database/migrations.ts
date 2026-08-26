import type { Client } from '@libsql/client';
import { SchemaInitError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
const log = createChildLogger('migrations');

export interface Migration {
  id: string;
  name: string;
  up: string;
}

export const MIGRATION_0001_INITIAL_SQL = `
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

-- 会话消息历史持久化表 (0001 基线：无 origin 列，普通索引)
CREATE TABLE IF NOT EXISTS session_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  message_id TEXT,
  sender TEXT NOT NULL,
  sender_id TEXT,
  content TEXT NOT NULL,
  message_type TEXT NOT NULL DEFAULT 'text',
  raw_payload TEXT,
  reply_target_id TEXT,
  is_from_self INTEGER NOT NULL DEFAULT 0,
  is_recalled INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_id ON session_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_message_id ON session_messages(message_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_message_id ON session_messages(session_id, message_id);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_created ON session_messages(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_session_messages_session_recalled ON session_messages(session_id, is_recalled, created_at);
`;

export const MIGRATION_0002_INBOUND_IDENTITY_SQL = `
-- 1. 为 session_messages 增加 origin 来源列
ALTER TABLE session_messages ADD COLUMN origin TEXT NOT NULL DEFAULT 'external';

-- 2. 预先清理历史遗留重复记录 (保留最早的一条记录)，确保唯一索引平滑建立
DELETE FROM session_messages
WHERE id NOT IN (
  SELECT MIN(id)
  FROM session_messages
  GROUP BY session_id, message_id
);

-- 3. 升级 (session_id, message_id) 索引为唯一索引：删除旧普通索引，创建唯一索引
DROP INDEX IF EXISTS idx_session_messages_session_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_session_messages_session_message_id ON session_messages(session_id, message_id);
`;

export const MIGRATION_0003_MESSAGE_DELIVERIES_SQL = `
-- 1. 创建 message_deliveries 交付生命周期表
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

-- 2. 创建索引
CREATE INDEX IF NOT EXISTS idx_message_deliveries_session_id ON message_deliveries(session_id);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_run_id ON message_deliveries(run_id);
CREATE INDEX IF NOT EXISTS idx_message_deliveries_status ON message_deliveries(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_deliveries_run_content ON message_deliveries(run_id, content_hash);
`;

/**
 * KKBot 内部版本化迁移脚本定义列表
 * 注意：所有 SQL 均为纯 KKBot 业务表，对 Mastra 内部表（mastra_*）实行零 DDL、零 DML
 */
export const KKBOT_MIGRATIONS: readonly Migration[] = [
  {
    id: '0001_initial_schema',
    name: 'Initial KKBot schema for organization and sessions',
    up: MIGRATION_0001_INITIAL_SQL,
  },
  {
    id: '0002_inbound_identity_and_groupsession_shortcircuit',
    name: 'Add message origin column and unique index for session_messages',
    up: MIGRATION_0002_INBOUND_IDENTITY_SQL,
  },
  {
    id: '0003_message_deliveries',
    name: 'Add message_deliveries table for delivery lifecycle and memory commit tracking',
    up: MIGRATION_0003_MESSAGE_DELIVERIES_SQL,
  },
];

export interface MigrationResult {
  applied: string[];
  total: number;
}

/**
 * 执行 KKBot 正式数据库迁移
 * 先确保创建迁移记录表 _kkbot_migrations，然后按序执行所有未应用的迁移脚本。
 *
 * @param client KKBot 专有 LibSQL Client 实例
 */
export async function runKKBotMigrations(client: Client): Promise<MigrationResult> {
  try {
    log.debug('开始检查并执行 KKBot 数据库迁移...');

    // 1. 创建迁移追踪表
    await client.execute(`
      CREATE TABLE IF NOT EXISTS _kkbot_migrations (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at INTEGER NOT NULL,
        checksum TEXT
      );
    `);

    // 2. 查询已应用的迁移
    const appliedResult = await client.execute('SELECT id FROM _kkbot_migrations');
    const appliedSet = new Set(
      appliedResult.rows.map(row => (typeof row.id === 'string' ? row.id : ''))
    );

    const newlyApplied: string[] = [];

    // 3. 顺序执行未应用的迁移
    for (const migration of KKBOT_MIGRATIONS) {
      if (!appliedSet.has(migration.id)) {
        log.info(
          { migrationId: migration.id, name: migration.name },
          '正在应用 KKBot 数据库迁移...'
        );

        // 执行迁移 DDL 脚本
        await client.executeMultiple(migration.up);

        // 记录迁移完成事实
        await client.execute({
          sql: 'INSERT INTO _kkbot_migrations (id, name, applied_at) VALUES (?, ?, ?)',
          args: [migration.id, migration.name, Date.now()],
        });

        newlyApplied.push(migration.id);
        log.info({ migrationId: migration.id }, 'KKBot 数据库迁移应用成功');
      }
    }

    log.debug(
      { newlyAppliedCount: newlyApplied.length, total: KKBOT_MIGRATIONS.length },
      'KKBot 数据库迁移流程全部完成'
    );

    return {
      applied: newlyApplied,
      total: KKBOT_MIGRATIONS.length,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error({ err }, 'KKBot 数据库迁移执行失败');
    throw new SchemaInitError(`KKBot 数据库迁移执行失败: ${err.message}`, err);
  }
}
