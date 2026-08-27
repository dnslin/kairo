import fs from 'node:fs/promises';

export interface GenerationCheckpoint {
  startupGenerationId: string;
  startedAt: number;
  readyAt: number;
  compensationFrom: number;
  compensationCompleted: boolean;
}

export class GenerationCheckpointStore {
  constructor(private readonly filePath: string) {}

  public async read(): Promise<GenerationCheckpoint | null> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const value: unknown = JSON.parse(raw);
      if (!this.isCheckpoint(value)) {
        throw new Error(`启动代次 checkpoint 格式无效: ${this.filePath}`);
      }
      return value;
    } catch (err) {
      if (isFileNotFound(err)) {
        return null;
      }
      const cause = err instanceof Error ? err : new Error(String(err));
      throw new Error(`读取启动代次 checkpoint 失败: ${this.filePath}`, { cause });
    }
  }

  public async write(checkpoint: GenerationCheckpoint): Promise<void> {
    const tempPath = `${this.filePath}.tmp-${process.pid}`;
    try {
      await fs.writeFile(tempPath, `${JSON.stringify(checkpoint)}\n`, 'utf8');
      await fs.rename(tempPath, this.filePath);
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      try {
        await fs.rm(tempPath, { force: true });
      } catch (cleanupError) {
        const cleanupCause =
          cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
        const aggregate = new AggregateError(
          [cause, cleanupCause],
          '写入启动代次 checkpoint 失败且临时文件清理失败'
        );
        throw new Error(
          `写入启动代次 checkpoint 失败: ${this.filePath}; 原因: ${cause.message}; 临时文件清理失败: ${cleanupCause.message}`,
          { cause: aggregate }
        );
      }
      throw new Error(`写入启动代次 checkpoint 失败: ${this.filePath}`, { cause });
    }
  }

  private isCheckpoint(value: unknown): value is GenerationCheckpoint {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate['startupGenerationId'] === 'string' &&
      typeof candidate['startedAt'] === 'number' &&
      typeof candidate['readyAt'] === 'number' &&
      typeof candidate['compensationFrom'] === 'number' &&
      typeof candidate['compensationCompleted'] === 'boolean'
    );
  }
}

function isFileNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}
