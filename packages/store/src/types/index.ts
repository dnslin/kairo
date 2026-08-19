/**
 * @kkbot/store 组织架构与数据库持久化类型定义
 */

/**
 * 数据库连接配置项
 */
export interface DatabaseOptions {
  /** 数据库文件路径，默认 `:memory:` 或指定路径如 `data/kkbot.db` */
  path?: string;
  /** 是否开启 WAL (Write-Ahead Logging) 模式，默认 true (对内存库自动忽略) */
  wal?: boolean;
  /** 繁忙超时等待时间 (毫秒)，默认 5000 */
  busyTimeout?: number;
  /** 是否启用外键约束，默认 true */
  foreignKeys?: boolean;
  /** 同步写入模式，默认 'NORMAL' */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL' | 'EXTRA';
  /** SQLite 缓存大小 (KB 为负数，页面数为正数)，默认 -64000 (64MB) */
  cacheSize?: number;
  /** 是否只读模式 */
  readOnly?: boolean;
}

/**
 * 部门实体（数据库持久化结构）
 */
export interface OrgDepartment {
  /** 部门唯一标识 ID */
  id: string;
  /** 部门名称 */
  name: string;
  /** 上级部门 ID（根部门为 null 或 undefined） */
  parentId?: string | null;
  /** 部门主管/负责人 ID */
  leaderId?: string | null;
  /** 层级路径，如 `/1/2/3`，用于快速子树检索与排序 */
  path?: string | null;
  /** 部门层级深度（根部门为 1） */
  level: number;
  /** 更新时间戳 (毫秒) */
  updatedAt: number;
}

/**
 * 部门同步输入结构
 */
export interface OrgDepartmentInput {
  /** 部门唯一标识 ID */
  id: string;
  /** 部门名称 */
  name: string;
  /** 上级部门 ID */
  parentId?: string | null;
  /** 部门主管/负责人 ID */
  leaderId?: string | null;
  /** 层级路径（可选，未提供时将根据层级关系自动推导生成） */
  path?: string | null;
  /** 部门层级（可选，未提供时将根据深度自动推导生成） */
  level?: number;
  /** 更新时间戳 (毫秒，可选，默认 Date.now()) */
  updatedAt?: number;
}

/**
 * 部门树节点结构（包含递归子部门列表）
 */
export interface OrgDepartmentNode extends OrgDepartment {
  /** 子部门列表 */
  children: OrgDepartmentNode[];
}

/**
 * 员工档案实体（数据库持久化结构）
 */
export interface OrgEmployee {
  /** 员工唯一标识 ID (UID) */
  id: string;
  /** 工号 / 登录账号 (login_name) */
  loginName: string;
  /** 真实姓名 */
  name: string;
  /** 联系手机号 */
  phone?: string | null;
  /** 电子邮箱 */
  email?: string | null;
  /** 办公物理区域 / 地区 */
  region?: string | null;
  /** 直属领导员工 ID */
  leaderId?: string | null;
  /** 更新时间戳 (毫秒) */
  updatedAt: number;
}

/**
 * 员工任职关系输入结构
 */
export interface OrgEmployeeDepartmentInput {
  /** 所属部门 ID */
  deptId: string;
  /** 是否主职部门（true: 主职，false: 兼职，默认 false） */
  isPrimary?: boolean;
  /** 是否为该部门主管（true: 是，false: 否，默认 false） */
  isLeader?: boolean;
  /** 该部门下的岗位 / 职称 */
  position?: string | null;
}

/**
 * 员工同步输入结构
 */
export interface OrgEmployeeInput {
  /** 员工唯一标识 ID (UID) */
  id: string | number;
  /** 工号 / 登录账号 (login_name) */
  loginName: string;
  /** 真实姓名 */
  name: string;
  /** 联系手机号 */
  phone?: string | null;
  /** 电子邮箱 */
  email?: string | null;
  /** 办公物理区域 / 地区 */
  region?: string | null;
  /** 直属领导员工 ID */
  leaderId?: string | null;
  /** 更新时间戳 (毫秒，可选，默认 Date.now()) */
  updatedAt?: number;
  /** 所属部门及任职关系列表（包含主职与兼职） */
  departments?: OrgEmployeeDepartmentInput[];
}

/**
 * 员工在特定部门的任职详情
 */
