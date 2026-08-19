import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Store, StoreError } from '../../src/store/index.js';
import type { StoreConfig } from '../../src/config/schema.js';

const TEST_DIR = join(process.cwd(), 'tmp', 'test-store');

const createConfig = (overrides: Partial<StoreConfig> = {}): StoreConfig => ({
  dbPath: join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`),
  storeMessageContent: true,
  ...overrides,
});

describe('Store', () => {
  let store: Store;
  let config: StoreConfig;

  beforeEach(() => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    config = createConfig();
    store = new Store(config);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    // 清理测试 DB 文件
    try {
      rmSync(config.dbPath, { force: true });
      rmSync(`${config.dbPath}-wal`, { force: true });
      rmSync(`${config.dbPath}-shm`, { force: true });
    } catch {
      /* 忽略 */
    }
  });

  describe('初始化', () => {
    it('首次运行自动创建数据库和表', () => {
      expect(existsSync(config.dbPath)).toBe(true);
    });

    it('自动创建数据库目录', () => {
      const nestedConfig = createConfig({
        dbPath: join(TEST_DIR, 'nested', 'deep', `auto-${Date.now()}.db`),
      });
      const nestedStore = new Store(nestedConfig);
      expect(existsSync(nestedConfig.dbPath)).toBe(true);
      nestedStore.close();
    });

    it('无效路径抛出 StoreError', () => {
      expect(() => new Store(createConfig({ dbPath: '' }))).toThrow(StoreError);
    });
  });

  describe('isProcessed / markProcessed', () => {
    it('未处理的指纹返回 false', () => {
      expect(store.isProcessed('abc123')).toBe(false);
    });

    it('标记后返回 true', () => {
      store.markProcessed('fp-001');
      expect(store.isProcessed('fp-001')).toBe(true);
    });

    it('重复标记不抛出错误', () => {
      store.markProcessed('fp-dup');
      expect(() => store.markProcessed('fp-dup')).not.toThrow();
      expect(store.isProcessed('fp-dup')).toBe(true);
    });

    it('不同指纹互不影响', () => {
      store.markProcessed('fp-a');
      expect(store.isProcessed('fp-a')).toBe(true);
      expect(store.isProcessed('fp-b')).toBe(false);
    });
  });

  describe('saveMessage / getSessionHistory', () => {
    it('保存并检索会话消息', () => {
      store.saveMessage('ses-1', {
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      });

      const history = store.getSessionHistory('ses-1', 10);
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        sender: 'Alice',
        content: '你好',
        isFromSelf: false,
      });
    });

    it('按时间正序返回（最旧在前）', () => {
      store.saveMessage('ses-1', { sender: 'A', content: '第一条', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'B', content: '第二条', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'C', content: '第三条', isFromSelf: false });

      const history = store.getSessionHistory('ses-1', 10);
      expect(history).toHaveLength(3);
      expect(history[0]?.sender).toBe('A');
      expect(history[1]?.sender).toBe('B');
      expect(history[2]?.sender).toBe('C');
    });

    it('限制返回数量（取最新的 n 条）', () => {
      store.saveMessage('ses-1', { sender: 'A', content: '1', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'B', content: '2', isFromSelf: false });
      store.saveMessage('ses-1', { sender: 'C', content: '3', isFromSelf: false });

      const history = store.getSessionHistory('ses-1', 2);
      expect(history).toHaveLength(2);
      // 取最新2条 (B, C)，正序排列
      expect(history[0]?.sender).toBe('B');
      expect(history[1]?.sender).toBe('C');
    });

    it('空会话返回空数组', () => {
      const history = store.getSessionHistory('not-exist', 10);
      expect(history).toEqual([]);
    });

    it('n<=0 时返回空数组（边界）', () => {
      store.saveMessage('ses-boundary', { sender: 'A', content: '消息', isFromSelf: false });
      expect(store.getSessionHistory('ses-boundary', 0)).toEqual([]);
      expect(store.getSessionHistory('ses-boundary', -1)).toEqual([]);
    });

    it('自动创建会话记录', () => {
      store.saveMessage(
        'ses-new',
        {
          sender: 'Bot',
          content: '回复',
          isFromSelf: true,
        },
        '测试会话'
      );

      const history = store.getSessionHistory('ses-new', 1);
      expect(history).toHaveLength(1);
      expect(history[0]?.isFromSelf).toBe(true);
    });

    it('不同会话互相隔离', () => {
      store.saveMessage('ses-a', { sender: 'A', content: 'msg-a', isFromSelf: false });
      store.saveMessage('ses-b', { sender: 'B', content: 'msg-b', isFromSelf: false });

      const historyA = store.getSessionHistory('ses-a', 10);
      const historyB = store.getSessionHistory('ses-b', 10);
      expect(historyA).toHaveLength(1);
      expect(historyB).toHaveLength(1);
      expect(historyA[0]?.sender).toBe('A');
      expect(historyB[0]?.sender).toBe('B');
    });

    it('getSessionHistory 不包含尚未保存的消息', () => {
      // 读取尚无任何消息的会话 → 空数组
      const before = store.getSessionHistory('ses-order', 10);
      expect(before).toEqual([]);

      // 写入一条消息
      store.saveMessage('ses-order', { sender: 'User', content: '消息1', isFromSelf: false });

      // 写入后再读 → 恰好 1 条
      const after = store.getSessionHistory('ses-order', 10);
      expect(after).toHaveLength(1);
      expect(after[0]?.content).toBe('消息1');
    });

    it('bot 回复（isFromSelf: true）保存后出现在历史中', () => {
      // 保存用户消息
      store.saveMessage('ses-bot', { sender: '张三', content: '你好', isFromSelf: false });
      // 保存 bot 回复
      store.saveMessage('ses-bot', { sender: '自己', content: '您好，有什么可以帮您？', isFromSelf: true });

      const history = store.getSessionHistory('ses-bot', 10);
      expect(history).toHaveLength(2);

      // 第一条：用户消息
      expect(history[0]?.isFromSelf).toBe(false);
      expect(history[0]?.sender).toBe('张三');
      expect(history[0]?.content).toBe('你好');

      // 第二条：bot 回复
      expect(history[1]?.isFromSelf).toBe(true);
      expect(history[1]?.sender).toBe('自己');
      expect(history[1]?.content).toBe('您好，有什么可以帮您？');
    });
  });

  describe('logEvent / getEvents', () => {
    it('记录并查询事件', () => {
      store.logEvent('message_sent', { sessionId: 'ses-1', text: 'hello' });

      const events = store.getEvents('message_sent');
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe('message_sent');
      expect(events[0]?.data).toBe(JSON.stringify({ sessionId: 'ses-1', text: 'hello' }));
    });

    it('无附加数据时 data 为 null', () => {
      store.logEvent('heartbeat');

      const events = store.getEvents('heartbeat');
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toBeNull();
    });

    it('按类型过滤事件', () => {
      store.logEvent('type_a', { x: 1 });
      store.logEvent('type_b', { y: 2 });
      store.logEvent('type_a', { x: 3 });

      const eventsA = store.getEvents('type_a');
      const eventsB = store.getEvents('type_b');
      expect(eventsA).toHaveLength(2);
      expect(eventsB).toHaveLength(1);
    });

    it('不传类型返回所有事件', () => {
      store.logEvent('a');
      store.logEvent('b');
      store.logEvent('c');

      const all = store.getEvents();
      expect(all).toHaveLength(3);
    });

    it('limit 参数限制结果数量', () => {
      for (let i = 0; i < 10; i++) {
        store.logEvent('batch', { i });
      }

      const limited = store.getEvents('batch', 3);
      expect(limited).toHaveLength(3);
    });

    it('事件按时间倒序返回（最新在前）', () => {
      store.logEvent('order', { seq: 1 });
      store.logEvent('order', { seq: 2 });
      store.logEvent('order', { seq: 3 });

      const events = store.getEvents('order');
      // 最新在前
      expect(JSON.parse(events[0]?.data ?? '{}')).toMatchObject({ seq: 3 });
      expect(JSON.parse(events[2]?.data ?? '{}')).toMatchObject({ seq: 1 });
    });

    it('循环引用数据可安全降级序列化', () => {
      const circular: { self?: unknown } = {};
      circular.self = circular;

      expect(() => store.logEvent('circular', circular)).not.toThrow();
      const events = store.getEvents('circular');
      expect(events).toHaveLength(1);
      expect(events[0]?.data).toBe(JSON.stringify({ _error: 'serialization_failed', _type: 'object' }));
    });

    it('数据库异常时 logEvent 不抛异常（非致命）', () => {
      store.close();
      expect(() => store.logEvent('after_close', { reason: 'db_closed' })).not.toThrow();
    });
  });

  describe('安全验收 - storeMessageContent', () => {
    it('storeMessageContent=false 时消息内容不存储', () => {
      const secureConfig = createConfig({ storeMessageContent: false });
      const secureStore = new Store(secureConfig);

      secureStore.saveMessage('ses-secret', {
        sender: 'Alice',
        content: '这是敏感消息',
        isFromSelf: false,
      });

      const history = secureStore.getSessionHistory('ses-secret', 10);
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toBe('[已隐藏]');
      secureStore.close();
    });

    it('storeMessageContent=true 时正常存储消息内容', () => {
      store.saveMessage('ses-open', {
        sender: 'Bob',
        content: '普通消息',
        isFromSelf: false,
      });

      const history = store.getSessionHistory('ses-open', 10);
      expect(history[0]?.content).toBe('普通消息');
    });
  });

  describe('性能验收', () => {
    it('单次查询 < 50ms', () => {
      // 先插入一些数据
      for (let i = 0; i < 100; i++) {
        store.markProcessed(`perf-fp-${String(i)}`);
      }
      for (let i = 0; i < 100; i++) {
        store.saveMessage('perf-ses', {
          sender: `user-${String(i)}`,
          content: `消息内容 ${String(i)}`,
          isFromSelf: i % 2 === 0,
        });
      }

      // 测试查询性能
      const start1 = performance.now();
      store.isProcessed('perf-fp-50');
      const duration1 = performance.now() - start1;
      expect(duration1).toBeLessThan(50);

      const start2 = performance.now();
      store.getSessionHistory('perf-ses', 20);
      const duration2 = performance.now() - start2;
      expect(duration2).toBeLessThan(50);

      const start3 = performance.now();
      store.getEvents(undefined, 50);
      const duration3 = performance.now() - start3;
      expect(duration3).toBeLessThan(50);
    });
  });


  describe('草稿管理', () => {
    const createDraft = () => ({
      sessionId: 'ses-draft-1',
      sessionName: '测试会话',
      originalMessage: '你好，有问题想问',
      originalSender: '张三',
      draftContent: '您好，请问有什么可以帮助您的？',
    });

    it('保存草稿并返回 ID', () => {
      const draftId = store.saveDraft(createDraft());
      expect(draftId).toBeGreaterThan(0);
    });

    it('获取待确认草稿列表', () => {
      store.saveDraft(createDraft());
      store.saveDraft({ ...createDraft(), sessionId: 'ses-draft-2', sessionName: '测试会话2' });

      const drafts = store.getPendingDrafts();
      expect(drafts).toHaveLength(2);
      expect(drafts[0]?.status).toBe('pending');
      expect(drafts[0]?.sessionName).toBe('测试会话2');
    });

    it('根据 ID 获取草稿', () => {
      const draftId = store.saveDraft(createDraft());
      const draft = store.getDraftById(draftId);

      expect(draft).not.toBeNull();
      expect(draft?.sessionId).toBe('ses-draft-1');
      expect(draft?.sessionName).toBe('测试会话');
      expect(draft?.originalMessage).toBe('你好，有问题想问');
      expect(draft?.originalSender).toBe('张三');
      expect(draft?.draftContent).toBe('您好，请问有什么可以帮助您的？');
      expect(draft?.status).toBe('pending');
    });

    it('获取不存在的草稿返回 null', () => {
      expect(store.getDraftById(9999)).toBeNull();
    });

    it('更新草稿内容', () => {
      const draftId = store.saveDraft(createDraft());
      store.updateDraftContent(draftId, '修改后的回复');

      const draft = store.getDraftById(draftId);
      expect(draft?.draftContent).toBe('修改后的回复');
      expect(draft?.updatedAt).toBeGreaterThanOrEqual(draft?.createdAt ?? 0);
    });

    it('更新草稿状态', () => {
      const draftId = store.saveDraft(createDraft());
      store.updateDraftStatus(draftId, 'sent');

      const draft = store.getDraftById(draftId);
      expect(draft?.status).toBe('sent');
    });

    it('已发送的草稿不出现在待确认列表', () => {
      const id1 = store.saveDraft(createDraft());
      store.saveDraft({ ...createDraft(), sessionId: 'ses-draft-2' });

      store.updateDraftStatus(id1, 'sent');

      const pending = store.getPendingDrafts();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.sessionId).toBe('ses-draft-2');
    });

    it('删除草稿', () => {
      const draftId = store.saveDraft(createDraft());
      store.deleteDraft(draftId);

      expect(store.getDraftById(draftId)).toBeNull();
    });

    it('丢弃草稿更新状态', () => {
      const draftId = store.saveDraft(createDraft());
      store.updateDraftStatus(draftId, 'discarded');

      const draft = store.getDraftById(draftId);
      expect(draft?.status).toBe('discarded');

      const pending = store.getPendingDrafts();
      expect(pending).toHaveLength(0);
    });

    it('编辑后发送状态会从待处理队列移除（状态转换）', () => {
      const draftId = store.saveDraft(createDraft());
      store.updateDraftStatus(draftId, 'edited_sent');

      const draft = store.getDraftById(draftId);
      expect(draft?.status).toBe('edited_sent');
      expect(store.getPendingDrafts()).toEqual([]);
    });
  });
  describe('会话摘要', () => {
    it('getLatestSummary 无摘要返回 null', () => {
      expect(store.getLatestSummary('no-summary')).toBeNull();
    });

    it('saveSummary 保存并返回 ID', () => {
      store.saveMessage('ses-sum', { sender: 'A', content: '你好', isFromSelf: false });
      const id = store.saveSummary('ses-sum', '摘要内容', 1, 100);
      expect(id).toBeGreaterThan(0);
    });

    it('getLatestSummary 返回最新摘要', () => {
      store.saveMessage('ses-sum2', { sender: 'A', content: '消息1', isFromSelf: false });
      store.saveSummary('ses-sum2', '第一次摘要', 1, 50);
      store.saveSummary('ses-sum2', '第二次摘要', 2, 80);

      const latest = store.getLatestSummary('ses-sum2');
      expect(latest).not.toBeNull();
      expect(latest!.summaryText).toBe('第二次摘要');
      expect(latest!.coveredUpToId).toBe(2);
      expect(latest!.tokenCount).toBe(80);
    });

    it('getLatestSummary 不同会话隔离', () => {
      store.saveMessage('ses-iso-a', { sender: 'A', content: '消息A', isFromSelf: false });
      store.saveMessage('ses-iso-b', { sender: 'B', content: '消息B', isFromSelf: false });
      store.saveSummary('ses-iso-a', '摘要A', 1, 50);
      store.saveSummary('ses-iso-b', '摘要B', 2, 60);

      const summaryA = store.getLatestSummary('ses-iso-a');
      const summaryB = store.getLatestSummary('ses-iso-b');
      expect(summaryA!.summaryText).toBe('摘要A');
      expect(summaryB!.summaryText).toBe('摘要B');
    });

    it('getMessageCountSince sinceId=0 返回全部消息', () => {
      for (let i = 0; i < 5; i++) {
        store.saveMessage('ses-cnt', { sender: 'U', content: `消息${String(i)}`, isFromSelf: false });
      }
      const count = store.getMessageCountSince('ses-cnt', 0);
      expect(count).toBe(5);
    });

    it('getMessageCountSince 从指定 ID 开始计数', () => {
      for (let i = 0; i < 5; i++) {
        store.saveMessage('ses-cnt2', { sender: 'U', content: `消息${String(i)}`, isFromSelf: false });
      }
      // 取第3条消息后的 maxId
      const allHistory = store.getSessionHistory('ses-cnt2', 5);
      // getMaxMessageId 返回的是最大的，我们需要中间的
      // 先获取全部5条的 maxId，然后用 maxId - 2 来模拟中间位置
      const maxId = store.getMaxMessageId('ses-cnt2');
      const sinceId = maxId - 2;
      const count = store.getMessageCountSince('ses-cnt2', sinceId);
      expect(count).toBe(2);
    });

    it('getMessageCountSince 空会话返回 0', () => {
      expect(store.getMessageCountSince('no-exist', 0)).toBe(0);
    });

    it('getMaxMessageId 返回最大消息 ID', () => {
      store.saveMessage('ses-max', { sender: 'A', content: '1', isFromSelf: false });
      store.saveMessage('ses-max', { sender: 'B', content: '2', isFromSelf: false });
      store.saveMessage('ses-max', { sender: 'C', content: '3', isFromSelf: false });
      const maxId = store.getMaxMessageId('ses-max');
      expect(maxId).toBeGreaterThan(0);
    });

    it('getMaxMessageId 空会话返回 0', () => {
      expect(store.getMaxMessageId('no-msgs')).toBe(0);
    });

    it('saveSummary 字段完整性', () => {
      store.saveMessage('ses-fields', { sender: 'A', content: '你好', isFromSelf: false });
      const maxId = store.getMaxMessageId('ses-fields');
      store.saveSummary('ses-fields', '完整性测试摘要', maxId, 200);

      const summary = store.getLatestSummary('ses-fields');
      expect(summary).not.toBeNull();
      expect(summary!.sessionId).toBe('ses-fields');
      expect(summary!.summaryText).toBe('完整性测试摘要');
      expect(summary!.coveredUpToId).toBe(maxId);
      expect(summary!.tokenCount).toBe(200);
      expect(summary!.createdAt).toBeGreaterThan(0);
      expect(summary!.id).toBeGreaterThan(0);
    });

    it('storeMessageContent=false 时摘要仍可保存', () => {
      const secureConfig = createConfig({ storeMessageContent: false });
      const secureStore = new Store(secureConfig);

      secureStore.saveMessage('ses-secure', { sender: 'A', content: '敏感消息', isFromSelf: false });
      const maxId = secureStore.getMaxMessageId('ses-secure');
      secureStore.saveSummary('ses-secure', '安全摘要', maxId, 50);

      const summary = secureStore.getLatestSummary('ses-secure');
      expect(summary).not.toBeNull();
      expect(summary!.summaryText).toBe('安全摘要');
      secureStore.close();
    });

    it('会话不存在时 saveSummary 抛出 StoreError（外键约束）', () => {
      expect(() => store.saveSummary('no-session', '孤立摘要', 1, 10)).toThrow(StoreError);
    });
  });

  describe('会话分组查询', () => {
    // 辅助函数：创建测试草稿
    const createTestDraft = (sessionId: string, sessionName: string) => {
      return store.saveDraft({
        sessionId,
        sessionName,
        originalMessage: `来自 ${sessionName} 的消息`,
        originalSender: sessionName,
        draftContent: `回复 ${sessionName}`,
      });
    };

    describe('getPendingDraftsBySession', () => {
      it('按会话过滤待确认草稿', () => {
        createTestDraft('ses-1', '张三');
        createTestDraft('ses-1', '张三');
        createTestDraft('ses-2', '李四');

        const result = store.getPendingDraftsBySession('ses-1');
        expect(result).toHaveLength(2);
        expect(result.every(d => d.sessionId === 'ses-1')).toBe(true);
      });

      it('不返回已处理草稿', () => {
        const id1 = createTestDraft('ses-1', '张三');
        createTestDraft('ses-1', '张三');

        store.updateDraftStatus(id1, 'sent');

        const result = store.getPendingDraftsBySession('ses-1');
        expect(result).toHaveLength(1);
        expect(result[0]?.status).toBe('pending');
      });

      it('空会话返回空数组', () => {
        const result = store.getPendingDraftsBySession('non-existent');
        expect(result).toEqual([]);
      });
    });

    describe('getSessionDraftCounts', () => {
      it('返回各会话待处理草稿数', () => {
        createTestDraft('ses-1', '张三');
        createTestDraft('ses-1', '张三');
        createTestDraft('ses-2', '李四');

        const counts = store.getSessionDraftCounts();
        expect(counts).toHaveLength(2);

        const ses1 = counts.find(c => c.sessionId === 'ses-1');
        expect(ses1?.count).toBe(2);
        expect(ses1?.sessionName).toBe('张三');

        const ses2 = counts.find(c => c.sessionId === 'ses-2');
        expect(ses2?.count).toBe(1);
      });

      it('已处理草稿不计入', () => {
        const id1 = createTestDraft('ses-1', '张三');
        createTestDraft('ses-1', '张三');

        store.updateDraftStatus(id1, 'discarded');

        const counts = store.getSessionDraftCounts();
        expect(counts).toHaveLength(1);
        expect(counts[0]?.count).toBe(1);
      });

      it('无待处理草稿返回空数组', () => {
        const counts = store.getSessionDraftCounts();
        expect(counts).toEqual([]);
      });
    });

    describe('getEventsBySessionId', () => {
      it('按会话过滤事件', () => {
        store.logEvent('draft_sent', { sessionId: 'ses-1', draftId: 1 });
        store.logEvent('draft_sent', { sessionId: 'ses-2', draftId: 2 });
        store.logEvent('draft_sent', { sessionId: 'ses-1', draftId: 3 });

        const result = store.getEventsBySessionId('ses-1');
        expect(result).toHaveLength(2);
      });

      it('limit 限制结果数量', () => {
        for (let i = 0; i < 5; i++) {
          store.logEvent('draft_sent', { sessionId: 'ses-1', draftId: i });
        }

        const result = store.getEventsBySessionId('ses-1', 2);
        expect(result).toHaveLength(2);
      });
    });
  });

  describe('markMessageRecalled 撤回消息与历史过滤 (Issue #67)', () => {
    it('标记撤回后，getSessionHistory 应自动过滤已撤回消息', () => {
      store.saveMessage('ses-recall', { sender: 'Alice', content: '第一条正常消息', isFromSelf: false });
      store.saveMessage('ses-recall', { sender: 'Bob', content: '这是一条发错的消息', isFromSelf: false });
      store.saveMessage('ses-recall', { sender: 'Charlie', content: '第三条正常消息', isFromSelf: false });

      // 撤回 Bob 的发错消息
      const recalled = store.markMessageRecalled({
        sessionId: 'ses-recall',
        content: '这是一条发错的消息',
      });
      expect(recalled).toBe(true);

      // 获取会话历史，发错的消息不应再出现
      const history = store.getSessionHistory('ses-recall', 10);
      expect(history).toHaveLength(2);
      expect(history.map(m => m.content)).toEqual(['第一条正常消息', '第三条正常消息']);
    });

    it('通过 sender 撤回发送者的最后一条消息', () => {
      store.saveMessage('ses-recall-2', { sender: 'UserA', content: '旧消息', isFromSelf: false });
      store.saveMessage('ses-recall-2', { sender: 'UserA', content: '准备撤回的最新消息', isFromSelf: false });

      const recalled = store.markMessageRecalled({
        sessionId: 'ses-recall-2',
        sender: 'UserA',
      });
      expect(recalled).toBe(true);

      const history = store.getSessionHistory('ses-recall-2', 10);
      expect(history).toHaveLength(1);
      expect(history[0]?.content).toBe('旧消息');
    });
  });

  describe('close', () => {
    it('关闭后操作抛出错误', () => {
      store.close();
      expect(() => store.isProcessed('test')).toThrow();
    });
  });
});
