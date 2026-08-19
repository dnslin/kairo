import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { closeDatabase, createDatabase, OrgRepository, type SyncOrgData } from '../src/index.js';

describe('OrgRepository 拼音首字母检索、多维模糊搜索与层级关系穿透 (TDD)', () => {
  let db: Database.Database;
  let repo: OrgRepository;

  // 预置完备的组织架构测试数据集
  // 部门结构：
  // 总公司 (dept_root)
  //   ├─ 技术中台 (dept_tech)
  //   │    ├─ 基础架构组 (dept_infra)
  //   │    └─ 前端体验组 (dept_fe)
  //   └─ 市场销售部 (dept_mkt)
  //
  // 汇报关系：
  // 董事长 (emp_ceo, 10001, "雷军", "B座-顶层", 无上级)
  //   └─ CTO (emp_cto, 10002, "张小龙", "A座-8F-001", leader: emp_ceo)
  //        ├─ 架构师 (emp_arch, 10003, "张三丰", "A座-8F-002", pos: "首席架构师", leader: emp_cto)
  //        │    └─ 后端开发 (emp_dev, 10004, "李四", "A座-8F-003", pos: "资深Go开发", leader: emp_arch)
  //        └─ 前端专家 (emp_fe, 10005, "诸葛孔明", "A座-8F-004", pos: "前端负责人", leader: emp_cto)
  // 市场总监 (emp_mkt_dir, 10006, "欧阳六六", "C座-3F-001", leader: emp_ceo)
  const fixtureData: SyncOrgData = {
    departments: [
      {
        id: 'dept_root',
        name: '总公司',
        parentId: null,
        leaderId: 'emp_ceo',
        path: '/dept_root',
        level: 1,
      },
      {
        id: 'dept_tech',
        name: '技术中台',
        parentId: 'dept_root',
        leaderId: 'emp_cto',
        path: '/dept_root/dept_tech',
        level: 2,
      },
      {
        id: 'dept_infra',
        name: '基础架构组',
        parentId: 'dept_tech',
        leaderId: 'emp_arch',
        path: '/dept_root/dept_tech/dept_infra',
        level: 3,
      },
      {
        id: 'dept_fe',
        name: '前端体验组',
        parentId: 'dept_tech',
        leaderId: 'emp_fe',
        path: '/dept_root/dept_tech/dept_fe',
        level: 3,
      },
      {
        id: 'dept_mkt',
        name: '市场销售部',
        parentId: 'dept_root',
        leaderId: 'emp_mkt_dir',
        path: '/dept_root/dept_mkt',
        level: 2,
      },
    ],
    employees: [
      {
        id: 'emp_ceo',
        loginName: '10001',
        name: '雷军',
        region: 'B座-顶层',
        departments: [
          { deptId: 'dept_root', isPrimary: true, isLeader: true, position: '董事长兼CEO' },
        ],
      },
      {
        id: 'emp_cto',
        loginName: '10002',
        name: '张小龙',
        region: 'A座-8F-001',
        leaderId: 'emp_ceo',
        departments: [
          { deptId: 'dept_tech', isPrimary: true, isLeader: true, position: '首席技术官' },
        ],
      },
      {
        id: 'emp_arch',
        loginName: '10003',
        name: '张三丰',
        region: 'A座-8F-002',
        leaderId: 'emp_cto',
        departments: [
          { deptId: 'dept_infra', isPrimary: true, isLeader: true, position: '首席架构师' },
          {
            deptId: 'dept_tech',
            isPrimary: false,
            isLeader: false,
            position: '技术专家委员会成员',
          },
        ],
      },
      {
        id: 'emp_dev',
        loginName: '10004',
        name: '李四',
        region: 'A座-8F-003',
        leaderId: 'emp_arch',
        departments: [
          { deptId: 'dept_infra', isPrimary: true, isLeader: false, position: '资深Go开发' },
        ],
      },
      {
        id: 'emp_fe',
        loginName: '10005',
        name: '诸葛孔明',
        region: 'A座-8F-004',
        leaderId: 'emp_cto',
        departments: [
          { deptId: 'dept_fe', isPrimary: true, isLeader: true, position: '前端负责人' },
        ],
      },
      {
        id: 'emp_mkt_dir',
        loginName: '10006',
        name: '欧阳六六',
        region: 'C座-3F-001',
        leaderId: 'emp_ceo',
        departments: [
          { deptId: 'dept_mkt', isPrimary: true, isLeader: true, position: '市场总监' },
        ],
      },
    ],
  };

  beforeEach(() => {
    db = createDatabase({ path: ':memory:' });
    repo = new OrgRepository(db);
    repo.syncOrganization(fixtureData);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('1. 拼音首字母字段 (pinyin_abbr) 持久化与索引', () => {
    it('表结构应包含 pinyin_abbr 字段并建立索引', () => {
      const colInfo = db.pragma('table_info(org_employees)') as Array<{
        name: string;
        type: string;
      }>;
      const pinyinCol = colInfo.find(c => c.name === 'pinyin_abbr');
      expect(pinyinCol).toBeDefined();

      const indexList = db.pragma('index_list(org_employees)') as Array<{ name: string }>;
      const pinyinIdx = indexList.find(idx => idx.name === 'idx_org_employees_pinyin_abbr');
      expect(pinyinIdx).toBeDefined();
    });

    it('同步员工时应自动生成并保存 pinyin_abbr', () => {
      const zsf = repo.getEmployeeById('emp_arch');
      expect(zsf).not.toBeNull();
      expect(zsf?.pinyinAbbr).toBe('zsf');

      const zgkm = repo.getEmployeeById('emp_fe');
      expect(zgkm?.pinyinAbbr).toBe('zgkm');

      const oyll = repo.getEmployeeById('emp_mkt_dir');
      expect(oyll?.pinyinAbbr).toBe('oyll');
    });

    it('若同步数据中已显式提供 pinyinAbbr 则优先使用指定值', () => {
      repo.syncOrganization({
        departments: [{ id: 'd1', name: '研发' }],
        employees: [{ id: 'e1', loginName: 'test01', name: '王五', pinyinAbbr: 'custom_ww' }],
      });
      const emp = repo.getEmployeeById('e1');
      expect(emp?.pinyinAbbr).toBe('custom_ww');
    });
  });

  describe('2. findEmployees: 多维模糊快搜', () => {
    it('按拼音首字母简写搜索应准确命中（如 zsf -> 张三丰，支持大小写不敏感）', () => {
      const resLower = repo.findEmployees('zsf');
      expect(resLower.length).toBeGreaterThanOrEqual(1);
      expect(resLower[0].name).toBe('张三丰');

      const resUpper = repo.findEmployees('ZSF');
      expect(resUpper.length).toBeGreaterThanOrEqual(1);
      expect(resUpper[0].name).toBe('张三丰');
    });

    it('按工号精确/前缀搜索应准确命中', () => {
      const res = repo.findEmployees('10003');
      expect(res.length).toBe(1);
      expect(res[0].id).toBe('emp_arch');
    });

    it('按中文姓名模糊搜索应准确命中', () => {
      const res = repo.findEmployees('诸葛');
      expect(res.length).toBe(1);
      expect(res[0].name).toBe('诸葛孔明');
    });

    it('按岗位/职称 (position) 搜索应准确命中', () => {
      const res = repo.findEmployees('架构师');
      expect(res.length).toBe(1);
      expect(res[0].name).toBe('张三丰');

      const devRes = repo.findEmployees('资深Go开发');
      expect(devRes.length).toBe(1);
      expect(devRes[0].name).toBe('李四');
    });

    it('按工位/办公区域 (region) 搜索应准确命中', () => {
      const res = repo.findEmployees('顶层');
      expect(res.length).toBe(1);
      expect(res[0].name).toBe('雷军');

      const roomRes = repo.findEmployees('8F-003');
      expect(roomRes.length).toBe(1);
      expect(roomRes[0].name).toBe('李四');
    });

    it('按部门名称或部门路径搜索应命中该部门下的所有员工', () => {
      const res = repo.findEmployees('市场销售部');
      expect(res.some(e => e.name === '欧阳六六')).toBe(true);
    });

    it('空查询或纯空白字符串应安全返回空数组', () => {
      expect(repo.findEmployees('')).toEqual([]);
      expect(repo.findEmployees('   ')).toEqual([]);
    });

    it('应支持 limit 参数截断返回数量', () => {
      const allResults = repo.findEmployees('A座');
      expect(allResults.length).toBeGreaterThanOrEqual(3);

      const limitedResults = repo.findEmployees('A座', 2);
      expect(limitedResults.length).toBe(2);
    });

    it('精确匹配项应排在模糊/前缀匹配项前面 (Ranking Relevance)', () => {
      // "张" 会同时匹配 "张小龙" (zxl) 和 "张三丰" (zsf)
      // 若搜索 "张三丰"，精确匹配姓名应排在首位
      const res = repo.findEmployees('张三丰');
      expect(res[0].name).toBe('张三丰');
    });

    it('输入特殊字符时应安全处理而不发生 SQL 语法错误或注入', () => {
      expect(() => repo.findEmployees("' OR '1'='1")).not.toThrow();
      expect(() => repo.findEmployees('" OR "1"="1')).not.toThrow();
      expect(() => repo.findEmployees('%')).not.toThrow();
      expect(() => repo.findEmployees('_')).not.toThrow();
      expect(() => repo.findEmployees('\\')).not.toThrow();
      expect(() => repo.findEmployees('[]')).not.toThrow();

      // 特殊连字符如 "8F-002" 应准确命中
      const res = repo.findEmployees('8F-002');
      expect(res.length).toBe(1);
      expect(res[0].name).toBe('张三丰');
    });

    it('limit 传入 0 或负数时应安全防御并返回至少 1 条记录', () => {
      const resZero = repo.findEmployees('A座', 0);
      expect(resZero.length).toBe(1);

      const resNeg = repo.findEmployees('A座', -5);
      expect(resNeg.length).toBe(1);
    });

    it('多部门兼职员工在多个任职命中搜索条件时应严格去重为单条记录', () => {
      // 张三丰在 dept_infra 职位为首席架构师，在 dept_tech 职位为技术专家委员会成员
      // 搜索 "技术" 会同时匹配 dept_tech (部门名) 和 技术专家委员会成员 (岗位)
      const res = repo.findEmployees('技术');
      const zsfMatches = res.filter(e => e.id === 'emp_arch');
      expect(zsfMatches).toHaveLength(1);
      expect(zsfMatches[0].departments).toHaveLength(2);
    });
  });

  describe('3. getReportingChain: 向上递归穿透管理汇报链', () => {
    it('应按层级向上递归获取完整汇报链：直属主管 -> 隔级主管 -> 最终高管', () => {
      // 李四 (10004) -> leader: 张三丰 (10003) -> leader: 张小龙 (10002) -> leader: 雷军 (10001) -> 无
      const chain = repo.getReportingChain('emp_dev');
      expect(chain.map(e => e.name)).toEqual(['张三丰', '张小龙', '雷军']);
      expect(chain[0].departments.length).toBeGreaterThan(0);
    });

    it('直属上级为根节点时，汇报链长度应为 1', () => {
      // 张小龙 (emp_cto) -> leader: 雷军 (emp_ceo)
      const chain = repo.getReportingChain('emp_cto');
      expect(chain.map(e => e.name)).toEqual(['雷军']);
    });

    it('顶层管理者无上级时，汇报链应返回空数组', () => {
      const chain = repo.getReportingChain('emp_ceo');
      expect(chain).toEqual([]);
    });

    it('查询不存在的员工 ID 时应安全返回空数组', () => {
      expect(repo.getReportingChain('non_existent_id')).toEqual([]);
      expect(repo.getReportingChain('')).toEqual([]);
    });

    it('遇到环形汇报关系时应进行环路防御，优雅退出而不死循环', () => {
      // 构造循环引用：A -> B -> A
      repo.syncOrganization({
        departments: [{ id: 'd1', name: '环形测试部' }],
        employees: [
          { id: 'emp_a', loginName: 'A', name: '员工A', leaderId: 'emp_b' },
          { id: 'emp_b', loginName: 'B', name: '员工B', leaderId: 'emp_a' },
        ],
      });

      const chainA = repo.getReportingChain('emp_a');
      expect(chainA.map(e => e.id)).toEqual(['emp_b']);
    });

    it('当中间领导离职/不存在时，汇报链应截断在有效范围内', () => {
      repo.syncOrganization({
        departments: [{ id: 'd1', name: '断链测试部' }],
        employees: [{ id: 'emp_1', loginName: '1', name: '员工1', leaderId: 'missing_leader' }],
      });

      const chain = repo.getReportingChain('emp_1');
      expect(chain).toEqual([]);
    });
  });

  describe('4. getDepartmentMembers: 部门成员获取与子部门递归穿透', () => {
    it('includeSubDepts: false (默认) 时，仅返回直属于该部门的员工', () => {
      // dept_tech 直属员工只有 张小龙 (emp_cto, 主职) 与 张三丰 (emp_arch, 兼职技术专家)
      const directMembers = repo.getDepartmentMembers('dept_tech');
      const memberNames = directMembers.map(m => m.name);
      expect(memberNames).toContain('张小龙');
      expect(memberNames).toContain('张三丰');
      expect(memberNames).not.toContain('李四'); // 李四在子部门 dept_infra
      expect(memberNames).not.toContain('诸葛孔明'); // 诸葛孔明在子部门 dept_fe
    });

    it('includeSubDepts: true 时，应递归获取该部门及其所有子部门全员', () => {
      // dept_tech 下包含 dept_infra 与 dept_fe
      // 成员应包含：张小龙、张三丰、李四、诸葛孔明
      const allTechMembers = repo.getDepartmentMembers('dept_tech', { includeSubDepts: true });
      const memberNames = allTechMembers.map(m => m.name);

      expect(memberNames).toContain('张小龙');
      expect(memberNames).toContain('张三丰');
      expect(memberNames).toContain('李四');
      expect(memberNames).toContain('诸葛孔明');
      expect(memberNames).not.toContain('欧阳六六'); // 市场部不在技术中台下
    });

    it('在父部门与子部门同时兼职的员工应自动去重，保留完整任职列表', () => {
      // 张三丰在 dept_infra 是主职+主管，在 dept_tech 是兼职
      const allTechMembers = repo.getDepartmentMembers('dept_tech', { includeSubDepts: true });
      const zsfList = allTechMembers.filter(m => m.id === 'emp_arch');
      expect(zsfList.length).toBe(1);
      expect(zsfList[0].departments.length).toBe(2);
    });

    it('查询空部门或不存在的部门 ID 应安全返回空数组', () => {
      expect(repo.getDepartmentMembers('non_existent_dept')).toEqual([]);
      expect(repo.getDepartmentMembers('')).toEqual([]);
    });
  });
});
