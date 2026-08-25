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

  it('should guarantee atomic mutual exclusion under heavy concurrent acquire race', async () => {
    const count = 10;
    const locks = Array.from({ length: count }, (_, idx) => {
      return new InstanceLock({
        lockDir: tempDir,
        startupGenerationId: `gen-concurrent-${idx}`,
      });
    });

    const results = await Promise.allSettled(locks.map((l) => l.acquire()));
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(count - 1);

    const winner = locks.find((l) => l.isHeld());
    expect(winner).toBeDefined();
    await winner?.release();
  });

  it('should propagate real I/O or permission errors during release instead of swallowing', async () => {
    const lock = new InstanceLock({
      lockDir: tempDir,
      startupGenerationId: 'gen-error-test',
    });
    await lock.acquire();

    // Mock fs.readFile or fs.unlink to throw a permission error
    const originalUnlink = fs.unlink;
    fs.unlink = () => {
      const err = new Error('EPERM: operation not permitted');
      (err as { code?: string }).code = 'EPERM';
      return Promise.reject(err);
    };

    try {
      await expect(lock.release()).rejects.toThrow('EPERM: operation not permitted');
    } finally {
      fs.unlink = originalUnlink;
      await lock.release();
    }
  });
});
