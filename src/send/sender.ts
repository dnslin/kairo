import type { DomLocator } from '../dom/locator.js';
import type { SenderConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('sender');

export interface SendResult {
  success: boolean;
  error?: string;
}

export class SenderError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'SenderError';
    this.originalCause = originalCause;
  }
}

export class Sender {
  private readonly pollIntervalMs = 200;

  constructor(
    private readonly locator: DomLocator,
    private readonly config: SenderConfig
  ) {}

  async send(text: string): Promise<SendResult> {
    const maskedText = this.config.logMasking ? this.maskText(text) : text;
    log.info({ text: maskedText }, '开始发送消息');

    try {
      const inputBox = await this.locator.getInputBox();
      if (!inputBox.found) {
        log.warn('输入框未找到');
        return { success: false, error: '输入框未找到' };
      }
      if (!inputBox.editable) {
        log.warn('输入框不可编辑');
        return { success: false, error: '输入框不可编辑' };
      }

      const textSet = await this.locator.setInputText(text);
      if (!textSet) {
        log.warn('设置文本失败');
        return { success: false, error: '设置文本失败' };
      }

      const sendButton = await this.locator.getSendButton();
      if (!sendButton.found) {
        log.warn('发送按钮未找到');
        return { success: false, error: '发送按钮未找到' };
      }

      const clicked = await this.locator.clickSendButton();
      if (!clicked) {
        log.warn('点击发送失败');
        return { success: false, error: '点击发送失败' };
      }

      const verified = await this.verifySent(text);
      if (!verified) {
        log.warn('验证超时');
        return { success: false, error: '验证超时' };
      }

      log.info({ text: maskedText }, '消息发送成功');
      return { success: true };
    } catch (error) {
      log.error({ err: error }, '发送消息时发生错误');
      return {
        success: false,
        error: error instanceof Error ? error.message : '未知错误',
      };
    }
  }

  private async verifySent(text: string): Promise<boolean> {
    const startTime = Date.now();
    const textPrefix = text.slice(0, 20);

    while (Date.now() - startTime < this.config.verifyTimeoutMs) {
      const messages = await this.locator.getMessages(5);
      const found = messages.some(m => m.isMe && m.content.includes(textPrefix));

      if (found) {
        return true;
      }

      await this.sleep(this.pollIntervalMs);
    }

    return false;
  }

  // 脱敏: 保留前3后3字符，中间用*替代
  private maskText(text: string): string {
    if (text.length <= 6) {
      return '*'.repeat(text.length);
    }
    return text.slice(0, 3) + '*'.repeat(text.length - 6) + text.slice(-3);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
