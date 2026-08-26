import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import { KKBotAgent } from '../src/agent.js';
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
});
