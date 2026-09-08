import type { Pool } from 'pg';

export type RuntimeBootStatus = 'starting' | 'running' | 'closed' | 'failed';

export interface StartBootInput {
  bootId: string;
  gitCommit: string;
  configDigest: string;
  /** Unix 毫秒。 */
  startedAt: number;
}

export interface RuntimeBoot extends StartBootInput {
  status: RuntimeBootStatus;
  /** Unix 毫秒，未关闭时为 null。 */
  closedAt: number | null;
}

export interface CloseBootInput {
  status: 'closed' | 'failed';
  /** Unix 毫秒。 */
  closedAt: number;
}

export interface ListBootsInput {
  limit: number;
  offset: number;
}

export interface RuntimeBootStore {
  /** 同 ID 重放保留首次元数据及当前状态。 */
  startBoot(input: StartBootInput): Promise<{ inserted: boolean; boot: RuntimeBoot }>;
  getBoot(bootId: string): Promise<RuntimeBoot | null>;
  markRunning(bootId: string): Promise<boolean>;
  closeBoot(bootId: string, input: CloseBootInput): Promise<boolean>;
  /** 按 startedAt、bootId 升序分页。 */
  listBoots(input: ListBootsInput): Promise<RuntimeBoot[]>;
}

type RuntimeBootRow = {
  boot_id: string;
  git_commit: string;
  config_digest: string;
  started_at: Date;
  closed_at: Date | null;
  status: RuntimeBootStatus;
};

function mapBoot(row: RuntimeBootRow): RuntimeBoot {
  return {
    bootId: row.boot_id,
    gitCommit: row.git_commit,
    configDigest: row.config_digest,
    startedAt: row.started_at.getTime(),
    closedAt: row.closed_at?.getTime() ?? null,
    status: row.status,
  };
}

/** 连接池由调用方持有和关闭；不执行迁移、不记录正文、不清理历史。 */
export class PostgresRuntimeBootStore implements RuntimeBootStore {
  public constructor(private readonly pool: Pool) {}

  public async startBoot(input: StartBootInput): Promise<{ inserted: boolean; boot: RuntimeBoot }> {
    const result = await this.pool.query<RuntimeBootRow>(
      `INSERT INTO kairo.runtime_boots
         (boot_id, git_commit, config_digest, started_at, status)
       VALUES ($1, $2, $3, $4, 'starting')
       ON CONFLICT (boot_id) DO NOTHING RETURNING *`,
      [input.bootId, input.gitCommit, input.configDigest, new Date(input.startedAt)]
    );
    const row = result.rows[0];
    if (row) return { inserted: true, boot: mapBoot(row) };
    // 冲突语句等待并发提交；下一条查询以新快照读取胜出记录，不覆盖首次元数据。
    const boot = await this.getBoot(input.bootId);
    if (!boot) throw new Error('重复启动的已存记录不存在');
    return { inserted: false, boot };
  }

  public async getBoot(bootId: string): Promise<RuntimeBoot | null> {
    const result = await this.pool.query<RuntimeBootRow>(
      'SELECT * FROM kairo.runtime_boots WHERE boot_id = $1',
      [bootId]
    );
    return result.rows[0] ? mapBoot(result.rows[0]) : null;
  }

  public async markRunning(bootId: string): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.runtime_boots SET status = 'running'
       WHERE boot_id = $1 AND status = 'starting'`,
      [bootId]
    );
    return result.rowCount === 1;
  }

  public async closeBoot(bootId: string, input: CloseBootInput): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE kairo.runtime_boots SET status = $2, closed_at = $3
       WHERE boot_id = $1 AND status IN ('starting', 'running')
         AND $2 IN ('closed', 'failed')`,
      [bootId, input.status, new Date(input.closedAt)]
    );
    return result.rowCount === 1;
  }

  public async listBoots(input: ListBootsInput): Promise<RuntimeBoot[]> {
    const result = await this.pool.query<RuntimeBootRow>(
      `SELECT * FROM kairo.runtime_boots
       ORDER BY started_at ASC, boot_id ASC LIMIT $1 OFFSET $2`,
      [input.limit, input.offset]
    );
    return result.rows.map(mapBoot);
  }
}
