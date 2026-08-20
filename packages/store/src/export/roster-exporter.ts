import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Client } from '@libsql/client';
import type {
  EmployeeAppointment,
  ExportRosterOptions,
  ExportRosterResult,
} from '../types/index.js';
import { StoreError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('roster-export');

/**
 * 默认花名册导出目标路径
 */
export const DEFAULT_ROSTER_TARGET_PATH = 'data/organization_roster.csv';

/**
 * 默认 CSV 表头列表
 */
export const DEFAULT_ROSTER_HEADERS = [
  '员工ID',
  '工号',
  '姓名',
  '部门与任职',
  '手机号',
  '邮箱',
  '办公地区',
  '直属领导ID',
  '更新时间',
];

/**
 * 数据库员工行结构
 */
interface EmployeeRow {
  id: string;
  login_name: string;
  name: string;
  phone: string | null;
  email: string | null;
  region: string | null;
  leader_id: string | null;
  updated_at: number;
}

/**
 * 数据库任职关系查询行结构
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
 * 部门查询行结构
 */
interface DepartmentRow {
  id: string;
  name: string;
  parent_id: string | null;
}

/**
 * 转义单个 CSV 字段（符合 RFC 4180 规范）
 *
 * @param value 字段原始值
 * @returns RFC 4180 兼容的字符串
 */
export function escapeCsvField(
  value: string | number | boolean | bigint | null | undefined
): string {
  if (value === null || value === undefined) {
    return '';
  }
  const str = typeof value === 'string' ? value : String(value);
  if (
    str.includes('"') ||
    str.includes(',') ||
    str.includes('\n') ||
    str.includes('\r')
  ) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * 将字段数组格式化为符合 RFC 4180 的单行 CSV 文本
 *
 * @param fields 字段值数组
 * @returns 逗号分隔的单行 CSV
 */
export function formatCsvRow(
  fields: Array<string | number | boolean | bigint | null | undefined>
): string {
  return fields.map(escapeCsvField).join(',');
}

/**
 * 格式化日期为 YYYY-MM-DD 格式
 */
function formatDateToDay(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * 格式化时间戳为 YYYY-MM-DD HH:mm:ss
 */
function formatTimestamp(timestamp: number): string {
  if (!timestamp || Number.isNaN(timestamp)) {
    return '';
  }
  const date = new Date(timestamp);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${y}-${m}-${d} ${h}:${min}:${s}`;
}

/**
 * 单行合并员工的主兼职任职信息
 * 格式示例: [主] 总经办/技术研发中心/基础架构组 (首席架构师); [兼] 创新实验室 (研究员)
 *
 * @param appointments 员工任职关系列表
 * @param deptPathMap 部门 ID 到部门中文层级全路径的映射表
 */
export function formatDepartmentAppointments(
  appointments: EmployeeAppointment[],
  deptPathMap?: Map<string, string>
): string {
  if (!appointments || appointments.length === 0) {
    return '';
  }

  // 排序：主职优先，然后按部门 ID 排序
  const sorted = [...appointments].sort((a, b) => {
    if (a.isPrimary && !b.isPrimary) return -1;
    if (!a.isPrimary && b.isPrimary) return 1;
    return a.deptId.localeCompare(b.deptId);
  });

  return sorted
    .map(appt => {
      const prefix = appt.isPrimary ? '[主]' : '[兼]';
      const deptDisplay =
        deptPathMap?.get(appt.deptId) || appt.deptName || appt.deptId;
      const cleanDept = deptDisplay.trim();
      const posDisplay = appt.position?.trim()
        ? ` (${appt.position.trim()})`
        : '';
      return `${prefix} ${cleanDept}${posDisplay}`;
    })
    .join('; ');
}

/**
 * 执行 Windows 文件独占锁免疫的原子写入
 *
 * 先写入同目录下的临时文件，然后执行 fs.rename 原子替换。
 * 若遭遇 Windows 上 Excel 打开引发的 EBUSY / EPERM / EACCES 锁，自动降级保存为带日期副本。
 *
 * @param targetPath 目标文件路径
 * @param content CSV 完整文本内容（包含 BOM）
 * @param options 配置项
 * @returns 最终写入的文件路径与是否降级标记
 */
export async function atomicWriteRosterCsv(
  targetPath: string,
  content: string,
  options?: { now?: Date }
): Promise<{ filePath: string; isFallback: boolean }> {
  const resolvedTarget = path.resolve(targetPath);
  const targetDir = path.dirname(resolvedTarget);

  // 确保目标目录存在
  await fs.promises.mkdir(targetDir, { recursive: true });

  const randomSuffix = Math.random().toString(36).slice(2, 8);
  const tempFileName = `.${path.basename(resolvedTarget)}.tmp.${Date.now()}_${process.pid}_${randomSuffix}`;
  const tempPath = path.join(targetDir, tempFileName);

  try {
    // 1. 写入临时文件
    await fs.promises.writeFile(tempPath, content, 'utf8');

    // 2. 尝试原子重命名替换目标文件
    try {
      await fs.promises.rename(tempPath, resolvedTarget);
      log.debug({ targetPath: resolvedTarget }, '花名册 CSV 原子替换成功');
      return { filePath: resolvedTarget, isFallback: false };
    } catch (renameErr) {
      const nodeErr = renameErr as NodeJS.ErrnoException;
      const isLocked =
        nodeErr.code === 'EBUSY' ||
        nodeErr.code === 'EPERM' ||
        nodeErr.code === 'EACCES';

      if (!isLocked) {
        throw renameErr;
      }

      // 3. 触发 Windows Excel 独占锁免疫降级
      const now = options?.now ?? new Date();
      const dateStr = formatDateToDay(now);
      const ext = path.extname(resolvedTarget) || '.csv';
      const baseName = path.basename(resolvedTarget, ext);
      const fallbackFileName = `${baseName}_${dateStr}${ext}`;
      const fallbackPath = path.join(targetDir, fallbackFileName);

      log.warn(
        {
          code: nodeErr.code,
          targetPath: resolvedTarget,
          fallbackPath,
        },
        '检测到花名册目标文件被独占锁定 (如 Excel 打开占用)，已自动降级输出至带日期副本'
      );

      try {
        await fs.promises.rename(tempPath, fallbackPath);
      } catch (fallbackRenameErr) {
        // 若日期副本也被锁定，二次降级追加时间戳
        const timeStr = `${now.getHours().toString().padStart(2, '0')}${now.getMinutes().toString().padStart(2, '0')}${now.getSeconds().toString().padStart(2, '0')}`;
        const timestampFallbackPath = path.join(
          targetDir,
          `${baseName}_${dateStr}_${timeStr}${ext}`
        );
        log.warn(
          {
            fallbackPath,
            timestampFallbackPath,
            err: fallbackRenameErr,
          },
          '日期副本仍被占用，二次降级输出至带精确时间戳副本'
        );
        await fs.promises.rename(tempPath, timestampFallbackPath);
        return { filePath: timestampFallbackPath, isFallback: true };
      }

      return { filePath: fallbackPath, isFallback: true };
    }
  } finally {
    // 4. 清理残留临时文件
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
    } catch {
      // 忽略清理临时文件时的非关键异常
    }
  }
}

/**
 * 企业花名册 CSV 导出器
 * 负责从 SQLite 提取在职员工与多部门任职关系，并原子导出为标准 UTF-8 BOM CSV 文件
 */
export class RosterExporter {
  private readonly client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  /**
   * 构建花名册 CSV 文本内容
   *
   * @param options 导出选项
   * @returns CSV 字符串及在职员工记录数
   */
  public async buildCsvContent(options?: ExportRosterOptions): Promise<{
    content: string;
    rowCount: number;
  }> {
    const {
      includeBom = true,
      includeHeader = true,
      customHeaders,
      formatDate = formatTimestamp,
    } = options ?? {};

    // 1. 查询所有部门信息并计算每个部门的中文层级全路径 (如: 总经办/技术研发中心/基础架构组)
    const deptRes = await this.client.execute(`
      SELECT id, name, parent_id
      FROM org_departments
    `);
    const deptRows = deptRes.rows as unknown as DepartmentRow[];
    const rawDeptMap = new Map<string, DepartmentRow>();
    for (const d of deptRows) {
      rawDeptMap.set(String(d.id), d);
    }

    const deptPathMap = new Map<string, string>();
    for (const d of deptRows) {
      const segments: string[] = [];
      let cur: DepartmentRow | undefined = d;
      const visited = new Set<string>();
      while (cur) {
        if (visited.has(String(cur.id))) break;
        visited.add(String(cur.id));
        segments.unshift(String(cur.name).trim());
        if (!cur.parent_id) break;
        cur = rawDeptMap.get(String(cur.parent_id));
      }
      deptPathMap.set(String(d.id), segments.join('/'));
    }

    // 2. 查询所有在职员工档案
    const empRes = await this.client.execute(`
      SELECT id, login_name, name, phone, email, region, leader_id, updated_at
      FROM org_employees
      ORDER BY id ASC
    `);
    const empRows = empRes.rows as unknown as EmployeeRow[];

    // 3. 批量查询所有员工任职关系
    const apptRes = await this.client.execute(`
      SELECT 
        ed.employee_id,
        ed.dept_id,
        d.name AS dept_name,
        ed.is_primary,
        ed.is_leader,
        ed.position
      FROM org_employee_departments ed
      LEFT JOIN org_departments d ON ed.dept_id = d.id
      ORDER BY ed.is_primary DESC, ed.dept_id ASC
    `);
    const apptRows = apptRes.rows as unknown as AppointmentRow[];

    const apptMap = new Map<string, EmployeeAppointment[]>();
    for (const row of apptRows) {
      const list = apptMap.get(String(row.employee_id)) ?? [];
      list.push({
        deptId: String(row.dept_id),
        deptName: row.dept_name ? String(row.dept_name) : undefined,
        isPrimary: Number(row.is_primary) === 1,
        isLeader: Number(row.is_leader) === 1,
        position: row.position ? String(row.position) : undefined,
      });
      apptMap.set(String(row.employee_id), list);
    }

    // 4. 生成每一行员工数据
    const lines: string[] = [];

    // 表头行
    if (includeHeader) {
      const headers = customHeaders ?? DEFAULT_ROSTER_HEADERS;
      lines.push(formatCsvRow(headers));
    }

    for (const emp of empRows) {
      const appointments = apptMap.get(String(emp.id)) ?? [];
      const deptFormatted = formatDepartmentAppointments(
        appointments,
        deptPathMap
      );

      const row = [
        String(emp.id),
        String(emp.login_name),
        String(emp.name),
        deptFormatted,
        emp.phone ? String(emp.phone) : '',
        emp.email ? String(emp.email) : '',
        emp.region ? String(emp.region) : '',
        emp.leader_id ? String(emp.leader_id) : '',
        formatDate(Number(emp.updated_at)),
      ];

      lines.push(formatCsvRow(row));
    }

    const bomPrefix = includeBom ? '\uFEFF' : '';
    // RFC 4180 要求 CRLF 作为行分隔符
    const csvBody = lines.length > 0 ? `${lines.join('\r\n')}\r\n` : '';
    const content = `${bomPrefix}${csvBody}`;

    return {
      content,
      rowCount: empRows.length,
    };
  }

  /**
   * 导出花名册 CSV 到文件（支持 Windows Excel 锁防御）
   *
   * @param options 导出选项
   * @returns 导出统计结果
   */
  public async export(
    options?: ExportRosterOptions
  ): Promise<ExportRosterResult> {
    const startTime = Date.now();
    const targetPath = options?.targetPath ?? DEFAULT_ROSTER_TARGET_PATH;

    log.info({ targetPath }, '开始导出企业组织花名册 CSV...');

    try {
      const { content, rowCount } = await this.buildCsvContent(options);

      const { filePath, isFallback } = await atomicWriteRosterCsv(
        targetPath,
        content,
        { now: options?.now }
      );

      const stats = fs.statSync(filePath);
      const durationMs = Date.now() - startTime;

      log.info(
        {
          filePath,
          isFallback,
          rowCount,
          fileSizeBytes: stats.size,
          durationMs,
        },
        '企业组织花名册 CSV 导出成功'
      );

      return {
        filePath,
        isFallback,
        rowCount,
        fileSizeBytes: stats.size,
        durationMs,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err, targetPath }, '导出企业组织花名册 CSV 发生严重错误');
      throw new StoreError(`导出组织花名册 CSV 失败: ${err.message}`, 'ROSTER_EXPORT_ERROR', err);
    }
  }
}

/**
 * 快捷函数：导出企业组织花名册 CSV
 *
 * @param client LibSQL 客户端实例
 * @param options 导出选项
 * @returns 最终生成的文件路径
 */
export async function exportRosterCsv(
  client: Client,
  options?: ExportRosterOptions
): Promise<string> {
  const exporter = new RosterExporter(client);
  const result = await exporter.export(options);
  return result.filePath;
}
