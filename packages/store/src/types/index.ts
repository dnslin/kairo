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
  /** 姓名拼音首字母缩写 (如 "zsf") */
  pinyinAbbr?: string | null;
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
  /** 姓名拼音首字母缩写（可选，未提供时将根据中文姓名自动生成） */
  pinyinAbbr?: string | null;
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

/**
 * 部门成员查询选项
 */
export interface GetDepartmentMembersOptions {
  /** 是否递归包含子部门员工，默认 false */
  includeSubDepts?: boolean;
}

/**
 * 花名册 CSV 导出配置选项
 */
export interface ExportRosterOptions {
  /** 导出目标路径，默认: data/organization_roster.csv */
  targetPath?: string;
  /** 是否包含 UTF-8 BOM 标头（\\uFEFF），防止 Excel 打开中文乱码，默认 true */
  includeBom?: boolean;
  /** 是否包含表头行，默认 true */
  includeHeader?: boolean;
  /** 自定义时间基准（用于生成日期备份后缀），默认当前系统时间 */
  now?: Date;
  /** 自定义表头列表，默认: ['员工ID', '工号', '姓名', '部门与任职', '手机号', '邮箱', '办公地区', '直属领导ID', '更新时间'] */
  customHeaders?: string[];
  /** 日期格式化函数（可选） */
  formatDate?: (timestamp: number) => string;
}

/**
 * 花名册 CSV 导出统计结果
 */
export interface ExportRosterResult {
  /** 实际写入并生成的文件路径（若触发文件锁防御则为带日期副本路径） */
  filePath: string;
  /** 是否触发了 Windows Excel 文件独占锁降级备份 */
  isFallback: boolean;
  /** 导出的总在职员工行数（不含表头） */
  rowCount: number;
  /** 写入的文件大小（字节） */
  fileSizeBytes: number;
  /** 导出操作总耗时（毫秒） */
  durationMs: number;
}

/**
 * 消息类型枚举/常量联合类型
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'file'
  | 'quote'
  | 'rich-text'
  | 'system'
  | (string & {});

/**
 * 消息多模态与扩展载荷结构
 */
