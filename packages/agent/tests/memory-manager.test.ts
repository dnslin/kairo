import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Client } from '@libsql/client';
import { closeDatabase, createDatabaseClient } from '@kkbot/store';
import { AgentMemoryManager } from '../src/memory/manager.js';
import type { LLMMessage, LLMProvider } from '../src/types/index.js';

describe('AgentMemoryManager 3-Tier 记忆管理系统与物理隔离测试 (TDD Red -> Green)', () => {
  let db: Client;
  let memoryManager: AgentMemoryManager;

  beforeEach(async () => {
    // 为每个测试用例分配隔离的 LibSQL 内存数据库实例
    db = await createDatabaseClient({ path: ':memory:' });
    memoryManager = new AgentMemoryManager({
      client: db,
      l1WindowSize: 5,
      l2SummaryThreshold: 4,
    });
    await memoryManager.init();
  });

  afterEach(async () => {
    await memoryManager.close();
    closeDatabase(db);
  });

  describe('1. 数据库与记忆表结构初始化', () => {
    it('应成功在 LibSQL 数据库中初始化所有核心仓储表与专属记忆表', async () => {
      const res = await db.execute(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name ASC"
      );
      const tables = res.rows.map(r => (typeof r.name === 'string' ? r.name : ''));

      expect(tables).toContain('session_messages');
      expect(tables).toContain('sessions');
      expect(tables).toContain('org_employees');
      expect(tables).toContain('agent_working_summaries');
      expect(tables).toContain('agent_colleague_profiles');
    });
  });

  describe('2. L1 短期会话滑动窗口与撤回消息过滤', () => {
    it('应当能保存消息并按时序正序返回指定条数的滑动窗口', async () => {
      const threadId = 'session_dev_01';

      // 写入 6 条时序递增的消息
      for (let i = 1; i <= 6; i++) {
        await memoryManager.saveMessage({
          threadId,
          sender: i % 2 === 1 ? '张三' : 'KKBot',
          content: `这是第 ${i} 条测试消息`,
          senderId: i % 2 === 1 ? 'user_zhang' : 'bot',
          messageId: `msg_${i}`,
          isFromSelf: i % 2 === 0,
          createdAt: 1000 + i * 10,
        });
      }

      // 窗口大小设为 5 条，应返回最近的第 2~6 条消息
      const window = await memoryManager.getL1Window(threadId, 5);

      expect(window.threadId).toBe(threadId);
      expect(window.totalCount).toBe(5);
      expect(window.filteredRecalledCount).toBe(0);
      expect(window.messages).toHaveLength(5);
      expect(window.messages[0].content).toBe('这是第 2 条测试消息');
      expect(window.messages[4].content).toBe('这是第 6 条测试消息');
      expect(window.formattedText).toContain('张三: 这是第 5 条测试消息');
      expect(window.formattedText).toContain('KKBot: 这是第 6 条测试消息');
    });

    it('当消息被标记撤回时，L1 窗口读取层面必须 100% 自动剔除该消息', async () => {
      const threadId = 'session_recall_01';

      await memoryManager.saveMessage({
        threadId,
        sender: '李四',
        content: '第一条有效消息',
        messageId: 'msg_valid_1',
        createdAt: 1000,
      });

      await memoryManager.saveMessage({
        threadId,
        sender: '李四',
        content: '这条消息包含机密信息，稍后会被撤回',
        messageId: 'msg_secret_2',
        createdAt: 1010,
      });

      await memoryManager.saveMessage({
        threadId,
        sender: '李四',
        content: '第三条有效消息',
        messageId: 'msg_valid_3',
        createdAt: 1020,
      });

      // 撤回第 2 条消息
      const recallResult = await memoryManager.markMessageRecalled(threadId, 'msg_secret_2');
      expect(recallResult).toBe(true);

      // 读取 L1 窗口
      const window = await memoryManager.getL1Window(threadId, 10);

      expect(window.totalCount).toBe(2);
      expect(window.filteredRecalledCount).toBe(1);
      expect(window.messages).toHaveLength(2);
      expect(window.messages.map(m => m.content)).toEqual(['第一条有效消息', '第三条有效消息']);
      expect(window.formattedText).not.toContain('包含机密信息');
    });

    it('对不存在消息的空会话应返回空窗口而不抛出异常', async () => {
      const window = await memoryManager.getL1Window('non_existent_thread');
      expect(window.threadId).toBe('non_existent_thread');
      expect(window.totalCount).toBe(0);
      expect(window.messages).toEqual([]);
      expect(window.filteredRecalledCount).toBe(0);
      expect(window.formattedText).toBe('');
    });
  });

  describe('3. L2 滚动工作摘要 (增量压缩与异步更新)', () => {
    it('初始状态下查询不存在摘要的会话应返回 null', async () => {
      const summary = await memoryManager.getL2Summary('session_no_summary');
      expect(summary).toBeNull();
    });

    it('手动更新 L2 工作摘要并能正确持久化与查询', async () => {
      const threadId = 'session_summary_manual';
      await memoryManager.updateL2Summary(
        threadId,
        '用户咨询了 Q3 财报系统导出报错问题，已引导排查权限。',
        5,
        'msg_5'
      );

      const summary = await memoryManager.getL2Summary(threadId);
      expect(summary).not.toBeNull();
      expect(summary?.threadId).toBe(threadId);
      expect(summary?.summary).toContain('Q3 财报系统导出报错');
      expect(summary?.messageCountCovered).toBe(5);
      expect(summary?.lastMessageId).toBe('msg_5');
    });

    it('当配置了 LLMProvider 且消息达到阈值时，应调用 LLM 生成增量摘要并持久化', async () => {
      let llmCallCount = 0;
      const mockLLM: LLMProvider = {
        chat(messages: LLMMessage[]) {
          llmCallCount++;
          const userMsg = messages.find(m => m.role === 'user');
          expect(userMsg?.content).toContain('请提炼以下会话的核心事实摘要');

          return Promise.resolve({
            content: '【事实摘要】员工王五正在申请 Kubernetes 集群发布权限，等待主管审批。',
          });
        },
      };

      const customManager = new AgentMemoryManager({
        client: db,
        l2SummaryThreshold: 3,
        llmProvider: mockLLM,
      });
      await customManager.init();
      const threadId = 'session_llm_summary';

      // 写入 4 条消息 (达到阈值 3)
      for (let i = 1; i <= 4; i++) {
        await customManager.saveMessage({
          threadId,
          sender: '王五',
          content: `申请 K8s 权限第 ${i} 步`,
          messageId: `k8s_msg_${i}`,
        });
      }

      // 执行摘要生成
      const summaryResult = await customManager.summarizeThread(threadId);

      expect(llmCallCount).toBe(1);
      expect(summaryResult.summary).toContain('Kubernetes 集群发布权限');
      expect(summaryResult.messageCountCovered).toBe(4);

      // 查询数据库确认已持久化
      const savedSummary = await customManager.getL2Summary(threadId);
      expect(savedSummary?.summary).toBe(summaryResult.summary);
    });

    it('异步触发摘要 (maybeTriggerAsyncSummary) 应非阻塞执行', async () => {
      let asyncTriggered = false;
      const mockLLM: LLMProvider = {
        chat() {
          asyncTriggered = true;
          return Promise.resolve({ content: '异步生成的摘要内容' });
        },
      };

      const customManager = new AgentMemoryManager({
        client: db,
        l2SummaryThreshold: 2,
        llmProvider: mockLLM,
      });
      await customManager.init();
      const threadId = 'session_async_summary';
      await customManager.saveMessage({ threadId, sender: 'A', content: '消息1' });
      await customManager.saveMessage({ threadId, sender: 'B', content: '消息2' });

      // 非阻塞异步触发
      const triggered = await customManager.maybeTriggerAsyncSummary(threadId);
      expect(triggered).toBe(true);

      // 等待后台异步完成
      await vi.waitFor(
        async () => {
          const s = await customManager.getL2Summary(threadId);
          expect(s?.summary).toBe('异步生成的摘要内容');
        },
        { timeout: 1000 }
      );

      expect(asyncTriggered).toBe(true);
    });
  });

  describe('4. L3 员工实体画像与长期协同', () => {
    it('查询初始员工画像应返回带默认结构的空画像', async () => {
      const profile = await memoryManager.getL3Profile('user_fresh_001');
      expect(profile.resourceId).toBe('user_fresh_001');
      expect(profile.preferences).toEqual({});
      expect(profile.keyFacts).toEqual([]);
      expect(profile.recentTopics).toEqual([]);
    });

    it('应当能更新与召回员工偏好、组织岗位及关键业务事实', async () => {
      const resourceId = 'user_dev_zhang';

      await memoryManager.updateL3Profile(resourceId, {
        name: '张三',
        department: '云原生平台部',
        position: '资深架构师',
        preferences: {
          techStack: ['Rust', 'TypeScript', 'Kubernetes'],
          preferredNotification: 'im_only',
        },
        keyFacts: ['负责微服务网关改造项目', '熟悉 KK9 开放平台接口规范'],
        rawSummary: '张三是云原生平台部资深架构师，主导网关重构与 IM 机器人落地。',
      });

      const profile = await memoryManager.getL3Profile(resourceId);

      expect(profile.resourceId).toBe(resourceId);
      expect(profile.name).toBe('张三');
      expect(profile.department).toBe('云原生平台部');
      expect(profile.position).toBe('资深架构师');
      expect(profile.preferences).toEqual({
        techStack: ['Rust', 'TypeScript', 'Kubernetes'],
        preferredNotification: 'im_only',
      });
      expect(profile.keyFacts).toContain('负责微服务网关改造项目');
      expect(profile.rawSummary).toContain('主导网关重构');
    });

    it('recordColleagueFact 应当能自动追加事实并执行去重', async () => {
      const resourceId = 'user_fact_test';

      await memoryManager.recordColleagueFact(resourceId, '习惯在早上 9 点前处理工单');
      await memoryManager.recordColleagueFact(resourceId, '主要负责支付网关模块');
      // 重复添加
      await memoryManager.recordColleagueFact(resourceId, '主要负责支付网关模块');

      const profile = await memoryManager.getL3Profile(resourceId);
      expect(profile.keyFacts).toHaveLength(2);
      expect(profile.keyFacts).toEqual(['习惯在早上 9 点前处理工单', '主要负责支付网关模块']);
    });

    it('recordTopicTransition 应当支持多轮话题平滑过渡并维护最近话题窗口', async () => {
      const resourceId = 'user_multi_topic';

      await memoryManager.recordTopicTransition(resourceId, '年假与调休政策咨询');
      await memoryManager.recordTopicTransition(resourceId, '绩效考评系统填报');
      await memoryManager.recordTopicTransition(resourceId, '跨部门协作接口人对接');

      const profile = await memoryManager.getL3Profile(resourceId);
      expect(profile.recentTopics).toEqual([
        '年假与调休政策咨询',
        '绩效考评系统填报',
        '跨部门协作接口人对接',
      ]);
    });
  });

  describe('5. 100% 物理隔离断言 (跨会话与跨员工绝对隔离)', () => {
    it('跨 threadId 隔离：A 会话的 L1 消息与 L2 摘要绝不能被 B 会话读取', async () => {
      const threadA = 'session_user_alice_secret';
      const threadB = 'session_user_bob_public';

      // 在 A 会话中存储机密消息与摘要
      await memoryManager.saveMessage({
        threadId: threadA,
        sender: 'Alice',
        content: 'Alice 的机密薪酬调整讨论',
        senderId: 'user_alice',
      });
      await memoryManager.updateL2Summary(threadA, '【机密】Alice 讨论薪酬与期权激励方案', 1);

      // 在 B 会话中存储普通消息
      await memoryManager.saveMessage({
        threadId: threadB,
        sender: 'Bob',
        content: 'Bob 询问周报提交截止时间',
        senderId: 'user_bob',
      });
      await memoryManager.updateL2Summary(threadB, 'Bob 咨询日常周报流程', 1);

      // 验证 B 会话的 L1 窗口绝无 Alice 的任何消息
      const windowB = await memoryManager.getL1Window(threadB);
      expect(windowB.messages).toHaveLength(1);
      expect(windowB.messages[0].content).toBe('Bob 询问周报提交截止时间');
      expect(windowB.formattedText).not.toContain('Alice');
      expect(windowB.formattedText).not.toContain('薪酬');

      // 验证 B 会话的 L2 摘要绝无 Alice 的摘要
      const summaryB = await memoryManager.getL2Summary(threadB);
      expect(summaryB?.summary).toBe('Bob 咨询日常周报流程');
      expect(summaryB?.summary).not.toContain('薪酬');
    });

    it('跨 resourceId 隔离：员工 A 的 L3 业务偏好与关键事实绝不能被员工 B 召回', async () => {
      const empA = 'user_employee_001_alice';
      const empB = 'user_employee_002_bob';

      // 记录员工 A 的偏好与事实
      await memoryManager.updateL3Profile(empA, {
        name: 'Alice',
        department: '核心安全组',
        preferences: { securityLevel: 'TopSecret', keyGroup: 'SecTeam' },
        keyFacts: ['持有主生产集群 Root 密钥', '直属汇报给 CTO'],
      });

      // 记录员工 B 的偏好与事实
      await memoryManager.updateL3Profile(empB, {
        name: 'Bob',
        department: '运营部',
        preferences: { favoriteChannel: 'email' },
        keyFacts: ['负责每周公众号排版推送'],
      });

      // 查询员工 B 的画像
      const profileB = await memoryManager.getL3Profile(empB);

      // 严格断言隔离性
      expect(profileB.resourceId).toBe(empB);
      expect(profileB.name).toBe('Bob');
      expect(profileB.department).toBe('运营部');
      expect(profileB.preferences).toEqual({ favoriteChannel: 'email' });
      expect(profileB.preferences).not.toHaveProperty('securityLevel');
      expect(profileB.keyFacts).toEqual(['负责每周公众号排版推送']);
      expect(profileB.keyFacts).not.toContain('持有主生产集群 Root 密钥');
    });

    it('同一员工切换不同会话 (新 threadId, 相同 resourceId) 时能够平滑召回 L3 画像但保持 L1 消息隔离', async () => {
      const empId = 'user_colleague_carol';
      const thread1 = 'session_carol_project_alpha';
      const thread2 = 'session_carol_project_beta';

      // 设置 Carol 的长期画像
      await memoryManager.updateL3Profile(empId, {
        name: 'Carol',
        department: '大数据研发部',
        preferences: { primaryLanguage: 'Scala' },
        keyFacts: ['主导实时计算 Flink 平台'],
      });

      // 在会话 1 中聊天
      await memoryManager.saveMessage({
        threadId: thread1,
        sender: 'Carol',
        senderId: empId,
        content: 'Alpha 项目的 Flink 任务已上线',
      });

      // 在会话 2 中聊天 (新话题)
      await memoryManager.saveMessage({
        threadId: thread2,
        sender: 'Carol',
        senderId: empId,
        content: 'Beta 项目需要开通 Spark 权限',
      });

      // 获取会话 1 上下文
      const ctx1 = await memoryManager.getContext({
        threadId: thread1,
        resourceId: empId,
      });

      // 获取会话 2 上下文
      const ctx2 = await memoryManager.getContext({
        threadId: thread2,
        resourceId: empId,
      });

      // 验证 L3 画像在两处均平滑一致召回
      expect(ctx1.l3Profile?.name).toBe('Carol');
      expect(ctx1.l3Profile?.department).toBe('大数据研发部');
      expect(ctx2.l3Profile?.name).toBe('Carol');
      expect(ctx2.l3Profile?.department).toBe('大数据研发部');

      // 验证 L1 消息在两个会话间严格隔离
      expect(ctx1.l1Window?.formattedText).toContain('Alpha 项目');
      expect(ctx1.l1Window?.formattedText).not.toContain('Beta 项目');

      expect(ctx2.l1Window?.formattedText).toContain('Beta 项目');
      expect(ctx2.l1Window?.formattedText).not.toContain('Alpha 项目');
    });
  });

  describe('6. 3-Tier 记忆上下文一键组装 (getContext) 与 Prompt 格式化', () => {
    it('getContext 应能聚合 L1/L2/L3 并生成格式化文本注入 System Prompt', async () => {
      const threadId = 'session_ctx_demo';
      const resourceId = 'user_ctx_demo';

      // L1
      await memoryManager.saveMessage({
        threadId,
        sender: '赵六',
        senderId: resourceId,
        content: '今天能帮我查一下上周的审批单吗？',
      });

      // L2
      await memoryManager.updateL2Summary(
        threadId,
        '赵六此前已提交过请假单审批，正在跟进主管审核进度。',
        3
      );

      // L3
      await memoryManager.updateL3Profile(resourceId, {
        name: '赵六',
        department: '财务部',
        position: '出纳主管',
        preferences: { excelShortcuts: true },
        keyFacts: ['常查差旅报销与付款审批单'],
        recentTopics: ['发票核验', '差旅报销'],
      });

      const contextResult = await memoryManager.getContext({
        threadId,
        resourceId,
        includeL1: true,
        includeL2: true,
        includeL3: true,
      });

      expect(contextResult.threadId).toBe(threadId);
      expect(contextResult.resourceId).toBe(resourceId);
      expect(contextResult.l1Window).toBeDefined();
      expect(contextResult.l2Summary).toBeDefined();
      expect(contextResult.l3Profile).toBeDefined();

      const combinedText = contextResult.combinedContext;

      // 验证格式化注入内容
      expect(combinedText).toContain('[L3 员工实体画像与长期协同背景]');
      expect(combinedText).toContain('员工姓名: 赵六');
      expect(combinedText).toContain('所属部门: 财务部');
      expect(combinedText).toContain('常查差旅报销与付款审批单');

      expect(combinedText).toContain('[L2 会话级滚动工作记忆摘要]');
      expect(combinedText).toContain('赵六此前已提交过请假单审批');

      expect(combinedText).toContain('[L1 会话近期对话历史]');
      expect(combinedText).toContain('赵六: 今天能帮我查一下上周的审批单吗？');
    });

    it('当特定级别被禁用时，getContext 应只组装启用的记忆级别', async () => {
      const threadId = 'session_partial_ctx';
      const resourceId = 'user_partial_ctx';

      await memoryManager.saveMessage({
        threadId,
        sender: '孙七',
        content: '你好！',
      });
      await memoryManager.updateL2Summary(threadId, '问候会话', 1);

      // 仅包含 L1，禁用 L2 和 L3
      const contextResult = await memoryManager.getContext({
        threadId,
        resourceId,
        includeL1: true,
        includeL2: false,
        includeL3: false,
      });

      expect(contextResult.l1Window).toBeDefined();
      expect(contextResult.l2Summary).toBeUndefined();
      expect(contextResult.l3Profile).toBeUndefined();

      expect(contextResult.combinedContext).toContain('[L1 会话近期对话历史]');
      expect(contextResult.combinedContext).not.toContain('[L2 会话级滚动工作记忆摘要]');
      expect(contextResult.combinedContext).not.toContain('[L3 员工实体画像与长期协同背景]');
    });
  });

  describe('7. 边界与防御性分支测试', () => {
    it('未调用 init 时直接执行数据操作应明确抛出错误', async () => {
      const uninitManager = new AgentMemoryManager({ client: db });
      await expect(uninitManager.getL1Window('some_thread')).rejects.toThrow(
        'AgentMemoryManager 尚未初始化'
      );
    });

    it('支持使用独立数据库配置自动创建与关闭 LibSQL 实例', async () => {
      const standaloneManager = new AgentMemoryManager({
        database: { path: ':memory:' },
      });
      await standaloneManager.init();

      await standaloneManager.saveMessage({
        threadId: 'standalone_session',
        sender: '测试人',
        content: '独立实例消息',
      });
      const window = await standaloneManager.getL1Window('standalone_session');
      expect(window.totalCount).toBe(1);

      await standaloneManager.close();
    });

    it('批量保存 saveMessages 应一次性持久化多条消息', async () => {
      const threadId = 'session_batch_save';
      const msgs = await memoryManager.saveMessages([
        { threadId, sender: 'A', content: '批量消息 1', createdAt: 100 },
        { threadId, sender: 'B', content: '批量消息 2', createdAt: 200 },
      ]);
      expect(msgs).toHaveLength(2);

      const window = await memoryManager.getL1Window(threadId);
      expect(window.totalCount).toBe(2);
    });

    it('话题记录超过 10 个时应自动截断保留最新的 10 个话题', async () => {
      const resourceId = 'user_topic_overflow';
      for (let i = 1; i <= 15; i++) {
        await memoryManager.recordTopicTransition(resourceId, `话题_${i}`);
      }

      const profile = await memoryManager.getL3Profile(resourceId);
      expect(profile.recentTopics).toHaveLength(10);
      expect(profile.recentTopics[0]).toBe('话题_6');
      expect(profile.recentTopics[9]).toBe('话题_15');
    });

    it('recordColleagueFact 与 recordTopicTransition 传入空字符串时不应产生无效记录', async () => {
      const resourceId = 'user_empty_input';
      await memoryManager.recordColleagueFact(resourceId, '   ');
      await memoryManager.recordTopicTransition(resourceId, '   ');

      const profile = await memoryManager.getL3Profile(resourceId);
      expect(profile.keyFacts).toEqual([]);
      expect(profile.recentTopics).toEqual([]);
    });

    it('能够获取底层 Mastra Memory 辅助实例', () => {
      const mastra = memoryManager.getMastraMemory();
      expect(mastra).toBeDefined();
    });
  });
});
