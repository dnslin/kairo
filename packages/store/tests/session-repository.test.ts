import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import {
  closeDatabase,
  createDatabase,
  isDatabaseInstance,
  KKBotStore,
  OrgRepository,
  SessionRepository,
} from '../src/index.js';

describe('SessionRepository 会话状态持久化仓储测试 (TDD Red -> Green)', () => {
  let db: Database.Database;
  let sessionRepo: SessionRepository;
  let orgRepo: OrgRepository;
  let store: KKBotStore;

  beforeEach(() => {
    // 为每个测试用例分配完全隔离的内存数据库实例
    db = createDatabase({ path: ':memory:' });
    sessionRepo = new SessionRepository(db);
    orgRepo = new OrgRepository(db);
    store = new KKBotStore(db);
  });

  afterEach(() => {
    closeDatabase(db);
  });

  describe('1. sessions 表结构与索引约束验证', () => {
    it('应正确创建 sessions 表及其所有必需字段与数据类型', () => {
      const tableInfo = db.pragma('table_info(sessions)') as Array<{
        cid: number;
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const columnMap = new Map(tableInfo.map(col => [col.name, col]));

      // 验证主键与必填字段
      expect(columnMap.has('id')).toBe(true);
      expect(columnMap.get('id')?.pk).toBe(1);

      expect(columnMap.has('name')).toBe(true);
      expect(columnMap.has('type')).toBe(true);
      expect(columnMap.has('employee_id')).toBe(true);
      expect(columnMap.has('mode')).toBe(true);
      expect(columnMap.has('human_takeover_until')).toBe(true);
      expect(columnMap.has('last_message_at')).toBe(true);
      expect(columnMap.has('last_reply_at')).toBe(true);
      expect(columnMap.has('daily_reply_count')).toBe(true);
      expect(columnMap.has('daily_count_reset_date')).toBe(true);
      expect(columnMap.has('created_at')).toBe(true);
      expect(columnMap.has('updated_at')).toBe(true);
    });

    it('应创建 idx_sessions_employee 与 idx_sessions_last_msg 等索引', () => {
      const indexList = db.pragma('index_list(sessions)') as Array<{
        seq: number;
        name: string;
        unique: number;
        origin: string;
        partial: number;
      }>;

      const indexNames = indexList.map(idx => idx.name);
      expect(indexNames).toContain('idx_sessions_employee');
      expect(indexNames).toContain('idx_sessions_last_msg');
    });
  });

  describe('2. upsertSession 与 getSession: 基础元数据读写与部分更新', () => {
    it('应成功插入新会话并自动填充默认值与时间戳', () => {
      const sessionId = 'ses_001_uuid';
      const beforeTime = Date.now();

      sessionRepo.upsertSession({
        id: sessionId,
        name: '张三 (技术部)',
      });

      const afterTime = Date.now();
      const session = sessionRepo.getSession(sessionId);

      expect(session).not.toBeNull();
      expect(session?.id).toBe(sessionId);
      expect(session?.name).toBe('张三 (技术部)');
      expect(session?.type).toBe('private');
      expect(session?.mode).toBe('auto');
      expect(session?.employeeId).toBeNull();
      expect(session?.humanTakeoverUntil).toBe(0);
      expect(session?.lastMessageAt).toBe(0);
      expect(session?.lastReplyAt).toBe(0);
      expect(session?.dailyReplyCount).toBe(0);
      expect(session?.dailyCountResetDate).toBeNull();
      expect(session?.createdAt).toBeGreaterThanOrEqual(beforeTime);
      expect(session?.createdAt).toBeLessThanOrEqual(afterTime);
      expect(session?.updatedAt).toBeGreaterThanOrEqual(beforeTime);
      expect(session?.updatedAt).toBeLessThanOrEqual(afterTime);
    });

    it('当会话已存在时，upsertSession 应更新指定字段且不覆盖未提供的旧字段', () => {
      const sessionId = 'ses_002_uuid';
      const initialTime = 1700000000000;

      // 1. 初始化完整会话
      sessionRepo.upsertSession({
        id: sessionId,
        name: '项目群聊',
        type: 'group',
        mode: 'auto',
        humanTakeoverUntil: 1700001000000,
        lastMessageAt: 1700000500000,
        lastReplyAt: 1700000600000,
        dailyReplyCount: 5,
        dailyCountResetDate: '2026-08-19',
        createdAt: initialTime,
        updatedAt: initialTime,
      });

      // 2. 部分更新：仅修改 mode 和 name
      const updateTime = 1700002000000;
      sessionRepo.upsertSession({
        id: sessionId,
        name: '项目核心群 (已改名)',
        mode: 'draft',
        updatedAt: updateTime,
      });

      const updated = sessionRepo.getSession(sessionId);
      expect(updated).not.toBeNull();
      expect(updated?.name).toBe('项目核心群 (已改名)');
      expect(updated?.mode).toBe('draft');
      // 保留原有未更新字段
      expect(updated?.type).toBe('group');
      expect(updated?.humanTakeoverUntil).toBe(1700001000000);
      expect(updated?.lastMessageAt).toBe(1700000500000);
      expect(updated?.lastReplyAt).toBe(1700000600000);
      expect(updated?.dailyReplyCount).toBe(5);
      expect(updated?.dailyCountResetDate).toBe('2026-08-19');
      expect(updated?.createdAt).toBe(initialTime);
      expect(updated?.updatedAt).toBe(updateTime);
    });

    it('查询不存在的会话 ID 时应返回 null', () => {
      const result = sessionRepo.getSession('non_existent_session_id');
      expect(result).toBeNull();
    });
  });

  describe('3. 关联 org_employees 员工档案与外键级联约束', () => {
    it('应成功关联会话与员工 UID', () => {
      // 1. 先在组织架构表中插入员工
      orgRepo.syncOrganization({
        departments: [{ id: 'dept_tech', name: '技术研发部' }],
        employees: [
          {
            id: 'emp_1001',
            loginName: 'zhangsan',
            name: '张三',
            departments: [{ deptId: 'dept_tech', isPrimary: true }],
          },
        ],
      });

      // 2. 创建关联该员工的会话
      sessionRepo.upsertSession({
        id: 'ses_emp_1001',
        name: '张三',
        employeeId: 'emp_1001',
      });

      const session = sessionRepo.getSession('ses_emp_1001');
      expect(session?.employeeId).toBe('emp_1001');
    });

    it('当关联员工被删除时，外键 ON DELETE SET NULL 应自动将会话 employee_id 置空', () => {
      // 1. 插入部门与员工
      orgRepo.syncOrganization({
        departments: [{ id: 'dept_dev', name: '开发部' }],
        employees: [
          {
            id: 'emp_temp',
            loginName: 'temp_user',
            name: '临时员工',
            departments: [{ deptId: 'dept_dev', isPrimary: true }],
          },
        ],
      });

      sessionRepo.upsertSession({
        id: 'ses_temp',
        name: '临时员工',
        employeeId: 'emp_temp',
      });

      expect(sessionRepo.getSession('ses_temp')?.employeeId).toBe('emp_temp');

      // 2. 通过同步清除该员工（全量同步清空）
      orgRepo.syncOrganization({
        departments: [{ id: 'dept_dev', name: '开发部' }],
        employees: [],
      });

      // 3. 验证会话依然存在，但 employeeId 被设置为 null
      const sessionAfterDelete = sessionRepo.getSession('ses_temp');
      expect(sessionAfterDelete).not.toBeNull();
      expect(sessionAfterDelete?.employeeId).toBeNull();
    });
  });

  describe('4. setTakeoverUntil 与 isTakeoverActive: 人工退避状态机', () => {
    it('setTakeoverUntil 应正确设置退避截止时间戳并刷新 updatedAt', () => {
      const sessionId = 'ses_takeover_test';
      const initialTime = 1000000;
      sessionRepo.upsertSession({
        id: sessionId,
        createdAt: initialTime,
        updatedAt: initialTime,
      });

      const takeoverTimestamp = 2000000;
      sessionRepo.setTakeoverUntil(sessionId, takeoverTimestamp);

      const session = sessionRepo.getSession(sessionId);
      expect(session?.humanTakeoverUntil).toBe(takeoverTimestamp);
      expect(session?.updatedAt).toBeGreaterThan(initialTime);
    });

    it('isTakeoverActive: 截止时间大于当前时间应判定为活跃 (true)，过期或为 0 应判定为不活跃 (false)', () => {
      const sessionId = 'ses_active_test';
      const now = 1700000000000;

      sessionRepo.upsertSession({
        id: sessionId,
        humanTakeoverUntil: now + 15 * 60 * 1000, // 15 分钟后过期
      });

      // 1. 在截止时间之前（退避生效中）
      expect(sessionRepo.isTakeoverActive(sessionId, now)).toBe(true);
      expect(sessionRepo.isTakeoverActive(sessionId, now + 10 * 60 * 1000)).toBe(true);

      // 2. 正好到达截止时间（退避结束）
      expect(sessionRepo.isTakeoverActive(sessionId, now + 15 * 60 * 1000)).toBe(false);

      // 3. 超过截止时间（退避已结束）
      expect(sessionRepo.isTakeoverActive(sessionId, now + 20 * 60 * 1000)).toBe(false);

      // 4. 重置为 0 后立即失效
      sessionRepo.setTakeoverUntil(sessionId, 0);
      expect(sessionRepo.isTakeoverActive(sessionId, now)).toBe(false);
    });

    it('对不存在的会话判定 isTakeoverActive 应安全返回 false', () => {
      expect(sessionRepo.isTakeoverActive('non_existent_id')).toBe(false);
    });
  });

  describe('5. touchMessageTime 与 touchReplyTime: 时间戳更新', () => {
    it('touchMessageTime 应更新 lastMessageAt 并刷新 updatedAt', () => {
      const sessionId = 'ses_touch_msg';
      const t0 = 1000000;
      sessionRepo.upsertSession({
        id: sessionId,
        createdAt: t0,
        updatedAt: t0,
        lastMessageAt: 0,
      });

      const msgTime = 1000500;
      sessionRepo.touchMessageTime(sessionId, msgTime);

      const session = sessionRepo.getSession(sessionId);
      expect(session?.lastMessageAt).toBe(msgTime);
      expect(session?.updatedAt).toBe(msgTime);
      expect(session?.lastReplyAt).toBe(0); // 保证其他字段未被污染
    });

    it('touchReplyTime 应更新 lastReplyAt 并刷新 updatedAt', () => {
      const sessionId = 'ses_touch_reply';
      const t0 = 1000000;
      sessionRepo.upsertSession({
        id: sessionId,
        createdAt: t0,
        updatedAt: t0,
        lastReplyAt: 0,
      });

      const replyTime = 1000800;
      sessionRepo.touchReplyTime(sessionId, replyTime);

      const session = sessionRepo.getSession(sessionId);
      expect(session?.lastReplyAt).toBe(replyTime);
      expect(session?.updatedAt).toBe(replyTime);
      expect(session?.lastMessageAt).toBe(0);
    });

    it('若不传 now 参数，touchMessageTime 和 touchReplyTime 应默认使用 Date.now()', () => {
      const sessionId = 'ses_touch_default';
      sessionRepo.upsertSession({ id: sessionId });

      const before = Date.now();
      sessionRepo.touchMessageTime(sessionId);
      const after = Date.now();

      const session1 = sessionRepo.getSession(sessionId);
      expect(session1?.lastMessageAt).toBeGreaterThanOrEqual(before);
      expect(session1?.lastMessageAt).toBeLessThanOrEqual(after);

      const beforeReply = Date.now();
      sessionRepo.touchReplyTime(sessionId);
      const afterReply = Date.now();

      const session2 = sessionRepo.getSession(sessionId);
      expect(session2?.lastReplyAt).toBeGreaterThanOrEqual(beforeReply);
      expect(session2?.lastReplyAt).toBeLessThanOrEqual(afterReply);
    });
  });

  describe('6. isNewTurn: 2 小时闲置轮次切断判定', () => {
    it('当会话不存在或从未有收发消息时，应判定为新轮次 (true)', () => {
      expect(sessionRepo.isNewTurn('unknown_session')).toBe(true);

      const emptySessionId = 'ses_never_spoken';
      sessionRepo.upsertSession({ id: emptySessionId });
      expect(sessionRepo.isNewTurn(emptySessionId)).toBe(true);
    });

    it('当最后活跃时间（消息或回复）距离当前时间超过 2 小时，应判定为新轮次 (true)', () => {
      const sessionId = 'ses_turn_timeout';
      const now = 1700000000000;
      const twoHoursMs = 2 * 60 * 60 * 1000; // 7,200,000 ms

      // 最后一条消息在 2 小时零 1 秒前
      sessionRepo.upsertSession({
        id: sessionId,
        lastMessageAt: now - twoHoursMs - 1000,
        lastReplyAt: 0,
      });

      expect(sessionRepo.isNewTurn(sessionId, 2, now)).toBe(true);

      // 如果最后一次回复在 1 小时前（即使最后消息在 3 小时前），应算在同一轮次中 (false)
      sessionRepo.upsertSession({
        id: sessionId,
        lastMessageAt: now - 3 * 3600 * 1000,
        lastReplyAt: now - 1 * 3600 * 1000,
      });
      expect(sessionRepo.isNewTurn(sessionId, 2, now)).toBe(false);
    });

    it('当最后活跃时间在 2 小时以内时，应判定为同一轮次延续 (false)', () => {
      const sessionId = 'ses_active_turn';
      const now = 1700000000000;

      // 最后一条消息在 30 分钟前
      sessionRepo.upsertSession({
        id: sessionId,
        lastMessageAt: now - 30 * 60 * 1000,
        lastReplyAt: 0,
      });

      expect(sessionRepo.isNewTurn(sessionId, 2, now)).toBe(false);

      // 临界值测试：恰好 1 小时 59 分 59 秒前
      const almostTwoHours = 2 * 3600 * 1000 - 1000;
      sessionRepo.upsertSession({
        id: sessionId,
        lastMessageAt: now - almostTwoHours,
      });
      expect(sessionRepo.isNewTurn(sessionId, 2, now)).toBe(false);
    });

    it('支持自定义 timeoutHours 超时时间', () => {
      const sessionId = 'ses_custom_timeout';
      const now = 1700000000000;

      // 45 分钟前有消息
      sessionRepo.upsertSession({
        id: sessionId,
        lastMessageAt: now - 45 * 60 * 1000,
      });

      // 自定义 0.5 小时超时 (30 分钟) -> 超时 (true)
      expect(sessionRepo.isNewTurn(sessionId, 0.5, now)).toBe(true);

      // 自定义 1 小时超时 (60 分钟) -> 未超时 (false)
      expect(sessionRepo.isNewTurn(sessionId, 1, now)).toBe(false);
    });

    it('当系统时间异常或未来时间戳时，应安全判定为未超时 (false)', () => {
      const sessionId = 'ses_future_time';
      const now = 1700000000000;

      sessionRepo.upsertSession({
        id: sessionId,
        lastMessageAt: now + 60000, // 未来的时间戳
      });

      expect(sessionRepo.isNewTurn(sessionId, 2, now)).toBe(false);
    });
  });

  describe('7. KKBotStore 统一门面与 store.sessions 调用', () => {
    it('通过 KKBotStore 门面可以正常访问 store.sessions 与 store.org', () => {
      expect(store.sessions).toBeInstanceOf(SessionRepository);
      expect(store.org).toBeInstanceOf(OrgRepository);

      // 测试 store.sessions 链路
      store.sessions.upsertSession({
        id: 'ses_facade_001',
        name: '门面测试会话',
        mode: 'draft',
      });

      const session = store.sessions.getSession('ses_facade_001');
      expect(session?.name).toBe('门面测试会话');
      expect(session?.mode).toBe('draft');
    });

    it('isDatabaseInstance 类型守卫应正确识别 Database 实例并防御非数据库对象', () => {
      expect(isDatabaseInstance(db)).toBe(true);
      expect(isDatabaseInstance(null)).toBe(false);
      expect(isDatabaseInstance(undefined)).toBe(false);
      expect(isDatabaseInstance({})).toBe(false);
      expect(isDatabaseInstance({ path: ':memory:' })).toBe(false);
    });

    it('多次使用相同字段组合更新会话时应命中 PreparedStatement 缓存并正确生效', () => {
      const sid = 'ses_cache_hit_test';
      sessionRepo.upsertSession({ id: sid, name: '初始名称', mode: 'auto' });

      // 多次重复相同字段形状的更新
      for (let i = 1; i <= 5; i++) {
        sessionRepo.upsertSession({ id: sid, name: `名称第${i}次`, mode: 'draft' });
        const cur = sessionRepo.getSession(sid);
        expect(cur?.name).toBe(`名称第${i}次`);
        expect(cur?.mode).toBe('draft');
      }
    });
  });
});
