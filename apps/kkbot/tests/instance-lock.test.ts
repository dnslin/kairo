import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { InstanceLock, InstanceLockConflictError } from '../src/instance-lock.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

  it('should guarantee atomic mutual exclusion among multiple distinct child processes on stale takeover', async () => {
    const lockFilePath = path.join(tempDir, 'kkbot.lock');
    // 1. 预置死进程陈旧锁
    await fs.writeFile(
      lockFilePath,
      JSON.stringify({
        pid: 99999999,
        startupGenerationId: 'stale-dead-gen',
        acquiredAt: new Date(Date.now() - 60000).toISOString(),
      }),
      'utf-8'
    );

    const instanceLockModuleUrl = pathToFileURL(
      path.resolve(__dirname, '../src/instance-lock.ts')
    ).href;

    const childScript = `
      import { InstanceLock, InstanceLockConflictError } from ${JSON.stringify(instanceLockModuleUrl)};
      const lock = new InstanceLock({
        lockDir: ${JSON.stringify(tempDir)},
        startupGenerationId: 'child-' + process.pid,
      });
      try {
        await lock.acquire();
        process.stdout.write('SUCCESS:' + process.pid + '\\n');
        process.stdin.resume();
        process.stdin.on('data', async () => {
          await lock.release();
          process.exit(0);
        });
      } catch (err) {
        if (
          err instanceof InstanceLockConflictError ||
          (err && typeof err === 'object' && 'name' in err && err.name === 'InstanceLockConflictError')
        ) {
          process.stdout.write('CONFLICT:' + process.pid + '\\n');
          process.exit(2);
        }
        process.stderr.write('ERROR:' + (err && typeof err === 'object' && 'message' in err ? err.message : String(err)) + '\\n');
        process.exit(1);
      }
    `;

    const childScriptFile = path.join(tempDir, 'child-worker.mjs');
    await fs.writeFile(childScriptFile, childScript, 'utf-8');
    const processCount = 5;
    const children: Array<{
      id: number;
      cp: ChildProcess;
      done: Promise<{ code: number; stdout: string }>;
      stdout: () => string;
    }> = [];

    const { promise: winnerPromise, resolve: resolveWinner, reject: rejectWinner } =
      Promise.withResolvers<{ id: number; cp: ChildProcess; pid: number }>();

    for (let i = 0; i < processCount; i++) {
      const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string }>();
      const cp = spawn(process.execPath, ['--import', 'tsx', childScriptFile], {
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let outBuf = '';
      cp.stdout?.on('data', (d: Buffer) => {
        const str = d.toString();
        outBuf += str;
        const match = str.match(/SUCCESS:(\d+)/);
        if (match && match[1]) {
          resolveWinner({ id: i, cp, pid: parseInt(match[1], 10) });
        }
      });
      cp.stderr?.on('data', (d: Buffer) => {
        outBuf += d.toString();
      });
      cp.on('close', (code) => {
        if (code === 1) {
          rejectWinner(new Error(`Child process failed with error: ${outBuf}`));
        }
        resolve({ code: code ?? -1, stdout: outBuf });
      });
      children.push({ id: i, cp, done: promise, stdout: () => outBuf });
    }

    // 1. 等待 Winner 抢占成功并持有锁（此时保持锁定状态，不释放）
    const winner = await winnerPromise;
    expect(winner.pid).toBeGreaterThan(0);

    // 2. 其余 4 个子进程必须全部被排他锁拦截并以 Conflict (exit code 2) 退出
    const losers = children.filter((c) => c.id !== winner.id);
    const loserResults = await Promise.all(losers.map((l) => l.done));

    for (const res of loserResults) {
      expect(res.code).toBe(2);
      expect(res.stdout).toContain('CONFLICT:');
    }

    // 3. 所有竞争者已被拦截后，向 Winner 发送指令释放锁并等待其正常退出
    winner.cp.stdin?.end('RELEASE\n');
    const winnerResult = await children[winner.id]!.done;
    expect(winnerResult.code).toBe(0);
    expect(winnerResult.stdout).toContain('SUCCESS:');
  });
});
