import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../../src/db/transaction.js';
import { createTaskTestDatabase, type TaskTestDatabase } from '../helpers/task-database.js';

let database: TaskTestDatabase;

beforeAll(async () => {
  database = await createTaskTestDatabase();
  await database.poolA.query(
    `CREATE TABLE public.transaction_test_records (
       id text PRIMARY KEY,
       value integer NOT NULL
     )`
  );
}, 30_000);

afterAll(async () => {
  await database?.close();
}, 30_000);

describe('共享事务的真实 PostgreSQL 提交与回滚', () => {
  it('事务提交后的全部写入对独立连接可见', async () => {
    await withTransaction(database.poolA, async client => {
      await client.query(
        'INSERT INTO public.transaction_test_records (id, value) VALUES ($1, $2)',
        ['成功提交', 1]
      );
      await client.query('UPDATE public.transaction_test_records SET value = $2 WHERE id = $1', [
        '成功提交',
        2,
      ]);
    });

    const committed = await database.poolB.query<{ value: number }>(
      'SELECT value FROM public.transaction_test_records WHERE id = $1',
      ['成功提交']
    );
    expect(committed.rows).toEqual([{ value: 2 }]);
  });

  it('后续 SQL 失败会回滚此前新增与更新，同一连接池随后仍能提交', async () => {
    await database.poolA.query(
      'INSERT INTO public.transaction_test_records (id, value) VALUES ($1, $2)',
      ['已提交记录', 10]
    );

    await expect(
      withTransaction(database.poolA, async client => {
        await client.query(
          'INSERT INTO public.transaction_test_records (id, value) VALUES ($1, $2)',
          ['待回滚记录', 1]
        );
        await client.query('UPDATE public.transaction_test_records SET value = $2 WHERE id = $1', [
          '已提交记录',
          20,
        ]);
        // 两次写入均已成功，随后真实 SQL 除零失败，不能只证明首条 INSERT 自己失败。
        await client.query('SELECT 1 / 0');
      })
    ).rejects.toMatchObject({ code: '22012' });

    const rolledBack = await database.poolB.query<{ id: string; value: number }>(
      'SELECT id, value FROM public.transaction_test_records WHERE id = ANY($1::text[])',
      [['已提交记录', '待回滚记录']]
    );
    expect(rolledBack.rows).toEqual([{ id: '已提交记录', value: 10 }]);

    // poolA 由隔离助手固定为 max: 1；若事务泄漏或连接未释放，此处不能正常提交。
    await withTransaction(database.poolA, async client => {
      await client.query(
        'INSERT INTO public.transaction_test_records (id, value) VALUES ($1, $2)',
        ['待回滚记录', 2]
      );
    });
    const recovered = await database.poolB.query<{ value: number }>(
      'SELECT value FROM public.transaction_test_records WHERE id = $1',
      ['待回滚记录']
    );
    expect(recovered.rows).toEqual([{ value: 2 }]);
  });
});
