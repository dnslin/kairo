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

  async generateReply(message: MessageInfo, sessionHistory: MessageInfo[], summaryContext?: string): Promise<string | null> {
    const messages = this.buildMessages(message, sessionHistory, summaryContext);

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

      const cleanedContent = this.removeThinkingTags(content);

      const matchedWords = this.containsSensitiveWords(cleanedContent);
      if (matchedWords.length > 0) {
        log.warn({ reason: 'sensitive_words', matchedWords }, '回复包含敏感词，已过滤');
        return null;
      }

      const truncated = this.truncate(cleanedContent, this.validation.maxReplyLength);
      log.debug(
        { originalLength: cleanedContent.length, truncatedLength: truncated.length },
        '回复已生成'
      );

      return truncated;
    } catch (error) {
      log.error({ err: error }, 'LLM API 调用失败');
      throw new LlmClientError('LLM API 调用失败', error as Error);
    }
  }

  /**
   * 根据会话历史生成摘要
   * @param sessionHistory - 需要摘要的会话历史
   * @param existingSummary - 可选的已有摘要，用于增量更新
   * @returns 生成的摘要文本，失败时返回 null
   */
  async generateSummary(sessionHistory: MessageInfo[], existingSummary?: string): Promise<string | null> {
    const historyText = sessionHistory
      .map(m => `${m.isMe ? 'assistant' : 'user'}: ${m.content}`)
      .join('\n');

    const userContent = existingSummary
      ? `已有摘要：\n${existingSummary}\n\n新消息：\n${historyText}`
      : historyText;

    const messages: ChatMessage[] = [
      { role: 'system', content: this.config.summaryPrompt },
      { role: 'user', content: userContent },
    ];

    try {
      log.debug({ historyLength: sessionHistory.length }, '生成会话摘要');

      const response = await this.client.chat.completions.create({
        model: this.config.model,
        messages,
        temperature: 0.3,
        max_tokens: this.config.maxTokens,
      });

      const content = response.choices[0]?.message?.content;

      if (!content) {
        log.debug('摘要生成返回空内容');
        return null;
      }

      const cleaned = this.removeThinkingTags(content);
      log.debug({ summaryLength: cleaned.length }, '会话摘要已生成');
      return cleaned;
    } catch (error) {
      log.error({ err: error }, '摘要生成 API 调用失败');
      throw new LlmClientError('摘要生成 API 调用失败', error as Error);
    }
  }

  private buildMessages(current: MessageInfo, history: MessageInfo[], summaryContext?: string): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: 'system', content: this.config.systemPrompt }];

    if (summaryContext) {
      messages.push({ role: 'system', content: `对话摘要：${summaryContext}` });
    }

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

  private containsSensitiveWords(text: string): string[] {
    if (this.validation.sensitiveWords.length === 0) {
      return [];
    }

    const lowerText = text.toLowerCase();
    return this.validation.sensitiveWords.filter(word => lowerText.includes(word.toLowerCase()));
  }

  private truncate(text: string, maxLength: number): string {
    if (text.length <= maxLength) {
      return text;
    }
    return text.slice(0, maxLength);
  }

  private removeThinkingTags(text: string): string {
    const lowerText = text.toLowerCase();
    const openTag = '<think>';
    const closeTag = '</think>';
    let result = '';
    let index = 0;
    let depth = 0;

    while (index < text.length) {
      if (lowerText.startsWith(openTag, index)) {
        depth += 1;
        index += openTag.length;
        continue;
      }

      if (depth > 0 && lowerText.startsWith(closeTag, index)) {
        depth -= 1;
        index += closeTag.length;
        if (depth === 0) {
          while (index < text.length && /\s/.test(text.charAt(index))) {
            index += 1;
          }
        }
        continue;
      }

      if (depth === 0) {
        result += text[index];
      }
      index += 1;
    }

    return result.trim();
  }
}