export interface MessageRawPayload {
  /** 图片元数据列表 */
  images?: Array<{
    url?: string;
    path?: string;
    relativePath?: string;
    width?: number;
    height?: number;
    size?: number;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  /** 文件卡片元数据 */
  fileInfo?: {
    name: string;
    size?: number | string;
    path?: string;
    relativePath?: string;
    extension?: string;
    [key: string]: unknown;
  };
  /** @ 提及信息 */
  mentions?: {
    isAtMe?: boolean;
    isAtAll?: boolean;
    mentionedUsers?: string[];
    [key: string]: unknown;
  };
  /** 引用回复信息 */
  replyTo?: {
    id?: string;
    sender?: string;
    content?: string;
    [key: string]: unknown;
  };
  /** 其它自定义或原始属性 */
  [key: string]: unknown;
}

/**
 * 会话消息实体（数据库持久化与查询返回结构）
 */
export interface SessionMessage {
  /** 数据库自增主键 ID */
  id: number;
  /** 聊天会话唯一 ID */
  sessionId: string;
  /** 客户端原生消息 ID (msgID)，用于精准撤回与排重 */
  messageId: string | null;
  /** 发送方名称/昵称 */
  sender: string;
  /** 发送方员工 UID 或用户 ID */
  senderId: string | null;
  /** 消息文本内容（文本、富文本摘要或媒体文件名） */
  content: string;
  /** 消息类型 ('text' | 'image' | 'file' | 'quote' | 'rich-text' | 'system' 等) */
  messageType: MessageType;
  /** 原始多模态或扩展 JSON 载荷反序列化对象 */
  rawPayload: MessageRawPayload | null;
  /** 被引用/回复的目标消息 ID */
  replyTargetId: string | null;
  /** 是否为机器人/自己发送的消息 */
  isFromSelf: boolean;
  /** 是否已被撤回 (false: 未撤回, true: 已撤回) */
  isRecalled: boolean;
  /** 消息创建/接收时间戳 (毫秒) */
  createdAt: number;
}

/**
 * 保存消息输入参数
 */
export interface SaveMessageInput {
  /** 聊天会话唯一 ID */
  sessionId: string;
  /** 客户端原生消息 ID (msgID) */
  messageId?: string | null;
  /** 发送方名称/昵称 */
  sender: string;
  /** 发送方员工 UID 或用户 ID */
  senderId?: string | null;
  /** 消息文本内容 */
  content: string;
  /** 消息类型，默认 'text' */
  messageType?: MessageType;
  /** 原始多模态载荷（支持对象或 JSON 字符串） */
  rawPayload?: MessageRawPayload | string | null;
  /** 被引用/回复的目标消息 ID */
  replyTargetId?: string | null;
  /** 是否为自己发送的消息，默认 false */
  isFromSelf?: boolean;
  /** 是否已被撤回，默认 false */
  isRecalled?: boolean;
  /** 消息创建时间戳 (毫秒)，默认 Date.now() */
  createdAt?: number;
}

/**
 * 查询会话历史选项
 */
export interface GetSessionHistoryOptions {
  /** 最大返回条数 */
  limit?: number;
  /** 是否包含已撤回消息，默认 false (自动过滤已撤回) */
  includeRecalled?: boolean;
  /** 查询指定消息 ID 之前的历史 (用于向上翻页) */
  beforeId?: number;
  /** 查询指定时间戳之前的历史 */
  beforeTimestamp?: number;
  /** 查询指定消息 ID 之后的历史 (用于向下翻页) */
  afterId?: number;
  /** 查询指定时间戳之后的历史 */
  afterTimestamp?: number;
  /** 返回排序方式，默认 'asc' (按时序正序排列) */
  order?: 'asc' | 'desc';
}

/**
 * 多维度消息查询过滤选项
 */
export interface QueryMessagesOptions {
  /** 会话 ID 过滤 */
  sessionId?: string;
  /** 发送人过滤 */
  sender?: string;
  /** 发送人 ID 过滤 */
  senderId?: string;
  /** 消息类型过滤 */
  messageType?: MessageType;
  /** 关键词文本模糊匹配 */
  keyword?: string;
  /** 是否仅查询自己发送的消息 */
  isFromSelf?: boolean;
  /** 是否包含已撤回消息，默认 false */
  includeRecalled?: boolean;
  /** 起始时间戳 (毫秒) */
  startTime?: number;
  /** 结束时间戳 (毫秒) */
  endTime?: number;
  /** 最大返回条数，默认 50 */
  limit?: number;
  /** 分页偏移量，默认 0 */
  offset?: number;
  /** 排序规则，默认 'desc' (最新的在前) */
  order?: 'asc' | 'desc';
}

/**
 * 多模态本地转存配置项
 */
export interface MediaStorageOptions {
  /** 媒体文件基础存储根目录，默认 'data/media' */
  baseDir?: string;
  /** 图片保存子目录，默认 'images' */
  imagesSubDir?: string;
  /** 文件保存子目录，默认 'files' */
  filesSubDir?: string;
  /** 最大允许转存的文件大小 (字节)，默认 100MB */
  maxFileSize?: number;
}

/**
 * 多模态转存文件元数据结果
 */
export interface MediaFileInfo {
  /** 原始文件名 */
  originalName: string;
  /** 保存的文件名 (带唯一哈希/时间戳) */
  fileName: string;
  /** 相对存储目录路径 (如 `images/2026-08/abc.png`)，用于数据库持久化 */
  relativePath: string;
  /** 本地磁盘绝对完整路径 */
  absolutePath: string;
  /** 文件大小 (字节) */
  size: number;
  /** 文件扩展名 (含点，如 `.png`) */
  extension: string;
  /** 文件 SHA-256 哈希值 */
  sha256: string;
  /** MIME 类型（若可识别） */
  mimeType?: string;
  /** 创建/转存时间戳 (毫秒) */
  createdAt: number;
}

/**
 * 统一 Store 初始化配置项
 */
export interface StoreOptions extends DatabaseOptions {
  /** 媒体转存配置 */
  media?: MediaStorageOptions;
}
