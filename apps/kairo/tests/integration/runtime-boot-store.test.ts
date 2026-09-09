import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../src/db/pool.js';
import {
  PostgresRuntimeBootStore,
  type RuntimeBoot,
  type StartBootInput,
} from '../../src/modules/operability/runtime-boot-store.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

const startedAt = Date.UTC(2026, 8, 8, 10, 0, 0, 123);
const closedAt = startedAt + 45_678;
let database: TaskTestDatabase;
let storeA: PostgresRuntimeBootStore;
let storeB: PostgresRuntimeBootStore;

function bootInput(overrides: Partial<StartBootInput> = {}): StartBootInput {
  return {
    bootId: randomUUID(),
    gitCommit: '合成版本标记，不含凭证',
    configDigest: '合成配置摘要，不含配置正文或凭证',
    startedAt,
    ...overrides,
  };
}

beforeAll(async () => {
  database = await createTaskTestDatabase();
  storeA = new PostgresRuntimeBootStore(database.poolA);
  storeB = new PostgresRuntimeBootStore(database.poolB);
}, 30_000);

afterAll(async () => {
  await database?.close();
}, 30_000);

describe('T20 启动记录真实 PostgreSQL 账本', () => {
  it('首次启动保存完整元数据及毫秒，正常关闭保留首次终态时间', async () => {
    const input = bootInput();
    const initial = { ...input, status: 'starting', closedAt: null };
    expect(await storeA.startBoot(input)).toEqual({ inserted: true, boot: initial });
    expect(await storeB.getBoot(input.bootId)).toEqual(initial);
    expect(await storeA.markRunning(input.bootId)).toBe(true);
    expect(await storeB.getBoot(input.bootId)).toEqual({ ...initial, status: 'running' });
    expect(await storeB.closeBoot(input.bootId, { status: 'closed', closedAt })).toBe(true);
    expect(await storeA.getBoot(input.bootId)).toEqual({ ...input, status: 'closed', closedAt });
    expect(await storeA.markRunning(input.bootId)).toBe(false);
    expect(
      await storeA.closeBoot(input.bootId, { status: 'closed', closedAt: closedAt + 100 })
    ).toBe(false);
    expect(await storeB.getBoot(input.bootId)).toEqual({ ...input, status: 'closed', closedAt });
  });

  it('重复启动保留首次元数据及当前状态，不把已关闭启动倒退为 starting', async () => {
    const input = bootInput();
    await storeA.startBoot(input);
    expect(await storeB.startBoot(input)).toEqual({
      inserted: false,
      boot: { ...input, status: 'starting', closedAt: null },
    });
    expect(await storeA.markRunning(input.bootId)).toBe(true);
    const replay = bootInput({
      bootId: input.bootId,
      gitCommit: '另一个版本',
      startedAt: closedAt,
    });
    expect(await storeB.startBoot(replay)).toEqual({
      inserted: false,
      boot: { ...input, status: 'running', closedAt: null },
    });
    expect(await storeA.closeBoot(input.bootId, { status: 'failed', closedAt })).toBe(true);
    expect(await storeB.startBoot({ ...replay, configDigest: '另一个摘要' })).toEqual({
      inserted: false,
      boot: { ...input, status: 'failed', closedAt },
    });
  });

  it('两个真实连接并发启动同一 ID 只有一条记录，双方读取胜出者元数据', async () => {
    const first = bootInput();
    const second = bootInput({
      bootId: first.bootId,
      gitCommit: '并发的另一个版本',
      configDigest: '并发的另一个摘要',
      startedAt: startedAt + 987,
    });
    const results = await Promise.all([storeA.startBoot(first), storeB.startBoot(second)]);
    expect(results.map(result => result.inserted).sort()).toEqual([false, true]);
    const expected = {
      ...(results[0].inserted ? first : second),
      status: 'starting',
      closedAt: null,
    };
    expect(results.map(result => result.boot)).toEqual([expected, expected]);
    expect(await storeB.getBoot(first.bootId)).toEqual(expected);
  });

  it('两个真实连接并发推进和关闭时仅一次条件更新生效，关闭竞争不覆盖胜出者', async () => {
    const input = bootInput();
    await storeA.startBoot(input);
    const runningResults = await Promise.all([
      storeA.markRunning(input.bootId),
      storeB.markRunning(input.bootId),
    ]);
    expect(runningResults.sort()).toEqual([false, true]);
    expect(await storeA.markRunning(input.bootId)).toBe(false);
    const closeResults = await Promise.all([
      storeA.closeBoot(input.bootId, { status: 'closed', closedAt }),
      storeB.closeBoot(input.bootId, { status: 'failed', closedAt: closedAt + 789 }),
    ]);
    expect([...closeResults].sort()).toEqual([false, true]);
    const expected = {
      ...input,
      status: closeResults[0] ? 'closed' : 'failed',
      closedAt: closeResults[0] ? closedAt : closedAt + 789,
    };
    expect(await storeA.getBoot(input.bootId)).toEqual(expected);
    expect(
      await storeB.closeBoot(input.bootId, { status: 'failed', closedAt: closedAt + 999 })
    ).toBe(false);
    expect(await storeB.getBoot(input.bootId)).toEqual(expected);
  });

  it.each([
    ['starting', 'closed'],
    ['starting', 'failed'],
    ['running', 'closed'],
    ['running', 'failed'],
  ] as const)('%s 可进入 %s，终态不能互转、重复关闭或重新运行', async (status, terminal) => {
    const input = bootInput();
    await storeA.startBoot(input);
    if (status === 'running') expect(await storeA.markRunning(input.bootId)).toBe(true);
    expect(await storeB.closeBoot(input.bootId, { status: terminal, closedAt })).toBe(true);
    expect(await storeA.markRunning(input.bootId)).toBe(false);
    for (const target of ['closed', 'failed'] as const) {
      expect(await storeA.closeBoot(input.bootId, { status: target, closedAt: closedAt + 1 })).toBe(
        false
      );
    }
    expect(await storeB.getBoot(input.bootId)).toEqual({ ...input, status: terminal, closedAt });
  });

  it('未知 ID 不会创建记录，关闭入口拒绝非终态目标', async () => {
    const missing = randomUUID();
    expect(await storeA.getBoot(missing)).toBeNull();
    expect(await storeA.markRunning(missing)).toBe(false);
    expect(await storeA.closeBoot(missing, { status: 'failed', closedAt })).toBe(false);
    const input = bootInput();
    await storeA.startBoot(input);
    // 绕过静态类型模拟错误调用，不能通过关闭入口伪造 running。
    expect(await storeA.closeBoot(input.bootId, { status: 'running' as 'closed', closedAt })).toBe(
      false
    );
    expect(await storeB.getBoot(input.bootId)).toEqual({
      ...input,
      status: 'starting',
      closedAt: null,
    });
  });

  it('分页以启动时间和 ID 升序稳定排列，同毫秒记录无遗漏且越界返回空页', async () => {
    const isolated = await createTaskTestDatabase();
    try {
      const store = new PostgresRuntimeBootStore(isolated.poolA);
      const inputs = [
        bootInput({ bootId: 'boot-c', startedAt: startedAt + 1 }),
        bootInput({ bootId: 'boot-b' }),
        bootInput({ bootId: 'boot-a' }),
        bootInput({ bootId: 'boot-d', startedAt: startedAt + 2 }),
      ];
      for (const input of inputs) await store.startBoot(input);
      const first = await store.listBoots({ limit: 2, offset: 0 });
      const second = await store.listBoots({ limit: 2, offset: 2 });
      expect([...first, ...second]).toEqual(
        [inputs[2], inputs[1], inputs[0], inputs[3]].map(input => ({
          ...input,
          status: 'starting',
          closedAt: null,
        }))
      );
      expect(await store.listBoots({ limit: 2, offset: 4 })).toEqual([]);
      expect(await store.listBoots({ limit: 0, offset: 0 })).toEqual([]);
    } finally {
      await isolated.close();
    }
  }, 30_000);

  it('关闭写入连接并重建后仍可读取四种状态、完整元数据和原始毫秒', async () => {
    const writingPool = createPostgresPool(database.databaseUrl, { max: 1 });
    const expected: RuntimeBoot[] = [];
    let writingPid: number;
    try {
      writingPid = (await writingPool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'))
        .rows[0]!.pid;
      const store = new PostgresRuntimeBootStore(writingPool);
      for (const status of ['starting', 'running', 'closed', 'failed'] as const) {
        const input = bootInput({ gitCommit: `持久化版本-${status}` });
        await store.startBoot(input);
        if (status === 'running') expect(await store.markRunning(input.bootId)).toBe(true);
        const terminal = status === 'closed' || status === 'failed';
        if (terminal) expect(await store.closeBoot(input.bootId, { status, closedAt })).toBe(true);
        expected.push({ ...input, status, closedAt: terminal ? closedAt : null });
      }
    } finally {
      await writingPool.end();
    }
    const recoveredPool = createPostgresPool(database.databaseUrl, { max: 1 });
    try {
      const identity = (
        await recoveredPool.query<{ name: string; pid: number }>(
          'SELECT current_database() AS name, pg_backend_pid() AS pid'
        )
      ).rows[0]!;
      expect(identity.name).toBe(database.databaseName);
      expect(identity.pid).not.toBe(writingPid);
      const recovered = new PostgresRuntimeBootStore(recoveredPool);
      for (const boot of expected) expect(await recovered.getBoot(boot.bootId)).toEqual(boot);
    } finally {
      await recoveredPool.end();
    }
  }, 30_000);

  it('真实 SQL 非空约束错误直接传播，失败写入不留下启动记录', async () => {
    const input = bootInput();
    // 只破坏输入类型以触发真实数据库约束，不替换 PostgreSQL 或查询实现。
    await expect(
      storeA.startBoot({ ...input, gitCommit: null as unknown as string })
    ).rejects.toMatchObject({ code: '23502' });
    expect(await storeB.getBoot(input.bootId)).toBeNull();
    expect(await storeA.startBoot(input)).toEqual({
      inserted: true,
      boot: { ...input, status: 'starting', closedAt: null },
    });
  });
});
