import fs from 'node:fs';
import path from 'node:path';
import mime from 'mime-types';
import type { CdpClient } from '../cdp/client.js';
import type { PreSendCheckResult, SelectorsConfig, SendResult } from '../types/index.js';
import { SendError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('send-ops');

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export class SendOps {
  constructor(
    private readonly cdp: CdpClient,
    private readonly selectors: SelectorsConfig
  ) {}

  /**
   * 发送前原子状态安全校验（防串线、防撤回）
   */
  public async checkPreSendState(expectedSessionId: string, _triggerMessageFingerprint?: string): Promise<PreSendCheckResult> {
    const script = `
      (() => {
        const expected = ${JSON.stringify(expectedSessionId)};

        // 1. 检查当前活跃节点
        const activeItem = document.querySelector('.chat-item.chat-selected') ||
          document.querySelector('${this.selectors.activeSession}');
        const activeTitle = activeItem?.querySelector('${this.selectors.sessionTitle}')?.textContent?.trim() || '';
        const activeId = activeItem?.getAttribute('data-sesuuid') ||
          activeItem?.getAttribute('data-session-id') ||
          activeItem?.getAttribute('id') ||
          '';

        // 2. 检查右侧聊天面板标题栏
        const headerTitle = document.querySelector('.chat-header, .chat-title, .head-title')?.textContent?.trim() || '';

        // 3. 尝试从 Vue 实例获取目标信息
        let expectedName = expected;
        let expectedUuid = expected;
        const scroller = document.querySelector('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        if (scroller && scroller.__vue__ && Array.isArray(scroller.__vue__.items)) {
          const item = scroller.__vue__.items.find(it => it.sesUUID === expected || it.typeName === expected || it.name === expected);
          if (item) {
            expectedName = item.typeName || item.name || expectedName;
            expectedUuid = item.sesUUID || expectedUuid;
          }
        }

        // 4. 多重综合比对
        const isMatch =
          activeId === expected ||
          activeId === expectedUuid ||
          activeTitle === expected ||
          activeTitle === expectedName ||
          (activeTitle && expectedName && activeTitle.includes(expectedName)) ||
          (activeTitle && expected && activeTitle.includes(expected)) ||
          headerTitle.includes(expected) ||
          headerTitle.includes(expectedName);

        if (!isMatch) {
          return {
            canSend: false,
            reason: 'session_switched',
            details: '当前活跃会话 [' + (activeTitle || activeId || '未知') + '] 与目标会话 [' + expected + '] 不一致',
          };
        }

        return { canSend: true };
      })()
    `;
    try {
      const res = await this.cdp.evaluate<PreSendCheckResult>(script);
      return res || { canSend: true };
    } catch (err) {
      log.warn({ err: String(err) }, '发送前校验脚本执行异常，放行');
      return { canSend: true };
    }
  }

  /**
   * 发送纯文本消息（带 DOM 回读验证闭环）
   */
  public async sendText(text: string, options: { verifyTimeoutMs?: number; targetSessionId?: string } = {}): Promise<SendResult> {
    const cleanText = text.trim();
    if (!cleanText) {
      return { success: false, error: '发送内容不能为空' };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason} (${check.details})` };
      }
    }

    const script = `
      (() => {
        const input = document.querySelector('${this.selectors.inputBox}') || document.querySelector('.chat-sendArea');
        if (!input) return { success: false, error: '未找到输入框元素' };

        input.focus();
        if (input.isContentEditable) {
          input.textContent = ${JSON.stringify(cleanText)};
        } else {
          input.value = ${JSON.stringify(cleanText)};
        }

        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        // 优先定位真实的 a.button 触发物理点击
        const sendBtn = document.querySelector('.sendMsg-btn a.button') ||
          document.querySelector('.sendMsg-btn a') ||
          document.querySelector('.sendMsg-btn .button') ||
          document.querySelector('${this.selectors.sendButton}') ||
          document.querySelector('.sendMsg-btn');

        if (sendBtn) {
          sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          if (typeof sendBtn.click === 'function') {
            sendBtn.click();
          } else {
            sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return { success: true };
        }

        return { success: false, error: '未找到发送按钮' };
      })()
    `;

    const startTime = Date.now();
    try {
      // 先确保页面激活
      await this.cdp.bringToFront();

      const injectRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!injectRes?.success) {
        return { success: false, error: injectRes?.error || '注入输入框失败' };
      }

      // 辅助按键模拟: 发送一次 Enter 键以确保触发
      await this.cdp.dispatchKeyEvent({
        type: 'keyDown',
        windowsVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
      });
      await this.cdp.dispatchKeyEvent({
        type: 'keyUp',
        windowsVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
      });

      // 回读严格验证
      const verifyTimeout = options.verifyTimeoutMs ?? 5000;
      const verified = await this.verifyTextSent(cleanText, verifyTimeout);
      const latency = Date.now() - startTime;

      if (!verified) {
        log.warn({ cleanText, latency }, '文本已点击发送但在回读超时内未在 DOM 确认上屏');
        return {
          success: false,
          error: '文本已触发发送但在指定超时内未能确认消息上屏',
          verifyLatencyMs: latency,
        };
      }

      return { success: true, verifyLatencyMs: latency };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送文本异常');
      throw new SendError(`发送文本异常: ${errorMsg}`, err instanceof Error ? err : undefined);
    }
  }

  /**
   * 发送本地图片（通过渲染进程 Clipboard API 写入与跨平台按键模拟）
   */
  public async sendImage(imagePath: string, options: { verifyTimeoutMs?: number; targetSessionId?: string } = {}): Promise<SendResult> {
    const fullPath = path.resolve(imagePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `图片文件不存在: ${fullPath}` };
    }

    const stats = fs.statSync(fullPath);
    if (stats.size > MAX_IMAGE_SIZE_BYTES) {
      return { success: false, error: `图片大小超出限制 (10MB): ${stats.size} bytes` };
    }

    const mimeType = mime.lookup(fullPath) || 'image/png';
    if (!mimeType.startsWith('image/')) {
      return { success: false, error: `不支持的图片格式: ${mimeType}` };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason}` };
      }
    }

    const base64Data = fs.readFileSync(fullPath).toString('base64');
    const startTime = Date.now();

    try {
      // 0. 将渲染窗口置于前台激活
      await this.cdp.bringToFront();

      // 1. 写入渲染进程剪贴板
      const clipScript = `
        (async () => {
          try {
            window.focus();
            const input = document.querySelector('${this.selectors.inputBox}');
            if (input) input.focus();

            const byteCharacters = atob('${base64Data}');
            const byteNumbers = new Array(byteCharacters.length);
            for (let i = 0; i < byteCharacters.length; i++) {
              byteNumbers[i] = byteCharacters.charCodeAt(i);
            }
            const byteArray = new Uint8Array(byteNumbers);
            const blob = new Blob([byteArray], { type: '${mimeType}' });

            await navigator.clipboard.write([
              new ClipboardItem({ ['${mimeType}']: blob })
            ]);
            return { success: true };
          } catch (e) {
            return { success: false, error: String(e) };
          }
        })()
      `;

      const clipRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(clipScript);
      if (!clipRes?.success) {
        return { success: false, error: `剪贴板写入失败: ${clipRes?.error}` };
      }

      await new Promise((r) => setTimeout(r, 400));

      // 2. 跨平台模拟 Ctrl+V / Meta+V 粘贴按键
      const isMac = process.platform === 'darwin';
      await this.cdp.dispatchKeyEvent({
        type: 'keyDown',
        modifiers: isMac ? 8 : 2, // 8: Meta, 2: Control
        windowsVirtualKeyCode: 86,
        key: 'v',
        code: 'KeyV',
      });
      await this.cdp.dispatchKeyEvent({
        type: 'keyUp',
        modifiers: isMac ? 8 : 2,
        windowsVirtualKeyCode: 86,
        key: 'v',
        code: 'KeyV',
      });
      // 3. 等待图片在输入框富文本中完成渲染挂载 (最多等待 3 秒)
      const waitImgScript = `
        (async () => {
          const start = Date.now();
          while (Date.now() - start < 3000) {
            const input = document.querySelector('.chat-sendArea, .chat-editor');
            const img = input?.querySelector('img');
            if (img) {
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return { ready: true };
            }
            await new Promise(r => setTimeout(r, 100));
          }
          return { ready: false };
        })()
      `;

      const waitRes = await this.cdp.evaluate<{ ready: boolean }>(waitImgScript);
      if (!waitRes?.ready) {
        log.warn('图片粘贴后在输入框渲染超时');
      }

      // 4. 点击发送按钮
      const sendScript = `
        (() => {
          const sendBtn = document.querySelector('.sendMsg-btn a.button') ||
            document.querySelector('.sendMsg-btn a') ||
            document.querySelector('.sendMsg-btn .button') ||
            document.querySelector('${this.selectors.sendButton}') ||
            document.querySelector('.sendMsg-btn');

          if (!sendBtn) return { success: false, error: '未找到发送按钮' };

          sendBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
          sendBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
          if (typeof sendBtn.click === 'function') {
            sendBtn.click();
          } else {
            sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
          }
          return { success: true };
        })()
      `;

      const sendRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(sendScript);
      if (!sendRes?.success) {
        return { success: false, error: `点击发送图片失败: ${sendRes?.error}` };
      }

      // 辅助按键: 发送一次 Enter
      await this.cdp.dispatchKeyEvent({
        type: 'keyDown',
        windowsVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
      });
      await this.cdp.dispatchKeyEvent({
        type: 'keyUp',
        windowsVirtualKeyCode: 13,
        key: 'Enter',
        code: 'Enter',
      });

      // 5. 严格回读确认: 检查输入框清空
      const verifyTimeout = options.verifyTimeoutMs ?? 5000;
      const verified = await this.verifyImageSent(verifyTimeout);
      const latency = Date.now() - startTime;

      if (!verified) {
        log.warn({ latency }, '图片已点击发送但在回读超时内未能确认输入框清空与上屏');
        return {
          success: false,
          error: '图片已触发发送但在指定超时内未能确认消息上屏',
          verifyLatencyMs: latency,
        };
      }

      return { success: true, verifyLatencyMs: latency };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送图片异常');
      throw new SendError(`发送图片异常: ${errorMsg}`, err instanceof Error ? err : undefined);
    }
  }

  private async verifyImageSent(timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const script = `
        (() => {
          const input = document.querySelector('.chat-sendArea');
          const hasImgInInput = Boolean(input?.querySelector('img'));
          return !hasImgInInput;
        })()
      `;

      try {
        const empty = await this.cdp.evaluate<boolean>(script);
        if (empty) return true;
      } catch {
        // 忽略轮询临时错误
      }

      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  private async verifyTextSent(text: string, timeoutMs: number): Promise<boolean> {
    const prefix = text.slice(0, 15);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const script = `
        (() => {
          const input = document.querySelector('.chat-sendArea');
          const isInputEmpty = !input || !input.textContent?.trim();

          const items = document.querySelectorAll('${this.selectors.messageItem}');
          const lastFew = Array.from(items).slice(-5);
          const foundInMessages = lastFew.some(item => {
            const isMe = item.matches('${this.selectors.messageIsMe}') ||
              item.classList.contains('rcd-msg-right') ||
              item.querySelector('.rcd-msg-right') !== null;
            const content = item.querySelector('${this.selectors.messageContent}')?.textContent || item.textContent || '';
            return isMe && content.includes(${JSON.stringify(prefix)});
          });

          return foundInMessages || (isInputEmpty && lastFew.length > 0);
        })()
      `;

      try {
        const verified = await this.cdp.evaluate<boolean>(script);
        if (verified) return true;
      } catch {
        // 忽略轮询临时错误
      }

      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }
}
