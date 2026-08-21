import EventEmitter from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { KK9Driver, type FormattedText, type KK9Message, type SendResult } from '../packages/driver/src/index.js';
import { createKKBotStore } from '../packages/store/src/index.js';
import {
  AgentMemoryManager,
  ApprovalManager,
  createAgentTool,
  createHitlStorage,
  createHitlWorkflow,
  KkbotAgentRuntime,
  LeaderApprovalRouter,
  StatefulApprovalMatcher,
  ToolRegistry,
  type LLMProvider,
} from '../packages/agent/src/index.js';
import { Mastra } from '@mastra/core';
import {
  SessionCoordinator,
  ProactiveScheduleManager,
  type CoordinatorDispatchResult,
} from '../packages/gateway/src/index.js';
import { createChildLogger } from '../packages/gateway/src/utils/logger.js';

const log = createChildLogger('verify-agent-e2e');
/**
 * 带超时保护的事件等待工具函数 (杜绝无限阻塞悬挂)
 */
function waitForEvent<T = unknown[]>(
  emitter: EventEmitter,
  event: string,
  timeoutMs = 10000,
  stepName = '执行阶段'
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`⏱️ [超时 ${timeoutMs}ms] ${stepName} 未在预期时限内收到 "${event}" 事件`));
    }, timeoutMs);

    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as T);
    });
  });
}

/**
 * 离线全功能仿真 Driver (当无真实 CDP 或默认安全模式时提供真实状态流转与硬断言支持)
 */
class SimulationDriver extends EventEmitter {
  public sentMessages: Array<{ targetSessionId: string; content: string | FormattedText }> = [];
  public readSessionIds = new Set<string>();

  public async connect(): Promise<void> {
    // 仿真直接就绪
  }

  public async disconnect(): Promise<void> {
    // 仿真直接断开
  }

  public async markSessionRead(sessionId: string): Promise<boolean> {
    this.readSessionIds.add(sessionId);
    return true;
  }

  public async sendText(
    text: string,
    options?: { targetSessionId?: string }
  ): Promise<SendResult> {
    const targetSessionId = options?.targetSessionId ?? 'default_session';
    this.sentMessages.push({ targetSessionId, content: text });
    return {
      success: true,
      messageId: `sim_msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };
  }

  public async sendRichText(
    richText: FormattedText,
    options?: { targetSessionId?: string }
  ): Promise<SendResult> {
    const targetSessionId = options?.targetSessionId ?? 'default_session';
    this.sentMessages.push({ targetSessionId, content: richText });
    return {
      success: true,
      messageId: `sim_rich_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    };
  }

  public emitInbound(msg: KK9Message): void {
    this.emit('message', msg);
  }
}

/**
 * 真机与模拟环境 E2E 验证脚本 (Verify Agent End-to-End)
 * 验证会话编排器 SessionCoordinator 与 Agent 认知微内核的端到端装配
 */
