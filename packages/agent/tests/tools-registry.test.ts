import { existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createDatabaseClient, OrgRepository, type SyncOrgData } from '@kkbot/store';
import { ToolRegistry } from '../src/tools/registry.js';
import { createSearchOrganizationTool } from '../src/tools/builtin/search-organization.js';
import { createQueryKnowledgeBaseTool } from '../src/tools/builtin/query-knowledge-base.js';
import { createGenerateFileDeliverableTool } from '../src/tools/builtin/generate-file-deliverable.js';
import { createAgentTool } from '../src/tools/registry.js';
import { ToolError } from '../src/utils/errors.js';

describe('ToolRegistry 与内置企业工具集 (TDD Red -> Green)', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  describe('1. ToolRegistry 基础注册、检索与生命周期管理', () => {
    it('应当支持注册基于 createAgentTool + Zod Schema 的工具并正确检索', () => {
      const tool = createAgentTool({
        id: 'calculate_tax',
        description: '计算企业个人所得税',
        readOnly: true,
        inputSchema: z.object({
          income: z.number().positive('收入必须为正数'),
          deduction: z.number().nonnegative().default(5000),
        }),
        outputSchema: z.object({
          tax: z.number(),
        }),
        execute: async ({ income, deduction }) => {
          await Promise.resolve();
          const taxable = Math.max(0, income - deduction);
          return { tax: taxable * 0.1 };
        },
      });

      registry.register(tool);

      expect(registry.has('calculate_tax')).toBe(true);
      expect(registry.get('calculate_tax')).toBe(tool);
      expect(registry.size).toBe(1);
    });

    it('重复注册同名工具且未开启 override 时应当抛出 ToolError 异常', () => {
      const tool1 = createAgentTool({
        id: 'mock_tool',
        description: 'Mock 1',
        readOnly: true,
        inputSchema: z.object({}),
        execute: async () => {
          await Promise.resolve();
          return { ok: 1 };
        },
      });

      const tool2 = createAgentTool({
        id: 'mock_tool',
        description: 'Mock 2',
        readOnly: false,
        inputSchema: z.object({}),
        execute: async () => {
          await Promise.resolve();
          return { ok: 2 };
        },
      });

      registry.register(tool1);
      expect(() => registry.register(tool2)).toThrowError(ToolError);
      expect(() => registry.register(tool2)).toThrowError(/已存在/);

      // 开启 override 应当允许覆盖
      registry.register(tool2, { override: true });
      expect(registry.get('mock_tool')?.description).toBe('Mock 2');
    });

    it('应当支持注销工具与清空注册中心', () => {
      const tool = createAgentTool({
        id: 'temp_tool',
        description: '临时工具',
        readOnly: true,
        inputSchema: z.object({}),
        execute: async () => {
          await Promise.resolve();
          return {};
        },
      });

      registry.register(tool);
      expect(registry.has('temp_tool')).toBe(true);

      const unregistered = registry.unregister('temp_tool');
      expect(unregistered).toBe(true);
      expect(registry.has('temp_tool')).toBe(false);
      expect(registry.size).toBe(0);

      // 注销不存在的工具返回 false
      expect(registry.unregister('not_exists')).toBe(false);
    });

    it('应当能够准确根据 readOnly 标志筛选只读工具与写工具', () => {
      registry.register(
        createAgentTool({
          id: 'read_1',
          description: '只读 1',
          readOnly: true,
          inputSchema: z.object({}),
          execute: async () => {
            await Promise.resolve();
            return {};
          },
        })
      );
      registry.register(
        createAgentTool({
          id: 'read_2',
          description: '只读 2',
          readOnly: true,
          inputSchema: z.object({}),
          execute: async () => {
            await Promise.resolve();
            return {};
          },
        })
      );
      registry.register(
        createAgentTool({
          id: 'write_1',
          description: '写入 1',
          readOnly: false,
          inputSchema: z.object({}),
          execute: async () => {
            await Promise.resolve();
            return {};
          },
        })
      );

      const readTools = registry.getReadOnlyTools();
      const writeTools = registry.getWriteTools();

      expect(readTools.map(t => t.id)).toEqual(['read_1', 'read_2']);
      expect(writeTools.map(t => t.id)).toEqual(['write_1']);
      expect(registry.getAll().length).toBe(3);
    });
  });

  describe('2. 内置工具：search_organization (组织架构与拼音检索)', () => {
    let orgRepo: OrgRepository;

    const fixtureOrgData: SyncOrgData = {
      departments: [
        { id: 'dept_root', name: '总经办', level: 1 },
        { id: 'dept_tech', name: '技术研发中心', parentId: 'dept_root', level: 2 },
        { id: 'dept_ai', name: 'AI认知实验室', parentId: 'dept_tech', level: 3 },
      ],
      employees: [
        {
          id: '1001',
          loginName: 'E1001',
          name: '张三',
          pinyinAbbr: 'zs',
          phone: '13800000001',
          email: 'zhangsan@kkbot.com',
          region: '北京 A 栋 301',
          leaderId: '1002',
          departments: [{ deptId: 'dept_ai', position: '资深算法专家', isPrimary: true }],
        },
        {
          id: '1002',
          loginName: 'E1002',
          name: '李四',
          pinyinAbbr: 'ls',
          phone: '13800000002',
          email: 'lisi@kkbot.com',
          region: '北京 A 栋 501',
          leaderId: '1003',
          departments: [{ deptId: 'dept_tech', position: '技术总监', isPrimary: true, isLeader: true }],
        },
        {
          id: '1003',
          loginName: 'E1003',
          name: '王五',
          pinyinAbbr: 'ww',
          phone: '13800000003',
          email: 'wangwu@kkbot.com',
          region: '上海总部 801',
          departments: [{ deptId: 'dept_root', position: '总经理', isPrimary: true, isLeader: true }],
        },
      ],
    };

    beforeEach(async () => {
      const db = await createDatabaseClient({ path: ':memory:' });
      orgRepo = new OrgRepository(db);
      await orgRepo.syncOrganization(fixtureOrgData);
    });

    it('应当能通过中文姓名检索员工信息', async () => {
      const tool = createSearchOrganizationTool({ orgRepo });
      expect(tool.id).toBe('search_organization');
      expect(tool.readOnly).toBe(true);

      const result = await tool.execute({ query: '张三' });
      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.employees[0].name).toBe('张三');
      expect(result.employees[0].loginName).toBe('E1001');
      expect(result.employees[0].departments[0].deptName).toBe('AI认知实验室');
    });

    it('应当能通过拼音缩写检索员工（如 zs 查张三）', async () => {
      const tool = createSearchOrganizationTool({ orgRepo });
      const result = await tool.execute({ query: 'zs' });

      expect(result.success).toBe(true);
      expect(result.count).toBe(1);
      expect(result.employees[0].name).toBe('张三');
    });

    it('应当能通过工号检索员工', async () => {
      const tool = createSearchOrganizationTool({ orgRepo });
      const result = await tool.execute({ query: 'E1002' });

      expect(result.success).toBe(true);
      expect(result.employees[0].name).toBe('李四');
    });

    it('开启 includeReportingChain 时应当级联向上查询汇报链', async () => {
      const tool = createSearchOrganizationTool({ orgRepo });
      const result = await tool.execute({ query: '张三', includeReportingChain: true });

      expect(result.success).toBe(true);
      expect(result.employees[0].reportingChain).toBeDefined();
      expect(result.employees[0].reportingChain?.length).toBe(2);
      expect(result.employees[0].reportingChain?.[0].name).toBe('李四'); // 直属主管
      expect(result.employees[0].reportingChain?.[1].name).toBe('王五'); // 隔级主管
    });
  });

  describe('3. 内置工具：query_knowledge_base (本地 Markdown 知识库切片检索)', () => {
    const mockKnowledgeDocs = [
      {
        title: '员工请假与考勤制度规范',
        category: 'hr',
        path: 'hr/leave-policy.md',
        content: `
# 员工请假与考勤管理制度
## 年假申请规则
员工入职满一年可享受带薪年休假 5 天。年假需提前 3 个工作日在 OA 系统发起审批，直属主管批准后生效。
## 病假与事假
病假需提供二级甲等及以上医院开具的就医证明与病休单。事假单次不能超过 5 个工作日。
        `.trim(),
      },
      {
        title: '技术研发上线与发布规范',
        category: 'tech',
        path: 'tech/deploy-policy.md',
        content: `
# 技术研发上线与代码发布规范
## 生产发布窗口
每周二和周四晚上 20:00 - 22:00 为常规生产发布窗口期。周五严禁进行重大变更与核心服务发布。
## 灰度与回滚机制
所有线上变更必须通过灰度环境验证，且发布包中必须包含经过演练的一键快速回滚脚本。
        `.trim(),
      },
      {
        title: '企业安全与数据防泄密指引',
        category: 'security',
        path: 'security/data-safety.md',
        content: `
# 企业信息安全管理准则
## 敏感凭证管理
严禁在即时通讯软件中明文发送数据库连接串、API 密钥或私钥证书。所有凭证需托管于企业安全密保箱。
        `.trim(),
      },
    ];

    it('应当能根据关键词检索相关知识切片并给出相关度得分', async () => {
      const tool = createQueryKnowledgeBaseTool({ docs: mockKnowledgeDocs });
      expect(tool.id).toBe('query_knowledge_base');
      expect(tool.readOnly).toBe(true);

      const result = await tool.execute({ query: '请问年假怎么申请？几天？' });

      expect(result.success).toBe(true);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].title).toBe('员工请假与考勤制度规范');
      expect(result.chunks[0].content).toContain('带薪年休假 5 天');
      expect(result.chunks[0].score).toBeGreaterThan(0.3);
    });

    it('支持按分类过滤知识切片', async () => {
      const tool = createQueryKnowledgeBaseTool({ docs: mockKnowledgeDocs });
      const result = await tool.execute({
        query: '发布与变更要求',
        category: 'tech',
      });

      expect(result.success).toBe(true);
      expect(result.chunks.every(c => c.category === 'tech')).toBe(true);
      expect(result.chunks[0].content).toContain('常规生产发布窗口期');
    });

    it('当检索无相关内容时应当返回空结果且不报错', async () => {
      const tool = createQueryKnowledgeBaseTool({ docs: mockKnowledgeDocs });
      const result = await tool.execute({
        query: '火星探测火箭轨道参数计算方法',
        minScore: 0.8,
      });

      expect(result.success).toBe(true);
      expect(result.chunks.length).toBe(0);
    });
  });

  describe('4. 内置工具：generate_file_deliverable (生成 CSV/MD 文件持久化)', () => {
    let testTempDir: string;

    beforeEach(() => {
      testTempDir = join(tmpdir(), `kkbot-deliverable-test-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
    });

    afterEach(() => {
      if (existsSync(testTempDir)) {
        rmSync(testTempDir, { recursive: true, force: true });
      }
    });

    it('应当能将结构化数据数组导出为带 UTF-8 BOM 的标准 CSV 文件', async () => {
      const tool = createGenerateFileDeliverableTool({ baseDir: testTempDir });
      expect(tool.id).toBe('generate_file_deliverable');
      expect(tool.readOnly).toBe(false); // 写工具

      const rowData = [
        { 工号: 'E1001', 姓名: '张三', 部门: 'AI实验室', 备注: '技术专家, 带逗号' },
        { 工号: 'E1002', 姓名: '李四', 部门: '研发部', 备注: '主管 "含双引号"' },
      ];

      const result = await tool.execute({
        fileType: 'csv',
        fileName: 'roster_output.csv',
        data: rowData,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('csv');
      expect(result.lineCount).toBe(3); // 表头 + 2行
      expect(existsSync(result.filePath)).toBe(true);

      const buffer = readFileSync(result.filePath);
      // 验证 UTF-8 BOM (\xEF\xBB\xBF)
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);

      const content = buffer.toString('utf-8');
      expect(content).toContain('工号,姓名,部门,备注');
      expect(content).toContain('"技术专家, 带逗号"');
      expect(content).toContain('"主管 ""含双引号"""');
    });

    it('应当能将 Markdown 文本内容保存为 .md 文件', async () => {
      const tool = createGenerateFileDeliverableTool({ baseDir: testTempDir });

      const mdContent = `# 会议纪要\n\n- 参会人：张三、李四\n- 讨论事项：工具系统设计`;
      const result = await tool.execute({
        fileType: 'md',
        fileName: 'meeting_notes.md',
        content: mdContent,
      });

      expect(result.success).toBe(true);
      expect(result.format).toBe('md');
      expect(existsSync(result.filePath)).toBe(true);

      const savedContent = readFileSync(result.filePath, 'utf-8');
      expect(savedContent).toBe(mdContent);
    });

    it('缺少必要参数时应抛出错误或返回自愈错误信息', async () => {
      const tool = createGenerateFileDeliverableTool({ baseDir: testTempDir });

      // CSV 类型缺少 data 参数
      await expect(
        tool.execute({
          fileType: 'csv',
          fileName: 'invalid.csv',
        })
      ).rejects.toThrowError(/data 数组/);
    });
  });
});
