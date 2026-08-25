import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { InstanceLock, InstanceLockConflictError } from '../src/instance-lock.js';

describe('InstanceLock (Single Instance Data Directory Lock)', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-lock-test-'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('should acquire lock successfully for a single instance', async () => {
    const lock = new InstanceLock({
      lockDir: tempDir,
      startupGenerationId: 'gen-001',
    });

    expect(lock.isHeld()).toBe(false);
    await lock.acquire();
    expect(lock.isHeld()).toBe(true);

    // Verify lock file content
    const lockFilePath = path.join(tempDir, 'kkbot.lock');
    const content = JSON.parse(await fs.readFile(lockFilePath, 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(content.startupGenerationId).toBe('gen-001');

    await lock.release();
    expect(lock.isHeld()).toBe(false);
    const exists = await fs
      .stat(lockFilePath)
      .then(() => true)
      .catch(() => false);
    expect(exists).toBe(false);
  });

  it('should reject a second instance when lock is active', async () => {
    const lock1 = new InstanceLock({
      lockDir: tempDir,
      startupGenerationId: 'gen-001',
    });
    const lock2 = new InstanceLock({
      lockDir: tempDir,
      startupGenerationId: 'gen-002',
    });

    await lock1.acquire();

    await expect(lock2.acquire()).rejects.toThrow(InstanceLockConflictError);

    await lock1.release();
    // After lock1 releases, lock2 can acquire
    await lock2.acquire();
    expect(lock2.isHeld()).toBe(true);
    await lock2.release();
  });

  it('should recover from stale lock file of a dead process', async () => {
    const lockFilePath = path.join(tempDir, 'kkbot.lock');
    // Write a fake lock file with a non-existent PID (e.g. 99999999)
    await fs.writeFile(
      lockFilePath,
      JSON.stringify({
        pid: 99999999,
        startupGenerationId: 'stale-gen',
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
      }),
      'utf-8'
    );

    const lock = new InstanceLock({
      lockDir: tempDir,
      startupGenerationId: 'gen-new',
    });

    // Should detect dead PID and acquire successfully
    await lock.acquire();
    expect(lock.isHeld()).toBe(true);

    const content = JSON.parse(await fs.readFile(lockFilePath, 'utf-8'));
    expect(content.pid).toBe(process.pid);
    expect(content.startupGenerationId).toBe('gen-new');

    await lock.release();
  });
});
