import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createClient, type Client } from '@libsql/client';
import { ApprovalManager } from '../../src/hitl/manager.js';
import { StatefulApprovalMatcher } from '../../src/hitl/matcher.js';

describe('StatefulApprovalMatcher 主管私聊自然语言与多任务消歧匹配器', () => {
  let client: Client;
  let manager: ApprovalManager;
  let matcher: StatefulApprovalMatcher;

  beforeEach(async () => {
    client = createClient({ url: ':memory:' });
    manager = new ApprovalManager({
      client,
      adminUserIds: ['web_admin'],
    });
    await manager.init();
    matcher = new StatefulApprovalMatcher({ approvalManager: manager });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await manager.close();
    client.close();
  });

  it('当主管无任何待办任务时，所有输入均不拦截 (matched: false)', async () => {
    const res1 = await matcher.match('emp_leader_1', '同意');
    expect(res1.matched).toBe(false);

    const res2 = await matcher.match('emp_leader_1', '拒绝');
    expect(res2.matched).toBe(false);

    const res3 = await matcher.match('emp_leader_1', '你好，今天下午有空吗？');
    expect(res3.matched).toBe(false);
  });

  describe('单笔待办任务匹配', () => {
    let taskId: string;

    beforeEach(async () => {
      const task = await manager.createTask({
        toolCallId: 'call_single',
        toolName: 'execute_sql_query',
        toolArgs: { sql: 'SELECT * FROM secrets' },
        applicantId: 'emp_001',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        threadId: 'thread_single',
      });
      taskId = task.id;
    });

    it('只支持单笔待办的显式审批动词同意表达', async () => {
      const approvePhrases = [
        '同意',
        '通过',
        '准了',
        '准',
        '批准',
        '通过审批',
        '同意申请',
      ];

      for (const phrase of approvePhrases) {
        const res = await matcher.match('emp_leader_1', phrase);
        expect(res.matched).toBe(true);
        expect(res.action).toBe('approve');
        expect(res.task?.id).toBe(taskId);
      }
    });

    it('只支持单笔待办的显式审批动词拒绝表达', async () => {
      const rejectPhrases = [
        '拒绝',
        '驳回',
        '不通过',
        '不同意',
        '不批准',
        '否决',
        '拒',
      ];

      for (const phrase of rejectPhrases) {
        const res = await matcher.match('emp_leader_1', phrase);
        expect(res.matched).toBe(true);
        expect(res.action).toBe('reject');
        expect(res.task?.id).toBe(taskId);
      }
    });

    it('严禁将日常口语词 (好/可以/行/没问题/ok/yes/收到) 误判为审批同意', async () => {
      const casualConversations = [
        '好',
        '好的',
        '可以',
        '行',
        '没问题',
        'ok',
        'OK',
        'yes',
        'Yes',
        '收到',
        '好的收到',
        '稍等我看一下代码',
        '这个需求背景是什么？',
        '明天再讨论',
      ];

      for (const phrase of casualConversations) {
        const res = await matcher.match('emp_leader_1', phrase);
        expect(res.matched).toBe(false);
      }
    });
  });

  describe('多笔待办任务消歧与 Fail-Closed 状态化防错批 (>= 2 笔)', () => {
    let task1Id: string;
    let task2Id: string;
    let task3Id: string;

    beforeEach(async () => {
      const task1 = await manager.createTask({
        toolCallId: 'call_1',
        toolName: 'grant_user_permission',
        toolArgs: { role: 'admin' },
        applicantId: 'emp_001',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        threadId: 'thread_1',
      });
      task1Id = task1.id;

      const task2 = await manager.createTask({
        toolCallId: 'call_2',
        toolName: 'export_database_table',
        toolArgs: { table: 'customers' },
        applicantId: 'emp_002',
        applicantName: '李四',
        leaderId: 'emp_leader_1',
        threadId: 'thread_2',
      });
      task2Id = task2.id;

      const task3 = await manager.createTask({
        toolCallId: 'call_3',
        toolName: 'delete_backup_archive',
        toolArgs: { file: 'backup_2026.tar' },
        applicantId: 'emp_003',
        applicantName: '王五',
        leaderId: 'emp_leader_1',
        threadId: 'thread_3',
      });
      task3Id = task3.id;
    });

    it('多笔待办下仅回复泛化动词“同意”触发消歧引导并绑定快照', async () => {
      const res = await matcher.match('emp_leader_1', '同意');

      expect(res.matched).toBe(true);
      expect(res.action).toBe('needs_disambiguation');
      expect(res.task).toBeUndefined();
      expect(res.promptMessage).toContain('当前有 3 项待处理的审批事项');
      expect(res.promptMessage).toContain('1. 【张三】grant_user_permission');
      expect(res.promptMessage).toContain('2. 【李四】export_database_table');
      expect(res.promptMessage).toContain('3. 【王五】delete_backup_archive');
    });

    it('状态化消歧保障：当第 1 项被外部处理后，回复“同意 2”依然准确指向任务 2，绝不错批任务 3', async () => {
      // 1. 主管发送“同意”，触发消歧列表展示并保存快照 (1->task1, 2->task2, 3->task3)
      const promptRes = await matcher.match('emp_leader_1', '同意');
      expect(promptRes.matched).toBe(true);
      expect(promptRes.action).toBe('needs_disambiguation');

      // 2. 模拟突发事件：任务 1 在 Web 端被管理员提前审批或超时结算
      await manager.resolveTask({
        taskId: task1Id,
        approved: true,
        deciderId: 'web_admin',
      });

      // 此时数据库 pending 列表仅剩 [task2, task3]
      const currentPending = await manager.getPendingTasksByLeaderId('emp_leader_1');
      expect(currentPending).toHaveLength(2);
      expect(currentPending[0].id).toBe(task2Id);
      expect(currentPending[1].id).toBe(task3Id);

      // 3. 主管随后回复“同意 2”（主管本意是审批原列表中第 2 项即 task2）
      const decisionRes = await matcher.match('emp_leader_1', '同意 2');
      expect(decisionRes.matched).toBe(true);
      expect(decisionRes.action).toBe('approve');
      // 核心断言：命中 task2，绝不会因为列表重排误批 task3！
      expect(decisionRes.task?.id).toBe(task2Id);
      expect(decisionRes.task?.toolName).toBe('export_database_table');
    });

    it('状态化消歧保障：若主管回复已失效项“同意 1”，返回友好错误提示并阻断执行', async () => {
      // 1. 生成消歧快照
      await matcher.match('emp_leader_1', '同意');

      // 2. 任务 1 被超时结算或提前驳回
      await manager.resolveTask({
        taskId: task1Id,
        approved: false,
        deciderId: 'web_admin',
      });

      // 3. 主管回复“同意 1”
      const decisionRes = await matcher.match('emp_leader_1', '同意 1');
      expect(decisionRes.matched).toBe(true);
      expect(decisionRes.action).toBe('disambiguation_error');
      expect(decisionRes.promptMessage).toContain('已被处理或已超时');
    });

    it('Fail-Closed 安全保障场景 1：新建 Matcher (模拟进程重启) 收到“同意 2”，必须重新提示列表且绝不返回 task', async () => {
      // 新建 Matcher 实例模拟重启后内存快照丢失
      const freshMatcher = new StatefulApprovalMatcher({ approvalManager: manager });

      // 主管直接回复“同意 2”
      const res = await freshMatcher.match('emp_leader_1', '同意 2');

      expect(res.matched).toBe(true);
      expect(res.action).toBe('needs_disambiguation');
      // 核心断言：必须 Fail-Closed，绝不猜测索引返回 task
      expect(res.task).toBeUndefined();
      expect(res.promptMessage).toContain('未检测到有效的审批待办上下文');
      expect(res.promptMessage).toContain('已为您重新生成最新待办列表');
      expect(res.promptMessage).toContain('1. 【张三】grant_user_permission');
    });

    it('Fail-Closed 安全保障场景 2：TTL 过期后收到“同意 2”，必须重新提示列表且绝不返回 task', async () => {
      // 创建快照 TTL 极短 (10ms) 的 Matcher
      const ttlMatcher = new StatefulApprovalMatcher({
        approvalManager: manager,
        snapshotTtlMs: 10,
      });

      // 1. 生成快照
      await ttlMatcher.match('emp_leader_1', '同意');

      // 2. 模拟经过 50ms 快照已过期
      await new Promise(resolve => setTimeout(resolve, 50));

      // 3. 主管随后回复“同意 2”
      const res = await ttlMatcher.match('emp_leader_1', '同意 2');

      expect(res.matched).toBe(true);
      expect(res.action).toBe('needs_disambiguation');
      // 核心断言：快照过期后必须 Fail-Closed 绝不执行返回 task
      expect(res.task).toBeUndefined();
      expect(res.promptMessage).toContain('未检测到有效的审批待办上下文');
    });

    it('带无效或越界编号时返回消歧错误提示 (disambiguation_error)', async () => {
      // 先建立快照
      await matcher.match('emp_leader_1', '同意');

      const res1 = await matcher.match('emp_leader_1', '同意 5');
      expect(res1.matched).toBe(true);
      expect(res1.action).toBe('disambiguation_error');
      expect(res1.promptMessage).toContain('输入的审批编号不存在');

      const res2 = await matcher.match('emp_leader_1', '拒绝 0');
      expect(res2.matched).toBe(true);
      expect(res2.action).toBe('disambiguation_error');
      expect(res2.promptMessage).toContain('输入的审批编号不存在');
    });
  });
});
