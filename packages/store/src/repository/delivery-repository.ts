import type { Client, InValue } from '@libsql/client';
import type {
  CreateDeliveryInput,
  Delivery,
  DeliveryStatus,
  UpdateDeliveryStatusOptions,
} from '../types/index.js';
import { DatabaseError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('delivery-repo');

interface DeliveryRow {
  id: string;
  run_id: string;
  session_id: string;
  mastra_message_id: string;
  kk_message_id: string | null;
  content: string;
  content_hash: string;
  status: string;
  memory_committed_at: number | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}
function mapRowToDelivery(row: DeliveryRow): Delivery {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    mastraMessageId: String(row.mastra_message_id),
    kkMessageId: row.kk_message_id ? String(row.kk_message_id) : null,
    content: String(row.content),
    contentHash: String(row.content_hash),
    status: row.status as DeliveryStatus,
    memoryCommittedAt:
      row.memory_committed_at !== null && row.memory_committed_at !== undefined
        ? Number(row.memory_committed_at)
        : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * DeliveryRepository: 负责 Delivery 交付实体及其生命周期状态持久化
 *
 * 核心契约：
 * 1. Delivery 是未发送生成结果和发送生命周期的唯一业务身份（不建立独立 Draft）。
 * 2. 状态机迁移固定为 generated -> sending -> sent / failed / unknown / aborted。
 * 3. run_id + content_hash 唯一约束防止并发创建与重复记录。
 * 4. 只有 sent 持久化成功后才能记录 memory_committed_at。
 * 5. 提供 sent-but-uncommitted 检索能力 (status = 'sent' AND memory_committed_at IS NULL)。
 */
export class DeliveryRepository {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 创建新的 Delivery 记录（默认初始状态为 generated）
   * 采用 ON CONFLICT (run_id, content_hash) DO NOTHING 保证幂等
   */
  async createDelivery(input: CreateDeliveryInput): Promise<Delivery> {
    const now = input.createdAt ?? Date.now();
    const status: DeliveryStatus = input.status ?? 'generated';
    const kkMessageId = input.kkMessageId ?? null;
    const errorCode = input.errorCode ?? null;

    try {
      await this.client.execute({
        sql: `
          INSERT INTO message_deliveries (
            id, run_id, session_id, mastra_message_id, kk_message_id,
            content, content_hash, status, memory_committed_at, error_code,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
          ON CONFLICT(run_id, content_hash) DO NOTHING
        `,
        args: [
          input.id,
          input.runId,
          input.sessionId,
          input.mastraMessageId,
          kkMessageId,
          input.content,
          input.contentHash,
          status,
          errorCode,
          now,
          now,
        ],
      });

      const existing = await this.getDeliveryByRunAndHash(input.runId, input.contentHash);
      if (existing) {
        return existing;
      }

      const byId = await this.getDeliveryById(input.id);
      if (byId) {
        return byId;
      }

      throw new DatabaseError(`创建 Delivery 记录失败，未查找到记录: ID [${input.id}]`);
    } catch (err) {
      if (err instanceof DatabaseError) {
        throw err;
      }
      log.error({ err, id: input.id, runId: input.runId }, '创建 Delivery 异常');
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`创建 Delivery 异常: ${cause.message}`, cause);
    }
  }

  /**
   * 更新 Delivery 状态及关联字段
   */
  async updateStatus(
    id: string,
    status: DeliveryStatus,
    options?: UpdateDeliveryStatusOptions
  ): Promise<Delivery> {
    const now = options?.updatedAt ?? Date.now();

    try {
      const setClauses: string[] = ['status = ?', 'updated_at = ?'];
      const args: InValue[] = [status, now];

      if (options?.kkMessageId !== undefined) {
        setClauses.push('kk_message_id = ?');
        args.push(options.kkMessageId);
      }
      if (options?.errorCode !== undefined) {
        setClauses.push('error_code = ?');
        args.push(options.errorCode);
      }

      args.push(id);

      const res = await this.client.execute({
        sql: `UPDATE message_deliveries SET ${setClauses.join(', ')} WHERE id = ?`,
        args,
      });

      if (res.rowsAffected === 0) {
        throw new DatabaseError(`更新 Delivery 状态失败: 未找到 ID 为 [${id}] 的记录`);
      }

      const updated = await this.getDeliveryById(id);
      if (!updated) {
        throw new DatabaseError(`更新 Delivery 状态后未能读取到记录: ${id}`);
      }

      return updated;
    } catch (err) {
      if (err instanceof DatabaseError) {
        throw err;
      }
      log.error({ err, id, status }, '更新 Delivery 状态异常');
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`更新 Delivery 状态异常: ${cause.message}`, cause);
    }
  }

  /**
   * 标记 Delivery 的 Memory 提交完成 (写入 memory_committed_at)
   */
  async markMemoryCommitted(id: string, timestamp?: number): Promise<Delivery> {
    const now = timestamp ?? Date.now();
    try {
      const res = await this.client.execute({
        sql: `UPDATE message_deliveries SET memory_committed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent'`,
        args: [now, now, id],
      });
      if (res.rowsAffected === 0) {
        throw new DatabaseError(
          `标记 Delivery Memory 提交失败: 未找到 ID 为 [${id}] 且状态为 sent 的记录`
        );
      }

      const updated = await this.getDeliveryById(id);
      if (!updated) {
        throw new DatabaseError(`标记 Delivery Memory 提交后未能读取到记录: ${id}`);
      }

      return updated;
    } catch (err) {
      if (err instanceof DatabaseError) {
        throw err;
      }
      log.error({ err, id }, '标记 Delivery Memory 提交异常');
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`标记 Delivery Memory 提交异常: ${cause.message}`, cause);
    }
  }

  /**
   * 按主键 ID 查询 Delivery
   */
  async getDeliveryById(id: string): Promise<Delivery | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE id = ? LIMIT 1`,
      args: [id],
    });

    if (res.rows.length === 0) {
      return null;
    }

    return mapRowToDelivery(res.rows[0] as unknown as DeliveryRow);
  }

  /**
   * 按 runId 和 contentHash 查询 Delivery
   */
  async getDeliveryByRunAndHash(runId: string, contentHash: string): Promise<Delivery | null> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE run_id = ? AND content_hash = ? LIMIT 1`,
      args: [runId, contentHash],
    });

    if (res.rows.length === 0) {
      return null;
    }

    return mapRowToDelivery(res.rows[0] as unknown as DeliveryRow);
  }

  /**
   * 查询指定会话的所有 Delivery 列表（按创建时间升序）
   */
  async getDeliveriesBySession(sessionId: string): Promise<Delivery[]> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE session_id = ? ORDER BY created_at ASC`,
      args: [sessionId],
    });

    return res.rows.map(row => mapRowToDelivery(row as unknown as DeliveryRow));
  }

  /**
   * 查询指定 runId 的所有 Delivery 列表
   */
  async getDeliveriesByRunId(runId: string): Promise<Delivery[]> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE run_id = ? ORDER BY created_at ASC`,
      args: [runId],
    });

    return res.rows.map(row => mapRowToDelivery(row as unknown as DeliveryRow));
  }

  /**
   * 查询所有已发送但尚未提交 Memory 的 Delivery (sent-but-uncommitted 检查点)
   */
  async getSentUncommittedDeliveries(): Promise<Delivery[]> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE status = 'sent' AND memory_committed_at IS NULL ORDER BY created_at ASC`,
      args: [],
    });

    return res.rows.map(row => mapRowToDelivery(row as unknown as DeliveryRow));
  }
}
