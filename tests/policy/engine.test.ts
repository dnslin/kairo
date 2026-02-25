import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PolicyConfig } from '../../src/config/schema.js';
import type { SessionInfo } from '../../src/dom/locator.js';

const { loggerErrorMock, loggerInfoMock, loggerDebugMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    error: loggerErrorMock,
    info: loggerInfoMock,
    debug: loggerDebugMock,
    warn: loggerWarnMock,
  }),
}));

import { PolicyEngine } from '../../src/policy/index.js';

const createConfig = (overrides: Partial<PolicyConfig> = {}): PolicyConfig => ({
  whitelist: [],
  blacklist: [],
  sessionTypes: [],
  workingHours: '',
  throttle: { perSessionMinIntervalSeconds: 60, dailyMaxPerSession: 50 },
  ...overrides,
});

const createSession = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: 'session-1',
  name: 'Test User',
  type: 'private',
  lastMessage: '',
  time: '',
  unread: false,
  isSelected: true,
  ...overrides,
});

describe('PolicyEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空 sessionTypes 数组允许所有会话类型', () => {
    const config = createConfig({ sessionTypes: [] });
    const engine = new PolicyEngine(config);

    const privateSession = createSession({ type: 'private' });
    const groupSession = createSession({ type: 'group' });

    const privateDecision = engine.shouldProcess(privateSession);
    const groupDecision = engine.shouldProcess(groupSession);

    expect(privateDecision.allowed).toBe(true);
    expect(groupDecision.allowed).toBe(true);
  });

  it("sessionTypes 为 ['private'] 时只允许私聊", () => {
    const config = createConfig({ sessionTypes: ['private'] });
    const engine = new PolicyEngine(config);

    const privateSession = createSession({ type: 'private' });
    const groupSession = createSession({ type: 'group' });

    const privateDecision = engine.shouldProcess(privateSession);
    const groupDecision = engine.shouldProcess(groupSession);

    expect(privateDecision.allowed).toBe(true);
    expect(groupDecision.allowed).toBe(false);
  });

  it("sessionTypes 为 ['group'] 时只允许群聊", () => {
    const config = createConfig({ sessionTypes: ['group'] });
    const engine = new PolicyEngine(config);

    const privateSession = createSession({ type: 'private' });
    const groupSession = createSession({ type: 'group' });

    const privateDecision = engine.shouldProcess(privateSession);
    const groupDecision = engine.shouldProcess(groupSession);

    expect(privateDecision.allowed).toBe(false);
    expect(groupDecision.allowed).toBe(true);
  });

  it("sessionTypes 为 ['private', 'group'] 时允许所有类型", () => {
    const config = createConfig({ sessionTypes: ['private', 'group'] });
    const engine = new PolicyEngine(config);

    const privateSession = createSession({ type: 'private' });
    const groupSession = createSession({ type: 'group' });

    const privateDecision = engine.shouldProcess(privateSession);
    const groupDecision = engine.shouldProcess(groupSession);

    expect(privateDecision.allowed).toBe(true);
    expect(groupDecision.allowed).toBe(true);
  });

  it('session.type 不在 sessionTypes 中时返回拒绝原因', () => {
    const config = createConfig({ sessionTypes: ['private'] });
    const engine = new PolicyEngine(config);

    const groupSession = createSession({ type: 'group' });
    const decision = engine.shouldProcess(groupSession);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBeDefined();
    expect(decision.reason).toContain('group');
  });

  describe('白名单/黑名单过滤', () => {
    it('白名单优先级高于黑名单', () => {
      const config = createConfig({
        whitelist: ['VIP客户'],
        blacklist: ['VIP客户'],
      });
      const engine = new PolicyEngine(config);
      const session = createSession({ name: 'VIP客户' });
      const decision = engine.shouldProcess(session);
      expect(decision.allowed).toBe(true);
    });

    it('黑名单会话返回 blacklisted 原因', () => {
      const config = createConfig({
        blacklist: ['垃圾用户'],
      });
      const engine = new PolicyEngine(config);
      const session = createSession({ name: '垃圾用户' });
      const decision = engine.shouldProcess(session);
      expect(decision.allowed).toBe(false);
      expect(decision.reason).toBe('blacklisted');
    });

    it('不在白名单也不在黑名单时允许处理', () => {
      const config = createConfig({
        whitelist: ['VIP'],
        blacklist: ['垃圾'],
      });
      const engine = new PolicyEngine(config);
      const session = createSession({ name: '普通用户' });
      const decision = engine.shouldProcess(session);
      expect(decision.allowed).toBe(true);
    });
  });

  describe('通配符匹配', () => {
    it('精确匹配', () => {
      const config = createConfig({
        whitelist: ['测试用户'],
      });
      const engine = new PolicyEngine(config);
      const match = createSession({ name: '测试用户' });
      const noMatch = createSession({ name: '测试用户2' });
      expect(engine.shouldProcess(match).allowed).toBe(true);
      expect(engine.shouldProcess(noMatch).allowed).toBe(true);
    });

    it('前缀通配符 *测试', () => {
      const config = createConfig({
        blacklist: ['*测试'],
      });
      const engine = new PolicyEngine(config);
      const match1 = createSession({ name: '用户测试' });
      const match2 = createSession({ name: 'ABC测试' });
      const noMatch = createSession({ name: '测试用户' });
      expect(engine.shouldProcess(match1).allowed).toBe(false);
      expect(engine.shouldProcess(match2).allowed).toBe(false);
      expect(engine.shouldProcess(noMatch).allowed).toBe(true);
    });

    it('后缀通配符 测试*', () => {
      const config = createConfig({
        blacklist: ['测试*'],
      });
      const engine = new PolicyEngine(config);
      const match1 = createSession({ name: '测试用户' });
      const match2 = createSession({ name: '测试ABC' });
      const noMatch = createSession({ name: '用户测试' });
      expect(engine.shouldProcess(match1).allowed).toBe(false);
      expect(engine.shouldProcess(match2).allowed).toBe(false);
      expect(engine.shouldProcess(noMatch).allowed).toBe(true);
    });

    it('中间通配符 *测试*', () => {
      const config = createConfig({
        blacklist: ['*测试*'],
      });
      const engine = new PolicyEngine(config);
      const match1 = createSession({ name: '用户测试账号' });
      const match2 = createSession({ name: '测试' });
      const match3 = createSession({ name: 'ABC测试XYZ' });
      const noMatch = createSession({ name: '正常用户' });
      expect(engine.shouldProcess(match1).allowed).toBe(false);
      expect(engine.shouldProcess(match2).allowed).toBe(false);
      expect(engine.shouldProcess(match3).allowed).toBe(false);
      expect(engine.shouldProcess(noMatch).allowed).toBe(true);
    });

    it('多个通配符 *测*试*', () => {
      const config = createConfig({
        blacklist: ['*测*试*'],
      });
      const engine = new PolicyEngine(config);
      const match1 = createSession({ name: 'A测B试C' });
      const match2 = createSession({ name: '测试' }); // 也应该匹配：空+测+空+试+空
      const match3 = createSession({ name: '测试ABC' }); // 也匹配：空+测+空+试+ABC
      const noMatch = createSession({ name: '测ABC' }); // 不匹配：没有"试"
      expect(engine.shouldProcess(match1).allowed).toBe(false);
      expect(engine.shouldProcess(match2).allowed).toBe(false);
      expect(engine.shouldProcess(match3).allowed).toBe(false);
      expect(engine.shouldProcess(noMatch).allowed).toBe(true);
    });

    describe('工作时间控制', () => {
      it('空字符串表示不限制时间', () => {
        const config = createConfig({ workingHours: '' });
        const engine = new PolicyEngine(config);
        const session = createSession();
        expect(engine.shouldProcess(session).allowed).toBe(true);
      });

      it('无效格式忽略限制', () => {
        const config = createConfig({ workingHours: 'invalid' });
        const engine = new PolicyEngine(config);
        const session = createSession();
        expect(engine.shouldProcess(session).allowed).toBe(true);
      });

      it('工作时间内允许处理', () => {
        const now = new Date();
        const currentHour = now.getHours();
        const startHour = String(currentHour - 1).padStart(2, '0');
        const endHour = String(currentHour + 1).padStart(2, '0');
        const config = createConfig({
          workingHours: `${startHour}:00-${endHour}:00`,
        });
        const engine = new PolicyEngine(config);
        const session = createSession();
        expect(engine.shouldProcess(session).allowed).toBe(true);
      });

      it('工作时间外返回 outside_working_hours', () => {
        const now = new Date();
        const currentHour = now.getHours();
        const startHour = String((currentHour + 2) % 24).padStart(2, '0');
        const endHour = String((currentHour + 3) % 24).padStart(2, '0');
        const config = createConfig({
          workingHours: `${startHour}:00-${endHour}:00`,
        });
        const engine = new PolicyEngine(config);
        const session = createSession();
        const decision = engine.shouldProcess(session);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('outside_working_hours');
      });
    });

    describe('策略优先级', () => {
      it('白名单 > 黑名单 > 工作时间 > 会话类型', () => {
        const now = new Date();
        const currentHour = now.getHours();
        const futureHour = String((currentHour + 5) % 24).padStart(2, '0');
        const config = createConfig({
          whitelist: ['VIP'],
          blacklist: ['VIP'],
          workingHours: `${futureHour}:00-${futureHour}:59`,
          sessionTypes: ['group'],
        });
        const engine = new PolicyEngine(config);
        const session = createSession({ name: 'VIP', type: 'private' });
        expect(engine.shouldProcess(session).allowed).toBe(true);
      });

      it('黑名单阻止非白名单会话（即使在工作时间）', () => {
        const now = new Date();
        const currentHour = now.getHours();
        const config = createConfig({
          blacklist: ['垃圾*'], // 使用通配符匹配
          workingHours: `${String(currentHour - 1).padStart(2, '0')}:00-${String(currentHour + 1).padStart(2, '0')}:00`,
        });
        const engine = new PolicyEngine(config);
        const session = createSession({ name: '垃圾用户' });
        const decision = engine.shouldProcess(session);
        expect(decision.allowed).toBe(false);
        expect(decision.reason).toBe('blacklisted');
      });
    });
  });
});
