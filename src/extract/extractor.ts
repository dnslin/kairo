import { createHash } from 'node:crypto';
import type { DomLocator, SessionInfo } from '../dom/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('extract');

export function normalizeText(text: string): string {
  return text.trim();
}

export function generateFingerprint(
  sessionId: string,
  sender: string,
  time: string,
  content: string
): string {
  const data = `${sessionId}\x00${sender}\x00${time}\x00${content}`;
  return createHash('sha256').update(data).digest('hex');
}

/**
 * 消息数据结构，包含会话信息和唯一指纹
 */
export interface Message {
  /** 会话唯一标识 */
  sessionId: string;
  /** 发送方名称 */
  sender: string;
  /** 时间字符串 (DOM 原始格式) */
  time: string;
  /** 消息内容 (已规范化) */
  content: string;
  /** 消息唯一指纹 (SHA-256) */
  fingerprint: string;
  /** 是否为自己发送的消息 */
  isMe: boolean;
}

/**
 * 消息提取器错误
 */
export class ExtractorError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'ExtractorError';
    this.originalCause = originalCause;
  }
}

/**
 * 消息提取器
 * 从 DOM 提取消息并生成唯一指纹
 */
export class MessageExtractor {
  constructor(private readonly locator: DomLocator) {}

  async getRecentMessages(n: number): Promise<Message[]> {
    if (n < 0) {
      throw new ExtractorError('消息数量不能为负数');
    }

    if (n === 0) {
      return [];
    }

    const session = await this.locator.getCurrentSession();
    if (!session) {
      throw new ExtractorError('无当前会话');
    }

    const rawMessages = await this.locator.getMessages(n);
    log.debug({ count: rawMessages.length, sessionId: session.id }, '提取原始消息');

    const messages: Message[] = rawMessages
      .filter(raw => !raw.isMe)
      .map(raw => {
        const content = normalizeText(raw.content);
        const fingerprint = generateFingerprint(session.id, raw.sender, raw.time, content);

        // isMe 过滤后恒为 false，但保留字段供 P1 getMessagesFromSession() 等未来方法复用 Message 接口
        return {
          sessionId: session.id,
          sender: raw.sender,
          time: raw.time,
          content,
          fingerprint,
          isMe: raw.isMe,
        };
      });

    log.debug({ count: messages.length }, '消息提取完成');
    return messages;
  }

  /** 获取全部会话列表（委托给 DomLocator） */
  async getAllSessions(): Promise<SessionInfo[]> {
    return this.locator.getAllSessions();
  }

  /** 切换到指定会话并提取消息 */
  async getMessagesFromSession(sessionId: string, n: number, switchDelayMs = 500): Promise<Message[]> {
    const selected = await this.locator.selectSession(sessionId);
    if (!selected) {
      throw new ExtractorError(`切换会话失败: ${sessionId}`);
    }

    // 等待 DOM 渲染
    await new Promise(resolve => setTimeout(resolve, switchDelayMs));

    const rawMessages = await this.locator.getMessages(n);
    log.debug({ count: rawMessages.length, sessionId }, '从指定会话提取消息');

    return rawMessages
      .filter(raw => !raw.isMe)
      .map(raw => {
        const content = normalizeText(raw.content);
        const fingerprint = generateFingerprint(sessionId, raw.sender, raw.time, content);
        return {
          sessionId,
          sender: raw.sender,
          time: raw.time,
          content,
          fingerprint,
          isMe: raw.isMe,
        };
      });
  }
}
