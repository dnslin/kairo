import EventEmitter from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { Client } from '@libsql/client';
import type { KK9Driver, KK9Message, KK9RecalledEvent, SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import {
  AgentMemoryManager,
  ApprovalManager,
  createAgentTool,
  createHitlStorage,
  createHitlWorkflow,
  createRegisterProactiveScheduleTool,
  KkbotAgentRuntime,
  LeaderApprovalRouter,
  ReadWriteSplitExecutor,
  StatefulApprovalMatcher,
  ToolRegistry,
  type LLMProvider,
} from '@kkbot/agent';
import { Mastra } from '@mastra/core';
import { SessionCoordinator } from '../src/coordinator.js';
import { ProactiveScheduleManager } from '../src/schedule/index.js';

/**
 * 模拟 KK9Driver 行为测试桩
 */
class MockDriver extends EventEmitter {
  public activeSessionId = 'session_emp_001';
  public markSessionRead = vi.fn().mockResolvedValue(true);
  public selectSession = vi.fn().mockImplementation((sessionId: string) => {
    this.activeSessionId = sessionId;
    return Promise.resolve(true);
  });
  public getCurrentSession = vi.fn().mockImplementation(() => {
    return Promise.resolve({
      id: this.activeSessionId,
      name: this.activeSessionId,
      type: 'private',
    });
  });
  public sendText = vi
    .fn()
    .mockImplementation((_text: string, options?: { targetSessionId?: string }) => {
      if (options?.targetSessionId && options.targetSessionId !== this.activeSessionId) {
        return Promise.resolve({
          success: false,
          error: `发送前状态校验失败: session_switched - 当前活跃会话 [${this.activeSessionId}] 与目标会话 [${options.targetSessionId}] 不一致`,
        } as SendResult);
      }
      return Promise.resolve({
        success: true,
        messageId: `bot_reply_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      } as SendResult);
    });
  public sendRichText = vi
    .fn()
    .mockImplementation((_text: unknown, options?: { targetSessionId?: string }) => {
      if (options?.targetSessionId && options.targetSessionId !== this.activeSessionId) {
        return Promise.resolve({
          success: false,
          error: `发送前状态校验失败: session_switched - 当前活跃会话 [${this.activeSessionId}] 与目标会话 [${options.targetSessionId}] 不一致`,
        } as SendResult);
      }
      return Promise.resolve({
        success: true,
        messageId: `bot_reply_rich_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      } as SendResult);
    });
  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
  }
}

