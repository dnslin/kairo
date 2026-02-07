import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sender } from '../../src/send/sender.js';
import type { DomLocator } from '../../src/dom/locator.js';

interface SenderConfig {
  verifyTimeoutMs: number;
  logMasking: boolean;
}

interface SendResult {
  success: boolean;
  error?: string;
}

const createMockLocator = () => ({
  getInputBox: vi.fn(),
  setInputText: vi.fn(),
  getSendButton: vi.fn(),
  clickSendButton: vi.fn(),
  getMessages: vi.fn(),
});

const createMockConfig = (overrides: Partial<SenderConfig> = {}): SenderConfig => ({
  verifyTimeoutMs: 3000,
  logMasking: false,
  ...overrides,
});

describe('Sender', () => {
  let mockLocator: ReturnType<typeof createMockLocator>;
  let config: SenderConfig;
  let sender: Sender;

  beforeEach(() => {
    mockLocator = createMockLocator();
    config = createMockConfig();
    sender = new Sender(mockLocator as unknown as DomLocator, config);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('send', () => {
    it('成功发送返回 { success: true }', async () => {
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.setInputText.mockResolvedValue(true);
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(true);
      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: 'Me', content: 'test message', time: '10:00', isMe: true },
      ]);

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockLocator.getInputBox).toHaveBeenCalledTimes(1);
      expect(mockLocator.setInputText).toHaveBeenCalledWith('test message');
      expect(mockLocator.getSendButton).toHaveBeenCalledTimes(1);
      expect(mockLocator.clickSendButton).toHaveBeenCalledTimes(1);
    });

    it('输入框未找到返回错误', async () => {
      mockLocator.getInputBox.mockResolvedValue({ found: false, editable: false });

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('输入框未找到');
      expect(mockLocator.setInputText).not.toHaveBeenCalled();
    });

    it('输入框不可编辑返回错误', async () => {
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: false });

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('输入框不可编辑');
      expect(mockLocator.setInputText).not.toHaveBeenCalled();
    });

    it('发送按钮未找到返回错误', async () => {
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.setInputText.mockResolvedValue(true);
      mockLocator.getSendButton.mockResolvedValue({
        found: false,
        selector: '.send-button',
        visible: false,
        enabled: false,
      });

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('发送按钮未找到');
      expect(mockLocator.clickSendButton).not.toHaveBeenCalled();
    });

    it('设置文本失败返回错误', async () => {
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.setInputText.mockResolvedValue(false);

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('设置文本失败');
      expect(mockLocator.getSendButton).not.toHaveBeenCalled();
    });

    it('点击发送失败返回错误', async () => {
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.setInputText.mockResolvedValue(true);
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(false);

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('点击发送失败');
    });

    it('验证超时返回错误', async () => {
      const shortTimeoutConfig = createMockConfig({ verifyTimeoutMs: 100 });
      sender = new Sender(mockLocator as unknown as DomLocator, shortTimeoutConfig);

      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.setInputText.mockResolvedValue(true);
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(true);
      mockLocator.getMessages.mockResolvedValue([]);

      const result: SendResult = await sender.send('test message');

      expect(result.success).toBe(false);
      expect(result.error).toBe('验证超时');
    });

    it('日志脱敏功能测试', async () => {
      const maskingConfig = createMockConfig({ logMasking: true });
      sender = new Sender(mockLocator as unknown as DomLocator, maskingConfig);

      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.setInputText.mockResolvedValue(true);
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(true);
      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: 'Me', content: 'sensitive data', time: '10:00', isMe: true },
      ]);

      const result: SendResult = await sender.send('sensitive data');

      expect(result.success).toBe(true);
      expect(mockLocator.setInputText).toHaveBeenCalledWith('sensitive data');
    });
  });
});
