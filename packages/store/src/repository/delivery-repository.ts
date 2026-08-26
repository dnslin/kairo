import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Client, InValue, Transaction } from '@libsql/client';
import type {
  AdjudicateDeliveryInput,
  CreateDeliveryInput,
  Delivery,
  DeliveryAdjudicationDecision,
  DeliveryAdjudicationRecord,
  DeliveryStatus,
  UpdateDeliveryStatusOptions,
} from '../types/index.js';
import { DatabaseError, DeliveryStateTransitionError, StoreError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('delivery-repo');

interface DeliveryRow {
  id: string;
  run_id: string;
  session_id: string;
  mastra_message_id: string;
  kk_message_id: string | null;
  content: string;
  contentHash?: string;
  content_hash: string;
  status: string;
  memory_committed_at: number | null;
  error_code: string | null;
  retry_count?: number | null;
  created_at: number;
  updated_at: number;
}


interface DeliveryAdjudicationRow {
  id: string;
  delivery_id: string;
  operator: string;
  decision: string;
  evidence_summary: string;
  created_at: number;
}

function mapRowToAdjudication(row: DeliveryAdjudicationRow): DeliveryAdjudicationRecord {
  return {
    id: String(row.id),
    deliveryId: String(row.delivery_id),
    operator: String(row.operator),
    decision: row.decision as DeliveryAdjudicationDecision,
    evidenceSummary: String(row.evidence_summary),
    createdAt: Number(row.created_at),
  };
}
function mapRowToDelivery(row: DeliveryRow): Delivery {
  return {
    id: String(row.id),
    runId: String(row.run_id),
    sessionId: String(row.session_id),
    mastraMessageId: String(row.mastra_message_id),
    kkMessageId: row.kk_message_id ? String(row.kk_message_id) : null,
    content: String(row.content),
    contentHash: String(row.content_hash || row.contentHash || ''),
    status: row.status as DeliveryStatus,
    memoryCommittedAt:
      row.memory_committed_at !== null && row.memory_committed_at !== undefined
        ? Number(row.memory_committed_at)
        : null,
    errorCode: row.error_code ? String(row.error_code) : null,
    retryCount:
      row.retry_count !== null && row.retry_count !== undefined ? Number(row.retry_count) : 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * 允许的状态迁移规则表 (目标状态 -> 允许的来源状态集合)
 */
const ALLOWED_FROM_STATUSES: Record<DeliveryStatus, readonly DeliveryStatus[]> = {
  sending: ['generated', 'failed'], // failed 仅在 isRetry 为 true 时允许
  aborted: ['generated', 'sending'], // 仅限证明发送动作尚未触发前的主动中止
  failed: ['generated', 'sending'],
  sent: ['sending'], // 正常流程仅允许 sending -> sent；unknown -> sent 必须经过 adjudicateDelivery 事务
  unknown: ['sending'],
  generated: [], // generated 仅限初始创建
};

async function withWriteTransaction<T>(
  client: Client,
  fn: (tx: Transaction) => Promise<T>,
  maxRetries = 10
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      const tx = await client.transaction('write');
      try {
        const result = await fn(tx);
        await tx.commit();
        return result;
      } catch (err) {
        try {
          await tx.rollback();
        } catch {
          // 忽略回滚异常
        }
        throw err;
      }
    } catch (err: unknown) {
      const isBusy =
        err instanceof Error &&
        (err.message.includes('SQLITE_BUSY') ||
          err.message.includes('database is locked') ||
          (err as { code?: string }).code === 'SQLITE_BUSY');

      if (isBusy && attempt < maxRetries) {
        attempt++;
        await sleep(20 * attempt + Math.floor(Math.random() * 20));
        continue;
      }
      throw err;
    }
  }
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
  private writeMutex: Promise<void> = Promise.resolve();

  constructor(client: Client) {
    this.client = client;
  }

  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.writeMutex;
    let release: () => void;
    this.writeMutex = new Promise<void>(r => {
      release = r;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release!();
    }
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
    const retryCount = input.retryCount ?? 0;

    try {
      await this.client.execute({
        sql: `
          INSERT INTO message_deliveries (
            id, run_id, session_id, mastra_message_id, kk_message_id,
            content, content_hash, status, memory_committed_at, error_code,
            retry_count, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)
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
          retryCount,
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
   * 条件更新 Delivery 状态 (受 CAS 与合法状态机转换规则保护)
   */
  async updateStatus(
    id: string,
    status: DeliveryStatus,
    options?: UpdateDeliveryStatusOptions
  ): Promise<Delivery> {
    const now = options?.updatedAt ?? Date.now();

    const current = await this.getDeliveryById(id);
    if (!current) {
      throw new DatabaseError(`更新 Delivery 状态失败: 未找到 ID 为 [${id}] 的记录`);
    }

    // 1. 幂等重放检查：若目标状态与当前状态完全相同
    if (current.status === status) {
      // 终态保护：对于 sent / aborted 终态，若传入不同的证据字段，禁止改写并抛出异常
      if (current.status === 'sent' || current.status === 'aborted') {
        if (
          (options?.kkMessageId !== undefined && options.kkMessageId !== current.kkMessageId) ||
          (options?.errorCode !== undefined && options.errorCode !== current.errorCode)
        ) {
          throw new DeliveryStateTransitionError(
            id,
            current.status,
            status,
            `Delivery [${id}] 已处于终态 [${current.status}]，禁止通过重放改写已确认的交付证据`
          );
        }
        return current;
      }

      if (
        (options?.kkMessageId !== undefined && options.kkMessageId !== current.kkMessageId) ||
        (options?.errorCode !== undefined && options.errorCode !== current.errorCode)
      ) {
        const patchClauses: string[] = ['updated_at = ?'];
        const patchArgs: InValue[] = [now];
        if (options?.kkMessageId !== undefined) {
          patchClauses.push('kk_message_id = ?');
          patchArgs.push(options.kkMessageId);
        }
        if (options?.errorCode !== undefined) {
          patchClauses.push('error_code = ?');
          patchArgs.push(options.errorCode);
        }
        patchArgs.push(id, status);
        await this.client.execute({
          sql: `UPDATE message_deliveries SET ${patchClauses.join(', ')} WHERE id = ? AND status = ?`,
          args: patchArgs,
        });
        const reloaded = await this.getDeliveryById(id);
        if (reloaded) return reloaded;
      }
      return current;
    }

    // 2. 终态保护：sent 与 aborted 为绝对不可逆终态，严禁任何自动或非裁定流转
    if (current.status === 'sent' || current.status === 'aborted') {
      throw new DeliveryStateTransitionError(
        id,
        current.status,
        status,
        `Delivery [${id}] 已处于终态 [${current.status}]，禁止流转回 [${status}]`
      );
    }

    // 3. 状态转换合法性检查
    const allowedSources = ALLOWED_FROM_STATUSES[status];
    if (!allowedSources || !allowedSources.includes(current.status)) {
      throw new DeliveryStateTransitionError(
        id,
        current.status,
        status,
        `非法 Delivery 状态转换: 不允许从 [${current.status}] 流转至 [${status}]`
      );
    }

    // 4. 重试状态控制：failed -> sending 必须显式声明 isRetry 且受 maxRetries 有界保护
    const isRetry = options?.isRetry ?? false;
    if (status === 'sending' && current.status === 'failed') {
      if (!isRetry) {
        throw new DeliveryStateTransitionError(
          id,
          current.status,
          status,
          `从 [failed] 重新进入 [sending] 必须显式声明为有界重试 (isRetry: true)`
        );
      }
      if (options?.maxRetries !== undefined && current.retryCount >= options.maxRetries) {
        throw new DeliveryStateTransitionError(
          id,
          current.status,
          status,
          `Delivery [${id}] 重试次数 [${current.retryCount}] 已达到或超过最大上限 [${options.maxRetries}]，禁止继续重试`
        );
      }
    }

    try {
      const setClauses: string[] = ['status = ?', 'updated_at = ?'];
      const args: InValue[] = [status, now];

      if (status === 'sending' && current.status === 'failed' && isRetry) {
        setClauses.push('retry_count = retry_count + 1');
      }

      if (options?.kkMessageId !== undefined) {
        setClauses.push('kk_message_id = ?');
        args.push(options.kkMessageId);
      }
      if (options?.errorCode !== undefined) {
        setClauses.push('error_code = ?');
        args.push(options.errorCode);
      }

      args.push(id, current.status);

      // 条件更新 (CAS) 保护：WHERE id = ? AND status = ?
      const res = await this.client.execute({
        sql: `UPDATE message_deliveries SET ${setClauses.join(', ')} WHERE id = ? AND status = ?`,
        args,
      });

      if (res.rowsAffected === 0) {
        const recheck = await this.getDeliveryById(id);
        throw new DeliveryStateTransitionError(
          id,
          recheck?.status ?? 'unknown',
          status,
          `并发更新 Delivery 状态冲突: 本次 CAS 条件更新失败 (当前状态 [${recheck?.status}]，期望流转至 [${status}])`
        );
      }

      const updated = await this.getDeliveryById(id);
      if (!updated) {
        throw new DatabaseError(`更新 Delivery 状态后未能读取到记录: ${id}`);
      }

      return updated;
    } catch (err) {
      if (err instanceof StoreError) {
        throw err;
      }
      log.error({ err, id, status }, '更新 Delivery 状态异常');
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new DatabaseError(`更新 Delivery 状态异常: ${cause.message}`, cause);
    }
  }

  /**
   * 人工裁定 Delivery (仅限对处于 unknown 状态的交付在事务中原子执行人工决议与审计持久化)
   */
  async adjudicateDelivery(id: string, input: AdjudicateDeliveryInput): Promise<Delivery> {
    return this.withWriteLock(async () => {
      const now = input.timestamp ?? Date.now();
      const auditId = `adj_${randomUUID().replace(/-/g, '')}`;

      try {
        return await withWriteTransaction(this.client, async tx => {
          const res = await tx.execute({
            sql: `SELECT * FROM message_deliveries WHERE id = ? LIMIT 1`,
            args: [id],
          });

          if (res.rows.length === 0) {
            throw new DatabaseError(`人工裁定 Delivery 失败: 未找到 ID 为 [${id}] 的记录`);
          }

          const current = mapRowToDelivery(res.rows[0] as unknown as DeliveryRow);

          // 幂等检查：若已处于 sent 且本次也是 sent 裁定，直接返回已有 sent 记录
          if (input.decision === 'sent' && current.status === 'sent') {
            return current;
          }

          // 状态限制：人工裁定仅允许对处于 unknown 状态的 Delivery 执行
          if (current.status !== 'unknown') {
            throw new DeliveryStateTransitionError(
              id,
              current.status,
              input.decision === 'sent' ? 'sent' : 'unknown',
              `人工裁定仅允许对处于 [unknown] 状态的 Delivery 执行，当前状态为 [${current.status}]`
            );
          }

          // 1. 如果裁定为 sent，在事务内原子更新 message_deliveries 状态为 sent (CAS 校验 status = 'unknown')
          if (input.decision === 'sent') {
            const updateRes = await tx.execute({
              sql: `UPDATE message_deliveries SET status = 'sent', updated_at = ? WHERE id = ? AND status = 'unknown'`,
              args: [now, id],
            });

            if (updateRes.rowsAffected === 0) {
              const recheck = await this.getDeliveryById(id);
              if (recheck && recheck.status === 'sent') {
                return recheck;
              }
              throw new DeliveryStateTransitionError(
                id,
                recheck?.status ?? 'unknown',
                'sent',
                `并发人工裁定冲突: Delivery 状态已发生变化`
              );
            }
          }

          // 2. 在同一事务内原子插入 delivery_adjudications 审计记录
          await tx.execute({
            sql: `
              INSERT INTO delivery_adjudications (
                id, delivery_id, operator, decision, evidence_summary, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)
            `,
            args: [auditId, id, input.operator, input.decision, input.evidenceSummary, now],
          });

          log.info(
            { deliveryId: id, operator: input.operator, decision: input.decision },
            '人工裁定事务提交成功 (状态与审计记录原子持久化)'
          );

          const updatedRes = await tx.execute({
            sql: `SELECT * FROM message_deliveries WHERE id = ? LIMIT 1`,
            args: [id],
          });
          if (updatedRes.rows.length === 0) {
            throw new DatabaseError(`读取已裁定 Delivery 失败: ID [${id}]`);
          }
          return mapRowToDelivery(updatedRes.rows[0] as unknown as DeliveryRow);
        });
      } catch (err) {
        if (err instanceof StoreError) {
          throw err;
        }
        const cause = err instanceof Error ? err : new Error(String(err));
        log.error({ err: cause.message, id }, '执行人工裁定事务异常');
        throw new DatabaseError(`执行人工裁定事务异常: ${cause.message}`, cause);
      }
    });
  }

  /**
   * 获取指定 Delivery 的所有人工裁定审计记录
   */
  async getAdjudicationsByDeliveryId(deliveryId: string): Promise<DeliveryAdjudicationRecord[]> {
    try {
      const res = await this.client.execute({
        sql: `SELECT * FROM delivery_adjudications WHERE delivery_id = ? ORDER BY created_at ASC`,
        args: [deliveryId],
      });
      return res.rows.map(row => mapRowToAdjudication(row as unknown as DeliveryAdjudicationRow));
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      log.error({ err, deliveryId }, '查询人工裁定审计记录异常');
      throw new DatabaseError(`查询人工裁定审计记录异常: ${cause.message}`, cause);
    }
  }

  /**
   * 标记 Delivery 的 Memory 提交完成 (写入 memory_committed_at，CAS 保护仅在 memory_committed_at 为 NULL 时更新)
   */
  async markMemoryCommitted(
    id: string,
    timestamp?: number
  ): Promise<Delivery & { isNewlyCommitted?: boolean }> {
    const now = timestamp ?? Date.now();
    try {
      const res = await this.client.execute({
        sql: `UPDATE message_deliveries SET memory_committed_at = ?, updated_at = ? WHERE id = ? AND status = 'sent' AND memory_committed_at IS NULL`,
        args: [now, now, id],
      });

      const updated = await this.getDeliveryById(id);
      if (!updated) {
        throw new DatabaseError(`标记 Delivery Memory 提交失败: 未找到 ID 为 [${id}] 的记录`);
      }
      if (updated.status !== 'sent') {
        throw new DatabaseError(
          `标记 Delivery Memory 提交失败: ID 为 [${id}] 的记录当前状态为 [${updated.status}]，非 sent 状态`
        );
      }

      return {
        ...updated,
        isNewlyCommitted: res.rowsAffected > 0,
      };
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

  /**
   * 查询所有在途发送中的 Delivery (sending 状态，用于重启恢复扫描)
   */
  async getInFlightSendingDeliveries(): Promise<Delivery[]> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE status = 'sending' ORDER BY created_at ASC`,
      args: [],
    });

    return res.rows.map(row => mapRowToDelivery(row as unknown as DeliveryRow));
  }

  /**
   * 查询所有处于 generated 状态的 Delivery (用于重启恢复安全收敛为 aborted)
   */
  async getGeneratedDeliveries(): Promise<Delivery[]> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE status = 'generated' ORDER BY created_at ASC`,
      args: [],
    });

    return res.rows.map((row) => mapRowToDelivery(row as unknown as DeliveryRow));
  }

  /**
   * 查询所有未知结果的未解决 Delivery (unknown 状态)
   */
  async getUnresolvedUnknownDeliveries(): Promise<Delivery[]> {
    const res = await this.client.execute({
      sql: `SELECT * FROM message_deliveries WHERE status = 'unknown' ORDER BY created_at ASC`,
      args: [],
    });

    return res.rows.map(row => mapRowToDelivery(row as unknown as DeliveryRow));
  }
}
