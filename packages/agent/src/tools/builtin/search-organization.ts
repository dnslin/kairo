import { z } from 'zod';
import type { OrgRepository, OrgEmployeeWithDepts } from '@kkbot/store';
import { createKkTool, type KkMastraTool } from '../create-tool.js';
import { createChildLogger } from '../../utils/logger.js';
const log = createChildLogger('tool-search-org');

/**
 * 组织架构检索工具入参 Schema
 */
export const SearchOrganizationInputSchema = z.object({
  query: z
    .string()
    .min(1, '检索关键词不能为空')
    .describe(
      '搜索关键词（支持中文姓名、工号如 E1001、拼音缩写如 zs/zhans、电话、邮箱、部门或职位）'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(10)
    .optional()
    .describe('返回结果最大数量，默认 10'),
  includeReportingChain: z
    .boolean()
    .default(false)
    .optional()
    .describe('是否级联查询直属汇报链（领导层级列表），默认 false'),
});

export type SearchOrganizationInput = z.infer<typeof SearchOrganizationInputSchema>;

/**
 * 带有汇报链的员工输出结构
 */
export interface EmployeeWithReportingChain extends OrgEmployeeWithDepts {
  reportingChain?: OrgEmployeeWithDepts[];
}

/**
 * 组织架构检索工具输出契约
 */
export interface SearchOrganizationOutput {
  success: boolean;
  count: number;
  employees: EmployeeWithReportingChain[];
}

/**
 * 执行 search_organization 核心组织架构与汇报链检索逻辑
 */
export async function executeSearchOrganizationCore(
  orgRepo: OrgRepository,
  input: SearchOrganizationInput
): Promise<SearchOrganizationOutput> {
  const cleanQuery = input.query.trim();
  const limit = input.limit ?? 10;
  const includeReportingChain = Boolean(input.includeReportingChain);

  log.debug({ query: cleanQuery, limit, includeReportingChain }, '执行组织架构同事与汇报链检索');

  const employees = await orgRepo.findEmployees(cleanQuery, limit);
  const enrichedEmployees: EmployeeWithReportingChain[] = [];

  for (const emp of employees) {
    if (includeReportingChain) {
      const reportingChain = await orgRepo.getReportingChain(emp.id);
      enrichedEmployees.push({
        ...emp,
        reportingChain,
      });
    } else {
      enrichedEmployees.push(emp);
    }
  }

  return {
    success: true,
    count: enrichedEmployees.length,
    employees: enrichedEmployees,
  };
}


/**
 * 创建 Mastra-native search_organization 工具
 */
export function createMastraSearchOrganizationTool(options: {
  orgRepo: OrgRepository;
}): KkMastraTool<typeof SearchOrganizationInputSchema> {
  const { orgRepo } = options;

  return createKkTool({
    id: 'search_organization',
    description: '根据工号、中文名、拼音缩写或部门检索企业员工档案、职位与直属汇报链。只读查询。',
    effect: 'read',
    risk: 'low',
    inputSchema: SearchOrganizationInputSchema,
    execute: async ({ context }) => executeSearchOrganizationCore(orgRepo, context),
  });
}
