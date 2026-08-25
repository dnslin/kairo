import fs from 'node:fs/promises';
import path from 'node:path';

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
    // 信号 0 仅用于测试进程是否存在与是否有权发送信号，不产生中断
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
 * 数据目录单实例锁（InstanceLock）
 * 保证同一数据目录下仅允许单个 KKBot 进程实例运行，防御双写冲突。
 */
export class InstanceLock {
  private readonly lockDir: string;
  private readonly startupGenerationId: string;
  private readonly lockFilePath: string;
  private held: boolean = false;

  constructor(options: InstanceLockOptions) {
    this.lockDir = path.resolve(options.lockDir);
    this.startupGenerationId = options.startupGenerationId;
    this.lockFilePath = path.join(this.lockDir, options.lockFileName ?? 'kkbot.lock');
  }

  /**
   * 取得单实例锁
   * 若存在陈旧锁（拥有者进程已消亡），将自动覆盖自愈；
   * 若活跃实例已持有锁，则抛出 InstanceLockConflictError 拒绝启动。
   */
  async acquire(): Promise<void> {
    await fs.mkdir(this.lockDir, { recursive: true });

    // 检查既有锁文件
    try {
      const rawContent = await fs.readFile(this.lockFilePath, 'utf-8');
      const metadata = JSON.parse(rawContent) as Partial<InstanceLockMetadata>;

      if (typeof metadata.pid === 'number' && metadata.pid > 0) {
        if (metadata.pid === process.pid && metadata.startupGenerationId === this.startupGenerationId) {
          // 当前进程同一代次已持有
          this.held = true;
          return;
        }

        if (isProcessAlive(metadata.pid)) {
          throw new InstanceLockConflictError(
            this.lockFilePath,
            metadata.pid,
            metadata.startupGenerationId ?? 'unknown'
          );
        }
        // 拥有者进程已死亡，陈旧锁可安全接管自愈
      }
    } catch (error) {
      if (error instanceof InstanceLockConflictError) {
        throw error;
      }
      // 文件不存在或内容损坏，可安全创建新锁
    }

    const payload: InstanceLockMetadata = {
      pid: process.pid,
      startupGenerationId: this.startupGenerationId,
      acquiredAt: new Date().toISOString(),
    };

    await fs.writeFile(this.lockFilePath, JSON.stringify(payload, null, 2), 'utf-8');
    this.held = true;
  }

  /**
   * 释放单实例锁
   * 必须在数据库、文件和外部资源关闭尝试完成后才调用。
   */
  async release(): Promise<void> {
    if (!this.held) {
      return;
    }

    try {
      // 仅当锁文件仍属于当前进程与代次时删除
      const rawContent = await fs.readFile(this.lockFilePath, 'utf-8');
      const metadata = JSON.parse(rawContent) as Partial<InstanceLockMetadata>;
      if (metadata.pid === process.pid && metadata.startupGenerationId === this.startupGenerationId) {
        await fs.unlink(this.lockFilePath);
      }
    } catch {
      // 忽略文件已不存在或删除失败
    } finally {
      this.held = false;
    }
  }

  /**
   * 当前实例是否持有锁
   */
  isHeld(): boolean {
    return this.held;
  }

  /**
   * 获取锁文件路径
   */
  getLockFilePath(): string {
    return this.lockFilePath;
  }
}
