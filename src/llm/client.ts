import OpenAI from 'openai';
import type { LlmConfig, ValidationConfig } from '../config/schema.js';
import type { MessageInfo } from '../dom/locator.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('llm');

export class LlmClientError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'LlmClientError';
    this.originalCause = originalCause;
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class LlmClient {
  private readonly client: OpenAI;

  constructor(
    private readonly config: LlmConfig,
    private readonly validation: ValidationConfig
  ) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      timeout: config.timeout,
      maxRetries: 2,
    });
    log.debug({ baseUrl: config.baseUrl, model: config.model }, 'LLM 客户端已初始化');
  }

  async generateReply(message: MessageInfo, sessionHistory: MessageInfo[]): Promise<string | null> {
    const messages = this.buildMessages(message, sessionHistory);

    try {
      log.debug({ messageCount: messages.length }, '调用 LLM API');

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      });

      const content = response.choices[0]?.message?.content;

      if (!content) {
        log.debug('LLM 返回空内容');
        return null;
      }

      if (this.containsSensitiveWords(content)) {
        log.warn({ reason: 'sensitive_words' }, '回复包含敏感词，已过滤');
        return null;
      }

      const truncated = this.truncate(content, this.validation.maxReplyLength);
      log.debug(
        { originalLength: content.length, truncatedLength: truncated.length },
        '回复已生成'
      );

      return truncated;
    } catch (error) {
      log.error({ err: error }, 'LLM API 调用失败');
      throw new LlmClientError('LLM API 调用失败', error as Error);
    }
  }

  private buildMessages(current: MessageInfo, history: MessageInfo[]): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: this.config.systemPrompt }];

    const contextCount = this.config.contextMessages;
    if (contextCount > 0 && history.length > 0) {
      const recentHistory = history.slice(-contextCount);
      for (const msg of recentHistory) {
        messages.push({
          role: msg.isMe ? 'assistant' : 'user',
          content: msg.content,
        });
      }
    }

    messages.push({ role: 'user', content: current.content });

    return messages;
  }

  private containsSensitiveWords(text: string): boolean {
    if (this.validation.sensitiveWords.length === 0) {
      return false;
    }

    const lowerText = text.toLowerCase();
    return this.validation.sensitiveWords.some(word => lowerText.includes(word.toLowerCase()));
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength);
  }
}
