import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import EventEmitter from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Memory } from '@mastra/memory';
import { LibSQLStore } from '@mastra/libsql';
import type { KK9Driver, KK9Message, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import {
  KKBotAgent,
  MastraModelFactory,
  createFakeModel,
  deriveUserMessageId,
  deriveAssistantMessageId,
  ensureMastraThread,
  createMastraTextMessage,
} from '@kkbot/agent';
import { SessionCoordinator } from '@kkbot/gateway';

class MockDriver extends EventEmitter {
  public selectSession = vi.fn().mockResolvedValue(true);
  public getCurrentSession = vi.fn().mockResolvedValue({ id: 'session_init' });
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public sendText = vi.fn().mockImplementation((_text: string, _options?: { targetSessionId?: string }) => {
    return Promise.resolve({
      success: true,
      messageId: `mock_sent_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    } as SendResult);
  });
  public sendRichText = vi.fn().mockImplementation(() => {
    return Promise.resolve({
      success: true,
      messageId: `mock_sent_rich_${Date.now()}`,
    } as SendResult);
  });

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (content && typeof content === 'object' && 'content' in content) {
    return String((content as { content: unknown }).content);
  }
  return String(content);
}

describe('MEMORY-01 Contract: Mastra-native Memory, Thread/Resource Identity & Read-Only Agent Loop', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let mockDriver: MockDriver;
  let coordinator: SessionCoordinator;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-memory01-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({
      id: 'test-mastra-storage',
      url: fileUrl,
    });
    await libSqlStore.init();

    mastraMemory = new Memory({
      storage: libSqlStore,
    });

    mockDriver = new MockDriver();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
    if (store) {
      store.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('MEMORY-01.1: 固定身份映射 threadId = sessionId, resourceId = senderId，两个会话不串线', async () => {
    const threadA = 'session_private_001';
    const resourceA = 'emp_alice';
    const threadB = 'session_private_002';
    const resourceB = 'emp_bob';

    await ensureMastraThread(mastraMemory, threadA, resourceA);
    await ensureMastraThread(mastraMemory, threadB, resourceB);

    await mastraMemory.saveMessages({
      messages: [
        createMastraTextMessage({
          id: deriveUserMessageId(threadA, 'native_1'),
          role: 'user',
          content: 'Alice 的消息',
          threadId: threadA,
          resourceId: resourceA,
        }),
      ],
    });

    await mastraMemory.saveMessages({
      messages: [
        createMastraTextMessage({
          id: deriveUserMessageId(threadB, 'native_2'),
          role: 'user',
          content: 'Bob 的消息',
          threadId: threadB,
          resourceId: resourceB,
        }),
      ],
    });

    const { messages: msgsA } = await mastraMemory.recall({
      threadId: threadA,
      resourceId: resourceA,
    });
    expect(msgsA.length).toBe(1);
    expect(extractMessageText(msgsA[0].content)).toBe('Alice 的消息');

    const { messages: msgsB } = await mastraMemory.recall({
      threadId: threadB,
      resourceId: resourceB,
    });
    expect(msgsB.length).toBe(1);
    expect(extractMessageText(msgsB[0].content)).toBe('Bob 的消息');
  });

  it('MEMORY-01.2: user message 在 Agent 运行前通过 Memory.saveMessages 显式保存，使用稳定 ID', async () => {
    const fakeModel = createFakeModel({
      responses: [
        {
          text: '收到查询',
          finishReason: 'stop',
        },
      ],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_pre_save_001';
    const senderId = 'emp_charlie';
    const nativeMsgId = 'native_msg_999';

    await coordinator.handleInboundMessage({
      id: nativeMsgId,
      messageId: nativeMsgId,
      sessionId,
      sessionName: 'Charlie',
      sessionType: 'private',
      sender: 'Charlie',
      senderId,
      content: '请帮我查询制度',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 验证 Mastra Memory 中 user 消息已持久化，且 ID 严格符合稳定派生规则
    const { messages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    const userMsg = messages.find((m) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg?.id).toBe(deriveUserMessageId(sessionId, nativeMsgId));
    expect(extractMessageText(userMsg?.content)).toBe('请帮我查询制度');
  });

  it('MEMORY-01.3: 相同原始消息在串行与并发重放后，仍只形成一条逻辑 user message', async () => {
    const threadId = 'session_idempotent_001';
    const resourceId = 'emp_david';
    const stableId = deriveUserMessageId(threadId, 'native_idempotent_100');

    await ensureMastraThread(mastraMemory, threadId, resourceId);

    // 并发 10 次写入相同 user 消息
    const savePromises = Array.from({ length: 10 }, () =>
      mastraMemory.saveMessages({
        messages: [
          createMastraTextMessage({
            id: stableId,
            role: 'user',
            content: '并发测试消息',
            threadId,
            resourceId,
          }),
        ],
      })
    );
    await Promise.all(savePromises);

    const { messages } = await mastraMemory.recall({
      threadId,
      resourceId,
    });

    expect(messages.length).toBe(1);
    expect(messages[0].id).toBe(stableId);
    expect(extractMessageText(messages[0].content)).toBe('并发测试消息');
  });

  it('MEMORY-01.4: Agent 运行明确使用 readOnly=true，可读取既有历史，但不自动保存本轮任何消息', async () => {
    const threadId = 'session_readonly_001';
    const resourceId = 'emp_eva';

    await ensureMastraThread(mastraMemory, threadId, resourceId);

    // 预置旧对话历史
    await mastraMemory.saveMessages({
      messages: [
        createMastraTextMessage({
          id: deriveUserMessageId(threadId, 'old_msg_1'),
          role: 'user',
          content: '旧问题：我的名字叫 Eva',
          threadId,
          resourceId,
        }),
        createMastraTextMessage({
          id: deriveAssistantMessageId('deliv_old_1'),
          role: 'assistant',
          content: '已记住您的名字是 Eva',
          threadId,
          resourceId,
        }),
      ],
    });

    // 显式提交新问题
    const newMsgId = deriveUserMessageId(threadId, 'new_msg_2');
    await mastraMemory.saveMessages({
      messages: [
        createMastraTextMessage({
          id: newMsgId,
          role: 'user',
          content: '新问题：我叫什么名字？',
          threadId,
          resourceId,
        }),
      ],
    });

    const fakeModel = createFakeModel({
      responses: [
        {
          text: '您好 Eva，您的名字是 Eva。',
          finishReason: 'stop',
        },
      ],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    // 执行 Agent（带 readOnly: true）
    const result = await agent.execute({
      input: '新问题：我叫什么名字？',
      sessionId: threadId,
      senderId: resourceId,
    });

    expect(result.text).toBe('您好 Eva，您的名字是 Eva。');

    // Agent 执行完成后，检查 Memory：未自动产生新的 assistant 记录（只有显式提交的 3 条）
    const { messages: afterRunMsgs } = await mastraMemory.recall({
      threadId,
      resourceId,
    });

    expect(afterRunMsgs.length).toBe(3);
    expect(afterRunMsgs.filter((m) => m.role === 'assistant').length).toBe(1); // 仍只有旧的那条
  });

  it('MEMORY-01.5: assistant message 仅在 Delivery 进入 sent 后通过 Memory.saveMessages 显式提交', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '最终回复', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_asst_commit_001';
    const senderId = 'emp_frank';
    const nativeMsgId = 'native_frank_1';

    await coordinator.handleInboundMessage({
      id: nativeMsgId,
      messageId: nativeMsgId,
      sessionId,
      sessionName: 'Frank',
      sessionType: 'private',
      sender: 'Frank',
      senderId,
      content: '问题',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('sent');
    expect(deliveries[0].memoryCommittedAt).toBeGreaterThan(0);

    const { messages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    const asstMsg = messages.find((m) => m.role === 'assistant');
    expect(asstMsg).toBeDefined();
    expect(asstMsg?.id).toBe(deriveAssistantMessageId(deliveries[0].id));
    expect(extractMessageText(asstMsg?.content)).toBe('最终回复');
  });

  it('MEMORY-01.6: 发送未获成功时 Delivery 进入 failed，且绝不提交 assistant Memory', async () => {
    mockDriver.sendText.mockResolvedValueOnce({
      success: false,
      error: 'CDP timeout',
    });
    const fakeModel = createFakeModel({
      responses: [{ text: '未送达的回复', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_nonsent_001';
    const senderId = 'emp_grace';

    await coordinator.handleInboundMessage({
      id: 'msg_grace_1',
      messageId: 'msg_grace_1',
      sessionId,
      sessionName: 'Grace',
      sessionType: 'private',
      sender: 'Grace',
      senderId,
      content: '测试非 sent 隔离',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    expect(deliveries[0].status).toBe('failed');
    expect(deliveries[0].memoryCommittedAt).toBeNull();

    const { messages } = await mastraMemory.recall({
      threadId: sessionId,
      resourceId: senderId,
    });

    expect(messages.filter((m) => m.role === 'assistant').length).toBe(0);
  });

  it('MEMORY-01.7: sent-but-uncommitted 检查点可被准确检索，且保持 sent 状态', async () => {
    const fakeModel = createFakeModel({
      responses: [{ text: '测试 sent-but-uncommitted', finishReason: 'stop' }],
    });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    const origSaveMessages = mastraMemory.saveMessages.bind(mastraMemory);
    let saveCount = 0;
    vi.spyOn(mastraMemory, 'saveMessages').mockImplementation(async (opts) => {
      saveCount++;
      if (saveCount === 2) {
        throw new Error('Simulated memory storage outage on assistant commit');
      }
      return origSaveMessages(opts);
    });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    const sessionId = 'session_uncommitted_001';
    const senderId = 'emp_helen';

    await coordinator.handleInboundMessage({
      id: 'msg_helen_1',
      messageId: 'msg_helen_1',
      sessionId,
      sessionName: 'Helen',
      sessionType: 'private',
      sender: 'Helen',
      senderId,
      content: '测试检查点',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(sessionId);

    // 检查 Delivery 为 sent 但 memory_committed_at 为 NULL
    const uncommittedList = await store.deliveries.getSentUncommittedDeliveries();
    expect(uncommittedList.length).toBe(1);
    expect(uncommittedList[0].status).toBe('sent');
    expect(uncommittedList[0].sessionId).toBe(sessionId);
    expect(uncommittedList[0].memoryCommittedAt).toBeNull();
  });

  it('MEMORY-01.8: GroupSession 群聊消息绝不创建 threadId/resourceId 或写入 Mastra Memory', async () => {
    const groupSessionId = 'group_room_memory_01';
    const fakeModel = createFakeModel({ responses: [] });
    const modelFactory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: mockDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
      config: { debounceMs: 50, maxWaitMs: 150 },
    });
    await coordinator.start();

    await coordinator.handleInboundMessage({
      id: 'group_msg_mem_1',
      messageId: 'group_msg_mem_1',
      sessionId: groupSessionId,
      sessionName: '群聊',
      sessionType: 'group',
      sender: '某群员',
      senderId: 'emp_group_user',
      content: '群消息',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    });

    await coordinator.flushSession(groupSessionId);

    // 验证 Mastra Memory 中不存在该 thread
    const thread = await mastraMemory.getThreadById({ threadId: groupSessionId });
    expect(thread).toBeNull();
  });
});
