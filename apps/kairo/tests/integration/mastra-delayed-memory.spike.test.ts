import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { Mastra } from '@mastra/core/mastra';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../src/db/pool.js';
import { migrateDatabase } from '../../src/db/migrate.js';
import { createMastraStorage } from '../../src/mastra/storage.js';
import { createConversationMemory } from '../../src/mastra/memory.js';
import { commitDeliveredMemory, type MemoryDelivery } from '../../src/mastra/delayed-memory.js';
import { createApprovedTestModel, createTestModel } from '../helpers/test-model.js';

const databaseUrl = process.env.KAIRO_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('缺少 KAIRO_TEST_DATABASE_URL，不能执行 T12 PostgreSQL 合同测试');
const databaseName = `kairo_t12_${randomUUID().replaceAll('-', '')}`;
let admin: Pool;
let temporaryUrl: string;
const realModel = process.env.KAIRO_T12_REAL_MODEL === '1';
vi.setConfig({ testTimeout: realModel ? 120_000 : 5_000 });

function runtime() {
  const storage = createMastraStorage(temporaryUrl);
  const { model, inputs } = realModel ? createApprovedTestModel() : createTestModel();
  const memory = createConversationMemory(storage, model);
  const agent = new Agent({
    id: 't12',
    name: 'T12 合同',
    instructions: '只根据当前对话回答。',
    model,
    memory,
  });
  const mastra = new Mastra({ agents: { agent }, storage });
  return {
    storage,
    memory,
    agent,
    inputs,
    async close() {
      await memory.settled();
      await mastra.shutdown();
      await storage.close();
    },
  };
}

function delivery(threadId = randomUUID(), resourceId = randomUUID()): MemoryDelivery {
  return {
    status: 'delivered',
    taskId: randomUUID(),
    threadId,
    resourceId,
    userText: '项目代号是蓝鲸。',
    assistantText: '已确认项目代号是蓝鲸。',
    deliveredAt: new Date('2026-09-05T01:00:01Z'),
  };
}

beforeAll(async () => {
  admin = createPostgresPool(databaseUrl, { max: 1 });
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(databaseUrl);
  url.pathname = `/${databaseName}`;
  temporaryUrl = url.toString();
  await migrateDatabase({ databaseUrl: temporaryUrl });
}, 30_000);

afterAll(async () => {
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
});

