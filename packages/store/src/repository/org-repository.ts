import type { Client } from '@libsql/client';
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
 * 当输入数据未显式提供 path/level 时，根据 parent_id 拓扑结构自动推导
 *
 * @param departments 原始部门输入列表
 * @returns 补齐 path 与 level 的标准化部门列表
 */
function normalizeDepartments(
  departments: OrgDepartmentInput[]
): Array<Required<OrgDepartmentInput>> {
  const deptMap = new Map<string, OrgDepartmentInput>();
  for (const dept of departments) {
    deptMap.set(dept.id, dept);
  }

  const normalizedList: Array<Required<OrgDepartmentInput>> = [];
  const now = Date.now();

  for (const dept of departments) {
    let path = dept.path;
    let level = dept.level;

    if (!path || !level) {
      const segments: string[] = [];
      let current: OrgDepartmentInput | undefined = dept;
      const visited = new Set<string>();

      while (current) {
        if (visited.has(current.id)) {
          log.warn({ deptId: dept.id, circularId: current.id }, '检测到部门树循环引用');
          break;
        }
        visited.add(current.id);
        segments.unshift(current.id);

        if (!current.parentId) {
          break;
        }
        current = deptMap.get(current.parentId);
      }

      path = `/${segments.join('/')}`;
      level = segments.length;
    }

    normalizedList.push({
      id: dept.id,
      name: dept.name,
      parentId: dept.parentId ?? null,
      leaderId: dept.leaderId ?? null,
      path,
      level,
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
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 全量原子同步组织架构数据（单事务内全量刷新，杜绝离职员工与废弃部门残留）
   *
   * @param data 组织架构数据载荷（部门列表与员工列表）
   * @returns 同步统计结果
   */
  public async syncOrganization(data: SyncOrgData): Promise<SyncOrgResult> {
    const startTime = Date.now();
    const { departments = [], employees = [] } = data;

    log.info(
      { departmentCount: departments.length, employeeCount: employees.length },
      '开始执行组织架构全量原子同步...'
    );

    const tx = await this.client.transaction('write');

    try {
      const normalizedDepts = normalizeDepartments(departments);
      const now = Date.now();

      // 延迟外键检查至事务提交时统一校验，允许清空与重装
      await tx.execute('PRAGMA defer_foreign_keys = ON;');

      // 1. 清空旧数据
      await tx.execute('DELETE FROM org_employee_departments;');
      await tx.execute('DELETE FROM org_employees;');
      await tx.execute('DELETE FROM org_departments;');

      // 2. 批量插入部门
      for (const dept of normalizedDepts) {
        await tx.execute({
          sql: `INSERT INTO org_departments (id, name, parent_id, leader_id, path, level, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            dept.id,
            dept.name,
            dept.parentId ?? null,
            dept.leaderId ?? null,
            dept.path,
            dept.level,
            dept.updatedAt,
          ],
        });
      }

      // 3. 批量插入员工与任职关系
      let appointmentCount = 0;
      const validDeptIds = new Set(normalizedDepts.map(d => d.id));

      for (const emp of employees) {
        const empId = String(emp.id);
        const empUpdatedAt = emp.updatedAt ?? now;
        const pinyinAbbr = emp.pinyinAbbr?.trim() || getPinyinAbbr(emp.name);

        await tx.execute({
          sql: `INSERT INTO org_employees (id, login_name, name, pinyin_abbr, phone, email, region, leader_id, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            empId,
            emp.loginName,
            emp.name,
            pinyinAbbr || null,
            emp.phone ?? null,
            emp.email ?? null,
            emp.region ?? null,
            emp.leaderId ?? null,
            empUpdatedAt,
          ],
        });

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
            await tx.execute({
              sql: `INSERT INTO org_employee_departments (employee_id, dept_id, is_primary, is_leader, position)
                    VALUES (?, ?, ?, ?, ?)`,
              args: [
                empId,
                deptId,
                apptData.isPrimary ? 1 : 0,
                apptData.isLeader ? 1 : 0,
                apptData.position,
              ],
            });
            appointmentCount++;
          }
        }
      }

      await tx.commit();
      const durationMs = Date.now() - startTime;

      const stats: SyncOrgResult = {
        departmentCount: normalizedDepts.length,
        employeeCount: employees.length,
        appointmentCount,
        durationMs,
      };

      log.info({ ...stats }, '组织架构全量原子同步成功');
      return stats;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // 忽略已关闭或已回滚事务的异常
      }
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
  public async getDepartmentTree(): Promise<OrgDepartmentNode[]> {
    const res = await this.client.execute(`
      SELECT id, name, parent_id, leader_id, path, level, updated_at
      FROM org_departments
      ORDER BY level ASC, name ASC
    `);

    const rows = res.rows as unknown as DepartmentRow[];
    const nodeMap = new Map<string, OrgDepartmentNode>();

    for (const row of rows) {
      nodeMap.set(row.id, {
        id: row.id,
        name: row.name,
        parentId: row.parent_id ?? undefined,
        leaderId: row.leader_id ?? undefined,
        path: row.path ?? undefined,
        level: Number(row.level),
        updatedAt: Number(row.updated_at),
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
  public async getDepartmentById(id: string): Promise<OrgDepartment | null> {
    if (!id) return null;

    const res = await this.client.execute({
      sql: `SELECT id, name, parent_id, leader_id, path, level, updated_at
            FROM org_departments
            WHERE id = ?`,
      args: [id],
    });

    if (res.rows.length === 0) return null;
    const row = res.rows[0] as unknown as DepartmentRow;

    return {
      id: String(row.id),
      name: String(row.name),
      parentId: row.parent_id ? String(row.parent_id) : undefined,
      leaderId: row.leader_id ? String(row.leader_id) : undefined,
      path: row.path ? String(row.path) : undefined,
      level: Number(row.level),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * 获取所有扁平部门列表
   */
  public async getAllDepartments(): Promise<OrgDepartment[]> {
    const res = await this.client.execute(`
      SELECT id, name, parent_id, leader_id, path, level, updated_at
      FROM org_departments
      ORDER BY level ASC, name ASC
    `);

    const rows = res.rows as unknown as DepartmentRow[];
    return rows.map(row => ({
      id: String(row.id),
      name: String(row.name),
      parentId: row.parent_id ? String(row.parent_id) : undefined,
      leaderId: row.leader_id ? String(row.leader_id) : undefined,
      path: row.path ? String(row.path) : undefined,
      level: Number(row.level),
      updatedAt: Number(row.updated_at),
    }));
  }

  /**
   * 按员工 ID 单点精确查询员工档案及任职信息（包含主职与兼职列表）
   *
   * @param id 员工 ID (UID)
   * @returns 员工档案实体及任职列表，不存在时返回 null
   */
  public async getEmployeeById(id: string | number): Promise<OrgEmployeeWithDepts | null> {
    const empId = String(id).trim();
    if (!empId) return null;

    const empRes = await this.client.execute({
      sql: `SELECT id, login_name, name, pinyin_abbr, phone, email, region, leader_id, updated_at
            FROM org_employees
            WHERE id = ?`,
      args: [empId],
    });

    if (empRes.rows.length === 0) return null;
    const empRow = empRes.rows[0] as unknown as EmployeeRow;

    const apptRes = await this.client.execute({
      sql: `SELECT 
              ed.employee_id,
              ed.dept_id,
              d.name AS dept_name,
              ed.is_primary,
              ed.is_leader,
              ed.position
            FROM org_employee_departments ed
            LEFT JOIN org_departments d ON ed.dept_id = d.id
            WHERE ed.employee_id = ?
            ORDER BY ed.is_primary DESC, ed.dept_id ASC`,
      args: [empId],
    });

    const apptRows = apptRes.rows as unknown as AppointmentRow[];
    return this.mapToEmployeeWithDepts(empRow, apptRows);
  }

  /**
   * 按员工 UID 查询员工（别名方法）
   *
   * @param uid 员工 UID
   * @returns 员工实体或 null
   */
  public async getEmployeeByUid(uid: string | number): Promise<OrgEmployeeWithDepts | null> {
    return this.getEmployeeById(uid);
  }

  /**
   * 按工号 / 登录名查询员工
   *
   * @param loginName 工号 / 登录名
   * @returns 员工实体或 null
   */
  public async getEmployeeByLoginName(loginName: string): Promise<OrgEmployeeWithDepts | null> {
    const cleanLoginName = loginName?.trim();
    if (!cleanLoginName) return null;

    const empRes = await this.client.execute({
      sql: `SELECT id, login_name, name, pinyin_abbr, phone, email, region, leader_id, updated_at
            FROM org_employees
            WHERE login_name = ?`,
      args: [cleanLoginName],
    });

    if (empRes.rows.length === 0) return null;
    const empRow = empRes.rows[0] as unknown as EmployeeRow;

    return this.getEmployeeById(empRow.id);
  }

  /**
   * 综合多条件搜索员工
   * 支持工号、姓名、手机号、邮箱模糊检索以及指定部门及子部门过滤
   *
   * @param options 搜索条件或关键词字符串
   * @returns 符合条件的员工列表（包含任职信息）
   */
  public async searchEmployees(
    options: SearchEmployeeOptions | string
  ): Promise<OrgEmployeeWithDepts[]> {
    const opts: SearchEmployeeOptions = typeof options === 'string' ? { query: options } : options;
    const { query, deptId, includeSubDepts = false, limit = 50, offset = 0 } = opts;

    const whereClauses: string[] = [];
    const params: (string | number)[] = [];

    if (query && query.trim()) {
      const q = `%${query.trim()}%`;
      whereClauses.push(
        '(e.login_name LIKE ? OR e.name LIKE ? OR e.pinyin_abbr LIKE ? OR e.phone LIKE ? OR e.email LIKE ?)'
      );
      params.push(q, q, q, q, q);
    }

    if (deptId && deptId.trim()) {
      if (includeSubDepts) {
        const targetDept = await this.getDepartmentById(deptId.trim());
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

    const empRes = await this.client.execute({ sql, args: params });
    const empRows = empRes.rows as unknown as EmployeeRow[];
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
  public async getEmployeesByDepartmentId(
    deptId: string,
    includeSubDepts = false
  ): Promise<OrgEmployeeWithDepts[]> {
    return this.getDepartmentMembers(deptId, { includeSubDepts });
  }

  /**
   * 获取指定部门全员列表，支持递归包含子部门全员
   *
   * @param deptId 部门 ID
   * @param options 查询选项（是否递归包含子部门）
   * @returns 员工列表（含任职信息）
   */
  public async getDepartmentMembers(
    deptId: string,
    options?: GetDepartmentMembersOptions
  ): Promise<OrgEmployeeWithDepts[]> {
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
  public async getReportingChain(employeeId: string | number): Promise<OrgEmployeeWithDepts[]> {
    const empId = String(employeeId)?.trim();
    if (!empId) {
      return [];
    }

    const startEmp = await this.getEmployeeById(empId);
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
      const leader = await this.getEmployeeById(currentLeaderId);
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
  public async findEmployees(query: string, limit = 20): Promise<OrgEmployeeWithDepts[]> {
    const cleanQuery = query?.trim();
    if (!cleanQuery) {
      return [];
    }

    const boundedLimit = Math.max(1, limit);
    const pattern = `%${cleanQuery}%`;
    const exactQuery = cleanQuery;
    const prefixPattern = `${cleanQuery}%`;

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

    const args = [
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
      boundedLimit,
    ];

    const empRes = await this.client.execute({ sql, args });
    const empRows = empRes.rows as unknown as EmployeeRow[];

    if (empRows.length === 0) {
      return [];
    }

    return this.hydrateEmployeesWithDepts(empRows);
  }

  /**
   * 获取组织架构当前统计信息
   */
  public async getStats(): Promise<OrgStats> {
    const res = await this.client.execute(`
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

    const row = res.rows[0] as unknown as StatsRow | undefined;
    return {
      totalDepartments: Number(row?.dept_count ?? 0),
      totalEmployees: Number(row?.emp_count ?? 0),
      totalAppointments: Number(row?.appt_count ?? 0),
      lastUpdatedAt: row?.max_updated_at ? Number(row.max_updated_at) : null,
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

    const exporter = new RosterExporter(this.client);
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
      deptId: String(r.dept_id),
      deptName: r.dept_name ? String(r.dept_name) : undefined,
      isPrimary: Number(r.is_primary) === 1,
      isLeader: Number(r.is_leader) === 1,
      position: r.position ? String(r.position) : undefined,
    }));

    return {
      id: String(empRow.id),
      loginName: String(empRow.login_name),
      name: String(empRow.name),
      pinyinAbbr: empRow.pinyin_abbr ? String(empRow.pinyin_abbr) : undefined,
      phone: empRow.phone ? String(empRow.phone) : undefined,
      email: empRow.email ? String(empRow.email) : undefined,
      region: empRow.region ? String(empRow.region) : undefined,
      leaderId: empRow.leader_id ? String(empRow.leader_id) : undefined,
      updatedAt: Number(empRow.updated_at),
      departments,
    };
  }

  /**
   * 批量将员工行关联任职数据并组装为聚合员工实体
   */
  private async hydrateEmployeesWithDepts(empRows: EmployeeRow[]): Promise<OrgEmployeeWithDepts[]> {
    const empIds = empRows.map(e => String(e.id));
    const placeholders = empIds.map(() => '?').join(',');

    const apptRes = await this.client.execute({
      sql: `SELECT 
              ed.employee_id,
              ed.dept_id,
              d.name AS dept_name,
              ed.is_primary,
              ed.is_leader,
              ed.position
            FROM org_employee_departments ed
            LEFT JOIN org_departments d ON ed.dept_id = d.id
            WHERE ed.employee_id IN (${placeholders})
            ORDER BY ed.is_primary DESC, ed.dept_id ASC`,
      args: empIds,
    });

    const apptRows = apptRes.rows as unknown as AppointmentRow[];
    const apptMap = new Map<string, AppointmentRow[]>();

    for (const appt of apptRows) {
      const list = apptMap.get(String(appt.employee_id)) ?? [];
      list.push(appt);
      apptMap.set(String(appt.employee_id), list);
    }

    return empRows.map(emp => this.mapToEmployeeWithDepts(emp, apptMap.get(String(emp.id)) ?? []));
  }
}
