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
 * 数据存储层错误
 */
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
    `);

    log.debug('数据库表结构已就绪');
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
      log.error({ err, type }, '记录事件失败');
      throw new StoreError('记录事件失败', err);
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