function createSampleMsg(overrides: Partial<KK9Message> = {}): KK9Message {
  const id = overrides.id || `msg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    sessionId: 'session_emp_001',
    sessionName: '张三工程师',
    sessionType: 'private',
    sender: '张三',
    senderId: 'emp_dev_1',
    content: '你好，请帮我查询本周待办。',
    time: '10:00',
    isMe: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('SessionCoordinator 与 @kkbot/agent 认知微内核完整集成装配测试', () => {
  let mockDriver: MockDriver;
  let store: KKBotStore;
  let client: Client;
  let memoryManager: AgentMemoryManager;
  let approvalManager: ApprovalManager;
  let leaderRouter: LeaderApprovalRouter;
  let statefulMatcher: StatefulApprovalMatcher;
  let scheduleManager: ProactiveScheduleManager;
  let toolRegistry: ToolRegistry;
  let mockDangerousExecute: ReturnType<typeof vi.fn>;
  let mockLLMProvider: LLMProvider;
  let agentRuntime: KkbotAgentRuntime;
  let coordinator: SessionCoordinator | null = null;

  beforeEach(async () => {
    coordinator = null;
    mockDriver = new MockDriver();
    // 1. 初始化统一 LibSQL 内存数据库连接 (单库注入，杜绝多库锁冲突)
    store = await createKKBotStore({ path: ':memory:' });
    client = store.db;

    // 2. 初始化组织架构基础数据 (张三汇报给李总监)
    await store.org.syncOrganization({
      departments: [
        {
          id: 'dept_tech',
          name: '技术中心',
          parentId: null,
          leaderId: 'emp_leader_1',
          level: 1,
        },
      ],
      employees: [
        {
          id: 'emp_dev_1',
          loginName: 'dev1',
          name: '张三',
          leaderId: 'emp_leader_1',
          departments: [
            { deptId: 'dept_tech', isPrimary: true, isLeader: false, position: '高级研发' },
          ],
        },
        {
          id: 'emp_leader_1',
          loginName: 'leader1',
          name: '李总监',
          leaderId: null,
          departments: [
            { deptId: 'dept_tech', isPrimary: true, isLeader: true, position: '部门总监' },
          ],
        },
      ],
    });

    // 3. 初始化 3-Tier 记忆管理器 (复用注入的 client)
    memoryManager = new AgentMemoryManager({
      client,
      autoInitSchema: true,
      l1WindowSize: 20,
    });
    await memoryManager.init();

    // 4. 初始化 Mastra Workflow 与双通道 HITL 审批状态机 (复用注入的 client)
    const storage = createHitlStorage(client);
    await storage.init();
    const hitlWorkflow = createHitlWorkflow();
    new Mastra({
      storage,
      workflows: {
        hitlWorkflow,
      },
    });

    approvalManager = new ApprovalManager({
      client,
      workflow: hitlWorkflow,
      defaultTimeoutMs: 60000,
    });
    await approvalManager.init();

    leaderRouter = new LeaderApprovalRouter({ orgRepository: store.org });
    statefulMatcher = new StatefulApprovalMatcher({
      approvalManager,
      router: leaderRouter,
    });

    // 5. 初始化工具注册中心 (注册一个只读工具和一个高危审批工具)
    toolRegistry = new ToolRegistry();
    mockDangerousExecute = vi
      .fn()
      .mockImplementation(async (args: { configKey: string; value: string }) => {
        await Promise.resolve();
        return { modified: true, configKey: args.configKey, value: args.value };
      });

    const updateConfigTool = createAgentTool({
      id: 'update_system_security_policy',
      description: '修改全局安全策略配置',
      inputSchema: z.object({
        configKey: z.string(),
        value: z.string(),
      }),
      readOnly: false,
      requireApproval: true,
      execute: mockDangerousExecute,
    });
    toolRegistry.register(updateConfigTool);

    // 6. 初始化 LLMProvider Mock
    mockLLMProvider = {
      chat: vi.fn().mockImplementation(async () => {
        await new Promise(r => setTimeout(r, 20));
        return {
          content: '已为您查询到本周共有 3 项待办工单。',
          finishReason: 'stop',
        };
      }),
    };

    // 7. 初始化 KkbotAgentRuntime
    agentRuntime = new KkbotAgentRuntime({
      llmProvider: mockLLMProvider,
      toolRegistry,
      approvalManager,
      leaderRouter,
      watchSoul: false,
    });
    await agentRuntime.init();

    // 8. 初始化 ProactiveScheduleManager (复用注入的 client)
    scheduleManager = new ProactiveScheduleManager({
      client,
      driver: mockDriver as unknown as KK9Driver,
    });
    await scheduleManager.init();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
      coordinator = null;
    }
    await agentRuntime.close();
    await approvalManager.close();
    await memoryManager.close();
    await scheduleManager.stop();
    store.close();
  });

  describe('1. 端到端全链路流水线 (End-to-End Pipeline)', () => {
    it('接收消息 -> 1.5s 防抖合并 -> 调取组织与记忆 -> 认知微内核生成 -> Driver 发送 -> 消除红点 -> 单路径无重复写库', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        memoryManager,
        approvalManager,
        leaderRouter,
        statefulMatcher,
        config: {
          debounceMs: 50,
          maxWaitMs: 200,
          autoMarkRead: true,
        },
      });
      await coordinator.start();

      const msg1 = createSampleMsg({ id: 'm1', content: '查询本周待办' });
      mockDriver.emitMessage(msg1);

      // 等待回复分发与执行完毕
      await new Promise(resolve => coordinator!.on('agent_completed', resolve));

      // 验证 Driver 发送被调用
      expect(mockDriver.sendText).toHaveBeenCalledTimes(1);
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        '已为您查询到本周共有 3 项待办工单。',
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );

      // 验证视觉红点已被显式消除
      expect(mockDriver.markSessionRead).toHaveBeenCalledWith('session_emp_001');

      // 验证 Store 消息单路径持久化：入站消息 1 条 + 出站回复 1 条，无重复双写
      const messages = await store.messages.getSessionHistory('session_emp_001');
      expect(messages).toHaveLength(2);
      expect(messages[0]?.content).toBe('查询本周待办');
      expect(messages[1]?.content).toBe('已为您查询到本周共有 3 项待办工单。');
      expect(messages[1]?.isFromSelf).toBe(true);
    });

    it('混合 agent_claimed 与 pending 消息时仅对 claimed pending 子集执行一次 Agent', async () => {
      mockLLMProvider.chat = vi.fn().mockResolvedValue({
        content: '只处理新消息的回复',
        finishReason: 'stop',
      });
      let startedMessageIds: string[] = [];
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        memoryManager,
        config: { debounceMs: 200, maxWaitMs: 500 },
      });
      coordinator.on('agent_started', (_sessionId, consolidated) => {
        startedMessageIds = consolidated.messageIds;
      });
      await coordinator.start();

      mockDriver.emitMessage(
        createSampleMsg({ id: 'claim-old-001', content: '上一轮已领取的消息' })
      );
      await new Promise(resolve => setTimeout(resolve, 10));
      expect(
        (await store.messages.getMessageBySessionAndMessageId('session_emp_001', 'claim-old-001'))
          ?.processingState
      ).toBe('pending');
      expect(
        await store.messages.claimMessagesForAgent(
          'session_emp_001',
          ['claim-old-001'],
          'previous-run-001'
        )
      ).toEqual(['claim-old-001']);

      const completed = new Promise<void>(resolve => {
        coordinator!.once('agent_completed', () => resolve());
      });
      mockDriver.emitMessage(createSampleMsg({ id: 'claim-new-001', content: '本轮新消息' }));
      await completed;

      expect(startedMessageIds).toEqual(['claim-new-001']);
      expect(mockDriver.sendText).toHaveBeenCalledTimes(1);
    });

    it('多轮对话 3-Tier 记忆协同：首轮对话沉淀 L1 历史并作为标准 user/assistant 消息注入第二轮大模型输入', async () => {
      const chatMessagesList: Array<Array<{ role: string; content: unknown }>> = [];
      mockLLMProvider.chat = vi.fn().mockImplementation(messages => {
        chatMessagesList.push(messages);
        const userMsg = messages[messages.length - 1];
        const text = typeof userMsg?.content === 'string' ? userMsg.content : '';
        if (text.includes('工号')) {
          return {
            content: '第一轮回复：您的工号是 9527。',
            finishReason: 'stop',
          };
        }
        return {
          content: '第二轮回复：今日上午 10 点召开技术评审会。',
          finishReason: 'stop',
        };
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        memoryManager,
        config: {
          debounceMs: 30,
          maxWaitMs: 100,
        },
      });
      await coordinator.start();

      // 第一轮：发送消息
      const round1Done = new Promise(resolve => coordinator!.once('agent_completed', resolve));
      mockDriver.emitMessage(
        createSampleMsg({ id: 'turn_1', content: '第一轮提问：我的工号是多少？' })
      );
      await round1Done;

      // 第二轮：发送新消息
      const round2Done = new Promise(resolve => coordinator!.once('agent_completed', resolve));
      mockDriver.emitMessage(
        createSampleMsg({ id: 'turn_2', content: '第二轮提问：今天技术部有什么会议？' })
      );
      await round2Done;

      expect(chatMessagesList).toHaveLength(2);
      // 验证第二轮消息结构: [system, user(历史), assistant(历史), user(当前)]
      const round2Messages = chatMessagesList[1]!;
      expect(round2Messages[0]?.role).toBe('system');
      // 核心安全断言：system prompt 严禁混入用户原始历史提问 (防提示注入)
      expect(round2Messages[0]?.content).not.toContain('第一轮提问：我的工号是多少？');

      // 核心角色断言：L1 历史以独立的 user 与 assistant 角色传递给大模型
      expect(round2Messages[1]?.role).toBe('user');
      expect(round2Messages[1]?.content).toBe('第一轮提问：我的工号是多少？');
      expect(round2Messages[2]?.role).toBe('assistant');
      expect(round2Messages[2]?.content).toBe('第一轮回复：您的工号是 9527。');

      // 当前轮消息
      expect(round2Messages[3]?.role).toBe('user');
      expect(round2Messages[3]?.content).toBe('第二轮提问：今天技术部有什么会议？');
    });
  });

  describe('2. 生成中并发互斥与瞬时中断 (In-Flight Lock & 50ms Abort & Regroup)', () => {
    it('在延迟 Matcher 异步前同步 0ms 切断在途请求，合并新旧上下文重新生成', async () => {
      // 模拟耗时 LLM 推理生成 (300ms)
      mockLLMProvider.chat = vi.fn().mockImplementation(async (messages, options) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            resolve({
              content: '旧请求回复',
              finishReason: 'stop',
            });
          }, 300);

          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              clearTimeout(timer);
              const err = new Error('AbortError');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      });

      // 在 matcher 上模拟异步耗时，验证 abort 在 matcher 前已同步完成
      const originalMatch = statefulMatcher.match.bind(statefulMatcher);
      vi.spyOn(statefulMatcher, 'match').mockImplementation(async (leaderId, content) => {
        await new Promise(r => setTimeout(r, 60));
        return originalMatch(leaderId, content);
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        approvalManager,
        statefulMatcher,
        config: {
          debounceMs: 30,
          maxWaitMs: 200,
        },
      });
      await coordinator.start();

      let inFlightAbortedEmitted = false;
      coordinator.on('in_flight_aborted', () => {
        inFlightAbortedEmitted = true;
      });

      let agentAbortedEmitted = false;
      coordinator.on('agent_aborted', () => {
        agentAbortedEmitted = true;
      });

      const startedPromise = new Promise(resolve => {
        coordinator!.once('agent_started', resolve);
      });

      // 1. 发送第一条消息触发进入生成
      const msg1 = createSampleMsg({ id: 'msg_abort_1', content: '第一句话：帮我查一下' });
      mockDriver.emitMessage(msg1);

      // 等待进入 Agent 生成中状态
      await startedPromise;
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(true);

      // 2. 在大模型生成途中，同一会话追加第二条消息
      const msg2 = createSampleMsg({ id: 'msg_abort_2', content: '第二句话：我要最新的销售报表' });
      mockDriver.emitMessage(msg2);

      // 核心断言：在途会话被同步切断
      expect(inFlightAbortedEmitted).toBe(true);
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(false);

      // 恢复 LLM 为快速响应，完成重聚后的第二次生成
      mockLLMProvider.chat = vi.fn().mockResolvedValue({
        content: '已为您查询到最新的销售报表。',
        finishReason: 'stop',
      });

      // 等待重聚防抖到期并完成第二次生成
      await new Promise(resolve => coordinator!.on('agent_completed', resolve));

      // 验证第一次生成被打断，仅有一次最终有效回复被递送给用户
      expect(agentAbortedEmitted).toBe(true);
      expect(mockDriver.sendText).toHaveBeenCalledTimes(1);
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        '已为您查询到最新的销售报表。',
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
    });

    it('多级连续追加中断 (CAS Signal 身份锁保护)：旧请求延迟返回不误删新请求的在途锁，第三条消息仍可成功中断', async () => {
      let resolveMsg1: (() => void) | null = null;
      let resolveMsg2: (() => void) | null = null;
      let abortCallCount = 0;

      mockLLMProvider.chat = vi.fn().mockImplementation((messages, options) => {
        const userMsg = messages[messages.length - 1]?.content;
        const text = typeof userMsg === 'string' ? userMsg : '';

        return new Promise((resolve, reject) => {
          if (options?.signal) {
            options.signal.addEventListener('abort', () => {
              abortCallCount++;
              const err = new Error('AbortError');
              err.name = 'AbortError';
              reject(err);
            });
          }

          if (text.includes('消息 1') && !text.includes('消息 2')) {
            resolveMsg1 = () => {
              resolve({ content: '消息 1 延迟返回', finishReason: 'stop' });
            };
          } else if (text.includes('消息 2') && !text.includes('消息 3')) {
            resolveMsg2 = () => {
              resolve({ content: '消息 2 延迟返回', finishReason: 'stop' });
            };
          } else {
            resolve({ content: '第三条消息最终回复', finishReason: 'stop' });
          }
        });
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        config: {
          debounceMs: 30,
          maxWaitMs: 150,
        },
      });
      await coordinator.start();

      // 发送消息 1
      mockDriver.emitMessage(createSampleMsg({ id: 'seq_1', content: '消息 1' }));
      await new Promise(r => setTimeout(r, 45));
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(true);

      // 发送消息 2 (中断消息 1)
      mockDriver.emitMessage(createSampleMsg({ id: 'seq_2', content: '消息 2' }));
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(false);

      // 等待消息 2 的重聚生成启动
      await new Promise(r => setTimeout(r, 45));
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(true);

      // 此时消息 1 的底层延迟 promise 得到解决（CAS 保护下不应清除消息 2 的在途锁）
      if (resolveMsg1) {
        (resolveMsg1 as () => void)();
      }
      await new Promise(r => setTimeout(r, 10));
      // 核心断言：消息 2 的锁仍然存在（未被消息 1 的 finally 误删）
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(true);

      // 发送消息 3 (成功中断消息 2)
      mockDriver.emitMessage(createSampleMsg({ id: 'seq_3', content: '消息 3' }));
      expect(coordinator.hasInFlightSession('session_emp_001')).toBe(false);

      // 释放消息 2 的挂起 promise
      if (resolveMsg2) {
        (resolveMsg2 as () => void)();
      }

      // 等待消息 3 最终合并完成
      await new Promise(resolve => coordinator!.on('agent_completed', resolve));

      expect(abortCallCount).toBe(2); // 消息 1 与消息 2 均被正确中断
      expect(mockDriver.sendText).toHaveBeenCalledTimes(1);
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        '第三条消息最终回复',
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
    });
  });

  describe('3. 直属主管 IM 私聊跨会话 HITL 审批贯通', () => {
    it('高危操作触发审批挂起 -> 自动向直属主管发送私聊通知 -> 主管私聊回复“同意” -> 自动执行高危工具恰好 1 次并跨会话通知员工', async () => {
      // LLM 返回调用高危工具 update_system_security_policy
      mockLLMProvider.chat = vi.fn().mockResolvedValue({
        content: '',
        finishReason: 'tool_calls',
      });

      // 配置 runtime 直接执行指定工具调用
      const originalExecute = agentRuntime.execute.bind(agentRuntime);
      vi.spyOn(agentRuntime, 'execute').mockImplementation(async (threadId, msg, options) => {
        if (msg.content.includes('修改安全策略')) {
          return originalExecute(threadId, msg, {
            ...options,
            toolCalls: [
              {
                callId: 'call_sec_policy_001',
                toolName: 'update_system_security_policy',
                args: { configKey: 'allow_public_access', value: 'false' },
              },
            ],
          });
        }
        return originalExecute(threadId, msg, options);
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        approvalManager,
        leaderRouter,
        statefulMatcher,
        config: {
          debounceMs: 30,
          maxWaitMs: 100,
        },
      });
      await coordinator.start();

      const approvalSuspendedPromise = new Promise(resolve => {
        coordinator!.on('approval_suspended', (sessionId, task) => {
          resolve(task);
        });
      });

      // 1. 张三发送高危操作指令
      const applicantMsg = createSampleMsg({
        id: 'msg_applicant_001',
        senderId: 'emp_dev_1',
        content: '请帮我修改安全策略，把 allow_public_access 设置为 false',
      });
      mockDriver.emitMessage(applicantMsg);

      // 等待高危工具触发挂起
      const task = (await approvalSuspendedPromise) as {
        id: string;
        leaderId: string;
        toolName: string;
      };
      expect(task.toolName).toBe('update_system_security_policy');
      expect(task.leaderId).toBe('emp_leader_1');

      // 核心断言：审批前底层高危工具严格未被执行
      expect(mockDangerousExecute).toHaveBeenCalledTimes(0);

      // 等待挂起中消息发送完成
      await new Promise(r => setTimeout(r, 60));

      // 验证向申请人张三发送了挂起中提示，并且严格保留红点 (markRead: false)
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining('高危权限'),
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
      expect(mockDriver.markSessionRead).not.toHaveBeenCalledWith('session_emp_001');

      // 验证已自动向直属主管李总监 (emp_leader_1) 发送了审批通知私聊卡片
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining('update_system_security_policy'),
        expect.objectContaining({ targetSessionId: 'emp_leader_1' })
      );

      // 2. 主管李总监在私聊窗口中回复“同意”
      const leaderReplyMsg: KK9Message = {
        id: 'msg_leader_reply_001',
        sessionId: 'session_leader_chat',
        sessionName: '李总监',
        sessionType: 'private',
        sender: '李总监',
        senderId: 'emp_leader_1',
        content: '同意',
        time: '10:05',
        isMe: false,
        timestamp: Date.now(),
      };

      const approvalResolvedPromise = new Promise(resolve => {
        coordinator!.on('approval_resolved', (leaderId, resolvedTask, approved) => {
          resolve({ leaderId, resolvedTask, approved });
        });
      });

      mockDriver.emitMessage(leaderReplyMsg);

      // 等待决议完成
      const resolution = (await approvalResolvedPromise) as { approved: boolean };
      expect(resolution.approved).toBe(true);

      // 核心断言：主管批准后底层高危工具恰好执行 1 次！
      expect(mockDangerousExecute).toHaveBeenCalledTimes(1);
      expect(mockDangerousExecute).toHaveBeenCalledWith(
        { configKey: 'allow_public_access', value: 'false' },
        expect.objectContaining({ approvedTaskId: task.id })
      );
      // 验证主管私聊窗口收到了批准反馈
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining('update_system_security_policy'),
        expect.objectContaining({ targetSessionId: 'session_leader_chat' })
      );

      // 验证跨会话向申请人原会话 (session_emp_001) 推送了执行结果通知
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining(
          '您的直属主管【李总监】已批准操作【update_system_security_policy】'
        ),
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
    });

    it('主管私聊回复“驳回”：正确拒绝操作并跨会话通知申请人', async () => {
      await approvalManager.startApprovalWorkflow({
        toolCallId: 'call_reject_001',
        toolName: 'update_system_security_policy',
        toolArgs: { configKey: 'allow_debug', value: 'true' },
        applicantId: 'emp_dev_1',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        leaderName: '李总监',
        threadId: 'session_emp_001',
        timeoutMs: 60000,
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        approvalManager,
        leaderRouter,
        statefulMatcher,
      });
      await coordinator.start();

      // 主管私聊回复“驳回”
      const leaderRejectMsg: KK9Message = {
        id: 'msg_reject_001',
        sessionId: 'session_leader_chat',
        sessionName: '李总监',
        sessionType: 'private',
        sender: '李总监',
        senderId: 'emp_leader_1',
        content: '驳回',
        time: '10:10',
        isMe: false,
        timestamp: Date.now(),
      };

      const resolvedPromise = new Promise(resolve => {
        coordinator!.on('approval_resolved', (leaderId, resolvedTask, approved) => {
          resolve({ leaderId, resolvedTask, approved });
        });
      });

      mockDriver.emitMessage(leaderRejectMsg);

      const res = (await resolvedPromise) as { approved: boolean };
      expect(res.approved).toBe(false);

      // 验证高危工具严格未执行
      expect(mockDangerousExecute).toHaveBeenCalledTimes(0);

      // 验证申请人原会话收到驳回通知
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining('您的直属主管【李总监】已驳回操作'),
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
    });

    it('主管多笔待办无编号回复“同意”：触发消歧引导提示', async () => {
      // 创建 2 笔待办任务
      await approvalManager.startApprovalWorkflow({
        toolCallId: 'call_m1',
        toolName: 'tool_a',
        toolArgs: {},
        applicantId: 'emp_dev_1',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        threadId: 'session_emp_001',
      });
      await approvalManager.startApprovalWorkflow({
        toolCallId: 'call_m2',
        toolName: 'tool_b',
        toolArgs: {},
        applicantId: 'emp_dev_1',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        threadId: 'session_emp_001',
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        approvalManager,
        leaderRouter,
        statefulMatcher,
      });
      await coordinator.start();

      const leaderMsg: KK9Message = {
        id: 'msg_generic_agree',
        sessionId: 'session_leader_chat',
        sessionName: '李总监',
        sessionType: 'private',
        sender: '李总监',
        senderId: 'emp_leader_1',
        content: '同意',
        time: '10:12',
        isMe: false,
        timestamp: Date.now(),
      };

      mockDriver.emitMessage(leaderMsg);
      await new Promise(r => setTimeout(r, 60));

      // 验证回复了消歧提示文案
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining('您当前有 2 项待处理的审批事项'),
        expect.objectContaining({ targetSessionId: 'session_leader_chat' })
      );
    });

    it('群聊中的“同意”消息严格不触发 HITL 决议匹配 (Fail-Closed 安全防线)', async () => {
      await approvalManager.startApprovalWorkflow({
        toolCallId: 'call_group_sec',
        toolName: 'tool_secret',
        toolArgs: {},
        applicantId: 'emp_dev_1',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        threadId: 'session_emp_001',
      });

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        approvalManager,
        leaderRouter,
        statefulMatcher,
      });
      await coordinator.start();

      let approvalResolved = false;
      coordinator.on('approval_resolved', () => {
        approvalResolved = true;
      });

      // 主管在群聊中发了一句“同意”
      const groupMsg: KK9Message = {
        id: 'msg_group_agree',
        sessionId: 'group_project_room',
        sessionName: '项目大群',
        sessionType: 'group',
        sender: '李总监',
        senderId: 'emp_leader_1',
        content: '同意',
        time: '10:15',
        isMe: false,
        timestamp: Date.now(),
      };

      mockDriver.emitMessage(groupMsg);
      await new Promise(r => setTimeout(r, 60));

      // 核心安全断言：群聊中的“同意”绝不被判定为主管审批决议
      expect(approvalResolved).toBe(false);
    });

    it('跨会话发送时若当前活跃会话不匹配，Coordinator 自动通过 selectSession 切换会话并安全发送', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      // 模拟当前 KK9 停留在员工会话 A
      mockDriver.activeSessionId = 'session_emp_001';

      // 向主管私聊会话 B 发送跨会话消息
      const res = await coordinator.dispatchReply(
        'session_leader_chat',
        '【审批待办】请审批张三的操作'
      );

      // 验证自动触发了 selectSession 切换到 session_leader_chat
      expect(mockDriver.selectSession).toHaveBeenCalledWith('session_leader_chat');
      // 验证发送成功，未因会话不匹配而被 Driver checkPreSendState 拦截
      expect(res.success).toBe(true);
      expect(res.action).toBe('message_sent');
      expect(mockDriver.activeSessionId).toBe('session_leader_chat');
    });

    it('跨会话发送时若 selectSession 返回 false，执行 Fail-Closed 安全拦截，严禁调用 sendText', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      mockDriver.activeSessionId = 'session_emp_001';
      mockDriver.selectSession.mockResolvedValueOnce(false);

      const res = await coordinator.dispatchReply('session_leader_chat', '【测试消息】');

      // 验证返回 send_failed 且红点未被清除
      expect(res.success).toBe(false);
      expect(res.action).toBe('send_failed');
      expect(res.redDotCleared).toBe(false);
      expect(res.error).toContain('selectSession [session_leader_chat] 返回 false');

      // 核心安全断言：切换失败时严禁调用底层的 sendText
      expect(mockDriver.sendText).not.toHaveBeenCalledWith('【测试消息】', expect.anything());
    });

    it('跨会话发送时若 selectSession 抛出异常，执行 Fail-Closed 安全拦截，严禁调用 sendText', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
      });
      await coordinator.start();

      mockDriver.activeSessionId = 'session_emp_001';
      mockDriver.selectSession.mockRejectedValueOnce(new Error('CDP 连接已断开'));

      const res = await coordinator.dispatchReply('session_leader_chat', '【测试消息】');

      // 验证返回 send_failed
      expect(res.success).toBe(false);
      expect(res.action).toBe('send_failed');
      expect(res.redDotCleared).toBe(false);
      expect(res.error).toContain('CDP 连接已断开');

      // 核心安全断言：抛错时严禁调用底层 sendText 避免发到错误会话
      expect(mockDriver.sendText).not.toHaveBeenCalledWith('【测试消息】', expect.anything());
    });
  });

  describe('4. 主动定时守护与推送 (Proactive Schedules)', () => {
    it('当 scheduleManager.start 抛错时，SessionCoordinator 自动回滚并解绑监听，允许后续重试启动并成功', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        scheduleManager,
      });

      // 1. 模拟 scheduleManager 首次启动失败
      const startSpy = vi
        .spyOn(scheduleManager, 'start')
        .mockRejectedValueOnce(new Error('Mastra Worker 存储暂时不可用'));

      await expect(coordinator.start()).rejects.toThrow('Mastra Worker 存储暂时不可用');

      // 验证未处于 running 状态，且 Driver 监听器已成功被解绑
      expect(coordinator.isRunningCoordinator).toBe(false);

      // 2. 第二次启动成功
      await expect(coordinator.start()).resolves.toBeUndefined();
      expect(coordinator.isRunningCoordinator).toBe(true);

      startSpy.mockRestore();
    });

    it('基于 Mastra Schedules 注册 Cron 定时任务，持久化存储并支持手动触发推送且严格保留红点', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        scheduleManager,
      });
      await coordinator.start();

      const schedule = await scheduleManager.registerSchedule({
        id: 'daily_ticket_summary',
        name: '每日工单晨报',
        targetSessionId: 'session_emp_001',
        cron: '0 9 * * *',
        message: '☀️ 早上好！您今日共有 2 项待跟进工单。',
      });

      expect(schedule.id).toMatch(/daily-ticket-summary/);
      expect(schedule.status).toBe('active');
      expect(schedule.nextFireAt).toBeDefined();

      // 查询任务列表
      const list = await scheduleManager.listSchedules();
      expect(list.length).toBeGreaterThanOrEqual(1);

      // 手动触发定时任务推送 (统一走 Coordinator.dispatchReply 串行锁与会话切换)
      const dispatchRes = await scheduleManager.triggerSchedule(schedule.id);
      expect(dispatchRes).toBeDefined();
      // 核心断言：手动触发仅走单一执行源，sendText 恰好调用 1 次，杜绝重复双发
      expect(mockDriver.sendText).toHaveBeenCalledTimes(1);
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        '☀️ 早上好！您今日共有 2 项待跟进工单。',
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );

      // 核心红点守卫断言：主动定时推送严格保留目标会话红点 (不调用 markSessionRead)
      expect(mockDriver.markSessionRead).not.toHaveBeenCalledWith('session_emp_001');
      // 暂停任务
      const paused = await scheduleManager.pauseSchedule(schedule.id);
      expect(paused?.status).toBe('paused');

      // 恢复任务
      const resumed = await scheduleManager.resumeSchedule(schedule.id);
      expect(resumed?.status).toBe('active');

      // 注销任务
      const deleted = await scheduleManager.unregisterSchedule(schedule.id);
      expect(deleted).toBe(true);
    });

    it('Mastra 原生工作流步驱动的主动推送：通过 executeWorkflowPush 执行并严禁清除红点', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        scheduleManager,
      });
      await coordinator.start();

      const pushRes = await scheduleManager.executeWorkflowPush({
        scheduleId: 'sched_wf_step_1',
        targetSessionId: 'session_emp_001',
        name: '系统维护通知',
        message: '今晚 23:00 系统升级。',
      });

      expect(pushRes.success).toBe(true);
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        '今晚 23:00 系统升级。',
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
      expect(mockDriver.markSessionRead).not.toHaveBeenCalledWith('session_emp_001');
    });

    it('自然语言主动定时任务注册 Tool：绑定 context.threadId 注册任务并在无 threadId 时 fail-closed 安全拦截', async () => {
      const schedTool = createRegisterProactiveScheduleTool({
        scheduleManager,
      });
      const toolRes = await schedTool.execute(
        {
          name: '每日站会提醒',
          cron: '0 10 * * 1-5',
          message: '请准时参加早 10 点晨会。',
        },
        {
          threadId: 'session_emp_001',
          senderId: 'emp_dev_1',
        }
      );

      expect(toolRes.success).toBe(true);
      expect(toolRes.scheduleId).toBeDefined();
      expect(toolRes.message).toContain('每日站会提醒');

      // 验证已落库 Mastra Schedules 且目标会话正确
      const savedSched = await scheduleManager.getSchedule(toolRes.scheduleId!);
      expect(savedSched?.targetSessionId).toBe('session_emp_001');

      // 2. 核心安全防线 (Fail-Closed): 若缺少 context.threadId，拒绝跨会话越权注册
      const failRes = await schedTool.execute(
        {
          name: '非法注入提醒',
          cron: '0 10 * * *',
          message: '恶意刷屏',
        },
        undefined
      );

      expect(failRes.success).toBe(false);
      expect(failRes.error).toContain('缺少可信会话上下文');
    });
    it('员工自然语言消息 ➔ LLM 首轮接收 Draft-07 JSON Schema tools 并返回 toolCalls ➔ Runtime 执行 ➔ 二次回灌模型 ➔ 成功落库 Mastra Schedules 且自动私聊回复', async () => {
      // 初始化 ToolRegistry 与 ReadWriteSplitExecutor (不手工注册 schedTool)
      const toolRegistry = new ToolRegistry();
      const toolExecutor = new ReadWriteSplitExecutor(toolRegistry);
      let round = 0;
      let receivedTools: unknown[] | undefined;
      const mockReActLLM = {
        chat: vi
          .fn()
          .mockImplementation(
            (
              messages: Array<{ role: string; content: unknown }>,
              options?: { tools?: unknown[] }
            ) => {
              round++;
              if (round === 1) {
                // 首轮：模型断言收到 JSON Schema tools 且结构合规，返回 register_proactive_schedule toolCalls
                receivedTools = options?.tools;
                return Promise.resolve({
                  content: '正在为您创建定时提醒...',
                  finishReason: 'tool_calls',
                  toolCalls: [
                    {
                      id: 'call_sched_nl_001',
                      name: 'register_proactive_schedule',
                      arguments: {
                        name: '工作日早晨站会提醒',
                        cron: '0 9 * * 1-5',
                        message: '早上好！9:30 组内站会请准备。',
                      },
                    },
                  ],
                });
              }
              // 第二轮：模型接收到了 role: 'tool' 的执行结果，生成最终回复
              const toolMsg = messages.find(m => m.role === 'tool');
              const toolContentStr =
                typeof toolMsg?.content === 'string'
                  ? toolMsg.content
                  : JSON.stringify(toolMsg?.content || {});
              return Promise.resolve({
                content: `已为您成功设置【工作日早晨站会提醒】！触发结果: ${toolContentStr}`,
                finishReason: 'stop',
              });
            }
          ),
      };

      const reactAgentRuntime = new KkbotAgentRuntime({
        llmProvider: mockReActLLM,
        toolRegistry,
        toolExecutor,
        watchSoul: false,
      });
      await reactAgentRuntime.init();

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime: reactAgentRuntime,
        scheduleManager,
        config: {
          debounceMs: 20,
        },
      });
      await coordinator.start();

      // 员工发送自然语言请求
      const nlMsg = createSampleMsg({
        id: 'msg_nl_schedule_req',
        content: '帮我定一个工作日早上 9 点提醒我开站会的闹钟',
      });
      mockDriver.emitMessage(nlMsg);

      await new Promise(r => setTimeout(r, 80));

      // 1. 验证首轮模型确实收到了包含 Draft-07 JSON Schema parameters 的 tools
      expect(receivedTools).toBeDefined();
      const schedDef = (
        receivedTools as Array<{ function: { name: string; parameters: Record<string, unknown> } }>
      ).find(t => t.function.name === 'register_proactive_schedule');
      expect(schedDef).toBeDefined();
      expect(schedDef?.function.parameters).toHaveProperty('type', 'object');
      expect(schedDef?.function.parameters).toHaveProperty('properties');

      // 2. 验证模型经过 2 轮调用（首轮 tool call + 次轮自然语言生成）
      expect(mockReActLLM.chat).toHaveBeenCalledTimes(2);

      // 3. 验证 Driver 成功向员工推送了最终回复
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        expect.stringContaining('已为您成功设置【工作日早晨站会提醒】'),
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );

      // 4. 验证任务成功落库 Mastra Schedules 且目标会话严格绑定 session_emp_001
      const schedules = await scheduleManager.listSchedules();
      const createdSched = schedules.find(s => s.name === '工作日早晨站会提醒');
      expect(createdSched).toBeDefined();
      expect(createdSched?.targetSessionId).toBe('session_emp_001');
      expect(createdSched?.cron).toBe('0 9 * * 1-5');
      await reactAgentRuntime.close();
    });
    it('RAG 知识库检索集成：通过 knowledgeRetriever 注入事实切片到 Prompt 事实层', async () => {
      let capturedPrompt = '';
      const mockLLM = {
        chat: vi.fn().mockImplementation((messages: Array<{ role: string; content: unknown }>) => {
          const sysMsg = messages.find(m => m.role === 'system');
          capturedPrompt = typeof sysMsg?.content === 'string' ? sysMsg.content : '';
          return Promise.resolve({
            content: '根据企业上线流程规定，需先在预发环境验证。',
            finishReason: 'stop',
          });
        }),
      };

      const customAgent = new KkbotAgentRuntime({
        llmProvider: mockLLM,
        watchSoul: false,
      });
      await customAgent.init();

      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime: customAgent,
        config: {
          debounceMs: 20,
          knowledgeRetriever: (query, _sid) => {
            if (query.includes('上线流程')) {
              return Promise.resolve([
                '【企业知识库】: 上线流程需提前 2 小时申请发布窗口并在预发验证通过。',
              ]);
            }
            return Promise.resolve([]);
          },
        },
      });
      await coordinator.start();

      const msg = createSampleMsg({
        id: 'msg_rag_query',
        content: '请问我们系统的上线流程是什么？',
      });
      mockDriver.emitMessage(msg);

      await new Promise(r => setTimeout(r, 60));

      // 验证 RAG 事实已注入编译出的 System Prompt
      expect(capturedPrompt).toContain('上线流程需提前 2 小时申请发布窗口');
      expect(mockDriver.sendText).toHaveBeenCalledWith(
        '根据企业上线流程规定，需先在预发环境验证。',
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
      await customAgent.close();
    });
  });
  describe('5. 视觉红点守卫原则与人工退避 (Visual Red Dot Guard & Takeover)', () => {
    it('人类操作员接入客户端 (isMe: true) -> 触发人工退避 10 分钟 -> 后续消息全部静默并严格保留未读红点', async () => {
      coordinator = new SessionCoordinator({
        driver: mockDriver as unknown as KK9Driver,
        store,
        agentRuntime,
        config: {
          debounceMs: 30,
          takeoverDurationMs: 600000,
        },
      });
      await coordinator.start();

      let takeoverEmitted = false;
      coordinator.on('takeover', () => {
        takeoverEmitted = true;
      });

      let suppressedEmitted = false;
      coordinator.on('suppressed', (sessionId, reason) => {
        if (reason === 'human_takeover') {
          suppressedEmitted = true;
        }
      });

      // 1. 人类客服在客户端打字回复客户
      const humanMsg = createSampleMsg({
        id: 'msg_human_agent',
        isMe: true,
        content: '您好，我是人工客服，请问有什么可以帮您？',
      });
      mockDriver.emitMessage(humanMsg);

      await new Promise(r => setTimeout(r, 20));
      expect(takeoverEmitted).toBe(true);
      expect(await coordinator.isTakeoverActive('session_emp_001')).toBe(true);

      // 2. 客户随后发送新消息
      const customerMsg = createSampleMsg({
        id: 'msg_customer_in_takeover',
        content: '我想问一下发票怎么开？',
      });
      mockDriver.emitMessage(customerMsg);

      await new Promise(r => setTimeout(r, 60));

      // 验证消息被抑制静默，Bot 零发送，且坚决不消除红点 (以便人工客服看到新消息)
      expect(suppressedEmitted).toBe(true);
      expect(mockDriver.sendText).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ targetSessionId: 'session_emp_001' })
      );
      expect(mockDriver.markSessionRead).not.toHaveBeenCalledWith('session_emp_001');
    });
  });
});