describe(`T12 延迟 Memory PostgreSQL 合同（${realModel ? '真实批准模型' : '确定性模型，非真实模型放行'}）`, () => {
  beforeAll(() => {
    if (realModel) createApprovedTestModel();
  });
  it('只读生成读取旧消息，但草稿及本轮输入不落库，也不自动观察', async () => {
    const r = runtime();
    const d = delivery();
    try {
      await commitDeliveredMemory(r.memory, d);
      const engine = await r.memory.omEngine;
      await engine!.updateRecordConfig(d.threadId, d.resourceId, {
        observation: { messageTokens: 1 },
      });
      const before = await r.memory.recall({ threadId: d.threadId, resourceId: d.resourceId });
      await r.agent.generate('不允许保存的输入：红狐', {
        memory: { thread: d.threadId, resource: d.resourceId, options: { readOnly: true } },
      });
      expect(r.inputs).toHaveLength(1);
      expect(r.inputs[0]).toContain('蓝鲸');
      expect(r.inputs[0]).toContain('红狐');
      const after = await r.memory.recall({ threadId: d.threadId, resourceId: d.resourceId });
      expect(after.messages).toEqual(before.messages);
      const om = await r.memory.omEngine;
      expect((await om!.getRecord(d.threadId, d.resourceId))?.activeObservations ?? '').toBe('');
    } finally {
      await r.close();
    }
  });

  it('失败、取消、超时和发送未知均不保存正式消息', async () => {
    const r = runtime();
    try {
      for (const status of ['failed', 'cancelled', 'timed_out', 'unknown'] as const) {
        const d = { ...delivery(), status };
        await commitDeliveredMemory(r.memory, d);
        expect(await r.memory.getThreadById({ threadId: d.threadId })).toBeNull();
      }
    } finally {
      await r.close();
    }
  });

  it('同次送达的正式消息在重复提交及重启后仍按问题、回答排序', async () => {
    const d = delivery();
    let r = runtime();
    try {
      await commitDeliveredMemory(r.memory, d);
      await commitDeliveredMemory(r.memory, d);
    } finally {
      await r.close();
    }
    r = runtime();
    try {
      await commitDeliveredMemory(r.memory, d);
      const store = (await r.storage.getStore('memory'))!;
      const persisted = await store.listMessages({ threadId: d.threadId, perPage: false });
      expect(persisted.messages.map(m => m.role)).toEqual(['user', 'assistant']);
      const result = await r.memory.recall({ threadId: d.threadId, resourceId: d.resourceId });
      expect(result.messages.map(m => ({ role: m.role, parts: m.content.parts }))).toEqual([
        { role: 'user', parts: [{ type: 'text', text: d.userText }] },
        { role: 'assistant', parts: [{ type: 'text', text: d.assistantText }] },
      ]);
    } finally {
      await r.close();
    }
  });

  it.each(['save 前', 'save 后', 'observe 后'] as const)(
    '%s 中断后新实例重放不重复正式消息或观察',
    async crashPoint => {
      const d = delivery();
      let r = runtime();
      try {
        await r.memory.createThread({ threadId: d.threadId, resourceId: d.resourceId });
        const engine = (await r.memory.omEngine)!;
        await engine.observe({ threadId: d.threadId, resourceId: d.resourceId });
        await engine.updateRecordConfig(d.threadId, d.resourceId, {
          observation: { messageTokens: 1 },
        });
        const crash = new Error('模拟进程在持久化边界中断');
        if (crashPoint === 'observe 后') {
          const observe = engine.observe.bind(engine);
          vi.spyOn(engine, 'observe').mockImplementationOnce(async args => {
            await observe(args);
            throw crash;
          });
        } else {
          const save = r.memory.saveMessages.bind(r.memory);
          vi.spyOn(r.memory, 'saveMessages').mockImplementationOnce(async args => {
            if (crashPoint === 'save 后') await save(args);
            throw crash;
          });
        }
        await expect(commitDeliveredMemory(r.memory, d)).rejects.toThrow(crash);
        const stored = await r.memory.recall({ threadId: d.threadId, resourceId: d.resourceId });
        expect(
          stored.messages.filter(m => m.id === JSON.stringify([d.threadId, d.taskId, 'user']))
        ).toHaveLength(crashPoint === 'save 前' ? 0 : 1);
      } finally {
        vi.restoreAllMocks();
        await r.close();
      }
      r = runtime();
      try {
        await commitDeliveredMemory(r.memory, d);
        const engine = (await r.memory.omEngine)!;
        expect(await engine.getObservations(d.threadId, d.resourceId)).toContain('蓝鲸');
        const observation = await engine.getRecord(d.threadId, d.resourceId);
        await commitDeliveredMemory(r.memory, d);
        expect(
          (await engine.observe({ threadId: d.threadId, resourceId: d.resourceId })).observed
        ).toBe(false);
        expect((await engine.getRecord(d.threadId, d.resourceId))?.activeObservations).toBe(
          observation?.activeObservations
        );
        const store = (await r.storage.getStore('memory'))!;
        const persisted = await store.listMessages({ threadId: d.threadId, perPage: false });
        for (const role of ['user', 'assistant']) {
          expect(
            persisted.messages.filter(m => m.id === JSON.stringify([d.threadId, d.taskId, role]))
          ).toHaveLength(1);
        }
        expect(r.inputs).toHaveLength(crashPoint === 'observe 后' ? 0 : 1);
      } finally {
        await r.close();
      }
    }
  );

  it('旧问题晚于上一轮送达时提交，仍进入本轮观察', async () => {
    const r = runtime();
    const first = delivery();
    try {
      await commitDeliveredMemory(r.memory, first);
      const engine = (await r.memory.omEngine)!;
      await engine.updateRecordConfig(first.threadId, first.resourceId, {
        observation: { messageTokens: 1 },
      });
      await engine.observe({ threadId: first.threadId, resourceId: first.resourceId });
      r.inputs.length = 0;
      await commitDeliveredMemory(r.memory, {
        ...first,
        taskId: randomUUID(),
        userText: '下一项任务代号是海豚。',
        assistantText: '收到新任务。',
        deliveredAt: new Date(first.deliveredAt.getTime() + 1000),
      });
      expect(r.inputs[0]).toContain('海豚');
    } finally {
      await r.close();
    }
  });

  it('员工 resource 与新 thread 不读取旧 thread 的消息及 observation', async () => {
    const r = runtime();
    const d = delivery();
    try {
      const other = {
        ...delivery(),
        userText: '我的项目代号是白鹭。',
        assistantText: '已确认白鹭。',
      };
      await commitDeliveredMemory(r.memory, other);
      await commitDeliveredMemory(r.memory, d);
      const engine = (await r.memory.omEngine)!;
      await engine.updateRecordConfig(d.threadId, d.resourceId, {
        observation: { messageTokens: 1 },
      });
      expect(
        (await engine.observe({ threadId: d.threadId, resourceId: d.resourceId })).observed
      ).toBe(true);
      const reflection = await engine.reflect(d.threadId, d.resourceId);
      expect(reflection.reflected).toBe(true);
      expect(reflection.record.activeObservations).toContain('蓝鲸');
      expect(r.inputs).toHaveLength(2);
      r.inputs.length = 0;
      await r.agent.generate('当前项目代号是什么？', {
        memory: { thread: d.threadId, resource: d.resourceId },
      });
      expect(r.inputs.at(-1)).toContain('蓝鲸');
      expect(r.inputs.at(-1)).not.toContain('白鹭');
      await r.agent.generate('当前项目代号是什么？', {
        memory: { thread: other.threadId, resource: other.resourceId },
      });
      expect(r.inputs.at(-1)).toContain('白鹭');
      expect(r.inputs.at(-1)).not.toContain('蓝鲸');
      for (const resource of [d.resourceId, randomUUID()]) {
        await r.agent.generate('当前项目代号是什么？', {
          memory: { thread: randomUUID(), resource },
        });
        expect(r.inputs.at(-1)).not.toContain('蓝鲸');
      }
      await expect(
        commitDeliveredMemory(r.memory, { ...d, resourceId: randomUUID() })
      ).rejects.toThrow('员工');
    } finally {
      await r.close();
    }
  });
});
