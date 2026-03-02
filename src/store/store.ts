import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { StoreConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('store');

/**
 * 保存消息的输入参数
 */
export interface SaveMessageInput {
  /** 发送方名称 */
  sender: string;
  /** 消息内容 */
  content: string;
  /** 是否为自己发送 */
  isFromSelf: boolean;
}

/**
 * 会话消息数据结构
 */
export interface SessionMessage {
  /** 发送方名称 */
  sender: string;
  /** 消息内容 */
  content: string;
  /** 是否为自己发送 */
  isFromSelf: boolean;
  /** 创建时间戳 (毫秒) */
  createdAt: number;
}

/**
 * 事件日志数据结构
 */
export interface EventRecord {
  /** 事件 ID */
  id: number;
  /** 事件类型 */
  type: string;
  /** 事件数据 (JSON 字符串) */
  data: string | null;
  /** 创建时间戳 (毫秒) */
  createdAt: number;
}

/**
 * 草稿状态类型
 */
export type DraftStatus = 'pending' | 'sent' | 'edited_sent' | 'discarded';

/**
 * 保存草稿的输入参数
 */
export interface SaveDraftInput {
 /** 会话 ID */
 sessionId: string;
 /** 会话名称 */
 sessionName: string;
 /** 原始消息内容 */
 originalMessage: string;
 /** 原始消息发送者 */
 originalSender: string;
 /** LLM 生成的草稿内容 */
 draftContent: string;
}

/**
 * 草稿记录数据结构
 */
export interface DraftRecord {
 /** 草稿 ID */
 id: number;
 /** 会话 ID */
 sessionId: string;
 /** 会话名称 */
 sessionName: string;
 /** 原始消息内容 */
 originalMessage: string;
 /** 原始消息发送者 */
 originalSender: string;
 /** 草稿内容 */
 draftContent: string;
 /** 草稿状态 */
 status: DraftStatus;
 /** 创建时间戳 (毫秒) */
 createdAt: number;
 /** 更新时间戳 (毫秒) */
 updatedAt: number;
}

/**
 * 会话草稿计数
 */
export interface SessionDraftCount {
  /** 会话 ID */
  sessionId: string;
  /** 会话名称 */
  sessionName: string;
  /** 待处理草稿数量 */
  count: number;
}

/**
 * 会话摘要数据结构
 */
export interface SessionSummary {
  /** 摘要 ID */
  id: number;
  /** 会话 ID */
  sessionId: string;
  /** 摘要文本 */
  summaryText: string;
  /** 覆盖到的消息 ID（含） */
  coveredUpToId: number;
  /** 估算 token 数 */
  tokenCount: number;
  /** 创建时间戳 (毫秒) */
  createdAt: number;
}

/**
 * 数据存储层错误
 */
/**
 * 会话节流状态（含会话名称）
 */
export interface SessionThrottleInfo {
  sessionId: string;
  sessionName: string | null;
  lastReplyAt: number;
  dailyReplyCount: number;
  dailyCountResetDate: string | null;
}

/**
 * 节流状态数据结构
 */
export interface ThrottleState {
  /** 上次回复时间戳 (毫秒) */
  lastReplyAt: number;
  /** 当日回复计数 */
  dailyReplyCount: number;
  /** 计数重置日期 (YYYY-MM-DD) */
  dailyCountResetDate: string | null;
}

export class StoreError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'StoreError';
    this.originalCause = originalCause;
  }
}

/** SQLite 查询结果行类型 */
interface SessionMessageRow {
  id: number;
  session_id: string;
  sender: string;
  content: string;
  is_from_self: number;
  created_at: number;
}

interface EventRow {
  id: number;
  type: string;
  data: string | null;
  created_at: number;
}

