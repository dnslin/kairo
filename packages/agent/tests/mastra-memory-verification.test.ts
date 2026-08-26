import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import {
  KKBotAgent,
  removeMastraMessage,
  resetObservationalMemoryScope,
} from '../src/agent.js';
import { MastraModelFactory } from '../src/models/factory.js';
import { createFakeModel } from './fixtures/fake-model.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

describe('Mastra Memory & LibSQLStore API Verification', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let libSqlStore: LibSQLStore;
  let memory: Memory;

  function extractTextContent(content: unknown): string {
    if (typeof content === 'string') {
      return content;
    }
    if (content && typeof content === 'object' && 'content' in content) {
      return String((content as { content: unknown }).content);
    }
    return String(content);
  }

  async function ensureThread(mem: Memory, threadId: string, resourceId: string) {
    const existing = await mem.getThreadById({ threadId });
    if (!existing) {
      await mem.createThread({ threadId, resourceId });
    }
  }

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-mem-test-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    libSqlStore = new LibSQLStore({
      id: 'test-mastra-store',
      url: fileUrl,
    });
    await libSqlStore.init();

    memory = new Memory({
      storage: libSqlStore,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  it('saveMessages and recall work with stable IDs, threadId and resourceId', async () => {
    const threadId = 'session_private_001';
    const resourceId = 'emp_user_001';
    const stableUserMsgId = 'msg_user_session_private_001_native_1001';

    await ensureThread(memory, threadId, resourceId);

    const saveResult = await memory.saveMessages({
      messages: [
        {
          id: stableUserMsgId,
          role: 'user',
          content: '你好，请帮我查询员工信息',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    expect(saveResult).toBeDefined();

    const { messages } = await memory.recall({
      threadId,
      resourceId,
    });

    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(stableUserMsgId);
    expect(messages[0].role).toBe('user');
    expect(extractTextContent(messages[0].content)).toBe('你好，请帮我查询员工信息');
  });

  it('saving duplicate message with same ID is idempotent', async () => {
    const threadId = 'session_private_002';
    const resourceId = 'emp_user_002';
    const stableUserMsgId = 'msg_user_session_private_002_native_2001';

    await ensureThread(memory, threadId, resourceId);

    // 首次保存
    await memory.saveMessages({
      messages: [
        {
          id: stableUserMsgId,
          role: 'user',
          content: '第一次发送',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    // 重放相同 ID
    await memory.saveMessages({
      messages: [
        {
          id: stableUserMsgId,
          role: 'user',
          content: '第一次发送',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    const { messages } = await memory.recall({
      threadId,
      resourceId,
    });

    // 验证幂等：仍只有 1 条消息
    expect(messages.length).toBe(1);
  });

  it('KKBotAgent with memory and readOnly=true reads history without auto-saving assistant or tool messages', async () => {
    const threadId = 'session_private_003';
    const resourceId = 'emp_user_003';
    const stableUserMsgId = 'msg_user_session_private_003_native_3001';

    await ensureThread(memory, threadId, resourceId);

    // 1. 在 Agent 运行前显式保存 user 消息
    await memory.saveMessages({
      messages: [
        {
          id: stableUserMsgId,
          role: 'user',
          content: '请回答：1+1等于几？',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    const fakeModel = createFakeModel({
      responses: [
        {
          text: '1+1等于2。',
          finishReason: 'stop',
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        },
      ],
    });

    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });

    const agent = new KKBotAgent({
      modelFactory: factory,
      memory,
    });

    // 2. 以 readOnly=true 执行 Agent 推理
    const result = await agent.execute({
      input: '请回答：1+1等于几？',
      sessionId: threadId,
      senderId: resourceId,
    });

    expect(result.text).toBe('1+1等于2。');

    // 3. 检查推理后的 Memory：assistant 消息严禁被自动保存 (readOnly 生效)
    const { messages: messagesAfterRun } = await memory.recall({
      threadId,
      resourceId,
    });

    expect(messagesAfterRun.length).toBe(1);
    expect(messagesAfterRun[0].role).toBe('user');

    // 4. 模拟发送成功后显式保存最终 assistant 消息
    const stableAsstMsgId = 'msg_asst_deliv_001';
    await memory.saveMessages({
      messages: [
        {
          id: stableAsstMsgId,
          role: 'assistant',
          content: result.text,
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    const { messages: messagesAfterExplicitCommit } = await memory.recall({
      threadId,
      resourceId,
    });

    expect(messagesAfterExplicitCommit.length).toBe(2);
    expect(messagesAfterExplicitCommit[0].role).toBe('user');
    expect(messagesAfterExplicitCommit[1].role).toBe('assistant');
    expect(messagesAfterExplicitCommit[1].id).toBe(stableAsstMsgId);
    expect(extractTextContent(messagesAfterExplicitCommit[1].content)).toBe('1+1等于2。');
  });

  it('deleteMessages removes message by ID from thread', async () => {
    const threadId = 'session_delete_001';
    const resourceId = 'emp_user_del_001';
    const msgId1 = 'msg_user_session_delete_001_1';
    const msgId2 = 'msg_user_session_delete_001_2';

    await ensureThread(memory, threadId, resourceId);

    await memory.saveMessages({
      messages: [
        {
          id: msgId1,
          role: 'user',
          content: '消息1',
          threadId,
          resourceId,
          createdAt: new Date(Date.now() - 1000),
        },
        {
          id: msgId2,
          role: 'user',
          content: '消息2',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    let recallRes = await memory.recall({ threadId, resourceId });
    expect(recallRes.messages.length).toBe(2);

    // 测试删除 msgId1
    // @ts-expect-error test signature
    await memory.deleteMessages([msgId1]);
    const recallAfter = await memory.recall({ threadId, resourceId });
    expect(recallAfter.messages.length).toBe(1);
    expect(recallAfter.messages[0].id).toBe(msgId2);
  });

  it('deleteThread deletes thread and its messages', async () => {
    const threadId = 'session_delete_thread_001';
    const resourceId = 'emp_user_del_002';
    const msgId1 = 'msg_user_session_del_t1';

    await ensureThread(memory, threadId, resourceId);
    await memory.saveMessages({
      messages: [
        {
          id: msgId1,
          role: 'user',
          content: '待删除线程的消息',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    expect(await memory.getThreadById({ threadId })).toBeDefined();

    // @ts-expect-error testing API signature
    // @ts-expect-error test signature
    await memory.deleteThread(threadId);
    const thread = await memory.getThreadById({ threadId });
    expect(thread).toBeNull();
  });

  it('removeMastraMessage safely deletes a message from thread', async () => {
    const threadId = 'session_rm_msg_01';
    const resourceId = 'emp_rm_01';
    const msgId = 'msg_user_rm_001';

    await ensureThread(memory, threadId, resourceId);
    await memory.saveMessages({
      messages: [
        {
          id: msgId,
          role: 'user',
          content: '这是一条将被撤回的消息',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });

    let recall = await memory.recall({ threadId, resourceId });
    expect(recall.messages.length).toBe(1);

    await removeMastraMessage(memory, msgId);

    recall = await memory.recall({ threadId, resourceId });
    expect(recall.messages.length).toBe(0);
  });

  it('resetObservationalMemoryScope resets thread and only rebuilds from visible messages', async () => {
    const threadId = 'session_om_reset_01';
    const resourceId = 'emp_om_01';
    const msgId1 = 'msg_user_om_keep';
    const msgId2 = 'msg_user_om_recalled';

    await ensureThread(memory, threadId, resourceId);
    await memory.saveMessages({
      messages: [
        {
          id: msgId1,
          role: 'user',
          content: '保留的消息1',
          threadId,
          resourceId,
          createdAt: new Date(Date.now() - 1000),
        },
        {
          id: msgId2,
          role: 'user',
          content: '被撤回的消息2',
          threadId,
          resourceId,
          createdAt: new Date(),
        },
      ],
    });
    // 1. 从 Thread 中显式移除 msgId2
    await removeMastraMessage(memory, msgId2);

    // 2. 重置 OM 范围
    await resetObservationalMemoryScope({
      memory,
      threadId,
      resourceId,
      storage: libSqlStore,
    });

    const recall = await memory.recall({ threadId, resourceId });
    expect(recall.messages.length).toBe(1);
    expect(recall.messages[0].id).toBe(msgId1);
    expect(extractTextContent(recall.messages[0].content)).toBe('保留的消息1');
  });

  it('verifies clearObservationalMemory on LibSQLStore memory domain and memory.settled()', async () => {
    const memDomain = await libSqlStore.getStore('memory');
    expect(memDomain).toBeDefined();

    // @ts-expect-error test clearObservationalMemory
    expect(typeof memDomain?.clearObservationalMemory).toBe('function');

    const resourceId = 'emp_test_om_clear';
    // @ts-expect-error call clearObservationalMemory
    await memDomain?.clearObservationalMemory(null, resourceId);
    await memory.settled();
  });
});
