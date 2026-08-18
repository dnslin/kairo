import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sender } from '../../src/send/sender.js';
import type { SendResult } from '../../src/send/sender.js';
import type { SenderConfig } from '../../src/config/schema.js';
import type { DomLocator } from '../../src/dom/locator.js';
import type { Stats } from 'node:fs';
import { stat, readFile } from 'fs/promises';
import { lookup } from 'mime-types';

vi.mock('fs/promises', () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock('mime-types', () => ({
  lookup: vi.fn(),
}));

const mockedStat = vi.mocked(stat);
const mockedReadFile = vi.mocked(readFile);
const mockedLookup = vi.mocked(lookup);

const createMockLocator = () => ({
  getInputBox: vi.fn(),
  setInputText: vi.fn(),
  getSendButton: vi.fn(),
  clickSendButton: vi.fn(),
  getMessages: vi.fn(),
  focusInputBox: vi.fn(),
  simulatePaste: vi.fn(),
  getConnector: vi.fn().mockReturnValue({ evaluate: vi.fn().mockResolvedValue(undefined) }),
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

  describe('sendImage', () => {
    const TEST_IMAGE_PATH = '/tmp/test-image.png';

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    const setupImageMocksUntilPaste = () => {
      mockedStat.mockResolvedValue({ size: 1024 } as Stats);
      mockedLookup.mockReturnValue('image/png');
      mockedReadFile.mockResolvedValue(Buffer.from('fake-png-data'));
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.focusInputBox.mockResolvedValue(true);
      mockLocator.simulatePaste.mockResolvedValue(undefined);
    };

    it('成功发送图片返回 { success: true }', async () => {
      setupImageMocksUntilPaste();
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(true);
      mockLocator.getMessages.mockResolvedValue([
        { id: 'msg-1', sender: 'Me', content: '[image]', time: '10:00', isMe: true },
      ]);

      const resultPromise = sender.sendImage(TEST_IMAGE_PATH);
      await vi.runAllTimersAsync();
      const result: SendResult = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(mockedStat).toHaveBeenCalledWith(TEST_IMAGE_PATH);
      expect(mockedReadFile).toHaveBeenCalledWith(TEST_IMAGE_PATH);
      expect(mockLocator.getConnector().evaluate).toHaveBeenCalledTimes(1);
      const evaluateScript = mockLocator.getConnector().evaluate.mock.calls[0]?.[0] as string;
      expect(evaluateScript).toContain('navigator.clipboard.write');
      expect(evaluateScript).toContain("mimeType = 'image/png'");
      expect(mockLocator.focusInputBox).toHaveBeenCalledTimes(1);
      expect(mockLocator.simulatePaste).toHaveBeenCalledTimes(1);
      expect(mockLocator.clickSendButton).toHaveBeenCalledTimes(1);
    });

    it('图片文件过大返回错误', async () => {
      const overSizeBytes = 10 * 1024 * 1024 + 1;
      mockedStat.mockResolvedValue({ size: overSizeBytes } as Stats);

      const result: SendResult = await sender.sendImage(TEST_IMAGE_PATH);

      expect(result.success).toBe(false);
      expect(result.error).toBe('图片文件过大 (>10MB)');
      expect(mockLocator.getInputBox).not.toHaveBeenCalled();
    });

    it('输入框未找到返回错误', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as Stats);
      mockLocator.getInputBox.mockResolvedValue({ found: false, editable: false });

      const result: SendResult = await sender.sendImage(TEST_IMAGE_PATH);

      expect(result.success).toBe(false);
      expect(result.error).toBe('输入框未找到');
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('输入框不可编辑返回错误', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as Stats);
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: false });

      const result: SendResult = await sender.sendImage(TEST_IMAGE_PATH);

      expect(result.success).toBe(false);
      expect(result.error).toBe('输入框不可编辑');
      expect(mockedLookup).not.toHaveBeenCalled();
    });

    it('非图片格式返回错误', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as Stats);
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockedLookup.mockReturnValue('application/pdf');

      const result: SendResult = await sender.sendImage('/tmp/doc.pdf');

      expect(result.success).toBe(false);
      expect(result.error).toBe('文件不是图片格式');
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('未知扩展名返回错误', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as Stats);
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockedLookup.mockReturnValue(false);

      const result: SendResult = await sender.sendImage('/tmp/file.xyz');

      expect(result.success).toBe(false);
      expect(result.error).toBe('文件不是图片格式');
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('聚焦输入框失败返回错误', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as Stats);
      mockedLookup.mockReturnValue('image/png');
      mockedReadFile.mockResolvedValue(Buffer.from('fake-png-data'));
      mockLocator.getInputBox.mockResolvedValue({ found: true, editable: true });
      mockLocator.focusInputBox.mockResolvedValue(false);

      const resultPromise = sender.sendImage(TEST_IMAGE_PATH);
      await vi.runAllTimersAsync();
      const result: SendResult = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('聚焦输入框失败');
      expect(mockLocator.simulatePaste).not.toHaveBeenCalled();
    });

    it('发送按钮未找到返回错误', async () => {
      setupImageMocksUntilPaste();
      mockLocator.getSendButton.mockResolvedValue({
        found: false,
        selector: '.send-button',
        visible: false,
        enabled: false,
      });

      const resultPromise = sender.sendImage(TEST_IMAGE_PATH);
      await vi.runAllTimersAsync();
      const result: SendResult = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('发送按钮未找到');
      expect(mockLocator.clickSendButton).not.toHaveBeenCalled();
    });

    it('点击发送失败返回错误', async () => {
      setupImageMocksUntilPaste();
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(false);

      const resultPromise = sender.sendImage(TEST_IMAGE_PATH);
      await vi.runAllTimersAsync();
      const result: SendResult = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('点击发送失败');
    });

    it('验证图片发送超时返回错误', async () => {
      const shortTimeoutConfig = createMockConfig({ verifyTimeoutMs: 100 });
      sender = new Sender(mockLocator as unknown as DomLocator, shortTimeoutConfig);

      setupImageMocksUntilPaste();
      mockLocator.getSendButton.mockResolvedValue({
        found: true,
        selector: '.send-button',
        visible: true,
        enabled: true,
      });
      mockLocator.clickSendButton.mockResolvedValue(true);
      mockLocator.getMessages.mockResolvedValue([]);

      const resultPromise = sender.sendImage(TEST_IMAGE_PATH);
      await vi.runAllTimersAsync();
      const result: SendResult = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.error).toBe('验证超时');
    });

    it('文件不存在时捕获异常返回错误', async () => {
      const fileError = new Error('ENOENT: no such file or directory');
      mockedStat.mockRejectedValue(fileError);

      const result: SendResult = await sender.sendImage('/tmp/not-exist.png');

      expect(result.success).toBe(false);
      expect(result.error).toBe('ENOENT: no such file or directory');
      expect(mockLocator.getInputBox).not.toHaveBeenCalled();
    });
  });
});
