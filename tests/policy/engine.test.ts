import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PolicyConfig, SessionType } from '../../src/config/schema.js';
import type { SessionInfo } from '../../src/dom/locator.js';

const { loggerErrorMock, loggerInfoMock, loggerDebugMock } = vi.hoisted(() => ({
  loggerErrorMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerDebugMock: vi.fn(),
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    error: loggerErrorMock,
    info: loggerInfoMock,
    debug: loggerDebugMock,
  }),
}));

import { PolicyEngine, type ProcessDecision } from '../../src/policy/index.js';

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
});
