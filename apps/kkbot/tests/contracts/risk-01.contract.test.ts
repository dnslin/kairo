import { describe, expect, it } from 'vitest';
import {
  KKBotAgent,
  MastraModelFactory,
  createFakeModel,
  createKkTool,
  type FakeLanguageModel,
} from '@kkbot/agent';
import { z } from 'zod';

function createTestFactory(options: {
  fast?: FakeLanguageModel;
  deep?: FakeLanguageModel;
}): MastraModelFactory {
  const fast = options.fast ?? createFakeModel({ provider: 'fake', modelId: 'fast' });
  const deep =
    options.deep ?? options.fast ?? createFakeModel({ provider: 'fake', modelId: 'deep' });
  return new MastraModelFactory({
    tiers: {
      FAST: { models: [{ model: fast }] },
      DEEP: { models: [{ model: deep }] },
      VISION: { models: [{ model: deep }] },
    },
  });
}

describe('RISK-01 Contract: 高风险意图无副作用与低风险 Tool 合同', () => {
  // =========================================================================
  // 1. 高风险意图无副作用与禁止调用副作用 Tool
  // =========================================================================
  describe('High-Risk Intent No Side Effects', () => {
    it('RISK-01.1: 删除用户/数据、修改权限、转账资金、全员大范围发送、修改敏感数据等高风险意图不调用副作用 Tool', async () => {
      let sideEffectExecuted = false;

      // 仅注册只读工具
      const readTool = createKkTool({
        id: 'query_user_info',
        description: '查询用户信息',
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ name: z.string() }),
        effect: 'read',
        risk: 'low',
        execute: () => Promise.resolve({ name: '张三' }),
      });

      const fakeModel = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            text: 'KKBot 没有执行外部操作。删除用户属于高风险管理操作，请由系统管理员登录管理后台手动执行。',
          },
        ],
      });
      const modelFactory = createTestFactory({ fast: fakeModel, deep: fakeModel });

      const agent = new KKBotAgent({
        modelFactory,
        tools: { query_user_info: readTool },
      });

      const result = await agent.execute({
        input: '请帮我彻底删除员工 emp_001 的账号与所有数据',
        sessionId: 'session_risk_del',
        senderId: 'emp_risk_del',
      });

      expect(sideEffectExecuted).toBe(false);
      expect(result.text).toContain('KKBot 没有执行外部操作');
    });

    it('RISK-01.2: Fake Model 强制请求不存在的高风险 Tool 时，不产生任何副作用', async () => {
      const fakeModel = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            toolCalls: [
              {
                toolCallId: 'call_drop_table',
                toolName: 'drop_database_table',
                input: JSON.stringify({ tableName: 'users' }),
              },
            ],
          },
          {
            text: 'KKBot 没有执行外部操作。该高危工具未被系统注册，已转由人工操作建议回复。',
          },
        ],
      });
      const modelFactory = createTestFactory({ fast: fakeModel, deep: fakeModel });

      const agent = new KKBotAgent({
        modelFactory,
        tools: {},
      });

      const result = await agent.execute({
        input: 'DROP TABLE users',
        sessionId: 'session_fake_drop',
        senderId: 'emp_fake_drop',
      });

      expect(result.text).toContain('KKBot 没有执行外部操作');
    });

    it('RISK-01.3: 高风险意图只形成普通 assistant 建议、拟写内容或操作清单，明确说明外部操作未执行', async () => {
      const highRiskInputs = [
        '请给张三授予管理员权限',
        '向公司全员发送放假通知广播',
        '将项目预算转账给供应商账户 50000 元',
        '修改员工李四的薪资为 30000',
      ];

      for (const input of highRiskInputs) {
        const fakeModel = createFakeModel({
          provider: 'fake-provider',
          modelId: 'test-model',
          responses: [
            {
              text: 'KKBot 没有执行外部操作。以下是为您拟写的操作指引清单：\n1. 登录企业内部管理后台\n2. 前往相应模块审批并提交',
            },
          ],
        });
        const modelFactory = createTestFactory({ fast: fakeModel, deep: fakeModel });

        const agent = new KKBotAgent({
          modelFactory,
          tools: {},
        });

        const result = await agent.execute({
          input,
          sessionId: 'session_risk_list',
          senderId: 'emp_risk_list',
        });

        expect(result.text).toContain('KKBot 没有执行外部操作');
        expect(result.text).toContain('操作指引清单');
      }
    });

    it('RISK-01.4: 系统不创建独立 Draft、Approval、Projection、deadline 或 Workflow suspend', async () => {
      const fakeModel = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            text: 'KKBot 没有执行外部操作。建议您联系直接上级处理。',
          },
        ],
      });
      const modelFactory = createTestFactory({ fast: fakeModel, deep: fakeModel });

      const agent = new KKBotAgent({
        modelFactory,
      });

      const result = await agent.execute({
        input: '请批准我的转岗申请',
        sessionId: 'session_no_appr',
        senderId: 'emp_no_appr',
      });

      expect(result.text).toBe('KKBot 没有执行外部操作。建议您联系直接上级处理。');
      expect(result.finishReason).toBe('stop');
    });
  });

  // =========================================================================
  // 2. 只读 Tool 与低风险写 Tool 合同
  // =========================================================================
  describe('Read-Only & Low-Risk Write Tool Contracts', () => {
    it('RISK-01.5: 只读 Tool (如 search_organization, query_knowledge_base) 可以直接完成多轮 Tool Calling', async () => {
      const searchOrgTool = createKkTool({
        id: 'search_organization',
        description: '组织架构查询',
        inputSchema: z.object({ query: z.string() }),
        outputSchema: z.object({ employees: z.array(z.string()) }),
        effect: 'read',
        risk: 'low',
        execute: () => Promise.resolve({ employees: ['张三 (技术部)', '李四 (产品部)'] }),
      });

      const fakeModel = createFakeModel({
        provider: 'fake-provider',
        modelId: 'test-model',
        responses: [
          {
            toolCalls: [
              {
                toolCallId: 'call_org_1',
                toolName: 'search_organization',
                input: JSON.stringify({ query: '技术部' }),
              },
            ],
          },
          {
            text: '技术部包含员工：张三',
          },
        ],
      });
      const modelFactory = createTestFactory({ fast: fakeModel, deep: fakeModel });

      const agent = new KKBotAgent({
        modelFactory,
        tools: { search_organization: searchOrgTool },
      });

      const result = await agent.execute({
        input: '查询技术部员工',
        sessionId: 'session_tool_read',
        senderId: 'emp_tool_read',
      });

      expect(result.text).toBe('技术部包含员工：张三');
    });

    it('RISK-01.6: 低风险写 Tool 必须具有稳定 idempotencyKey，重复调用不产生重复副作用', async () => {
      let sideEffectCount = 0;
      const seenKeys: Record<string, true> = {};

      const lowRiskWriteTool = createKkTool({
        id: 'generate_file_deliverable',
        description: '生成低风险报表文件',
        inputSchema: z.object({
          fileName: z.string(),
          content: z.string(),
          idempotencyKey: z.string().min(1, 'idempotencyKey 不能为空'),
        }),
        outputSchema: z.object({
          fileUrl: z.string(),
          alreadyExisted: z.boolean(),
        }),
        effect: 'write',
        risk: 'low',
        execute: ({ context }) => {
          const key = context.idempotencyKey ?? context.fileName;
          if (seenKeys[key]) {
            return Promise.resolve({
              fileUrl: `/files/${context.fileName}`,
              alreadyExisted: true,
            });
          }
          seenKeys[key] = true;
          sideEffectCount++;
          return Promise.resolve({
            fileUrl: `/files/${context.fileName}`,
            alreadyExisted: false,
          });
        },
      });

      // 第一次调用
      const res1 = await lowRiskWriteTool.execute({
        fileName: 'report.csv',
        content: 'a,b,c',
        idempotencyKey: 'idemp_key_001',
      });
      expect(res1.alreadyExisted).toBe(false);
      expect(sideEffectCount).toBe(1);

      // 相同 idempotencyKey 第二次重放调用
      const res2 = await lowRiskWriteTool.execute({
        fileName: 'report.csv',
        content: 'a,b,c',
        idempotencyKey: 'idemp_key_001',
      });
      expect(res2.alreadyExisted).toBe(true);
      expect(sideEffectCount).toBe(1);
    });

    it('RISK-01.7: createKkTool 拒绝注册 risk != "low" 的高危写工具', () => {
      expect(() => {
        createKkTool({
          id: 'unauthorized_dangerous_tool',
          description: '高风险工具',
          inputSchema: z.object({}),
          outputSchema: z.object({}),
          effect: 'write',
          // @ts-expect-error 测试强制传入非 low 的 risk
          risk: 'high',
          execute: () => Promise.resolve({}),
        });
      }).toThrow(/risk 必须为 'low'/);
    });
  });
});
