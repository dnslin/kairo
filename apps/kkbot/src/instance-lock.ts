import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient, type Client, type Transaction } from '@kkbot/store';

export interface InstanceLockOptions {
  /** 锁定目录（如数据目录） */
  lockDir: string;
  /** 当前启动代次唯一标识 */
  startupGenerationId: string;
  /** 锁文件名（默认为 kkbot.lock） */
  lockFileName?: string;
}

export interface InstanceLockMetadata {
  pid: number;
  startupGenerationId: string;
  acquiredAt: string;
}

export class InstanceLockConflictError extends Error {
  readonly lockPath: string;
  readonly existingPid: number;
  readonly existingGenerationId: string;

  constructor(lockPath: string, existingPid: number, existingGenerationId: string) {
    super(
      `单实例锁已被占用 (PID: ${existingPid}, 启动代次: ${existingGenerationId}, 路径: ${lockPath})，拒绝第二实例同时启动`
    );
    this.name = 'InstanceLockConflictError';
    this.lockPath = lockPath;
    this.existingPid = existingPid;
    this.existingGenerationId = existingGenerationId;
  }
}

/**
 * 检查指定 PID 的进程是否存活
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
      if (error.code === 'ESRCH') {
        return false;
      }
      if (error.code === 'EPERM') {
        return true;
      }
    }
    return false;
  }
}

/**
 * 基于 SQLite / LibSQL 内核级排他事务的单实例锁（InstanceLock）
 *
 * 核心原理：
 * 1. 在数据目录下维护专用的排他守护库（.kkbot_instance_lock.guard.db）。
 * 2. 进程启动时持有 BEGIN IMMEDIATE 长事务排他锁。
 * 3. 操作系统内核保证：若进程崩溃（SIGKILL / 异常中断），OS 会立即自动关闭文件句柄并释放排他锁，杜绝任何 TOCTOU 竞态与陈旧孤儿锁遗留。
 */
export class InstanceLock {
  private readonly lockDir: string;
  private readonly startupGenerationId: string;
  private readonly lockFilePath: string;
  private readonly guardDbPath: string;

  private guardClient: Client | null = null;
  private guardTx: Transaction | null = null;
  private held: boolean = false;

  constructor(options: InstanceLockOptions) {
    this.lockDir = path.resolve(options.lockDir);
    this.startupGenerationId = options.startupGenerationId;
    const baseName = options.lockFileName ?? 'kkbot.lock';
    this.lockFilePath = path.join(this.lockDir, baseName);
    this.guardDbPath = path.join(this.lockDir, `.${baseName}_guard.sqlite`);
  }

  /**
   * 取得单实例排他锁
   */
  async acquire(): Promise<void> {
    await fs.mkdir(this.lockDir, { recursive: true });

    // 建立排他守护连接并设置极短繁忙等待（快速拦截冲突）
    const client = createClient({ url: `file:${this.guardDbPath}` });

    try {
      await client.execute('PRAGMA busy_timeout = 100;');
      await client.execute(`
        CREATE TABLE IF NOT EXISTS _kkbot_instance_lock (
          id INTEGER PRIMARY KEY,
          pid INTEGER NOT NULL,
          startup_generation_id TEXT NOT NULL,
          acquired_at TEXT NOT NULL
        );
      `);

      // 开启长生命周期写入排他事务（BEGIN IMMEDIATE）
      let tx: Transaction;
      try {
        tx = await client.transaction('write');
      } catch (txErr: unknown) {
        client.close();

        const isBusy =
          txErr &&
          typeof txErr === 'object' &&
          (('code' in txErr &&
            (txErr.code === 'SQLITE_BUSY' ||
              txErr.code === 'SQLITE_LOCKED' ||
              txErr.code === 'SQLITE_BUSY_RECOVERY' ||
              txErr.code === 'SQLITE_BUSY_SNAPSHOT' ||
              String(txErr.code).includes('BUSY') ||
              String(txErr.code).includes('LOCKED'))) ||
            ('message' in txErr &&
              (String(txErr.message).includes('SQLITE_BUSY') ||
                String(txErr.message).includes('SQLITE_LOCKED') ||
                String(txErr.message).includes('database is locked') ||
                String(txErr.message).includes('database table is locked') ||
                String(txErr.message).includes('Resource temporarily unavailable'))));
        if (isBusy) {
          // 仅在明确检测到锁繁忙冲突时抛出 InstanceLockConflictError
          let existingPid = 0;
          let existingGen = 'unknown';
          try {
            const raw = await fs.readFile(this.lockFilePath, 'utf-8');
            const meta = JSON.parse(raw) as Partial<InstanceLockMetadata>;
            existingPid = meta.pid ?? 0;
            existingGen = meta.startupGenerationId ?? 'unknown';
          } catch {
            // 忽略
          }
          throw new InstanceLockConflictError(this.lockFilePath, existingPid, existingGen);
        }

        // 非锁冲突类的结构性数据库异常直接向外抛出
        throw txErr;
      }

      try {
        // 在排他事务内部更新当前进程元数据
        const nowIso = new Date().toISOString();
        await tx.execute({
          sql: 'INSERT OR REPLACE INTO _kkbot_instance_lock (id, pid, startup_generation_id, acquired_at) VALUES (1, ?, ?, ?)',
          args: [process.pid, this.startupGenerationId, nowIso],
        });

        // 镜像写入文本锁文件供外部诊断与工具检查
        const payload: InstanceLockMetadata = {
          pid: process.pid,
          startupGenerationId: this.startupGenerationId,
          acquiredAt: nowIso,
        };
        await fs.writeFile(this.lockFilePath, JSON.stringify(payload, null, 2), 'utf-8');

        // 仅在全部动作成功后将 tx 与 client 登记至实例字段
        this.guardClient = client;
        this.guardTx = tx;
        this.held = true;
      } catch (innerErr) {
        await tx.rollback().catch(() => {});
        client.close();
        throw innerErr;
      }
    } catch (err) {
      if (this.guardClient !== client) {
        client.close();
      }
      throw err;
    }
  }

  /**
   * 释放单实例锁
   */
  async release(): Promise<void> {
    if (!this.held) {
      return;
    }

    const cleanupErrors: Error[] = [];

    try {
      if (this.guardTx) {
        try {
          await this.guardTx.rollback();
        } catch (txErr: unknown) {
          cleanupErrors.push(txErr instanceof Error ? txErr : new Error(String(txErr)));
        }
        this.guardTx = null;
      }

      if (this.guardClient) {
        try {
          this.guardClient.close();
        } catch (clientErr: unknown) {
          cleanupErrors.push(
            clientErr instanceof Error ? clientErr : new Error(String(clientErr))
          );
        }
        this.guardClient = null;
      }

      try {
        await fs.unlink(this.lockFilePath);
      } catch (unlinkErr: unknown) {
        const code =
          unlinkErr && typeof unlinkErr === 'object' && 'code' in unlinkErr
            ? unlinkErr.code
            : undefined;
        if (code !== 'ENOENT') {
          cleanupErrors.push(
            unlinkErr instanceof Error ? unlinkErr : new Error(String(unlinkErr))
          );
        }
      }
    } finally {
      this.held = false;
    }

    if (cleanupErrors.length > 0) {
      if (cleanupErrors.length === 1 && cleanupErrors[0]) {
        throw cleanupErrors[0];
      }
      throw new AggregateError(
        cleanupErrors,
        `释放单实例锁时产生 ${cleanupErrors.length} 处清理错误`
      );
    }
  }

  isHeld(): boolean {
    return this.held;
  }

  getLockFilePath(): string {
    return this.lockFilePath;
  }
}
