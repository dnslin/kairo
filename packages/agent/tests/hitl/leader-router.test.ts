import { describe, it, expect } from 'vitest';
import { createDatabaseClient } from '@kkbot/store';
import { OrgRepository } from '@kkbot/store';
import { LeaderApprovalRouter } from '../../src/hitl/router.js';
import type { OrgRepositoryLike, ApprovalTask } from '../../src/hitl/types.js';
import { LeaderNotFoundError } from '../../src/utils/errors.js';

describe('LeaderApprovalRouter 直属主管审批路由解析器', () => {
  const mockOrgRepo: OrgRepositoryLike = {
    async getEmployeeById(id: string | number) {
      await Promise.resolve();
      const empId = String(id);
      if (empId === 'emp_001') {
        return { id: 'emp_001', name: '张三', leaderId: 'emp_leader_1' };
      }
      if (empId === 'emp_leader_1') {
        return { id: 'emp_leader_1', name: '李主管', leaderId: 'emp_ceo' };
      }
      if (empId === 'emp_no_direct_leader') {
        return { id: 'emp_no_direct_leader', name: '王五', leaderId: null };
      }
      if (empId === 'emp_ceo') {
        return { id: 'emp_ceo', name: '赵总', leaderId: null };
      }
      return null;
    },
    async getReportingChain(id: string | number) {
      await Promise.resolve();
      const empId = String(id);
      if (empId === 'emp_no_direct_leader') {
        // 真实 OrgRepository 返回的 reportingChain 只包含领导链，不含自身
        return [
          { id: 'emp_leader_1', name: '李主管', leaderId: 'emp_ceo' },
          { id: 'emp_ceo', name: '赵总', leaderId: null },
        ];
      }
      if (empId === 'emp_ceo') {
        return [];
      }
      return [];
    },
  };

  it('当员工有直接 leaderId 时，成功解析直属主管 ID 与姓名', async () => {
    const router = new LeaderApprovalRouter({ orgRepository: mockOrgRepo });
    const leader = await router.resolveLeader('emp_001');

    expect(leader).toEqual({
      leaderId: 'emp_leader_1',
      leaderName: '李主管',
    });
  });

  it('当员工无直接 leaderId 但有汇报链时，沿着汇报链解析上级主管', async () => {
    const router = new LeaderApprovalRouter({ orgRepository: mockOrgRepo });
    const leader = await router.resolveLeader('emp_no_direct_leader');

    expect(leader).toEqual({
      leaderId: 'emp_leader_1',
      leaderName: '李主管',
    });
  });

  it('当员工无直属主管且无上级汇报链时，若未配置 fallback 应抛出 LeaderNotFoundError', async () => {
    const router = new LeaderApprovalRouter({ orgRepository: mockOrgRepo });

    await expect(router.resolveLeader('emp_ceo')).rejects.toThrow(LeaderNotFoundError);
  });

  it('当员工无直属主管但配置了 fallbackLeaderId 时，降级返回配置的主管', async () => {
    const router = new LeaderApprovalRouter({
      orgRepository: mockOrgRepo,
      fallbackLeaderId: 'admin_security',
      fallbackLeaderName: '安全合规管理员',
    });

    const leader = await router.resolveLeader('emp_ceo');
    expect(leader).toEqual({
      leaderId: 'admin_security',
      leaderName: '安全合规管理员',
    });
  });

  it('formatApprovalNotification 生成完整格式的主管私聊通知', () => {
    const router = new LeaderApprovalRouter({ orgRepository: mockOrgRepo });
    const task: ApprovalTask = {
      id: 'appr_123456',
      toolCallId: 'call_999',
      toolName: 'database_drop_table',
      toolArgs: { tableName: 'users', force: true },
      applicantId: 'emp_001',
      applicantName: '张三',
      leaderId: 'emp_leader_1',
      leaderName: '李主管',
      threadId: 'session_chat_1',
      status: 'pending',
      timeoutMs: 60000,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60000,
    };

    const notification = router.formatApprovalNotification(task);

    expect(notification.leaderId).toBe('emp_leader_1');
    expect(notification.text).toContain('【KKBot 人工审批待办】');
    expect(notification.text).toContain('张三');
    expect(notification.text).toContain('database_drop_table');
    expect(notification.text).toContain('tableName: "users"');
    expect(notification.text).toContain('回复【同意】或【拒绝】');
  });

  it('formatDisambiguationPrompt 生成多任务消歧引导提示', () => {
    const router = new LeaderApprovalRouter({ orgRepository: mockOrgRepo });
    const tasks: ApprovalTask[] = [
      {
        id: 'appr_1',
        toolCallId: 'call_1',
        toolName: 'grant_role',
        toolArgs: { role: 'admin' },
        applicantId: 'emp_001',
        applicantName: '张三',
        leaderId: 'emp_leader_1',
        threadId: 'thread_1',
        status: 'pending',
        timeoutMs: 60000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
      {
        id: 'appr_2',
        toolCallId: 'call_2',
        toolName: 'export_data',
        toolArgs: { scope: 'all' },
        applicantId: 'emp_002',
        applicantName: '李四',
        leaderId: 'emp_leader_1',
        threadId: 'thread_2',
        status: 'pending',
        timeoutMs: 60000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 60000,
      },
    ];

    const prompt = router.formatDisambiguationPrompt(tasks);

    expect(prompt).toContain('当前有 2 项待处理的审批事项');
    expect(prompt).toContain('1. 【张三】grant_role');
    expect(prompt).toContain('2. 【李四】export_data');
    expect(prompt).toContain('回复【同意 编号】或【拒绝 编号】');
  });

  describe('集成真实 OrgRepository 实例契约验证', () => {
    it('与 @kkbot/store OrgRepository 真实实例协同工作并成功解析直属主管', async () => {
      const client = await createDatabaseClient({ url: ':memory:' });
      const realOrgRepo = new OrgRepository(client);

      // 同步测试组织架构数据
      await realOrgRepo.syncOrganization({
        departments: [{ id: 'dept_1', name: '技术部', parent_id: null, leader_id: 'leader_99' }],
        employees: [
          {
            id: 'emp_dev_1',
            loginName: 'dev1',
            name: '研发小明',
            leaderId: 'leader_99',
            appointments: [{ deptId: 'dept_1', isPrimary: true, isLeader: false }],
          },
          {
            id: 'leader_99',
            loginName: 'tech_lead',
            name: '技术总监老王',
            leaderId: 'ceo_1',
            appointments: [{ deptId: 'dept_1', isPrimary: true, isLeader: true }],
          },
          {
            id: 'ceo_1',
            loginName: 'ceo',
            name: 'CEO 大刘',
            appointments: [],
          },
        ],
      });

      const router = new LeaderApprovalRouter({ orgRepository: realOrgRepo });

      // 1. 验证研发小明的直属领导是技术总监老王
      const leader1 = await router.resolveLeader('emp_dev_1');
      expect(leader1).toEqual({
        leaderId: 'leader_99',
        leaderName: '技术总监老王',
      });

      // 2. 验证技术总监老王的直属领导是 CEO 大刘
      const leader2 = await router.resolveLeader('leader_99');
      expect(leader2).toEqual({
        leaderId: 'ceo_1',
        leaderName: 'CEO 大刘',
      });

      client.close();
    });
  });
});
