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

import { LlmClient, LlmClientError } from '../../src/llm/client.js';

const createLlmConfig = (overrides: Partial<LlmConfig> = {}): LlmConfig => ({
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test-secret-key-12345',
  model: 'gpt-4o-mini',
  temperature: 0.7,
  timeout: 30000,
  maxTokens: 1000,
  contextMessages: 5,
  systemPrompt: '你是一个友好的助手。',
  summaryIntervalMessages: 0,
  summaryPrompt: '请总结以下对话内容。',
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

    it('传入 summaryContext 时在 system 之后插入摘要消息', () => {
      const client = new LlmClient(config, validation);
      const current = createMessage({ content: '继续聊' });
      const history = [createMessage({ content: '之前的消息', isMe: false })];

      const messages = (
        client as unknown as {
          buildMessages: (c: MessageInfo, h: MessageInfo[], s?: string) => unknown[];
        }
      ).buildMessages(current, history, '这是之前的对话摘要');

      expect(messages).toHaveLength(4); // system + summary + 1 history + current
      expect(messages[0]).toEqual({ role: 'system', content: config.systemPrompt });
      expect(messages[1]).toEqual({ role: 'system', content: '对话摘要：这是之前的对话摘要' });
      expect(messages[2]).toEqual({ role: 'user', content: '之前的消息' });
      expect(messages[3]).toEqual({ role: 'user', content: '继续聊' });
    });

    it('summaryContext 为 undefined 时不插入摘要消息', () => {
      const client = new LlmClient(config, validation);
      const current = createMessage({ content: '你好' });

      const messages = (
        client as unknown as {
          buildMessages: (c: MessageInfo, h: MessageInfo[], s?: string) => unknown[];
        }
      ).buildMessages(current, [], undefined);

      expect(messages).toHaveLength(2); // system + current
      expect(messages[0]).toEqual({ role: 'system', content: config.systemPrompt });
      expect(messages[1]).toEqual({ role: 'user', content: '你好' });
    });
  });

  describe('containsSensitiveWords', () => {
    it('检测到敏感词返回命中词数组', () => {
      const client = new LlmClient(config, validation);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => string[] }
      ).containsSensitiveWords.bind(client);

      expect(checkFn('这里有敏感词内容')).toEqual(['敏感词']);
      expect(checkFn('违禁内容在这里')).toEqual(['违禁']);
    });

    it('无敏感词返回空数组', () => {
      const client = new LlmClient(config, validation);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => string[] }
      ).containsSensitiveWords.bind(client);

      expect(checkFn('正常的回复内容')).toEqual([]);
      expect(checkFn('你好，今天天气不错')).toEqual([]);
    });

    it('空敏感词列表时始终返回空数组', () => {
      const noSensitiveConfig = createValidationConfig({ sensitiveWords: [] });
      const client = new LlmClient(config, noSensitiveConfig);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => string[] }
      ).containsSensitiveWords.bind(client);

      expect(checkFn('任何内容')).toEqual([]);
    });

    it('敏感词大小写不敏感（如果配置）', () => {
      const mixedCaseConfig = createValidationConfig({ sensitiveWords: ['Sensitive'] });
      const client = new LlmClient(config, mixedCaseConfig);
      const checkFn = (
        client as unknown as { containsSensitiveWords: (text: string) => string[] }
      ).containsSensitiveWords.bind(client);

      // 中文敏感词无大小写问题，英文敏感词测试
      expect(checkFn('This is Sensitive content')).toEqual(['Sensitive']);
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

  describe('removeThinkingTags', () => {
    it('移除 <think> 标签及其内容', () => {
      const client = new LlmClient(config, validation);
      const removeFn = (
        client as unknown as { removeThinkingTags: (text: string) => string }
      ).removeThinkingTags.bind(client);

      const input = '<think>\n这是思考内容\n</think>\n\n这是实际回复';
      const result = removeFn(input);

      expect(result).toBe('这是实际回复');
    });

    it('无 <think> 标签时保持原样', () => {
      const client = new LlmClient(config, validation);
      const removeFn = (
        client as unknown as { removeThinkingTags: (text: string) => string }
      ).removeThinkingTags.bind(client);

      const input = '这是普通回复';
      const result = removeFn(input);

      expect(result).toBe('这是普通回复');
    });

    it('处理多个 <think> 标签', () => {
      const client = new LlmClient(config, validation);
      const removeFn = (
        client as unknown as { removeThinkingTags: (text: string) => string }
      ).removeThinkingTags.bind(client);

      const input = '<think>思考1</think>回复1<think>思考2</think>回复2';
      const result = removeFn(input);

      expect(result).toBe('回复1回复2');
    });

    it('处理嵌套 <think> 标签（大小写不敏感）', () => {
      const client = new LlmClient(config, validation);
      const removeFn = (
        client as unknown as { removeThinkingTags: (text: string) => string }
      ).removeThinkingTags.bind(client);

      const input = '<ThInK>外层<tHINK>内层</THINK>外层补充</think>最终回复';
      const result = removeFn(input);

      expect(result).toBe('最终回复');
    });

    it('未闭合 <think> 时移除到结尾，避免推理泄露', () => {
      const client = new LlmClient(config, validation);
      const removeFn = (
        client as unknown as { removeThinkingTags: (text: string) => string }
      ).removeThinkingTags.bind(client);

      const input = '用户可见前缀<think>内部推理未闭合';
      const result = removeFn(input);

      expect(result).toBe('用户可见前缀');
    });

    it('处理大小写变体 <THINK>', () => {
      const client = new LlmClient(config, validation);
      const removeFn = (
        client as unknown as { removeThinkingTags: (text: string) => string }
      ).removeThinkingTags.bind(client);

      const input = '<THINK>思考内容</THINK>回复';
      const result = removeFn(input);

      expect(result).toBe('回复');
    });
  });

  describe('generateSummary', () => {
    it('正常生成摘要', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '这是一段对话摘要。' } }],
      });

      const summaryConfig = createLlmConfig({
        summaryIntervalMessages: 10,
        summaryPrompt: '请总结对话',
      });
      const client = new LlmClient(summaryConfig, validation);
      const history = [
        createMessage({ content: '你好', isMe: false }),
        createMessage({ content: '你好！', isMe: true }),
      ];

      const summary = await client.generateSummary(history);

      expect(summary).toBe('这是一段对话摘要。');
      expect(mockCreate).toHaveBeenCalledWith({
        model: summaryConfig.model,
        messages: [
          { role: 'system', content: '请总结对话' },
          { role: 'user', content: 'user: 你好\nassistant: 你好！' },
        ],
        temperature: 0.3,
        max_tokens: summaryConfig.maxTokens,
      });
    });

    it('传入 existingSummary 时拼接已有摘要', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '更新后的摘要。' } }],
      });

      const client = new LlmClient(config, validation);
      const history = [createMessage({ content: '新消息', isMe: false })];

      const summary = await client.generateSummary(history, '旧的摘要内容');

      expect(summary).toBe('更新后的摘要。');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: config.summaryPrompt },
            { role: 'user', content: '已有摘要：\n旧的摘要内容\n\n新消息：\nuser: 新消息' },
          ],
        })
      );
    });

    it('API 返回空内容时返回 null', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '' } }],
      });

      const client = new LlmClient(config, validation);
      const summary = await client.generateSummary([createMessage()]);

      expect(summary).toBeNull();
    });

    it('API 调用失败时抛出 LlmClientError', async () => {
      mockCreate.mockRejectedValue(new Error('API Error'));

      const client = new LlmClient(config, validation);

      await expect(client.generateSummary([createMessage()])).rejects.toThrow(
        '摘要生成 API 调用失败'
      );
    });

    it('摘要 API 失败时保留 originalCause', async () => {
      const cause = new Error('summary-timeout');
      mockCreate.mockRejectedValue(cause);

      const client = new LlmClient(config, validation);
      let thrown: unknown;
      try {
        await client.generateSummary([createMessage()]);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LlmClientError);
      expect(thrown).toMatchObject({
        message: '摘要生成 API 调用失败',
        originalCause: cause,
      });
    });

    it('移除回复中的 think 标签', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '<think>内部思考</think>干净的摘要' } }],
      });

      const client = new LlmClient(config, validation);
      const summary = await client.generateSummary([createMessage()]);

      expect(summary).toBe('干净的摘要');
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

    it('回复会先移除 think 标签再返回', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '<think>内部推理</think>这是给用户的回复' } }],
      });

      const client = new LlmClient(config, validation);
      const reply = await client.generateReply(createMessage(), []);

      expect(reply).toBe('这是给用户的回复');
    });

    it('回复含嵌套 think 标签时只保留可见内容', async () => {
      mockCreate.mockResolvedValue({
        choices: [
          {
            message: {
              content: '<think>外层<think>内层</think>外层补充</think>这是最终回复',
            },
          },
        ],
      });

      const client = new LlmClient(config, validation);
      const reply = await client.generateReply(createMessage(), []);

      expect(reply).toBe('这是最终回复');
    });

    it('回复中 think 标签未闭合时移除后续内容', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '用户可见内容<think>未闭合内部推理' } }],
      });

      const client = new LlmClient(config, validation);
      const reply = await client.generateReply(createMessage(), []);

      expect(reply).toBe('用户可见内容');
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
        expect.objectContaining({ reason: 'sensitive_words', matchedWords: ['敏感词'] }),
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

    it('maxReplyLength=0 时返回空字符串（边界）', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '任意回复' } }],
      });

      const zeroLimitValidation = createValidationConfig({ maxReplyLength: 0 });
      const client = new LlmClient(config, zeroLimitValidation);
      const reply = await client.generateReply(createMessage(), []);

      expect(reply).toBe('');
    });

    it('API 调用失败时抛出 LlmClientError', async () => {
      mockCreate.mockRejectedValue(new Error('API Error'));

      const client = new LlmClient(config, validation);
      const message = createMessage();

      await expect(client.generateReply(message, [])).rejects.toThrow('LLM API 调用失败');
    });

    it('API 调用失败时保留 originalCause', async () => {
      const cause = new Error('network-timeout');
      mockCreate.mockRejectedValue(cause);

      const client = new LlmClient(config, validation);
      let thrown: unknown;
      try {
        await client.generateReply(createMessage(), []);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(LlmClientError);
      expect(thrown).toMatchObject({
        message: 'LLM API 调用失败',
        originalCause: cause,
      });
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

    it('传入 summaryContext 时转发给 buildMessages', async () => {
      mockCreate.mockResolvedValue({
        choices: [{ message: { content: '带摘要的回复' } }],
      });

      const client = new LlmClient(config, validation);
      const message = createMessage({ content: '你好' });

      const reply = await client.generateReply(message, [], '之前的摘要');

      expect(reply).toBe('带摘要的回复');
      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            { role: 'system', content: config.systemPrompt },
            { role: 'system', content: '对话摘要：之前的摘要' },
          ]),
        })
      );
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