interface DraftRow {
  id: number;
  session_id: string;
  session_name: string;
  original_message: string;
  original_sender: string;
  draft_content: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface SessionDraftCountRow {
  session_id: string;
  session_name: string;
  cnt: number;
}

interface ThrottleStateRow {
  last_reply_at: number;
  daily_reply_count: number;
  daily_count_reset_date: string | null;
}

interface SessionThrottleRow {
  session_id: string;
  session_name: string | null;
  last_reply_at: number;
  daily_reply_count: number;
  daily_count_reset_date: string | null;
}

interface SessionSummaryRow {
  id: number;
  session_id: string;
  summary_text: string;
  covered_up_to_id: number;
  token_count: number;
  created_at: number;
}

/** 预编译 SQL 语句集合 */
interface PreparedStatements {
  isProcessed: Statement;
  markProcessed: Statement;
  getSessionHistory: Statement;
  upsertSession: Statement;
  insertMessage: Statement;
  updateLastReply: Statement;
  insertEvent: Statement;
  getEventsByType: Statement;
  getEventsAll: Statement;
  insertDraft: Statement;
  getDraftsPending: Statement;
  getDraftById: Statement;
  updateDraftContent: Statement;
  updateDraftStatus: Statement;
  deleteDraft: Statement;
  getDraftsPendingBySession: Statement;
  getSessionDraftCounts: Statement;
  getEventsBySessionData: Statement;
  getLatestSummary: Statement;
  getMessageCountSince: Statement;
  saveSummary: Statement;
  getMaxMessageId: Statement;
  getThrottleState: Statement;
  incrementDailyReplyCount: Statement;
  resetDailyCount: Statement;
  getAllThrottleStates: Statement;
}

/**
 * 安全地将值序列化为 JSON 字符串
 * 处理循环引用等异常情况
 */
function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify({ _error: 'serialization_failed', _type: typeof data });
  }
}

/**
 * 基于 SQLite 的数据存储层
 *
 * 提供消息指纹去重、会话历史管理、事件日志等功能。
 * 首次运行自动创建数据库文件和表结构。
 */
export class Store {
  private readonly db: DatabaseType;
  private readonly storeMessageContent: boolean;
  private readonly stmts: PreparedStatements;
  private readonly saveTransaction: (
    sessionId: string,
    message: SaveMessageInput,
    sessionName: string | null,
    now: number,
    contentToStore: string
  ) => void;

