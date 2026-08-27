import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import readline from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { createValidTestYaml } from '../fixtures.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const workerPath = path.resolve(__dirname, '../helpers/cdp-generation-worker.ts');

function waitForEvent(
  child: ChildProcessWithoutNullStreams,
  eventName: string
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const reader = readline.createInterface({ input: child.stdout });
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      reader.close();
      callback();
    };

    reader.on('line', line => {
      try {
        const value: unknown = JSON.parse(line);
        if (
          value &&
          typeof value === 'object' &&
          'event' in value &&
          value.event === eventName
        ) {
          finish(() => resolve(value as Record<string, unknown>));
        }
      } catch {
        // 只跳过非 JSON 日志，子进程错误由 exit/error 事件处理。
      }
    });
    child.once('error', error => finish(() => reject(error)));
    child.once('exit', code => {
      if (code !== null) {
        finish(() => reject(new Error(`worker 在 ${eventName} 前退出，code=${code}`)));
      }
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<number | null> {
  if (child.exitCode !== null) {
    return Promise.resolve(child.exitCode);
  }
  return new Promise(resolve => child.once('exit', code => resolve(code)));
}

function startWorker(configPath: string): ChildProcessWithoutNullStreams {
  return spawn(
    process.execPath,
    ['--import', 'tsx/esm', workerPath, configPath],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
}

describe('CONCURRENCY-01 startup generation 跨进程恢复合同', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (!tempDir) return;
    const directory = tempDir;
    tempDir = undefined;
    try {
      await fs.rm(directory, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'EBUSY') {
        return;
      }
      throw err;
    }
  });

  it('强杀后新进程产生新 generation 并重新 Ready/补偿', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kkbot-generation-restart-'));
    const configPath = path.join(tempDir, 'config.yaml');
    await fs.writeFile(
      configPath,
      createValidTestYaml({ dbFilePath: path.join(tempDir, 'kkbot.db') }),
      'utf8'
    );

    const first = startWorker(configPath);
    const firstReady = await waitForEvent(first, 'ready');
    const firstGeneration = firstReady['generationId'];
    const firstCompensationFrom = firstReady['compensationFrom'];
    expect(typeof firstGeneration).toBe('string');
    expect(typeof firstCompensationFrom).toBe('number');

    first.kill('SIGKILL');
    await waitForExit(first);

    const second = startWorker(configPath);
    const secondReady = await waitForEvent(second, 'ready');
    expect(secondReady['generationId']).not.toBe(firstGeneration);
    expect(secondReady['compensationFrom']).toBe(firstCompensationFrom);

    const shutdownEvent = waitForEvent(second, 'shutdown');
    second.stdin.end('shutdown\n');
    const shutdown = await shutdownEvent;
    expect(shutdown['successful']).toBe(true);
    expect(await waitForExit(second)).toBe(0);
  });
});
