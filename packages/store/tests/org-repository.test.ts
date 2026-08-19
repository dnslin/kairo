import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  closeDatabase,
  createDatabase,
  OrgRepository,
  type OrgDepartmentInput,
  type OrgEmployeeInput,
  type SyncOrgData,
} from '../src/index.js';

describe('OrgRepository 与组织架构三表模型持久化测试 (TDD Red -> Green)', () => {
  let db: Database.Database;
  let repo: OrgRepository;

  beforeEach(() => {
    // 为每个测试用例分配完全隔离的内存数据库实例
    db = createDatabase({ path: ':memory:' });
    repo = new OrgRepository(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('1. 数据库底座与 DDL 表结构初始化', () => {
    it('应成功建立内存数据库并默认启用外键约束', () => {
      const fk = db.pragma('foreign_keys', { simple: true });
      expect(fk).toBe(1);
    });

    it('应正确创建 org_departments、org_employees 与 org_employee_departments 三张数据表及对应索引', () => {
      const tables = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'org_%' ORDER BY name"
        )
        .all()
        .map(t => t.name);

      expect(tables).toEqual(['org_departments', 'org_employee_departments', 'org_employees']);

      const indices = db
        .prepare<[], { name: string }>(
          "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_org_%' ORDER BY name"
        )
        .all()
        .map(i => i.name);

      expect(indices).toContain('idx_org_departments_parent_id');
      expect(indices).toContain('idx_org_departments_path');
      expect(indices).toContain('idx_org_departments_level');
      expect(indices).toContain('idx_org_employees_login_name');
      expect(indices).toContain('idx_org_employees_name');
      expect(indices).toContain('idx_org_emp_dept_primary');
    });
  });

  describe('2. syncOrganization: 原子全量同步与多部门兼职模型', () => {
    it('应成功原子同步部门树与员工档案（含主职与兼职任职）', () => {
      const departments: OrgDepartmentInput[] = [
        { id: 'dept-root', name: '总公司', parentId: null },
        { id: 'dept-tech', name: '技术研发中心', parentId: 'dept-root' },
        { id: 'dept-ai', name: 'AI实验室', parentId: 'dept-tech' },
        { id: 'dept-op', name: '运营中心', parentId: 'dept-root' },
      ];

      const employees: OrgEmployeeInput[] = [
        {
          id: 'emp-001',
          loginName: 'zhangsan',
          name: '张三',
          phone: '13800000001',
          email: 'zhangsan@example.com',
          region: '北京总部',
          departments: [
            { deptId: 'dept-ai', isPrimary: true, isLeader: true, position: '首席算法专家' },
            { deptId: 'dept-tech', isPrimary: false, isLeader: false, position: '架构委员会委员' },
          ],
        },
        {
          id: 'emp-002',
          loginName: 'lisi',
          name: '李四',
          phone: '13800000002',
          email: 'lisi@example.com',
          region: '上海分部',
          departments: [
            { deptId: 'dept-op', isPrimary: true, isLeader: true, position: '运营总监' },
          ],
        },
      ];

      const result = repo.syncOrganization({ departments, employees });

      expect(result.departmentCount).toBe(4);
      expect(result.employeeCount).toBe(2);
      expect(result.appointmentCount).toBe(3);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      // 验证统计数据
      const stats = repo.getStats();
      expect(stats.totalDepartments).toBe(4);
      expect(stats.totalEmployees).toBe(2);
      expect(stats.totalAppointments).toBe(3);
    });

    it('未提供 path 与 level 时应自动推导多级层级路径与深度', () => {
      const departments: OrgDepartmentInput[] = [
        { id: 'd1', name: '总部', parentId: null },
        { id: 'd2', name: '华北区', parentId: 'd1' },
        { id: 'd3', name: '海淀研发组', parentId: 'd2' },
      ];

      repo.syncOrganization({ departments, employees: [] });

      const d1 = repo.getDepartmentById('d1');
      const d2 = repo.getDepartmentById('d2');
      const d3 = repo.getDepartmentById('d3');

      expect(d1?.path).toBe('/d1');
      expect(d1?.level).toBe(1);

      expect(d2?.path).toBe('/d1/d2');
      expect(d2?.level).toBe(2);

      expect(d3?.path).toBe('/d1/d2/d3');
      expect(d3?.level).toBe(3);
    });

    it('对同一员工在同一部门的重复任职应自动去重，并优先保留主职与负责人标记', () => {
      const departments: OrgDepartmentInput[] = [{ id: 'dept-1', name: '部门1' }];
      const employees: OrgEmployeeInput[] = [
        {
          id: 'emp-dup',
          loginName: 'dupuser',
          name: '重复用户',
          departments: [
            { deptId: 'dept-1', isPrimary: false, isLeader: false, position: '初级职员' },
            { deptId: 'dept-1', isPrimary: true, isLeader: true, position: '高级工程师' },
          ],
        },
      ];

      repo.syncOrganization({ departments, employees });

      const emp = repo.getEmployeeById('emp-dup');
      expect(emp?.departments).toHaveLength(1);
      expect(emp?.departments[0]).toMatchObject({
        deptId: 'dept-1',
        isPrimary: true,
        isLeader: true,
      });
    });

    it('当多次全量同步时，应原子清除已离职员工、废弃部门与废弃任职关系（杜绝残留僵尸数据）', () => {
      // 第一次同步：3 个部门，2 个员工
      const initialData: SyncOrgData = {
        departments: [
          { id: 'd1', name: '部门1' },
          { id: 'd2', name: '部门2' },
          { id: 'd-obsolete', name: '废弃部门' },
        ],
        employees: [
          {
            id: 'e1',
            loginName: 'emp1',
            name: '在职员工1',
            departments: [{ deptId: 'd1', isPrimary: true }],
          },
          {
            id: 'e-departed',
            loginName: 'departed',
            name: '已离职员工',
            departments: [{ deptId: 'd-obsolete', isPrimary: true }],
          },
        ],
      };

      repo.syncOrganization(initialData);
      expect(repo.getStats().totalEmployees).toBe(2);
      expect(repo.getStats().totalDepartments).toBe(3);

      // 第二次全量同步：离职员工与废弃部门被剔除，新增 e2
      const updatedData: SyncOrgData = {
        departments: [
          { id: 'd1', name: '部门1-重命名' },
          { id: 'd2', name: '部门2' },
        ],
        employees: [
          {
            id: 'e1',
            loginName: 'emp1',
            name: '在职员工1',
            departments: [{ deptId: 'd1', isPrimary: true }],
          },
          {
            id: 'e2',
            loginName: 'emp2',
            name: '新入职员工2',
            departments: [{ deptId: 'd2', isPrimary: true }],
          },
        ],
      };

      repo.syncOrganization(updatedData);

      const stats = repo.getStats();
      expect(stats.totalDepartments).toBe(2);
      expect(stats.totalEmployees).toBe(2);

      // 验证已离职员工与废弃部门不可查
      expect(repo.getEmployeeById('e-departed')).toBeNull();
      expect(repo.getEmployeeByLoginName('departed')).toBeNull();
      expect(repo.getDepartmentById('d-obsolete')).toBeNull();

      // 验证新员工与重命名部门可查
      expect(repo.getEmployeeById('e2')).not.toBeNull();
      expect(repo.getDepartmentById('d1')?.name).toBe('部门1-重命名');
    });
  });

  describe('3. getDepartmentTree: 递归部门层级树', () => {
    it('应正确组装多级嵌套部门树并按层级与名称排序', () => {
      const departments: OrgDepartmentInput[] = [
        { id: 'root-1', name: '集团总部', parentId: null },
        { id: 'root-2', name: '创新研究院', parentId: null },
        { id: 'sub-1', name: '产品中心', parentId: 'root-1' },
        { id: 'sub-2', name: '技术中心', parentId: 'root-1' },
        { id: 'team-1', name: '前端组', parentId: 'sub-2' },
        { id: 'team-2', name: '后端组', parentId: 'sub-2' },
      ];

      repo.syncOrganization({ departments, employees: [] });

      const tree = repo.getDepartmentTree();
      expect(tree).toHaveLength(2);

      const root1 = tree.find(r => r.id === 'root-1');
      expect(root1).toBeDefined();
      expect(root1?.children).toHaveLength(2);

      const techCenter = root1?.children.find(c => c.id === 'sub-2');
      expect(techCenter).toBeDefined();
      expect(techCenter?.children).toHaveLength(2);
      expect(techCenter?.children.map(c => c.name)).toEqual(['前端组', '后端组']);
    });

    it('当组织架构为空时应安全返回空数组', () => {
      const tree = repo.getDepartmentTree();
      expect(tree).toEqual([]);
    });
  });

  describe('4. getEmployeeById 与 getEmployeeByLoginName: 单点精确查询', () => {
    beforeEach(() => {
      repo.syncOrganization({
        departments: [
          { id: 'dept-dev', name: '研发部' },
          { id: 'dept-sec', name: '安全部' },
        ],
        employees: [
          {
            id: 1001, // 支持数字型 ID
            loginName: 'wangwu',
            name: '王五',
            phone: '13911112222',
            email: 'wangwu@corp.com',
            region: '深圳基地',
            departments: [
              { deptId: 'dept-dev', isPrimary: true, isLeader: false, position: '后端架构师' },
              { deptId: 'dept-sec', isPrimary: false, isLeader: true, position: '兼职安全专员' },
            ],
          },
        ],
      });
    });

    it('getEmployeeById 应返回完整员工档案及主兼职列表（主职排在首位）', () => {
      const emp = repo.getEmployeeById('1001');

      expect(emp).not.toBeNull();
      expect(emp?.id).toBe('1001');
      expect(emp?.loginName).toBe('wangwu');
      expect(emp?.name).toBe('王五');
      expect(emp?.phone).toBe('13911112222');
      expect(emp?.email).toBe('wangwu@corp.com');
      expect(emp?.region).toBe('深圳基地');

      expect(emp?.departments).toHaveLength(2);
      expect(emp?.departments[0]).toMatchObject({
        deptId: 'dept-dev',
        deptName: '研发部',
        isPrimary: true,
        isLeader: false,
        position: '后端架构师',
      });
      expect(emp?.departments[1]).toMatchObject({
        deptId: 'dept-sec',
        deptName: '安全部',
        isPrimary: false,
        isLeader: true,
        position: '兼职安全专员',
      });
    });

    it('getEmployeeByLoginName 应支持通过工号/登录名精确查询', () => {
      const emp = repo.getEmployeeByLoginName('wangwu');
      expect(emp).not.toBeNull();
      expect(emp?.id).toBe('1001');
      expect(emp?.name).toBe('王五');
    });

    it('查询不存在的 ID 或工号时应返回 null', () => {
      expect(repo.getEmployeeById('99999')).toBeNull();
      expect(repo.getEmployeeByLoginName('non_existent')).toBeNull();
      expect(repo.getEmployeeById('')).toBeNull();
    });
  });

  describe('5. searchEmployees: 综合搜索与部门层级过滤', () => {
    beforeEach(() => {
      const departments: OrgDepartmentInput[] = [
        { id: 'hq', name: '总公司', parentId: null },
        { id: 'tech', name: '技术部', parentId: 'hq' },
        { id: 'ai', name: 'AI组', parentId: 'tech' },
        { id: 'sales', name: '销售部', parentId: 'hq' },
      ];

      const employees: OrgEmployeeInput[] = [
        {
          id: 'e1',
          loginName: 'alice',
          name: '艾丽斯',
          phone: '13812345678',
          email: 'alice@corp.com',
          departments: [{ deptId: 'ai', isPrimary: true }],
        },
        {
          id: 'e2',
          loginName: 'bob',
          name: '鲍勃',
          phone: '13987654321',
          email: 'bob@corp.com',
          departments: [{ deptId: 'tech', isPrimary: true }],
        },
        {
          id: 'e3',
          loginName: 'charlie',
          name: '查理',
          phone: '13700001111',
          email: 'charlie@corp.com',
          departments: [{ deptId: 'sales', isPrimary: true }],
        },
      ];

      repo.syncOrganization({ departments, employees });
    });

    it('应支持按关键词（工号、姓名、手机号、邮箱）模糊匹配', () => {
      const byName = repo.searchEmployees('艾丽斯');
      expect(byName).toHaveLength(1);
      expect(byName[0]?.loginName).toBe('alice');

      const byPhone = repo.searchEmployees('13987654321');
      expect(byPhone).toHaveLength(1);
      expect(byPhone[0]?.loginName).toBe('bob');

      const byEmail = repo.searchEmployees('corp.com');
      expect(byEmail).toHaveLength(3);
    });

    it('应支持按部门 ID 筛选员工', () => {
      const techEmps = repo.searchEmployees({ deptId: 'tech', includeSubDepts: false });
      expect(techEmps).toHaveLength(1);
      expect(techEmps[0]?.loginName).toBe('bob');
    });

    it('开启 includeSubDepts 时应递归筛选包含所有子部门的员工', () => {
      const allTechEmps = repo.getEmployeesByDepartmentId('tech', true);
      expect(allTechEmps).toHaveLength(2);
      const logins = allTechEmps.map(e => e.loginName).sort();
      expect(logins).toEqual(['alice', 'bob']);
    });
  });

  describe('6. 外键级联、事务回滚与边界异常处理', () => {
    it('删除员工或部门时应自动级联删除对应的任职关系记录', () => {
      repo.syncOrganization({
        departments: [{ id: 'd-test', name: '测试部门' }],
        employees: [
          {
            id: 'e-test',
            loginName: 'testuser',
            name: '测试员',
            departments: [{ deptId: 'd-test', isPrimary: true }],
          },
        ],
      });

      expect(repo.getStats().totalAppointments).toBe(1);

      // 直接删除员工
      db.prepare('DELETE FROM org_employees WHERE id = ?').run('e-test');
      expect(repo.getStats().totalAppointments).toBe(0);

      // 重新同步并测试删除部门时的级联
      repo.syncOrganization({
        departments: [{ id: 'd-test2', name: '测试部门2' }],
        employees: [
          {
            id: 'e-test2',
            loginName: 'testuser2',
            name: '测试员2',
            departments: [{ deptId: 'd-test2', isPrimary: true }],
          },
        ],
      });
      expect(repo.getStats().totalAppointments).toBe(1);

      db.prepare('DELETE FROM org_departments WHERE id = ?').run('d-test2');
      expect(repo.getStats().totalAppointments).toBe(0);
    });

    it('当同步过程中抛出异常时，整个事务应完全回滚且原有数据不受破坏', () => {
      const initialData: SyncOrgData = {
        departments: [{ id: 'd-safe', name: '安全部门' }],
        employees: [
          {
            id: 'e-safe',
            loginName: 'safeuser',
            name: '安全人员',
            departments: [{ deptId: 'd-safe', isPrimary: true }],
          },
        ],
      };

      repo.syncOrganization(initialData);
      expect(repo.getStats().totalEmployees).toBe(1);

      // 构造会导致失败的同步（如重复插入或在内部抛出错误）
      // 模拟只读事务或损坏约束
      const badData: SyncOrgData = {
        departments: [{ id: 'd-new', name: '新部门' }],
        employees: [
          // 缺少必填字段或格式非法导致崩溃
          { id: 'e-fail', loginName: null as unknown as string, name: '失败用户' },
        ],
      };

      expect(() => repo.syncOrganization(badData)).toThrow();

      // 验证回滚：原数据完好保留
      const stats = repo.getStats();
      expect(stats.totalDepartments).toBe(1);
      expect(stats.totalEmployees).toBe(1);
      expect(repo.getEmployeeById('e-safe')).not.toBeNull();
      expect(repo.getDepartmentById('d-safe')).not.toBeNull();
    });

    it('应支持批量大规模组织架构同步 (压力与性能基准)', () => {
      const departments: OrgDepartmentInput[] = [];
      for (let i = 1; i <= 50; i++) {
        departments.push({
          id: `dept-${i}`,
          name: `部门第${i}组`,
          parentId: i > 1 ? `dept-${Math.floor(i / 2)}` : null,
        });
      }

      const employees: OrgEmployeeInput[] = [];
      for (let i = 1; i <= 200; i++) {
        const assignedDept1 = `dept-${(i % 50) + 1}`;
        const assignedDept2 = `dept-${((i + 5) % 50) + 1}`;
        employees.push({
          id: `emp-${i}`,
          loginName: `user_${i}`,
          name: `员工_${i}`,
          phone: `1380000${String(i).padStart(4, '0')}`,
          email: `user_${i}@example.com`,
          departments: [
            { deptId: assignedDept1, isPrimary: true, position: '专员' },
            { deptId: assignedDept2, isPrimary: false, position: '兼任' },
          ],
        });
      }

      const result = repo.syncOrganization({ departments, employees });
      expect(result.departmentCount).toBe(50);
      expect(result.employeeCount).toBe(200);
      expect(result.appointmentCount).toBe(400);

      // 验证分页与过滤
      const page1 = repo.searchEmployees({ limit: 10, offset: 0 });
      expect(page1).toHaveLength(10);

      const page2 = repo.searchEmployees({ limit: 10, offset: 10 });
      expect(page2).toHaveLength(10);
      expect(page1[0]?.id).not.toEqual(page2[0]?.id);
    });
  });
});
