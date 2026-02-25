import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { StoreConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('store');

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
interface ProcessedRow {
  fingerprint: string;
  processed_at: number;
}

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

/**
 * 基于 SQLite 的数据存储层
 *
 * 提供消息指纹去重、会话历史管理、事件日志等功能。
 * 首次运行自动创建数据库文件和表结构。
 */
export class Store {
  private readonly db: DatabaseType;
  private readonly storeMessageContent: boolean;

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
    `);

    log.debug('数据库表结构已就绪');
  }

  /**
   * 检查消息是否已处理
   */
  isProcessed(fingerprint: string): boolean {
    try {
      const row = this.db
        .prepare('SELECT fingerprint FROM processed_messages WHERE fingerprint = ?')
        .get(fingerprint) as ProcessedRow | undefined;
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
      this.db
        .prepare(
          'INSERT OR IGNORE INTO processed_messages (fingerprint, processed_at) VALUES (?, ?)'
        )
        .run(fingerprint, Date.now());
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
   * @param n - 最多返回的消息数量
   * @returns 按时间正序排列的历史消息
   */
  getSessionHistory(sessionId: string, n: number): SessionMessage[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT id, session_id, sender, content, is_from_self, created_at
           FROM session_messages
           WHERE session_id = ?
           ORDER BY created_at DESC, id DESC
           LIMIT ?`
        )
        .all(sessionId, n) as SessionMessageRow[];

      // 反转为正序（最旧的在前）
      const messages = rows.reverse().map(
        (row): SessionMessage => ({
          sender: row.sender,
          content: this.storeMessageContent ? row.content : '[已隐藏]',
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
  saveMessage(
    sessionId: string,
    message: { sender: string; content: string; isFromSelf: boolean },
    sessionName?: string
  ): void {
    try {
      const now = Date.now();
      const contentToStore = this.storeMessageContent ? message.content : '';

      const saveTransaction = this.db.transaction(() => {
        // 确保会话记录存在（upsert）
        this.db
          .prepare(
            `INSERT INTO sessions (session_id, session_name, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(session_id) DO UPDATE SET
               session_name = COALESCE(excluded.session_name, sessions.session_name)`
          )
          .run(sessionId, sessionName ?? null, now);

        // 插入消息
        this.db
          .prepare(
            `INSERT INTO session_messages (session_id, sender, content, is_from_self, created_at)
             VALUES (?, ?, ?, ?, ?)`
          )
          .run(sessionId, message.sender, contentToStore, message.isFromSelf ? 1 : 0, now);

        // 如果是自己发送的消息，更新 last_reply_at
        if (message.isFromSelf) {
          this.db
            .prepare('UPDATE sessions SET last_reply_at = ? WHERE session_id = ?')
            .run(now, sessionId);
        }
      });

      saveTransaction();
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
   * @param data - 事件附加数据（可选，会序列化为 JSON）
   */
  logEvent(type: string, data?: unknown): void {
    try {
      const serializedData = data !== undefined ? JSON.stringify(data) : null;
      this.db
        .prepare('INSERT INTO events (type, data, created_at) VALUES (?, ?, ?)')
        .run(type, serializedData, Date.now());
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
      let rows: EventRow[];
      if (type !== undefined) {
        rows = this.db
          .prepare(
            'SELECT id, type, data, created_at FROM events WHERE type = ? ORDER BY created_at DESC, id DESC LIMIT ?'
          )
          .all(type, limit) as EventRow[];
      } else {
        rows = this.db
          .prepare('SELECT id, type, data, created_at FROM events ORDER BY created_at DESC, id DESC LIMIT ?')
          .all(limit) as EventRow[];
      }

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
