import type Database from 'better-sqlite3';
import type {
  EmployeeAppointment,
  ExportRosterOptions,
  GetDepartmentMembersOptions,
  OrgDepartment,
  OrgDepartmentInput,
  OrgDepartmentNode,
  OrgEmployeeWithDepts,
  OrgStats,
  SearchEmployeeOptions,
  SyncOrgData,
  SyncOrgResult,
} from '../types/index.js';
import { RosterExporter } from '../export/roster-exporter.js';
import { TransactionError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import { getPinyinAbbr } from '../utils/pinyin.js';

const log = createChildLogger('org-repo');

/**
 * 部门表 SQLite 数据行结构
 */
interface DepartmentRow {
  id: string;
  name: string;
  parent_id: string | null;
  leader_id: string | null;
  path: string | null;
  level: number;
  updated_at: number;
}

/**
 * 员工表 SQLite 数据行结构
 */
interface EmployeeRow {
  id: string;
  login_name: string;
  name: string;
  pinyin_abbr: string | null;
  phone: string | null;
  email: string | null;
  region: string | null;
  leader_id: string | null;
  updated_at: number;
}

/**
 * 任职关系联合查询行结构
 */
interface AppointmentRow {
  employee_id: string;
  dept_id: string;
  dept_name: string | null;
  is_primary: number;
  is_leader: number;
  position: string | null;
}

/**
 * 统计信息查询行结构
 */
interface StatsRow {
  dept_count: number;
  emp_count: number;
  appt_count: number;
  max_updated_at: number | null;
}

/**
 * 计算部门的层级路径 (path) 与层级深度 (level)
 *
 * @param departments 部门输入列表
 * @returns 补齐 path 与 level 的标准化部门列表
 */
function normalizeDepartments(
  departments: OrgDepartmentInput[]
): Array<Required<OrgDepartmentInput>> {
  const deptMap = new Map<string, OrgDepartmentInput>();
  for (const dept of departments) {
    deptMap.set(dept.id, dept);
  }

  const now = Date.now();
  const normalizedList: Array<Required<OrgDepartmentInput>> = [];

  for (const dept of departments) {
    let finalPath = dept.path ?? null;
    let finalLevel = dept.level ?? 1;

    if (!finalPath || !dept.level) {
      // 遍历父链生成 path 和 level
      const pathSegments: string[] = [];
      let currentId: string | null | undefined = dept.id;
      const visited = new Set<string>();

      while (currentId && deptMap.has(currentId)) {
        if (visited.has(currentId)) {
          // 环路防御
          break;
        }
        visited.add(currentId);
        pathSegments.unshift(currentId);
        const parentDept = deptMap.get(currentId);
        currentId = parentDept?.parentId;
      }

      if (!finalPath) {
        finalPath = `/${pathSegments.join('/')}`;
      }
      if (!dept.level) {
        finalLevel = pathSegments.length > 0 ? pathSegments.length : 1;
      }
    }

    normalizedList.push({
      id: dept.id,
      name: dept.name,
      parentId: dept.parentId ?? null,
      leaderId: dept.leaderId ?? null,
      path: finalPath,
      level: finalLevel,
      updatedAt: dept.updatedAt ?? now,
    });
  }

  return normalizedList;
}

/**
 * 组织架构仓储类
 * 负责部门树、员工档案与多部门任职关系的持久化、原子全量同步与层级查询
 */
export class OrgRepository {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * 全量原子同步组织架构数据（单事务内全量刷新，杜绝离职员工与废弃部门残留）
   *
   * @param data 组织架构数据载荷（部门列表与员工列表）
   * @returns 同步统计结果
   */
  public syncOrganization(data: SyncOrgData): SyncOrgResult {
    const startTime = Date.now();
    const { departments = [], employees = [] } = data;

    log.info(
      { departmentCount: departments.length, employeeCount: employees.length },
      '开始执行组织架构全量原子同步...'
    );

    try {
      const normalizedDepts = normalizeDepartments(departments);
      const now = Date.now();

      // 构建事务执行函数
      const performSync = this.db.transaction(() => {
        // 延迟外键检查至事务提交时统一校验，允许清空与重装
        this.db.pragma('defer_foreign_keys = ON');

        // 1. 清空旧数据
        this.db.prepare('DELETE FROM org_employee_departments').run();
        this.db.prepare('DELETE FROM org_employees').run();
        this.db.prepare('DELETE FROM org_departments').run();

        // 2. 批量插入部门
        const insertDeptStmt = this.db.prepare(`
          INSERT INTO org_departments (id, name, parent_id, leader_id, path, level, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        for (const dept of normalizedDepts) {
          insertDeptStmt.run(
            dept.id,
            dept.name,
            dept.parentId,
            dept.leaderId,
            dept.path,
            dept.level,
            dept.updatedAt
          );
        }

        // 3. 批量插入员工与任职关系
        const insertEmpStmt = this.db.prepare(`
          INSERT INTO org_employees (id, login_name, name, pinyin_abbr, phone, email, region, leader_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertApptStmt = this.db.prepare(`
          INSERT INTO org_employee_departments (employee_id, dept_id, is_primary, is_leader, position)
          VALUES (?, ?, ?, ?, ?)
        `);

        let appointmentCount = 0;
        const validDeptIds = new Set(normalizedDepts.map(d => d.id));

        for (const emp of employees) {
          const empId = String(emp.id);
          const empUpdatedAt = emp.updatedAt ?? now;
          const pinyinAbbr = emp.pinyinAbbr?.trim() || getPinyinAbbr(emp.name);

          insertEmpStmt.run(
            empId,
            emp.loginName,
            emp.name,
            pinyinAbbr || null,
            emp.phone ?? null,
            emp.email ?? null,
            emp.region ?? null,
            emp.leaderId ?? null,
            empUpdatedAt
          );

          if (Array.isArray(emp.departments) && emp.departments.length > 0) {
            // 对同一员工的任职部门进行去重，优先保留主职标记
            const seenDepts = new Map<
              string,
              { isPrimary: boolean; isLeader: boolean; position: string | null }
            >();

            for (const appt of emp.departments) {
              if (!appt.deptId || !validDeptIds.has(appt.deptId)) {
                // 跳过不存在或空的部门引用
                continue;
              }

              const existing = seenDepts.get(appt.deptId);
              const isPrimary = Boolean(appt.isPrimary) || (existing?.isPrimary ?? false);
              const isLeader = Boolean(appt.isLeader) || (existing?.isLeader ?? false);
              const position = appt.position ?? existing?.position ?? null;

              seenDepts.set(appt.deptId, { isPrimary, isLeader, position });
            }

            for (const [deptId, apptData] of seenDepts.entries()) {
              insertApptStmt.run(
                empId,
                deptId,
                apptData.isPrimary ? 1 : 0,
                apptData.isLeader ? 1 : 0,
                apptData.position
              );
              appointmentCount++;
            }
          }
        }

        return {
          departmentCount: normalizedDepts.length,
          employeeCount: employees.length,
          appointmentCount,
        };
      });

      const stats = performSync();
      const durationMs = Date.now() - startTime;

      log.info({ ...stats, durationMs }, '组织架构全量原子同步成功');

      return {
        ...stats,
        durationMs,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, '组织架构全量原子同步失败，事务已自动回滚');
      throw new TransactionError(`组织架构原子同步失败: ${err.message}`, err);
    }
  }

  /**
   * 获取完整的部门层级树
   *
   * @returns 根部门节点列表（包含嵌套子部门列表）
   */
  public getDepartmentTree(): OrgDepartmentNode[] {
    const stmt = this.db.prepare<[], DepartmentRow>(`
      SELECT id, name, parent_id, leader_id, path, level, updated_at
      FROM org_departments
      ORDER BY level ASC, name ASC
    `);

    const rows = stmt.all();
    const nodeMap = new Map<string, OrgDepartmentNode>();

    for (const row of rows) {
      nodeMap.set(row.id, {
        id: row.id,
        name: row.name,
        parentId: row.parent_id ?? undefined,
        leaderId: row.leader_id ?? undefined,
        path: row.path ?? undefined,
        level: row.level,
        updatedAt: row.updated_at,
        children: [],
      });
    }

    const roots: OrgDepartmentNode[] = [];

    for (const node of nodeMap.values()) {
      if (node.parentId && nodeMap.has(node.parentId)) {
        const parent = nodeMap.get(node.parentId)!;
        parent.children.push(node);
      } else {
        roots.push(node);
      }
    }

    return roots;
  }

  /**
   * 按部门 ID 查询单个部门信息
   *
   * @param id 部门 ID
   * @returns 部门实体或 null
   */
  public getDepartmentById(id: string): OrgDepartment | null {
    if (!id) return null;

    const stmt = this.db.prepare<[string], DepartmentRow>(`
      SELECT id, name, parent_id, leader_id, path, level, updated_at
      FROM org_departments
      WHERE id = ?
    `);

    const row = stmt.get(id);
    if (!row) return null;

    return {
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? undefined,
      leaderId: row.leader_id ?? undefined,
      path: row.path ?? undefined,
      level: row.level,
      updatedAt: row.updated_at,
    };
  }

  /**
   * 获取所有扁平部门列表
   */
  public getAllDepartments(): OrgDepartment[] {
    const stmt = this.db.prepare<[], DepartmentRow>(`
      SELECT id, name, parent_id, leader_id, path, level, updated_at
      FROM org_departments
      ORDER BY level ASC, name ASC
    `);

    return stmt.all().map(row => ({
      id: row.id,
      name: row.name,
      parentId: row.parent_id ?? undefined,
      leaderId: row.leader_id ?? undefined,
      path: row.path ?? undefined,
      level: row.level,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * 按员工 ID 单点精确查询员工档案及任职信息（包含主职与兼职列表）
   *
   * @param id 员工 ID (UID)
   * @returns 员工档案实体及任职列表，不存在时返回 null
   */
  public getEmployeeById(id: string | number): OrgEmployeeWithDepts | null {
    const empId = String(id).trim();
    if (!empId) return null;

    const empStmt = this.db.prepare<[string], EmployeeRow>(`
      SELECT id, login_name, name, pinyin_abbr, phone, email, region, leader_id, updated_at
      FROM org_employees
      WHERE id = ?
    `);

    const empRow = empStmt.get(empId);
    if (!empRow) return null;

    const apptStmt = this.db.prepare<[string], AppointmentRow>(`
      SELECT 
        ed.employee_id,
        ed.dept_id,
        d.name AS dept_name,
        ed.is_primary,
        ed.is_leader,
        ed.position
      FROM org_employee_departments ed
      LEFT JOIN org_departments d ON ed.dept_id = d.id
      WHERE ed.employee_id = ?
      ORDER BY ed.is_primary DESC, ed.dept_id ASC
    `);

    const apptRows = apptStmt.all(empId);

    return this.mapToEmployeeWithDepts(empRow, apptRows);
  }

  /**
   * 按工号 / 登录名查询员工
   *
   * @param loginName 工号 / 登录名
   * @returns 员工实体或 null
   */
  public getEmployeeByLoginName(loginName: string): OrgEmployeeWithDepts | null {
    const cleanLoginName = loginName?.trim();
    if (!cleanLoginName) return null;

    const empStmt = this.db.prepare<[string], EmployeeRow>(`
      SELECT id, login_name, name, pinyin_abbr, phone, email, region, leader_id, updated_at
      FROM org_employees
      WHERE login_name = ?
    `);

    const empRow = empStmt.get(cleanLoginName);
    if (!empRow) return null;

    return this.getEmployeeById(empRow.id);
  }

  /**
   * 综合多条件搜索员工
   * 支持工号、姓名、手机号、邮箱模糊检索以及指定部门及子部门过滤
   *
   * @param options 搜索条件或关键词字符串
   * @returns 符合条件的员工列表（包含任职信息）
   */
  public searchEmployees(options: SearchEmployeeOptions | string): OrgEmployeeWithDepts[] {
    const opts: SearchEmployeeOptions = typeof options === 'string' ? { query: options } : options;
    const { query, deptId, includeSubDepts = false, limit = 50, offset = 0 } = opts;

    const whereClauses: string[] = [];
    const params: unknown[] = [];

    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      whereClauses.push(
        '(e.login_name LIKE ? OR e.name LIKE ? OR e.pinyin_abbr LIKE ? OR e.phone LIKE ? OR e.email LIKE ?)'
      );
      params.push(q, q, q, q, q);
    }

    if (deptId && deptId.trim()) {
      if (includeSubDepts) {
        const targetDept = this.getDepartmentById(deptId.trim());
        if (targetDept?.path) {
          whereClauses.push(`
            e.id IN (
              SELECT ed.employee_id FROM org_employee_departments ed
              WHERE ed.dept_id IN (
                SELECT d.id FROM org_departments d
                WHERE d.path LIKE ? OR d.id = ?
              )
            )
          `);
          params.push(`${targetDept.path}/%`, targetDept.id);
        } else {
          whereClauses.push(
            'e.id IN (SELECT ed.employee_id FROM org_employee_departments ed WHERE ed.dept_id = ?)'
          );
          params.push(deptId.trim());
        }
      } else {
        whereClauses.push(
          'e.id IN (SELECT ed.employee_id FROM org_employee_departments ed WHERE ed.dept_id = ?)'
        );
        params.push(deptId.trim());
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const sql = `
      SELECT e.id, e.login_name, e.name, e.pinyin_abbr, e.phone, e.email, e.region, e.leader_id, e.updated_at
      FROM org_employees e
      ${whereSql}
      ORDER BY e.id ASC
      LIMIT ? OFFSET ?
    `;

    params.push(limit, offset);

    const empRows = this.db.prepare(sql).all(...params) as EmployeeRow[];
    if (empRows.length === 0) {
      return [];
    }

    return this.hydrateEmployeesWithDepts(empRows);
  }

  /**
   * 获取指定部门下的员工列表
   *
   * @param deptId 部门 ID
   * @param includeSubDepts 是否递归包含子部门员工，默认 false
   * @returns 员工列表
   */
  public getEmployeesByDepartmentId(
    deptId: string,
    includeSubDepts = false
  ): OrgEmployeeWithDepts[] {
    return this.getDepartmentMembers(deptId, { includeSubDepts });
  }

  /**
   * 获取指定部门全员列表，支持递归包含子部门全员
   *
   * @param deptId 部门 ID
   * @param options 查询选项（是否递归包含子部门）
   * @returns 员工列表（含任职信息）
   */
  public getDepartmentMembers(
    deptId: string,
    options?: GetDepartmentMembersOptions
  ): OrgEmployeeWithDepts[] {
    const cleanDeptId = deptId?.trim();
    if (!cleanDeptId) {
      return [];
    }

    const includeSubDepts = options?.includeSubDepts ?? false;
    return this.searchEmployees({
      deptId: cleanDeptId,
      includeSubDepts,
      limit: 10000,
    });
  }

  /**
   * 向上递归穿透管理汇报链
   * 通过 leader_id 逐级向上检索直属领导、隔级领导直到顶级管理者
   *
   * @param employeeId 员工唯一标识 ID (UID)
   * @returns 汇报链上的管理者列表（按管理层级由近及远排列）
   */
  public getReportingChain(employeeId: string | number): OrgEmployeeWithDepts[] {
    const empId = String(employeeId)?.trim();
    if (!empId) {
      return [];
    }

    const startEmp = this.getEmployeeById(empId);
    if (!startEmp || !startEmp.leaderId) {
      return [];
    }

    const chain: OrgEmployeeWithDepts[] = [];
    const visited = new Set<string>([startEmp.id]);
    let currentLeaderId: string | null | undefined = startEmp.leaderId;

    while (currentLeaderId) {
      if (visited.has(currentLeaderId)) {
        log.warn(
          { employeeId: empId, circularLeaderId: currentLeaderId },
          '检测到员工汇报链存在环形引用，已安全终止向上递归'
        );
        break;
      }

      visited.add(currentLeaderId);
      const leader = this.getEmployeeById(currentLeaderId);
      if (!leader) {
        break;
      }

      chain.push(leader);
      currentLeaderId = leader.leaderId;
    }

    return chain;
  }

  /**
   * 多维模糊快搜员工
   * 组合工号、中文名、拼音缩写、岗位/职称、工位区域与部门名称/路径的多字段 SQL 模糊快搜
   * 结果按精确匹配度与相关性自动排序
   *
   * @param query 搜索关键词（支持中文名、拼音简写、工号、岗位、工位、部门等）
   * @param limit 返回最大条数，默认 20
   * @returns 匹配的员工聚合实体列表（含完整任职信息）
   */
  public findEmployees(query: string, limit = 20): OrgEmployeeWithDepts[] {
    const cleanQuery = query?.trim();
    if (!cleanQuery) {
      return [];
    }

    const boundedLimit = Math.max(1, limit);
    const pattern = `%${cleanQuery}%`;
    const exactQuery = cleanQuery;
    const prefixPattern = `${cleanQuery}%`;

    // 多维联合查询与排序权重计算：
    // 1: 工号/姓名精确匹配
    // 2: 拼音缩写精确匹配
    // 3: 工号/姓名/拼音前缀匹配
    // 4: 模糊匹配
    const sql = `
      SELECT 
        e.id, 
        e.login_name, 
        e.name, 
        e.pinyin_abbr, 
        e.phone, 
        e.email, 
        e.region, 
        e.leader_id, 
        e.updated_at,
        MIN(
          CASE 
            WHEN e.login_name = ? THEN 1
            WHEN e.name = ? THEN 2
            WHEN LOWER(e.pinyin_abbr) = LOWER(?) THEN 3
            WHEN e.login_name LIKE ? THEN 4
            WHEN e.name LIKE ? THEN 5
            WHEN LOWER(e.pinyin_abbr) LIKE LOWER(?) THEN 6
            WHEN e.region LIKE ? THEN 7
            WHEN ed.position LIKE ? THEN 8
            WHEN d.name LIKE ? OR d.path LIKE ? THEN 9
            ELSE 10
          END
        ) AS rank_score
      FROM org_employees e
      LEFT JOIN org_employee_departments ed ON e.id = ed.employee_id
      LEFT JOIN org_departments d ON ed.dept_id = d.id
      WHERE (
        e.login_name LIKE ?
        OR e.name LIKE ?
        OR e.pinyin_abbr LIKE ?
        OR e.region LIKE ?
        OR e.phone LIKE ?
        OR e.email LIKE ?
        OR ed.position LIKE ?
        OR d.name LIKE ?
        OR d.path LIKE ?
      )
      GROUP BY e.id
      ORDER BY rank_score ASC, e.id ASC
      LIMIT ?
    `;

    const empRows = this.db.prepare(sql).all(
      exactQuery,
      exactQuery,
      exactQuery,
      prefixPattern,
      prefixPattern,
      prefixPattern,
      pattern,
      pattern,
      pattern,
      pattern,
      // WHERE 条件参数
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      pattern,
      // LIMIT 参数
      boundedLimit
    ) as EmployeeRow[];

    if (empRows.length === 0) {
      return [];
    }

    return this.hydrateEmployeesWithDepts(empRows);
  }

  /**
   * 获取组织架构当前统计信息
   */
  public getStats(): OrgStats {
    const stmt = this.db.prepare<[], StatsRow>(`
      SELECT 
        (SELECT COUNT(*) FROM org_departments) AS dept_count,
        (SELECT COUNT(*) FROM org_employees) AS emp_count,
        (SELECT COUNT(*) FROM org_employee_departments) AS appt_count,
        (
          SELECT MAX(updated_at) FROM (
            SELECT updated_at FROM org_departments
            UNION ALL
            SELECT updated_at FROM org_employees
          )
        ) AS max_updated_at
    `);

    const row = stmt.get();
    return {
      totalDepartments: row?.dept_count ?? 0,
      totalEmployees: row?.emp_count ?? 0,
      totalAppointments: row?.appt_count ?? 0,
      lastUpdatedAt: row?.max_updated_at ?? null,
    };
  }

  /**
   * 导出企业组织花名册 CSV 文件（支持 Windows Excel 独占锁防御）
   *
   * @param targetPathOrOptions 目标文件路径或导出选项（默认: data/organization_roster.csv）
   * @param options 补充导出选项
   * @returns 实际生成的文件路径
   */
  public async exportRosterCsv(
    targetPathOrOptions?: string | ExportRosterOptions,
    options?: ExportRosterOptions
  ): Promise<string> {
    const opts: ExportRosterOptions =
      typeof targetPathOrOptions === 'string'
        ? { targetPath: targetPathOrOptions, ...options }
        : { ...targetPathOrOptions, ...options };

    const exporter = new RosterExporter(this.db);
    const result = await exporter.export(opts);
    return result.filePath;
  }

  /**
   * 将原始员工数据库行与任职记录转换为标准领域实体
   */
  private mapToEmployeeWithDepts(
    empRow: EmployeeRow,
    apptRows: AppointmentRow[]
  ): OrgEmployeeWithDepts {
    const departments: EmployeeAppointment[] = apptRows.map(r => ({
      deptId: r.dept_id,
      deptName: r.dept_name ?? undefined,
      isPrimary: r.is_primary === 1,
      isLeader: r.is_leader === 1,
      position: r.position ?? undefined,
    }));

    return {
      id: empRow.id,
      loginName: empRow.login_name,
      name: empRow.name,
      pinyinAbbr: empRow.pinyin_abbr ?? undefined,
      phone: empRow.phone ?? undefined,
      email: empRow.email ?? undefined,
      region: empRow.region ?? undefined,
      leaderId: empRow.leader_id ?? undefined,
      updatedAt: empRow.updated_at,
      departments,
    };
  }

  /**
   * 批量将员工行关联任职数据并组装为聚合员工实体
   */
  private hydrateEmployeesWithDepts(empRows: EmployeeRow[]): OrgEmployeeWithDepts[] {
    const empIds = empRows.map(e => e.id);
    const placeholders = empIds.map(() => '?').join(',');

    const apptStmt = this.db.prepare(`
      SELECT 
        ed.employee_id,
        ed.dept_id,
        d.name AS dept_name,
        ed.is_primary,
        ed.is_leader,
        ed.position
      FROM org_employee_departments ed
      LEFT JOIN org_departments d ON ed.dept_id = d.id
      WHERE ed.employee_id IN (${placeholders})
      ORDER BY ed.is_primary DESC, ed.dept_id ASC
    `);

    const apptRows = apptStmt.all(...empIds) as AppointmentRow[];
    const apptMap = new Map<string, AppointmentRow[]>();

    for (const appt of apptRows) {
      const list = apptMap.get(appt.employee_id) ?? [];
      list.push(appt);
      apptMap.set(appt.employee_id, list);
    }

    return empRows.map(emp => this.mapToEmployeeWithDepts(emp, apptMap.get(emp.id) ?? []));
  }
}
