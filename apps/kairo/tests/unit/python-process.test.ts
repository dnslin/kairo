import * as childProcess from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { retrieveKnowledge } from '../../src/modules/tool-integration/python-retrieval.js';

vi.mock('node:child_process', async importOriginal => {
  const actual = await importOriginal<typeof childProcess>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
const { spawn: originalSpawn } = await vi.importActual<typeof childProcess>('node:child_process');
beforeEach(() => {
  vi.mocked(childProcess.spawn).mockReset().mockImplementation(originalSpawn);
});
const directories: string[] = [];
const settings = { apiUrl: 'http://127.0.0.1:1', apiKey: 'kairo-process-secret', datasetId: 'ERP' };
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
async function script(source: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'kairo-python-fault-'));
  directories.push(directory);
  const path = join(directory, '故障.py');
  await writeFile(path, source);
  return path;
}

describe('Python 启动和输出错误不可降级', () => {
  it('解释器缺失明确失败且不重试', async () => {
    const spawn = vi
      .mocked(childProcess.spawn)
      .mockImplementation((_command, args, options) =>
        originalSpawn('kairo-python-does-not-exist', args, options)
      );
    const run = await retrieveKnowledge('采购', settings, { deadline: Date.now() + 5000 });
    expect(run.result).toMatchObject({ kind: 'service_error', error: { reason: 'python_start' } });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['脚本缺失', null, 'service_error', 'python_exit'],
    ['非零退出', 'import sys\nsys.exit(7)\n', 'service_error', 'python_exit'],
    ['无效JSON', 'print("不是JSON")\n', 'format_error', 'output_json'],
    ['错误结构', 'print("{}")\n', 'format_error', 'output_contract'],
    ['非法编码', 'import sys\nsys.stdout.buffer.write(b"\\xff")\n', 'format_error', 'output_json'],
  ])('%s 保留退出事实且不重试', async (_name, source, kind, reason) => {
    const path = await script(source ?? '');
    const spawn = vi
      .mocked(childProcess.spawn)
      .mockImplementation((command, args, options) =>
        originalSpawn(
          command,
          [...args.slice(0, -1), source === null ? `${path}.missing` : path],
          options
        )
      );
    const run = await retrieveKnowledge('采购', settings, { deadline: Date.now() + 5000 });
    expect(run.result).toMatchObject({ kind, error: { reason } });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(() => process.kill(run.attempts[0]!.pid!, 0)).toThrow();
  });

  it.each(['stdout', 'stderr', 'stdin'] as const)(
    '%s 流错误终止真实 Python 并等待回收',
    async stream => {
      const path = await script('import time\ntime.sleep(60)\n');
      vi.mocked(childProcess.spawn).mockImplementation((command, args, options) => {
        const child = originalSpawn(command, [...args.slice(0, -1), path], options);
        child.once('spawn', () => {
          setImmediate(() => {
            child[stream]!.emit('error', new Error('本地管道读取失败'));
          });
        });
        return child;
      });
      const run = await retrieveKnowledge('采购', settings, { deadline: Date.now() + 5000 });
      expect(run.result).toMatchObject({
        kind: 'service_error',
        error: { reason: stream === 'stdin' ? 'stdin_write' : `${stream}_read` },
      });
      expect(run.attempts).toHaveLength(1);
      expect(() => process.kill(run.attempts[0]!.pid!, 0)).toThrow();
    }
  );

  it('模型文字从stdin传入，进程参数固定且不继承其他服务凭证', async () => {
    vi.stubEnv('DATABASE_URL', '数据库秘密');
    vi.stubEnv('KAIRO_T12_MODEL_API_KEY', '模型秘密');
    const spawn = vi.mocked(childProcess.spawn);
    await retrieveKnowledge('采购; powershell --script other.py', settings, {
      deadline: Date.now() + 5000,
    });
    const [command, args, options] = spawn.mock.calls[0]!;
    expect(command).toBe('python');
    expect(args.slice(0, 2)).toEqual(['-I', '-B']);
    expect(JSON.stringify(args)).not.toContain('采购');
    expect(JSON.stringify(args)).not.toContain(settings.apiKey);
    expect(options).toMatchObject({
      shell: false,
      env: { RAGFLOW_API_KEY: settings.apiKey, RAGFLOW_DATASET_ID: 'ERP' },
    });
    expect(options.env).not.toHaveProperty('DATABASE_URL');
    expect(options.env).not.toHaveProperty('KAIRO_T12_MODEL_API_KEY');
  });
});