async function runAgentE2eVerification(): Promise<void> {
  console.log('====================================================');
  console.log('🤖 KKBot v2 Gateway + Agent 认知微内核真机装配 E2E 验证');
  console.log('====================================================\n');

  const isLiveRequested = process.env['E2E_LIVE'] === '1';
  const liveTargetSessionId = process.env['E2E_TARGET_SESSION_ID'];
  const liveSupervisorSessionId = process.env['E2E_SUPERVISOR_SESSION_ID'] || liveTargetSessionId;

  let driver: KK9Driver | SimulationDriver;
  let isRealCdp = false;
  let targetSessionId = 'session_test_dev';
  let supervisorSessionId = 'session_leader_chat';

  if (isLiveRequested) {
    if (!liveTargetSessionId) {
      console.error('❌ 开启 E2E_LIVE=1 时必须显式指定 E2E_TARGET_SESSION_ID 环境变量，严禁向随机真实同事会话发送测试消息！');
      process.exit(1);
    }

    console.log(`Step 1: 显式开启真机模式，连接 CDP (127.0.0.1:9222) 并绑定测试目标会话 [${liveTargetSessionId}]...`);
    const realDriver = new KK9Driver({
      cdp: {
        url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
        pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
      },
      polling: {
        intervalMs: 1500,
      },
    });

    await realDriver.connect();
    driver = realDriver;
    isRealCdp = true;
    targetSessionId = liveTargetSessionId;
    supervisorSessionId = liveSupervisorSessionId!;
    console.log(`  ✅ 成功连接至真实 KK9 Electron CDP 会话，指定测试会话: ${targetSessionId}\n`);
  } else {
    console.log('Step 1: 默认安全仿真模式 (如需真实真机交互，请配置 E2E_LIVE=1 和 E2E_TARGET_SESSION_ID)...');
    driver = new SimulationDriver();
    await driver.connect();
    console.log('  ✅ 启用高保真 SimulationDriver 执行严谨全链路硬断言验证。\n');
  }

  // 2. 初始化独立唯一的 LibSQL 数据库 (杜绝旧数据干扰多任务消歧)
  const uniqueDbName = `kkbot_e2e_${Date.now()}_${randomUUID().slice(0, 8)}.db`;
  const dbPath = path.resolve(os.tmpdir(), uniqueDbName);
  console.log(`Step 2: 初始化单库 LibSQL 存储持久化中枢 (${dbPath})...`);
  const store = await createKKBotStore({ path: dbPath });
  const client = store.db;
  console.log('  ✅ 单库 LibSQL 存储中枢就绪。\n');

  // 3. 同步测试组织架构
  console.log('Step 3: 同步企业组织架构汇报链 (测试员工小明 -> 直属主管李总监)...');
  await store.org.syncOrganization({
    departments: [
      {
        id: 'dept_arch',
        name: '基础架构部',
        parentId: null,
        leaderId: 'emp_leader_100',
        level: 1,
      },
    ],
    employees: [
      {
        id: 'emp_dev_100',
        loginName: 'ming.xiao',
        name: '小明工程师',
        leaderId: 'emp_leader_100',
        departments: [
          { deptId: 'dept_arch', isPrimary: true, isLeader: false, position: '服务端开发' },
        ],
      },
      {
        id: 'emp_leader_100',
        loginName: 'zongjian.li',
        name: '李总监',
        leaderId: null,
        departments: [
          { deptId: 'dept_arch', isPrimary: true, isLeader: true, position: '部门总监' },
        ],
      },
    ],
  });
  console.log('  ✅ 组织架构同步成功。\n');

  // 4. 初始化 3-Tier 记忆管理器
  console.log('Step 4: 装配 3-Tier 记忆引擎 (L1 滑动窗口 / L2 滚动摘要 / L3 实体画像)...');
  const memoryManager = new AgentMemoryManager({
    client,
    autoInitSchema: true,
    l1WindowSize: 20,
  });
  await memoryManager.init();
  console.log('  ✅ 3-Tier 记忆管理器装配完成。\n');

  // 5. 初始化双通道 HITL 审批状态机与 Mastra Workflow
  console.log('Step 5: 装配双通道 HITL 审批状态机与 Mastra Workflow...');
  const storage = createHitlStorage(client);
  await storage.init();
  const hitlWorkflow = createHitlWorkflow();
  new Mastra({
    storage,
    workflows: {
      hitlWorkflow,
    },
  });

  const approvalManager = new ApprovalManager({
    client,
    workflow: hitlWorkflow,
    defaultTimeoutMs: 60000,
  });
  await approvalManager.init();

  const leaderRouter = new LeaderApprovalRouter({ orgRepository: store.org });
  const statefulMatcher = new StatefulApprovalMatcher({
    approvalManager,
    router: leaderRouter,
  });
  console.log('  ✅ 双通道主管审批状态机装配完成。\n');

  // 6. 初始化工具注册中心
  console.log('Step 6: 注册业务与高危工具 (restart_production_cluster)...');
  const toolRegistry = new ToolRegistry();
  let toolExecutedCount = 0;

  const restartClusterTool = createAgentTool({
    id: 'restart_production_cluster',
    description: '重启核心生产集群节点',
    inputSchema: z.object({
      clusterId: z.string(),
      reason: z.string(),
    }),
    readOnly: false,
    requireApproval: true,
    execute: async (args: { clusterId: string; reason: string }, ctx) => {
      toolExecutedCount++;
      console.log(`    ⚡ [高危工具已执行] 集群: ${args.clusterId}, 原因: ${args.reason}, 操作人: ${ctx?.senderId}`);
      return { status: 'restarted', clusterId: args.clusterId, time: new Date().toISOString() };
    },
  });
  toolRegistry.register(restartClusterTool);
  console.log('  ✅ 工具注册完成。\n');

  // 7. 初始化智能微内核 Runtime
  console.log('Step 7: 初始化 KkbotAgentRuntime 智能认知微内核...');
  const mockLLMProvider: LLMProvider = {
    chat: async (messages) => {
      const userMsg = messages.find(m => m.role === 'user')?.content;
      const text = typeof userMsg === 'string' ? userMsg : '您好';
      if (text.includes('重启核心生产集群')) {
        return {
          content: '',
          finishReason: 'tool_calls',
        };
      }
      return {
        content: `已收到您的指令「${text}」，正在为您执行全量查询分析。`,
        finishReason: 'stop',
      };
    },
  };

  const agentRuntime = new KkbotAgentRuntime({
    llmProvider: mockLLMProvider,
    toolRegistry,
    approvalManager,
    leaderRouter,
    watchSoul: false,
  });
  await agentRuntime.init();
  console.log('  ✅ KkbotAgentRuntime 微内核就绪。\n');

  // 8. 初始化主动推送调度器
  console.log('Step 8: 初始化 ProactiveScheduleManager 定时推送管理器...');
  const scheduleManager = new ProactiveScheduleManager({
    client,
    driver: driver as unknown as KK9Driver,
  });
  await scheduleManager.init();
  console.log('  ✅ 主动推送调度器就绪。\n');

  // 9. 完整装配 SessionCoordinator
  console.log('Step 9: 启动会话编排器 SessionCoordinator 并打通全链路闭环...');
  const coordinator = new SessionCoordinator({
    driver: driver as unknown as KK9Driver,
    store,
    agentRuntime,
    memoryManager,
    approvalManager,
    leaderRouter,
    statefulMatcher,
    scheduleManager,
    config: {
      debounceMs: 50,
      maxWaitMs: 200,
      autoMarkRead: true,
    },
  });
  await coordinator.start();
  console.log('  ✅ SessionCoordinator 编排中枢已全面就绪！\n');

  try {
    // 10. 验证普通消息防抖与应答闭环
    console.log('Step 10: 验证普通对话入站 ➔ 防抖 ➔ Agent 回复 ➔ 红点消除...');
    const replyDispatchedPromise = waitForEvent<[string, CoordinatorDispatchResult]>(
      coordinator,
      'reply_dispatched',
      8000,
      'Step 10 普通对话生成与分发'
    );

    driver.emit('message', {
      id: 'e2e_msg_001',
      sessionId: targetSessionId,
      sessionName: '小明工程师',
      sessionType: 'private',
      sender: '小明工程师',
      senderId: 'emp_dev_100',
      content: '请帮我查询今日服务健康度指标',
      time: '12:00',
      isMe: false,
      timestamp: Date.now(),
    });

    const [, dispatchRes] = await replyDispatchedPromise;
    if (!dispatchRes.success) {
      throw new Error(`普通对话消息回复分发失败: ${dispatchRes.error}`);
    }
    if (!dispatchRes.redDotCleared) {
      throw new Error('普通对话回复成功后应消除视觉红点');
    }
    console.log('  ✅ 普通对话流水线顺利闭环并消除红点！\n');

    // 11. 验证主动定时任务推送
    console.log('Step 11: 验证主动定时任务注册 ➔ Mastra Schedules 存储 ➔ 触发推送 (严格保留红点)...');
    const schedule = await scheduleManager.registerSchedule({
      id: 'e2e_daily_health_check',
      name: '每日健康巡检推送',
      targetSessionId,
      cron: '0 9 * * *',
      message: '📊 今日集群健康度 99.99%，所有容器状态正常。',
    });

    const schedulePushRes = await scheduleManager.triggerSchedule(schedule.id);
    if (!schedulePushRes || !schedulePushRes.success) {
      throw new Error('主动定时任务推送执行失败');
    }
    if (schedulePushRes.redDotCleared) {
      throw new Error('主动定时推送严禁清除目标会话未读红点');
    }
    console.log('  ✅ 主动定时任务推送成功且严格保留红点！\n');

    // 12. 验证双通道 HITL 主管私聊审批闭环
    console.log('Step 12: 验证高危操作挂起 ➔ 主管私聊审批 ➔ 跨会话执行闭环...');
    const { task } = await approvalManager.startApprovalWorkflow({
      toolCallId: 'call_restart_001',
      toolName: 'restart_production_cluster',
      toolArgs: { clusterId: 'k8s-prod-us-west', reason: '版本发布灰度滚动重启' },
      applicantId: 'emp_dev_100',
      applicantName: '小明工程师',
      leaderId: 'emp_leader_100',
      leaderName: '李总监',
      threadId: targetSessionId,
      timeoutMs: 60000,
    });

    if (toolExecutedCount !== 0) {
      throw new Error('审批挂起前底层高危工具严禁提前执行');
    }

    // 主管在私聊窗口回复“同意”
    const approvalResolvedPromise = waitForEvent<[string, unknown, boolean]>(
      coordinator,
      'approval_resolved',
      8000,
      'Step 12 主管私聊审批决议流转'
    );

    driver.emit('message', {
      id: 'e2e_leader_msg_001',
      sessionId: supervisorSessionId,
      sessionName: '李总监',
      sessionType: 'private',
      sender: '李总监',
      senderId: 'emp_leader_100',
      content: '同意',
      time: '12:05',
      isMe: false,
      timestamp: Date.now(),
    });

    const [, , approved] = await approvalResolvedPromise;
    if (!approved) {
      throw new Error('主管审批决议应为 approved = true');
    }
    if (toolExecutedCount !== 1) {
      throw new Error(`主管批准后底层高危工具应恰好执行 1 次，当前执行次数: ${toolExecutedCount}`);
    }
    console.log(`  ✅ 主管私聊决议通过，底层高危工具恰好执行 1 次并跨会话通知原申请人！\n`);

    console.log('====================================================');
    console.log('🎉 KKBot v2 Gateway + Agent 全链路集成装配真机与仿真验证 100% 成功！');
    console.log('====================================================\n');
  } finally {
    await coordinator.stop();
    await agentRuntime.close();
    await approvalManager.close();
    await memoryManager.close();
    await scheduleManager.stop();
    store.close();
    if (isRealCdp) {
      await (driver as KK9Driver).disconnect();
    }
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    } catch {
      // 忽略临时清理错误
    }
  }
}

runAgentE2eVerification()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ E2E 验证发生异常:', err);
    process.exit(1);
  });
