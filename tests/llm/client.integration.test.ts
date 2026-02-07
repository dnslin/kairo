import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { LlmClient } from '../../src/llm/client.js';
import { loadConfig } from '../../src/config/loader.js';
import type { MessageInfo } from '../../src/dom/locator.js';

const SKIP_INTEGRATION = !process.env['LLM_INTEGRATION'];

describe.skipIf(SKIP_INTEGRATION)('LlmClient Integration Tests', () => {
  let client: LlmClient;

  beforeAll(() => {
    const appConfig = loadConfig();
    client = new LlmClient(appConfig.llm, appConfig.validation);
  });

  afterAll(() => {});

  it('generateReply() 返回有效回复', async () => {
    const message: MessageInfo = {
      id: 'test-msg-1',
      sender: '测试用户',
      content: '你好，请简短回复',
      time: '10:00',
      isMe: false,
    };

    const start = Date.now();
    const reply = await client.generateReply(message, []);
    const duration = Date.now() - start;

    expect(reply).not.toBeNull();
    expect(typeof reply).toBe('string');
    expect(reply!.length).toBeGreaterThan(0);
    expect(duration).toBeLessThan(30000);

    console.log(`LLM 回复 (${duration}ms): ${reply}`);
  });

  it('generateReply() 携带历史消息', async () => {
    const history: MessageInfo[] = [
      { id: 'h1', sender: '用户', content: '我叫小明', time: '09:58', isMe: false },
      { id: 'h2', sender: '助手', content: '你好小明！', time: '09:59', isMe: true },
    ];

    const message: MessageInfo = {
      id: 'test-msg-2',
      sender: '用户',
      content: '我叫什么名字？',
      time: '10:00',
      isMe: false,
    };

    const reply = await client.generateReply(message, history);

    expect(reply).not.toBeNull();
    expect(reply!.toLowerCase()).toContain('小明');
  });
});
