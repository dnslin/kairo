// 运行: pnpm tsx scripts/verify-policy.ts

import { PolicyEngine } from '../src/policy/index.js';
import type { PolicyConfig } from '../src/config/schema.js';
import type { SessionInfo } from '../src/dom/locator.js';

const config: PolicyConfig = {
  whitelist: [],
  blacklist: [],
  sessionTypes: ['private'],
  workingHours: '',
  throttle: { perSessionMinIntervalSeconds: 60, dailyMaxPerSession: 50 },
};

const privateSession: SessionInfo = {
  id: 'session-1',
  name: '张三',
  type: 'private',
  lastMessage: '你好',
  time: '10:00',
  unread: true,
  isSelected: true,
};

const groupSession: SessionInfo = {
  id: 'session-2',
  name: '工作群',
  type: 'group',
  lastMessage: '大家好',
  time: '10:05',
  unread: false,
  isSelected: false,
};

const engine = new PolicyEngine(config);

console.log('=== PolicyEngine 会话类型过滤验证 ===\n');
console.log('配置: sessionTypes =', config.sessionTypes);
console.log('');

const privateResult = engine.shouldProcess(privateSession);
console.log(`私聊会话 "${privateSession.name}":`);
console.log(`  - allowed: ${privateResult.allowed}`);
if (privateResult.reason) console.log(`  - reason: ${privateResult.reason}`);
console.log('');

const groupResult = engine.shouldProcess(groupSession);
console.log(`群聊会话 "${groupSession.name}":`);
console.log(`  - allowed: ${groupResult.allowed}`);
if (groupResult.reason) console.log(`  - reason: ${groupResult.reason}`);
console.log('');

const passed = privateResult.allowed === true && groupResult.allowed === false;
console.log('=== 验证结果 ===');
console.log(passed ? '✅ 通过' : '❌ 失败');
