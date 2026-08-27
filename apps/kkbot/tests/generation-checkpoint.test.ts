import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GenerationCheckpointStore } from '../src/generation-checkpoint.js';

const checkpoint: Parameters<GenerationCheckpointStore['write']>[0] = {
  startupGenerationId: 'generation-test',
  startedAt: 1,
  readyAt: 2,
  compensationFrom: 1,
  compensationCompleted: false,
};

describe('GenerationCheckpointStore 错误诊断', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('写入失败且临时文件清理失败时保留两个错误原因', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-checkpoint-test-'));
    const checkpointPath = path.join(tempDir, 'checkpoint.json');
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('checkpoint-rename-error'));
    vi.spyOn(fs, 'rm').mockRejectedValueOnce(new Error('checkpoint-cleanup-error'));

    let thrown: unknown;
    try {
      await new GenerationCheckpointStore(checkpointPath).write(checkpoint);
    } catch (error) {
      thrown = error;
    } finally {
      vi.restoreAllMocks();
      await fs.rm(tempDir, { recursive: true, force: true });
    }

    expect(thrown).toBeInstanceOf(Error);
    const error = thrown as Error & { cause?: unknown };
    expect(error.message).toContain('checkpoint-rename-error');
    expect(error.message).toContain('checkpoint-cleanup-error');
    expect(error.cause).toBeInstanceOf(AggregateError);
  });
});
