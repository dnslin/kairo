import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Client } from '@libsql/client';
import {
  closeDatabase,
  createDatabaseClient,
  OrgRepository,
  type SyncOrgData,
  RosterExporter,
  exportRosterCsv,
  escapeCsvField,
  formatCsvRow,
} from '../src/index.js';

describe('CSV 花名册导出器与 Excel 独占锁免疫测试 (TDD Red -> Green)', () => {
  let db: Client;
  let repo: OrgRepository;
  let testTempDir: string;

  const mockOrgData: SyncOrgData = {
    departments: [
      { id: 'dept-root', name: '总经办', parentId: null },
      { id: 'dept-tech', name: '技术研发中心', parentId: 'dept-root' },
      { id: 'dept-arch', name: '基础架构组', parentId: 'dept-tech' },
      { id: 'dept-lab', name: '创新实验室', parentId: 'dept-tech' },
    ],
    employees: [
      {
        id: 'emp-001',
        loginName: 'E001',
        name: '张三, "老张"', // 含逗号和双引号
        phone: '13800000001',
        email: 'zhangsan@example.com',
        region: '北京',
        departments: [
          { deptId: 'dept-arch', isPrimary: true, position: '首席架构师' },
          { deptId: 'dept-lab', isPrimary: false, position: '研究员' },
        ],
      },
      {
        id: 'emp-002',
        loginName: 'E002',
        name: '李四\n(全栈)', // 含换行符
        phone: '13800000002',
        email: 'lisi@example.com',
        region: '上海',
        departments: [
          { deptId: 'dept-arch', isPrimary: true },
        ],
      },
      {
        id: 'emp-003',
        loginName: 'E003',
        name: '王五',
        phone: null,
        email: null,
        region: null,
        departments: [], // 无部门
      },
    ],
  };

  beforeEach(async () => {
    db = await createDatabaseClient({ path: ':memory:' });
    repo = new OrgRepository(db);
    await repo.syncOrganization(mockOrgData);

    testTempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-roster-test-'));
  });

  afterEach(() => {
    closeDatabase(db);
    vi.restoreAllMocks();
    if (fs.existsSync(testTempDir)) {
      fs.rmSync(testTempDir, { recursive: true, force: true });
    }
  });

  describe('1. CSV 转义与行格式化 (RFC 4180)', () => {
    it('应正确转义包含双引号、逗号与换行符的字段', () => {
      expect(escapeCsvField('普通文本')).toBe('普通文本');
      expect(escapeCsvField('包含,逗号')).toBe('"包含,逗号"');
      expect(escapeCsvField('包含"双引号"')).toBe('"包含""双引号"""');
      expect(escapeCsvField('包含\n换行')).toBe('"包含\n换行"');
      expect(escapeCsvField(null)).toBe('');
      expect(escapeCsvField(undefined)).toBe('');
    });

    it('formatCsvRow 应以逗号连接转义后的字段', () => {
      const row = formatCsvRow(['1001', '张三, 架构师', 'test"1"']);
      expect(row).toBe('1001,"张三, 架构师","test""1"""');
    });
  });

  describe('2. UTF-8 BOM 标头与在职员工 1:1 行数对齐', () => {
    it('导出的 CSV 文件必须以 UTF-8 BOM (\\uFEFF) 开头，且总行数与员工数严格 1:1 对齐', async () => {
      const targetPath = path.join(testTempDir, 'data', 'organization_roster.csv');
      const result = await repo.exportRosterCsv(targetPath);

      expect(result).toBe(targetPath);
      expect(fs.existsSync(targetPath)).toBe(true);

      const buffer = fs.readFileSync(targetPath);
      // 校验 UTF-8 BOM: 0xEF, 0xBB, 0xBF
      expect(buffer[0]).toBe(0xef);
      expect(buffer[1]).toBe(0xbb);
      expect(buffer[2]).toBe(0xbf);

      const content = buffer.toString('utf8');
      expect(content.startsWith('\uFEFF')).toBe(true);

      expect(content).toContain('员工ID,工号,姓名,部门与任职');
      expect(content).toContain('E001');
      expect(content).toContain('E002');
      expect(content).toContain('E003');
    });
  });

  describe('3. 单行合并主兼职任职格式化', () => {
    it('兼职信息应使用 [主]...; [兼]... 单列合并格式化，并优先保留主职与层级路径', async () => {
      const targetPath = path.join(testTempDir, 'roster.csv');
      const exporter = new RosterExporter(db);
      const res = await exporter.export({ targetPath });

      expect(res.rowCount).toBe(3);
      const content = fs.readFileSync(res.filePath, 'utf8');

      // 验证张三（主职在基础架构组，兼职在创新实验室）
      expect(content).toContain('[主] 总经办/技术研发中心/基础架构组 (首席架构师); [兼] 总经办/技术研发中心/创新实验室 (研究员)');
      // 验证李四（仅主职）
      expect(content).toContain('[主] 总经办/技术研发中心/基础架构组');
      // 验证王五（无部门）
      expect(content).toContain('emp-003,E003,王五');
    });
  });

  describe('4. 原子写入与临时文件清理', () => {
    it('应在同一目录生成临时文件并原子替换，导出完成后无临时文件残留', async () => {
      const targetPath = path.join(testTempDir, 'roster.csv');
      const exporter = new RosterExporter(db);
      await exporter.export({ targetPath });

      const files = fs.readdirSync(testTempDir);
      expect(files).toContain('roster.csv');
      // 不应包含任何 .tmp 临时文件
      const tmpFiles = files.filter(f => f.includes('.tmp'));
      expect(tmpFiles).toEqual([]);
    });
  });

  describe('5. Windows Excel 文件锁 (EBUSY/EPERM/EACCES) 免疫与自动降级', () => {
    it('当目标文件遭遇 EBUSY 文件锁时，应自动降级输出带日期副本且不抛出异常', async () => {
      const targetPath = path.join(testTempDir, 'organization_roster.csv');
      const exporter = new RosterExporter(db);

      const fixedDate = new Date(2026, 7, 19); // 2026-08-19

      // 模拟 fs.promises.rename 在重命名为 targetPath 时抛出 EBUSY
      const originalRename = fs.promises.rename;
      const renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (newPath === targetPath) {
          const err = new Error('resource busy or locked') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalRename(oldPath, newPath);
      });

      const res = await exporter.export({
        targetPath,
        now: fixedDate,
      });

      expect(res.isFallback).toBe(true);
      expect(res.filePath).toBe(path.join(testTempDir, 'organization_roster_2026-08-19.csv'));
      expect(fs.existsSync(res.filePath)).toBe(true);

      // 验证临时文件已被清理
      const files = fs.readdirSync(testTempDir);
      const tmpFiles = files.filter(f => f.includes('.tmp'));
      expect(tmpFiles).toEqual([]);

      renameSpy.mockRestore();
    });

    it('当遭遇 EPERM / EACCES 锁定时同样能正常降级', async () => {
      const targetPath = path.join(testTempDir, 'locked_roster.csv');
      const exporter = new RosterExporter(db);
      const fixedDate = new Date(2026, 7, 19);

      const originalRename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
        if (newPath === targetPath) {
          const err = new Error('permission denied / locked') as NodeJS.ErrnoException;
          err.code = 'EPERM';
          throw err;
        }
        return originalRename(oldPath, newPath);
      });

      const res = await exporter.export({
        targetPath,
        now: fixedDate,
      });

      expect(res.isFallback).toBe(true);
      expect(res.filePath).toBe(path.join(testTempDir, 'locked_roster_2026-08-19.csv'));
      expect(fs.existsSync(res.filePath)).toBe(true);
    });
  });

  describe('6. 边界场景与自定义导出配置', () => {
    it('当数据库为空时，应正常导出仅含表头且 0 行记录的 CSV', async () => {
      const emptyDb = await createDatabaseClient({ path: ':memory:' });
      const targetPath = path.join(testTempDir, 'empty.csv');
      const exporter = new RosterExporter(emptyDb);

      const res = await exporter.export({ targetPath });
      expect(res.rowCount).toBe(0);

      const content = fs.readFileSync(targetPath, 'utf8');
      expect(content.startsWith('\uFEFF')).toBe(true);
      expect(content).toContain('员工ID,工号,姓名,部门与任职');
      closeDatabase(emptyDb);
    });

    it('支持 includeBom: false, includeHeader: false 与自定义表头及日期格式化', async () => {
      const targetPath = path.join(testTempDir, 'custom.csv');
      const exporter = new RosterExporter(db);

      const res = await exporter.export({
        targetPath,
        includeBom: false,
        includeHeader: false,
        formatDate: ts => `T_${ts}`,
      });

      expect(res.rowCount).toBe(3);
      const buffer = fs.readFileSync(targetPath);
      // 不含 BOM
      expect(buffer[0]).not.toBe(0xef);

      const content = buffer.toString('utf8');
      // 不含表头行
      expect(content.startsWith('emp-001')).toBe(true);
      expect(content).toContain('T_');
    });

    it('当日期副本也被占用时，应进行二次降级输出精确时间戳副本', async () => {
      const targetPath = path.join(testTempDir, 'double_locked.csv');
      const exporter = new RosterExporter(db);
      const fixedDate = new Date(2026, 7, 19, 14, 30, 45); // 2026-08-19 14:30:45

      const originalRename = fs.promises.rename;
      vi.spyOn(fs.promises, 'rename').mockImplementation(async (oldPath, newPath) => {
        const targetStr = String(newPath);
        if (targetStr.endsWith('double_locked.csv') || targetStr.endsWith('double_locked_2026-08-19.csv')) {
          const err = new Error('EBUSY') as NodeJS.ErrnoException;
          err.code = 'EBUSY';
          throw err;
        }
        return originalRename(oldPath, newPath);
      });

      const res = await exporter.export({
        targetPath,
        now: fixedDate,
      });

      expect(res.isFallback).toBe(true);
      expect(res.filePath).toBe(path.join(testTempDir, 'double_locked_2026-08-19_143045.csv'));
      expect(fs.existsSync(res.filePath)).toBe(true);
    });
  });

  describe('7. 独立函数与 OrgRepository 快捷方法', () => {
    it('exportRosterCsv 独立快捷函数应正常工作', async () => {
      const targetPath = path.join(testTempDir, 'export_func.csv');
      const filePath = await exportRosterCsv(db, { targetPath });
      expect(filePath).toBe(targetPath);
      expect(fs.existsSync(targetPath)).toBe(true);
    });

    it('repo.exportRosterCsv 应直接调用并返回路径', async () => {
      const targetPath = path.join(testTempDir, 'repo_export.csv');
      const filePath = await repo.exportRosterCsv(targetPath);
      expect(filePath).toBe(targetPath);
      expect(fs.existsSync(targetPath)).toBe(true);
    });
  });
});
