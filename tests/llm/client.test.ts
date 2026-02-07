import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LlmConfig, ValidationConfig } from '../../src/config/schema.js';
import type { MessageInfo } from '../../src/dom/locator.js';

const {
  mockCreate,
  mockOpenAIConstructor,
  loggerDebugMock,
  loggerInfoMock,
  loggerWarnMock,
  loggerErrorMock,
} = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockOpenAIConstructor: vi.fn(),
  loggerDebugMock: vi.fn(),
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
  loggerErrorMock: vi.fn(),
}));

vi.mock('openai', () => {
  return {
    default: mockOpenAIConstructor,
  };
});

mockOpenAIConstructor.mockImplementation(() => ({
  chat: {
    completions: {
      create: mockCreate,
    },
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  createChildLogger: () => ({
    debug: loggerDebugMock,
    info: loggerInfoMock,
    warn: loggerWarnMock,
    error: loggerErrorMock,
  }),
}));

import { LlmClient } from '../../src/llm/client.js';

const createLlmConfig = (overrides: Partial<LlmConfig> = {}): LlmConfig => ({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test-secret-key-12345',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  timeout: 30000,
  maxTokens: 1000,
  contextMessages: 5,
  systemPrompt: '你是一个友好的助手。',
  ...overrides,
});

const createValidationConfig = (overrides: Partial<ValidationConfig> = {}): ValidationConfig => ({
  sensitiveWords: ['敏感词', '违禁'],
  maxReplyLength: 500,
  ...overrides,
});

const createMessage = (overrides: Partial<MessageInfo> = {}): MessageInfo => ({
  id: 'msg-1',
  sender: 'Alice',
  content: '你好',
  time: '10:00',
  isMe: false,
  ...overrides,
});

describe('LlmClient', () => {
  let config: LlmConfig;
  let validation: ValidationConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOpenAIConstructor.mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    }));
    config = createLlmConfig();
    validation = createValidationConfig();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('构造函数', () => {
    it('使用配置初始化 OpenAI 客户端', () => {
      new LlmClient(config, validation);

      expect(mockOpenAIConstructor).toHaveBeenCalledWith({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        timeout: config.timeout,
        maxRetries: 2,
      });
    });

    it('支持自定义 baseUrl', () => {
      const customConfig = createLlmConfig({ baseUrl: 'http://localhost:11434/v1' });
      new LlmClient(customConfig, validation);

      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: 'http://localhost:11434/v1',
        })
      );
    });
  });

  describe('buildMessages', () => {
    it('正确构建消息数组：system + history + current', () => {
      const client = new LlmClient(config, validation);
      const current = createMessage({ content: '今天天气怎么样？' });
      const history = [
        createMessage({ content: '你好', isMe: false }),
        createMessage({ content: '你好！有什么可以帮你的？', isMe: true }),
      ];

      // 通过反射访问私有方法进行测试
      const messages = (
        client as unknown as { buildMessages: (c: MessageInfo, h: MessageInfo[]) => unknown[] }
      ).buildMessages(current, history);

      expect(messages).toHaveLength(4); // system + 2 history + 1 current
      expect(messages[0]).toEqual({ role: 'system', content: config.systemPrompt });
      expect(messages[1]).toEqual({ role: 'user', content: '你好' });
      expect(messages[2]).toEqual({ role: 'assistant', content: '你好！有什么可以帮你的？' });
      expect(messages[3]).toEqual({ role: 'user', content: '今天天气怎么样？' });
    });

    it('限制历史消息数量为 contextMessages', () => {
      const limitedConfig = createLlmConfig({ contextMessages: 2 });
      const client = new LlmClient(limitedConfig, validation);
      const current = createMessage({ content: '问题' });
      const history = [
        createMessage({ content: '消息1', isMe: false }),
        createMessage({ content: '消息2', isMe: true }),
        createMessage({ content: '消息3', isMe: false }),
        createMessage({ content: '消息4', isMe: true }),
      ];

      const messages = (
        client as unknown as { buildMessages: (c: MessageInfo, h: MessageInfo[]) => unknown[] }
      ).buildMessages(current, history);

      // system + 2 history (限制) + 1 current = 4
      expect(messages).toHaveLength(4);
      // 应该是最后 2 条历史
      expect(messages[1]).toEqual({ role: 'user', content: '消息3' });
      expect(messages[2]).toEqual({ role: 'assistant', content: '消息4' });
    });

    it('contextMessages=0 时不携带历史', () => {
      const noHistoryConfig = createLlmConfig({ contextMessages: 0 });
      const client = new LlmClient(noHistoryConfig, validation);
      const current = createMessage({ content: '问题' });
      const history = [
        createMessage({ content: '历史1', isMe: false }),
        createMessage({ content: '历史2', isMe: true }),
      ];

      const messages = (
        client as unknown as { buildMessages: (c: MessageInfo, h: MessageInfo[]) => unknown[] }
      ).buildMessages(current, history);

      expect(messages).toHaveLength(2); // system + current only
      expect(messages[0]).toEqual({ role: 'system', content: noHistoryConfig.systemPrompt });
      expect(messages[1]).toEqual({ role: 'user', content: '问题' });
    });

    it('空历史时只返回 system + current', () => {
      const client = new LlmClient(config, validation);
      const current = createMessage({ content: '你好' });

      const messages = (
        client as unknown as { buildMessages: (c: MessageInfo, h: MessageInfo[]) => unknown[] }
      ).buildMessages(current, []);

      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual({ role: 'system', content: config.systemPrompt });
      expect(messages[1]).toEqual({ role: 'user', content: '你好' });
    });
  });

  describe('containsSensitiveWords', () => {
    it('检测到敏感词返回 true', () => {
      const client = new LlmClient(config, validation);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => boolean }
      ).containsSensitiveWords.bind(client);

      expect(checkFn('这里有敏感词内容')).toBe(true);
      expect(checkFn('违禁内容在这里')).toBe(true);
    });

    it('无敏感词返回 false', () => {
      const client = new LlmClient(config, validation);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => boolean }
      ).containsSensitiveWords.bind(client);

      expect(checkFn('正常的回复内容')).toBe(false);
      expect(checkFn('你好，今天天气不错')).toBe(false);
    });

    it('空敏感词列表时始终返回 false', () => {
      const noSensitiveConfig = createValidationConfig({ sensitiveWords: [] });
      const client = new LlmClient(config, noSensitiveConfig);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => boolean }
      ).containsSensitiveWords.bind(client);

      expect(checkFn('任何内容')).toBe(false);
    });

    it('敏感词大小写不敏感（如果配置）', () => {
      const mixedCaseConfig = createValidationConfig({ sensitiveWords: ['Sensitive'] });
      const client = new LlmClient(config, mixedCaseConfig);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => boolean }
      ).containsSensitiveWords.bind(client);

      // 中文敏感词无大小写问题，英文敏感词测试
      expect(checkFn('This is Sensitive content')).toBe(true);
    });
  });

  describe('truncate', () => {
    it('超过最大长度时截断', () => {
      const client = new LlmClient(config, validation);
      const truncateFn = (
        client as unknown as { truncate: (text: string, maxLength: number) => string }
      ).truncate.bind(client);

      const longText = 'a'.repeat(600);
      const result = truncateFn(longText, 500);

      expect(result.length).toBe(500);
    });

    it('未超过长度时保持原样', () => {
      const client = new LlmClient(config, validation);
      const truncateFn = (
        client as unknown as { truncate: (text: string, maxLength: number) => string }
      ).truncate.bind(client);

      const shortText = '短文本';
      const result = truncateFn(shortText, 500);

      expect(result).toBe(shortText);
    });

    it('正好等于最大长度时保持原样', () => {
      const client = new LlmClient(config, validation);
      const truncateFn = (
        client as unknown as { truncate: (text: string, maxLength: number) => string }
      ).truncate.bind(client);

      const exactText = 'a'.repeat(500);
      const result = truncateFn(exactText, 500);

      expect(result).toBe(exactText);
      expect(result.length).toBe(500);
    });
  });

  describe('generateReply', () => {
    it('正常返回 LLM 生成的回复', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '你好！很高兴认识你。' } }],
      });

      const client = new LlmClient(config, validation);
      const message = createMessage({ content: '你好' });
      const history: MessageInfo[] = [];

      const reply = await client.generateReply(message, history);

      expect(reply).toBe('你好！很高兴认识你。');
      expect(mockCreate).toHaveBeenCalledWith({
        model: config.model,
        messages: expect.any(Array),
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      });
    });

    it('回复包含敏感词时返回 null 并记录日志', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '这里有敏感词内容' } }],
      });

      const client = new LlmClient(config, validation);
      const message = createMessage();

      const reply = await client.generateReply(message, []);

      expect(reply).toBeNull();
      expect(loggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'sensitive_words' }),
        expect.any(String)
      );
    });

    it('回复超长时截断', async () => {
      const longReply = 'a'.repeat(600);
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: longReply } }],
      });

      const client = new LlmClient(config, validation);
      const message = createMessage();

      const reply = await client.generateReply(message, []);

      expect(reply).not.toBeNull();
      expect(reply!.length).toBe(validation.maxReplyLength);
    });

    it('API 调用失败时抛出 LlmClientError', async () => {
      mockCreate.mockRejectedValue(new Error('API Error'));

      const client = new LlmClient(config, validation);
      const message = createMessage();

      await expect(client.generateReply(message, [])).rejects.toThrow('LLM API 调用失败');
    });

    it('LLM 返回空内容时返回 null', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '' } }],
      });

      const client = new LlmClient(config, validation);
      const message = createMessage();

      const reply = await client.generateReply(message, []);

      expect(reply).toBeNull();
    });

    it('LLM 返回 null content 时返回 null', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: null } }],
      });

      const client = new LlmClient(config, validation);
      const message = createMessage();

      const reply = await client.generateReply(message, []);

      expect(reply).toBeNull();
    });
  });

  describe('安全性: API Key 不出现在日志', () => {
    it('日志中不包含 API Key', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '回复' } }],
      });

      const client = new LlmClient(config, validation);
      await client.generateReply(createMessage(), []);

      // 检查所有日志调用
      const allLogCalls = [
        ...loggerDebugMock.mock.calls,
        ...loggerInfoMock.mock.calls,
        ...loggerWarnMock.mock.calls,
        ...loggerErrorMock.mock.calls,
      ];

      for (const call of allLogCalls) {
        const logString = JSON.stringify(call);
        expect(logString).not.toContain(config.apiKey);
        expect(logString).not.toContain('sk-test-secret-key-12345');
      }
    });
  });
});
