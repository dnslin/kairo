import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createClient, type Client } from '@libsql/client';
import { KkbotAgentRuntime } from '../src/runtime.js';
import { ToolRegistry, createAgentTool } from '../src/tools/registry.js';
import { ApprovalManager } from '../src/hitl/manager.js';
import { LeaderApprovalRouter } from '../src/hitl/router.js';
import type { LLMProvider, ConsolidatedMessage } from '../src/types/index.js';

describe('KkbotAgentRuntime 核心智能微内核 HITL 高危工具拦截与执行集成测试', () => {
  let client: Client;
  let toolRegistry: ToolRegistry;
  let approvalManager: ApprovalManager;
  let leaderRouter: LeaderApprovalRouter;
  let runtime: KkbotAgentRuntime;
  let mockToolExecute: ReturnType<typeof vi.fn>;
  let mockLLMProvider: LLMProvider;

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    approvalManager = new ApprovalManager({
      client,
      defaultTimeoutMs: 60000,
    });
    await approvalManager.init();

    leaderRouter = new LeaderApprovalRouter({
      orgRepository: {
        async getEmployeeById(id) {
          await Promise.resolve();
          return { id: String(id), name: '测试员工', leaderId: 'emp_leader_99' };
        },
        async getReportingChain() {
          await Promise.resolve();
          return [];
        },
      },
    });

    toolRegistry = new ToolRegistry();
    mockToolExecute = vi.fn().mockImplementation(async (input: { key: string; value: string }) => {
      await Promise.resolve();
      return { updated: true, key: input.key, value: input.value };
    });

    const dangerousTool = createAgentTool({
      id: 'update_global_security_config',
      description: '修改全局安全策略配置',
      inputSchema: z.object({
        key: z.string().min(1),
        value: z.string().min(1),
      }),
      readOnly: false,
      requireApproval: true,
      execute: mockToolExecute,
    });

    toolRegistry.register(dangerousTool);

    mockLLMProvider = {
      chat: vi.fn().mockImplementation(async () => {
        await Promise.resolve();
        return {
          content: '已为您处理该请求。',
          finishReason: 'stop',
        };
      }),
    };

    runtime = new KkbotAgentRuntime({
      llmProvider: mockLLMProvider,
      toolRegistry,
      approvalManager,
      leaderRouter,
      watchSoul: false,
    });

    await runtime.init();
  });

  afterEach(async () => {
    await runtime.close();
    client.close();
  });

  it('Runtime 级高危工具拦截：触发高危工具时自动挂起，底层 execute 调用次数严格为 0', async () => {
    const userMessage: ConsolidatedMessage = {
      sessionId: 'session_chat_001',
      sessionName: '安全运维沟通群',
      sessionType: 'private',
      sender: '小张',
      senderId: 'emp_zhang_001',
      content: '请帮我把全局安全配置 allow_external_access 改为 true',
      messageCount: 1,
      startTime: Date.now(),
      endTime: Date.now(),
      rawMessages: [],
    };

    const reply = await runtime.execute('session_chat_001', userMessage, {
      toolCalls: [
        {
          callId: 'call_sec_001',
          toolName: 'update_global_security_config',
          args: { key: 'allow_external_access', value: 'true' },
        },
      ],
    });

    expect(reply.finishReason).toBe('tool_calls');
    expect(reply.content).toContain('该操作涉及高危权限');
    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0].status).toBe('suspended');
    expect(reply.toolCalls[0].approvalTaskId).toMatch(/^appr_/);

    // 核心安全断言：底层高危工具未被执行
    expect(mockToolExecute).toHaveBeenCalledTimes(0);

    // 验证待办任务已在数据库中持久化
    const taskId = reply.toolCalls[0].approvalTaskId!;
    const task = await approvalManager.getTaskById(taskId);
    expect(task?.status).toBe('pending');
    expect(task?.leaderId).toBe('emp_leader_99');
  });

  it('Runtime 级批准后执行：主管批准后携带 approvedTaskId 调用，底层工具执行恰好 1 次', async () => {
    const userMessage: ConsolidatedMessage = {
      sessionId: 'session_chat_002',
      sessionName: '安全运维',
      sessionType: 'private',
      sender: '小张',
      senderId: 'emp_zhang_001',
      content: '修改安全配置',
      messageCount: 1,
      startTime: Date.now(),
      endTime: Date.now(),
      rawMessages: [],
    };

    // 1. 首次触发挂起
    const firstReply = await runtime.execute('session_chat_002', userMessage, {
      toolCalls: [
        {
          callId: 'call_sec_002',
          toolName: 'update_global_security_config',
          args: { key: 'max_retry', value: '5' },
        },
      ],
    });

    const taskId = firstReply.toolCalls[0].approvalTaskId!;
    expect(mockToolExecute).toHaveBeenCalledTimes(0);

    // 2. 直属主管批准
    await approvalManager.resolveTask({
      taskId,
      approved: true,
      deciderId: 'emp_leader_99',
    });

    // 3. 携已获批准的 approvedTaskId 恢复执行
    const secondReply = await runtime.execute('session_chat_002', userMessage, {
      approvedTaskId: taskId,
      toolCalls: [
        {
          callId: 'call_sec_002_resumed',
          toolName: 'update_global_security_config',
          args: { key: 'max_retry', value: '5' },
        },
      ],
    });

    expect(secondReply.toolCalls).toHaveLength(1);
    expect(secondReply.toolCalls[0].status).toBe('success');
    expect(secondReply.toolCalls[0].result).toEqual({
      updated: true,
      key: 'max_retry',
      value: '5',
    });
    // 核心安全断言：底层高危工具恰好执行 1 次
    expect(mockToolExecute).toHaveBeenCalledTimes(1);

    // 核心协议断言：LLM Provider 收到的 messages 中包含 role: 'tool' 消息回传给 ReAct 循环
    expect(mockLLMProvider.chat).toHaveBeenCalled();
    const chatMock = vi.mocked(mockLLMProvider.chat);
    const lastChatCall = chatMock.mock.calls.at(-1);
    const passedMessages = lastChatCall ? lastChatCall[0] : [];
    const toolMessage = passedMessages.find(m => m.role === 'tool');
    expect(toolMessage).toBeDefined();
    expect(toolMessage?.toolCallId).toBe('call_sec_002_resumed');
    expect(toolMessage?.content).toContain('max_retry');
    expect(toolMessage?.content).toContain('5');
  });
  it('Fail-Closed 身份防护：缺少 senderId 时高危操作立即被阻断，绝不用昵称冒充 UID', async () => {
    const anonymousMessage: ConsolidatedMessage = {
      sessionId: 'session_chat_anon',
      sessionName: '外部群聊',
      sessionType: 'group',
      sender: '小张', // 仅有昵称展示名，无真实 senderId
      content: '请帮我修改全局配置',
      messageCount: 1,
      startTime: Date.now(),
      endTime: Date.now(),
      rawMessages: [],
    };

    const reply = await runtime.execute('session_chat_anon', anonymousMessage, {
      toolCalls: [
        {
          callId: 'call_sec_anon',
          toolName: 'update_global_security_config',
          args: { key: 'enable_debug', value: 'true' },
        },
      ],
    });

    expect(reply.toolCalls).toHaveLength(1);
    expect(reply.toolCalls[0].status).toBe('error');
    expect(reply.toolCalls[0].error).toContain('缺失必要的员工身份信息 (senderId)');
    expect(mockToolExecute).toHaveBeenCalledTimes(0);

    // 验证数据库中未创建任何无主待办
    const pendingTasks = await approvalManager.getPendingTasksByThreadId('session_chat_anon');
    expect(pendingTasks).toHaveLength(0);
  });
});