  constructor(config: StoreConfig) {
    this.storeMessageContent = config.storeMessageContent;

    if (!config.dbPath) {
      throw new StoreError('数据库路径不能为空');
    }

    try {
      // 确保数据库目录存在
      const dbDir = dirname(config.dbPath);
      if (!existsSync(dbDir)) {
        mkdirSync(dbDir, { recursive: true });
        log.info({ dbDir }, '已创建数据库目录');
      }

      this.db = new Database(config.dbPath);

      // 启用 WAL 模式提升并发性能
      this.db.pragma('journal_mode = WAL');
      // 启用外键约束
      this.db.pragma('foreign_keys = ON');

      this.initTables();
      this.stmts = this.prepareStatements();
      this.saveTransaction = this.buildSaveTransaction();
      log.info({ dbPath: config.dbPath }, '数据存储层已初始化');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, '数据存储层初始化失败');
      throw new StoreError('数据存储层初始化失败', err);
    }
  }

  /**
   * 初始化表结构
   */
  private initTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS processed_messages (
        fingerprint TEXT PRIMARY KEY,
        processed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        session_name TEXT,
        last_reply_at INTEGER DEFAULT 0,
        daily_reply_count INTEGER DEFAULT 0,
        daily_count_reset_date TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        is_from_self INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        data TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_session
        ON session_messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_events_type
        ON events(type);
      CREATE INDEX IF NOT EXISTS idx_processed_messages_at
        ON processed_messages(processed_at);

      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_name TEXT NOT NULL,
        original_message TEXT NOT NULL,
        original_sender TEXT NOT NULL,
        draft_content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_drafts_status
        ON drafts(status);

      CREATE INDEX IF NOT EXISTS idx_drafts_session_status
        ON drafts(session_id, status);

      CREATE TABLE IF NOT EXISTS session_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        summary_text TEXT NOT NULL,
        covered_up_to_id INTEGER NOT NULL,
        token_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      );

      CREATE INDEX IF NOT EXISTS idx_session_summaries_session
        ON session_summaries(session_id);
    `);

    log.debug('数据库表结构已就绪');

    // 迁移：为已存在的 sessions 表添加节流字段
    this.migrateThrottleColumns();
  }

  /**
   * 迁移：为已存在的 sessions 表添加节流字段
   * 使用 PRAGMA table_info 检测字段是否存在，兼容旧数据库
   */
  private migrateThrottleColumns(): void {
    const columns = this.db.pragma('table_info(sessions)') as Array<{ name: string }>;
    const columnNames = new Set(columns.map(c => c.name));

    if (!columnNames.has('daily_reply_count')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN daily_reply_count INTEGER DEFAULT 0');
      log.info('迁移：sessions 表已添加 daily_reply_count 字段');
    }
    if (!columnNames.has('daily_count_reset_date')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN daily_count_reset_date TEXT');
      log.info('迁移：sessions 表已添加 daily_count_reset_date 字段');
    }
  }

  /**
   * 预编译所有 SQL 语句（性能关键）
   */
  private prepareStatements(): PreparedStatements {
    return {
      isProcessed: this.db.prepare('SELECT 1 FROM processed_messages WHERE fingerprint = ?'),
      markProcessed: this.db.prepare(
        'INSERT OR IGNORE INTO processed_messages (fingerprint, processed_at) VALUES (?, ?)'
      ),
      getSessionHistory: this.db.prepare(
        `SELECT id, session_id, sender, content, is_from_self, created_at
         FROM session_messages
         WHERE session_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      ),
      upsertSession: this.db.prepare(
        `INSERT INTO sessions (session_id, session_name, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           session_name = COALESCE(excluded.session_name, sessions.session_name)`
      ),
      insertMessage: this.db.prepare(
        `INSERT INTO session_messages (session_id, sender, content, is_from_self, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ),
      updateLastReply: this.db.prepare(
        'UPDATE sessions SET last_reply_at = ? WHERE session_id = ?'
      ),
      insertEvent: this.db.prepare('INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)'),
      getEventsByType: this.db.prepare(
        'SELECT id, type, data, created_at FROM events WHERE type = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      ),
      getEventsAll: this.db.prepare(
        'SELECT id, type, data, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT ?'
      ),
      insertDraft: this.db.prepare(
        `INSERT INTO drafts (session_id, session_name, original_message, original_sender, draft_content, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`
      ),
      getDraftsPending: this.db.prepare(
        `SELECT id, session_id, session_name, original_message, original_sender, draft_content, status, created_at, updated_at
         FROM drafts
         WHERE status = 'pending'
         ORDER BY created_at DESC, id DESC`
      ),
      getDraftById: this.db.prepare(
        `SELECT id, session_id, session_name, original_message, original_sender, draft_content, status, created_at, updated_at
         FROM drafts
         WHERE id = ?`
      ),
      updateDraftContent: this.db.prepare(
        'UPDATE drafts SET draft_content = ?, updated_at = ? WHERE id = ?'
      ),
      updateDraftStatus: this.db.prepare(
        'UPDATE drafts SET status = ?, updated_at = ? WHERE id = ?'
      ),
      deleteDraft: this.db.prepare(
        'DELETE FROM drafts WHERE id = ?'
      ),
      getDraftsPendingBySession: this.db.prepare(
        `SELECT id, session_id, session_name, original_message, original_sender, draft_content, status, created_at, updated_at
         FROM drafts
         WHERE status = 'pending' AND session_id = ?
         ORDER BY created_at DESC, id DESC`
      ),
      getSessionDraftCounts: this.db.prepare(
        `SELECT session_id, session_name, COUNT(*) as cnt
         FROM drafts
         WHERE status = 'pending'
         GROUP BY session_id
         ORDER BY MAX(created_at) DESC`
      ),
      getEventsBySessionData: this.db.prepare(
        `SELECT id, type, data, created_at
         FROM events
         WHERE json_extract(data, '$.sessionId') = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      ),
      getLatestSummary: this.db.prepare(
        `SELECT id, session_id, summary_text, covered_up_to_id, token_count, created_at
         FROM session_summaries
         WHERE session_id = ?
         ORDER BY id DESC
         LIMIT 1`
      ),
      getMessageCountSince: this.db.prepare(
        `SELECT COUNT(*) as cnt FROM session_messages WHERE session_id = ? AND id > ?`
      ),
      saveSummary: this.db.prepare(
        `INSERT INTO session_summaries (session_id, summary_text, covered_up_to_id, token_count, created_at)
         VALUES (?, ?, ?, ?, ?)`
      ),
      getMaxMessageId: this.db.prepare(
        `SELECT MAX(id) as max_id FROM session_messages WHERE session_id = ?`
      ),
      getThrottleState: this.db.prepare(
        `SELECT last_reply_at, daily_reply_count, daily_count_reset_date
         FROM sessions WHERE session_id = ?`
      ),
      incrementDailyReplyCount: this.db.prepare(
        `UPDATE sessions SET daily_reply_count = daily_reply_count + 1, last_reply_at = ? WHERE session_id = ?`
      ),
      resetDailyCount: this.db.prepare(
        `UPDATE sessions SET daily_reply_count = 0, daily_count_reset_date = ? WHERE session_id = ?`
      ),
      getAllThrottleStates: this.db.prepare(
        `SELECT session_id, session_name, last_reply_at, daily_reply_count, daily_count_reset_date
         FROM sessions
         WHERE daily_reply_count > 0 OR last_reply_at > 0
         ORDER BY last_reply_at DESC`
      ),
    };
  }

  /**
   * 预编译保存消息的事务
   */
  private buildSaveTransaction(): (
    sessionId: string,
    message: SaveMessageInput,
    sessionName: string | null,
    now: number,
    contentToStore: string
  ) => void {
    return this.db.transaction(
      (
        sessionId: string,
        message: SaveMessageInput,
        sessionName: string | null,
        now: number,
        contentToStore: string
      ) => {
        // 确保会话记录存在（upsert）
        this.stmts.upsertSession.run(sessionId, sessionName, now);

        // 插入消息
        this.stmts.insertMessage.run(
          sessionId,
          message.sender,
          contentToStore,
          message.isFromSelf ? 1 : 0,
          now
        );

        // 如果是自己发送的消息，更新 last_reply_at
        if (message.isFromSelf) {
          this.stmts.updateLastReply.run(now, sessionId);
        }
      }
    );
  }

  /**
   * 检查消息是否已处理
   */
  isProcessed(fingerprint: string): boolean {
    try {
      const row = this.stmts.isProcessed.get(fingerprint) as Record<string, unknown> | undefined;
      return row !== undefined;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, fingerprint }, '检查消息指纹失败');
      throw new StoreError('检查消息指纹失败', err);
    }
  }

  /**
   * 标记消息已处理
   */
  markProcessed(fingerprint: string): void {
    try {
      this.stmts.markProcessed.run(fingerprint, Date.now());
      log.debug({ fingerprint }, '消息已标记为已处理');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, fingerprint }, '标记消息指纹失败');
      throw new StoreError('标记消息指纹失败', err);
    }
  }

  /**
   * 获取会话历史消息
   *
   * @param sessionId - 会话 ID
   * @param n - 最多返回的消息数量（必须 >= 0）
   * @returns 按时间正序排列的历史消息
   */
  getSessionHistory(sessionId: string, n: number): SessionMessage[] {
    if (n <= 0) {
      return [];
    }

    try {
      const rows = this.stmts.getSessionHistory.all(sessionId, n) as SessionMessageRow[];

      // 反转为正序（最旧的在前）
      const messages = rows.reverse().map(
        (row): SessionMessage => ({
          sender: row.sender,
          content: row.content || '[已隐藏]',
          isFromSelf: row.is_from_self === 1,
          createdAt: row.created_at,
        })
      );

      log.debug({ sessionId, requested: n, returned: messages.length }, '获取会话历史');
      return messages;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '获取会话历史失败');
      throw new StoreError('获取会话历史失败', err);
    }
  }

  /**
   * 保存会话消息
   *
   * 自动创建或更新会话记录，然后插入消息。
   *
   * @param sessionId - 会话 ID
   * @param message - 消息数据
   * @param sessionName - 会话名称（可选，用于创建/更新会话记录）
   */
  saveMessage(sessionId: string, message: SaveMessageInput, sessionName?: string): void {
    try {
      const now = Date.now();
      const contentToStore = this.storeMessageContent ? message.content : '';

      this.saveTransaction(sessionId, message, sessionName ?? null, now, contentToStore);
      log.debug({ sessionId, sender: message.sender }, '消息已保存');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '保存消息失败');
      throw new StoreError('保存消息失败', err);
    }
  }

  /**
   * 记录操作日志
   *
   * @param type - 事件类型（如 'message_sent', 'llm_call', 'error' 等）
   * @param data - 事件附加数据（可选，会序列化为 JSON，循环引用安全）
   */
  logEvent(type: string, data?: unknown): void {
    try {
      const serializedData = data !== undefined ? safeStringify(data) : null;
      this.stmts.insertEvent.run(type, serializedData, Date.now());
      log.debug({ type }, '事件已记录');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      // 事件日志是旁路能力，失败时仅记录告警，避免阻断主流程。
      log.warn({ err, type }, '记录事件失败，已降级为非致命');
    }
  }

  /**
   * 查询事件日志
   *
   * @param type - 事件类型过滤（可选）
   * @param limit - 最多返回条数
   * @returns 按时间倒序排列的事件
   */
  getEvents(type?: string, limit = 100): EventRecord[] {
    try {
      const rows =
        type !== undefined
          ? (this.stmts.getEventsByType.all(type, limit) as EventRow[])
          : (this.stmts.getEventsAll.all(limit) as EventRow[]);

      return rows.map(
        (row): EventRecord => ({
          id: row.id,
          type: row.type,
          data: row.data,
          createdAt: row.created_at,
        })
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, type }, '查询事件失败');
      throw new StoreError('查询事件失败', err);
    }
  }


  /**
 * 将 DraftRow 转换为 DraftRecord
 */
  private toDraftRecord(row: DraftRow): DraftRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      sessionName: row.session_name,
      originalMessage: row.original_message,
      originalSender: row.original_sender,
      draftContent: row.draft_content,
      status: row.status as DraftStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 保存回复草稿
   *
   * @param input - 草稿输入数据
   * @returns 新创建的草稿 ID
   */
  saveDraft(input: SaveDraftInput): number {
    try {
      const now = Date.now();
      const result = this.stmts.insertDraft.run(
        input.sessionId,
        input.sessionName,
        input.originalMessage,
        input.originalSender,
        input.draftContent,
        now,
        now
      );
      const draftId = Number(result.lastInsertRowid);
      log.debug({ draftId, sessionId: input.sessionId }, '草稿已保存');
      return draftId;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId: input.sessionId }, '保存草稿失败');
      throw new StoreError('保存草稿失败', err);
    }
  }

  /**
   * 获取所有待确认草稿
   *
   * @returns 按时间倒序排列的待确认草稿列表
   */
  getPendingDrafts(): DraftRecord[] {
    try {
      const rows = this.stmts.getDraftsPending.all() as DraftRow[];
      return rows.map(row => this.toDraftRecord(row));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, '获取待确认草稿失败');
      throw new StoreError('获取待确认草稿失败', err);
    }
  }

  /**
   * 按会话获取待确认草稿
   *
   * @param sessionId - 会话 ID
   * @returns 按时间倒序排列的待确认草稿列表
   */
  getPendingDraftsBySession(sessionId: string): DraftRecord[] {
    try {
      const rows = this.stmts.getDraftsPendingBySession.all(sessionId) as DraftRow[];
      return rows.map(row => this.toDraftRecord(row));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '按会话获取待确认草稿失败');
      throw new StoreError('按会话获取待确认草稿失败', err);
    }
  }

  /**
   * 获取各会话的待处理草稿计数
   *
   * @returns 按最新草稿时间倒序排列的会话草稿计数
   */
  getSessionDraftCounts(): SessionDraftCount[] {
    try {
      const rows = this.stmts.getSessionDraftCounts.all() as SessionDraftCountRow[];
      return rows.map((row): SessionDraftCount => ({
        sessionId: row.session_id,
        sessionName: row.session_name,
        count: row.cnt,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, '获取会话草稿计数失败');
      throw new StoreError('获取会话草稿计数失败', err);
    }
  }

  /**
   * 按会话 ID 查询事件日志
   *
   * @param sessionId - 会话 ID
   * @param limit - 最多返回条数
   * @returns 按时间倒序排列的事件
   */
  getEventsBySessionId(sessionId: string, limit = 100): EventRecord[] {
    try {
      const rows = this.stmts.getEventsBySessionData.all(sessionId, limit) as EventRow[];
      return rows.map((row): EventRecord => ({
        id: row.id,
        type: row.type,
        data: row.data,
        createdAt: row.created_at,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '按会话查询事件失败');
      throw new StoreError('按会话查询事件失败', err);
    }
  }

  /**
   * 根据 ID 获取草稿
   *
   * @param id - 草稿 ID
   * @returns 草稿记录，不存在时返回 null
   */
  getDraftById(id: number): DraftRecord | null {
    try {
      const row = this.stmts.getDraftById.get(id) as DraftRow | undefined;
      if (!row) {
        return null;
      }
      return this.toDraftRecord(row);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, draftId: id }, '获取草稿失败');
      throw new StoreError('获取草稿失败', err);
    }
  }

  /**
   * 更新草稿内容（编辑后发送场景）
   *
   * @param id - 草稿 ID
   * @param newContent - 新的草稿内容
   */
  updateDraftContent(id: number, newContent: string): void {
    try {
      this.stmts.updateDraftContent.run(newContent, Date.now(), id);
      log.debug({ draftId: id }, '草稿内容已更新');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, draftId: id }, '更新草稿内容失败');
      throw new StoreError('更新草稿内容失败', err);
    }
  }

  /**
   * 更新草稿状态
   *
   * @param id - 草稿 ID
   * @param status - 新状态
   */
  updateDraftStatus(id: number, status: DraftStatus): void {
    try {
      this.stmts.updateDraftStatus.run(status, Date.now(), id);
      log.debug({ draftId: id, status }, '草稿状态已更新');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, draftId: id }, '更新草稿状态失败');
      throw new StoreError('更新草稿状态失败', err);
    }
  }

  /**
   * 删除草稿
   *
   * @param id - 草稿 ID
   */
  deleteDraft(id: number): void {
    try {
      this.stmts.deleteDraft.run(id);
      log.debug({ draftId: id }, '草稿已删除');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, draftId: id }, '删除草稿失败');
      throw new StoreError('删除草稿失败', err);
    }
  }
  /**
   * 获取会话最新摘要
   *
   * @param sessionId - 会话 ID
   * @returns 最新摘要，不存在时返回 null
   */
  getLatestSummary(sessionId: string): SessionSummary | null {
    try {
      const row = this.stmts.getLatestSummary.get(sessionId) as SessionSummaryRow | undefined;
      if (!row) {
        return null;
      }
      return {
        id: row.id,
        sessionId: row.session_id,
        summaryText: row.summary_text,
        coveredUpToId: row.covered_up_to_id,
        tokenCount: row.token_count,
        createdAt: row.created_at,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '获取会话摘要失败');
      throw new StoreError('获取会话摘要失败', err);
    }
  }

  /**
   * 获取指定消息 ID 之后的消息数量
   *
   * @param sessionId - 会话 ID
   * @param sinceId - 起始消息 ID（不含）
   * @returns 消息数量
   */
  getMessageCountSince(sessionId: string, sinceId: number): number {
    try {
      const row = this.stmts.getMessageCountSince.get(sessionId, sinceId) as { cnt: number } | undefined;
      return row?.cnt ?? 0;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '获取消息计数失败');
      throw new StoreError('获取消息计数失败', err);
    }
  }

  /**
   * 获取会话最大消息 ID
   *
   * @param sessionId - 会话 ID
   * @returns 最大消息 ID，无消息时返回 0
   */
  getMaxMessageId(sessionId: string): number {
    try {
      const row = this.stmts.getMaxMessageId.get(sessionId) as { max_id: number | null } | undefined;
      return row?.max_id ?? 0;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '获取最大消息 ID 失败');
      throw new StoreError('获取最大消息 ID 失败', err);
    }
  }

  /**
   * 保存会话摘要
   *
   * @param sessionId - 会话 ID
   * @param summaryText - 摘要文本
   * @param coveredUpToId - 覆盖到的消息 ID
   * @param tokenCount - 估算 token 数
   * @returns 新创建的摘要 ID
   */
  saveSummary(sessionId: string, summaryText: string, coveredUpToId: number, tokenCount: number): number {
    try {
      const result = this.stmts.saveSummary.run(sessionId, summaryText, coveredUpToId, tokenCount, Date.now());
      const summaryId = Number(result.lastInsertRowid);
      log.debug({ summaryId, sessionId, coveredUpToId }, '会话摘要已保存');
      return summaryId;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '保存会话摘要失败');
      throw new StoreError('保存会话摘要失败', err);
    }
  }

  /**
   * 获取会话节流状态
   *
   * @param sessionId - 会话 ID
   * @returns 节流状态（会话不存在时返回默认值）
   */
  getThrottleState(sessionId: string): ThrottleState {
    try {
      const row = this.stmts.getThrottleState.get(sessionId) as ThrottleStateRow | undefined;
      if (!row) {
        return { lastReplyAt: 0, dailyReplyCount: 0, dailyCountResetDate: null };
      }
      return {
        lastReplyAt: row.last_reply_at,
        dailyReplyCount: row.daily_reply_count,
        dailyCountResetDate: row.daily_count_reset_date,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '获取节流状态失败');
      throw new StoreError('获取节流状态失败', err);
    }
  }

  /**
   * 递增会话当日回复计数并更新 lastReplyAt
   *
   * @param sessionId - 会话 ID
   */
  incrementDailyReplyCount(sessionId: string): void {
    try {
      this.stmts.incrementDailyReplyCount.run(Date.now(), sessionId);
      log.debug({ sessionId }, '当日回复计数已递增');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '递增回复计数失败');
      throw new StoreError('递增回复计数失败', err);
    }
  }

  /**
   * 重置会话当日回复计数
   *
   * @param sessionId - 会话 ID
   * @param todayStr - 今日日期字符串 (YYYY-MM-DD)
   */
  resetDailyCount(sessionId: string, todayStr: string): void {
    try {
      this.stmts.resetDailyCount.run(todayStr, sessionId);
      log.debug({ sessionId, date: todayStr }, '当日回复计数已重置');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, sessionId }, '重置回复计数失败');
      throw new StoreError('重置回复计数失败', err);
    }
  }

  /**
   * 获取所有有回复记录的会话节流状态
   *
   * @returns 按最后回复时间倒序排列的会话节流信息
   */
  getAllThrottleStates(): SessionThrottleInfo[] {
    try {
      const rows = this.stmts.getAllThrottleStates.all() as SessionThrottleRow[];
      return rows.map((row): SessionThrottleInfo => ({
        sessionId: row.session_id,
        sessionName: row.session_name,
        lastReplyAt: row.last_reply_at,
        dailyReplyCount: row.daily_reply_count,
        dailyCountResetDate: row.daily_count_reset_date,
      }));
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, '获取全部节流状态失败');
      throw new StoreError('获取全部节流状态失败', err);
    }
  }

  /**
   * 关闭数据库连接
   */
  close(): void {
    try {
      this.db.close();
      log.info('数据库连接已关闭');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, '关闭数据库失败');
      throw new StoreError('关闭数据库失败', err);
    }
  }
}