export interface EmployeeAppointment {
  /** 部门 ID */
  deptId: string;
  /** 部门名称 (可选关联查询) */
  deptName?: string;
  /** 是否为主职部门 */
  isPrimary: boolean;
  /** 是否为该部门主管 */
  isLeader: boolean;
  /** 职位 / 职称 */
  position?: string;
}

/**
 * 聚合员工实体（包含基本档案与多部门主兼职任职列表）
 */
export interface OrgEmployeeWithDepts extends OrgEmployee {
  /** 任职部门列表 */
  departments: EmployeeAppointment[];
}

/**
 * 组织架构全量原子同步输入载荷
 */
export interface SyncOrgData {
  /** 部门列表 */
  departments: OrgDepartmentInput[];
  /** 员工列表 */
  employees: OrgEmployeeInput[];
}

/**
 * 组织架构同步统计结果
 */
export interface SyncOrgResult {
  /** 同步成功的部门数量 */
  departmentCount: number;
  /** 同步成功的员工数量 */
  employeeCount: number;
  /** 同步成功的任职关联记录数 */
  appointmentCount: number;
  /** 同步耗时 (毫秒) */
  durationMs: number;
}

/**
 * 组织架构整体统计信息
 */
export interface OrgStats {
  /** 部门总数 */
  totalDepartments: number;
  /** 员工总数 */
  totalEmployees: number;
  /** 任职关联总数 */
  totalAppointments: number;
  /** 最近更新时间戳 */
  lastUpdatedAt: number | null;
}

/**
 * 员工搜索过滤选项
 */
export interface SearchEmployeeOptions {
  /** 搜索关键词（支持匹配工号、姓名、手机号、邮箱） */
  query?: string;
  /** 指定部门 ID */
  deptId?: string;
  /** 是否包含子部门员工，默认 false */
  includeSubDepts?: boolean;
  /** 最大返回条数，默认 50 */
  limit?: number;
  /** 分页偏移量，默认 0 */
  offset?: number;
}

/**
 * 会话工作模式
 * - auto: 自动应答
 * - draft: 草稿待审
 * - disabled: 完全禁用
 */
export type SessionMode = 'auto' | 'draft' | 'disabled';

/**
 * 会话类型（私聊或群聊）
 */
export type SessionType = 'private' | 'group';

/**
 * 会话实体（数据库持久化记录）
 */
export interface SessionRecord {
  /** 会话唯一标识 (sesUUID) */
  id: string;
  /** 会话显示名称 */
  name: string;
  /** 会话类型 */
  type: SessionType;
  /** 关联员工档案 ID (org_employees.id) */
  employeeId: string | null;
  /** 会话工作模式 */
  mode: SessionMode;
  /** 人工接管截止时间戳 (毫秒)，大于当前时间代表人工接管中/退避中 */
  humanTakeoverUntil: number;
  /** 最后收到/发送消息的时间戳 (毫秒) */
  lastMessageAt: number;
  /** 机器人最后回复时间戳 (毫秒) */
  lastReplyAt: number;
  /** 当日回复计数 */
  dailyReplyCount: number;
  /** 当日计数重置日期 (YYYY-MM-DD) */
  dailyCountResetDate: string | null;
  /** 会话创建时间戳 (毫秒) */
  createdAt: number;
  /** 会话最后更新时间戳 (毫秒) */
  updatedAt: number;
}

/**
 * 会话插入或更新输入结构
 */
export interface UpsertSessionInput {
  /** 会话唯一标识 (sesUUID) */
  id: string;
  /** 会话显示名称 */
  name?: string;
  /** 会话类型 */
  type?: SessionType;
  /** 关联员工档案 ID */
  employeeId?: string | null;
  /** 会话工作模式 */
  mode?: SessionMode;
  /** 人工接管截止时间戳 (毫秒) */
  humanTakeoverUntil?: number;
  /** 最后消息时间戳 (毫秒) */
  lastMessageAt?: number;
  /** 最后回复时间戳 (毫秒) */
  lastReplyAt?: number;
  /** 当日回复计数 */
  dailyReplyCount?: number;
  /** 当日计数重置日期 */
  dailyCountResetDate?: string | null;
  /** 创建时间戳 (毫秒，可选，默认 Date.now()) */
  createdAt?: number;
  /** 更新时间戳 (毫秒，可选，默认 Date.now()) */
  updatedAt?: number;
}
