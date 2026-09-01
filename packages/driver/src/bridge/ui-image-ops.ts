import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mime from 'mime-types';
import type { CdpClient } from '../cdp/client.js';
import type { SendOptions, SendResult } from '../types/index.js';
import {
  encodeRendererPayload,
  RENDERER_SESSION_RESOLVER_SCRIPT,
} from './renderer-script.js';

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024;

export async function sendUiImage(
  cdp: CdpClient,
  imagePath: string,
  options: SendOptions = {}
): Promise<SendResult> {
  const fullPath = path.resolve(imagePath);
  if (!fs.existsSync(fullPath)) {
    return { success: false, error: `图片文件不存在: ${fullPath}`, isPreTrigger: true };
  }

  const stats = fs.statSync(fullPath);
  if (stats.size > MAX_IMAGE_SIZE_BYTES) {
    return {
      success: false,
      error: `图片大小超出限制 (10MB): ${stats.size} bytes`,
      isPreTrigger: true,
    };
  }

  const mimeType = mime.lookup(fullPath) || 'image/png';
  if (!mimeType.startsWith('image/')) {
    return { success: false, error: `不支持的图片格式: ${mimeType}`, isPreTrigger: true };
  }

  const encoded = encodeRendererPayload({
    target: options.targetSessionId || '',
    base64Data: fs.readFileSync(fullPath).toString('base64'),
    mimeType,
  });
  const startTime = Date.now();
  let sendMayHaveTriggered = false;

  try {
    const clipboardScript = `
      (async () => {
        try {
          window.focus();
          const data = JSON.parse(decodeURIComponent(${encoded}));
          const target = data.target;
          ${RENDERER_SESSION_RESOLVER_SCRIPT}
          const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
          if (target) {
            const found = resolveRendererSession(editor?.sortedSessions, target);
            if (!found) {
              return { success: false, error: '未找到唯一目标会话 [' + target + ']' };
            }
            const active = editor?.activedSes;
            const isActive = Boolean(
              active &&
              (
                active.sesUUID === found.sesUUID ||
                String(active.id) === String(found.id)
              )
            );
            if (!isActive) {
              return { success: false, error: '目标会话尚未真实激活 [' + target + ']' };
            }
          }

          const input = document.querySelector('.chat-sendArea, .chat-editor, [contenteditable]');
          if (input) input.focus();
          const bytes = Uint8Array.from(atob(data.base64Data), character => character.charCodeAt(0));
          const blob = new Blob([bytes], { type: data.mimeType });
          await navigator.clipboard.write([new ClipboardItem({ [data.mimeType]: blob })]);
          return { success: true };
        } catch (error) {
          return { success: false, error: String(error) };
        }
      })()
    `;
    let clipResult: { success: boolean; error?: string } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      await cdp.bringToFront();
      await sleep(150);
      clipResult = await cdp.evaluate<{ success: boolean; error?: string }>(clipboardScript);
      if (clipResult?.success) break;
      const focusFailure = /not focused|notallowederror/i.test(clipResult?.error || '');
      if (!focusFailure) break;
    }
    if (!clipResult?.success) {
      return {
        success: false,
        error: `剪贴板写入失败: ${clipResult?.error}`,
        isPreTrigger: true,
      };
    }

    await sleep(300);
    const isMac = process.platform === 'darwin';
    await cdp.dispatchKeyEvent({
      type: 'keyDown',
      modifiers: isMac ? 8 : 2,
      windowsVirtualKeyCode: 86,
      key: 'v',
      code: 'KeyV',
    });
    await cdp.dispatchKeyEvent({
      type: 'keyUp',
      modifiers: isMac ? 8 : 2,
      windowsVirtualKeyCode: 86,
      key: 'v',
      code: 'KeyV',
    });
    await sleep(400);

    sendMayHaveTriggered = true;
    const sendResult = await cdp.evaluate<{ success: boolean; error?: string }>(`
      (() => {
        const sendButton = document.querySelector('.sendMsg-btn a.button') ||
          document.querySelector('.sendMsg-btn a') ||
          document.querySelector('.sendMsg-btn .button') ||
          document.querySelector('.sendMsg-btn');
        if (!sendButton) return { success: false, error: '未找到发送按钮' };

        sendButton.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
        sendButton.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
        if (typeof sendButton.click === 'function') {
          sendButton.click();
        } else {
          sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        }
        return { success: true };
      })()
    `);
    if (!sendResult?.success) {
      return {
        success: false,
        error: `点击发送图片失败: ${sendResult?.error}`,
        isPreTrigger: true,
      };
    }

    return { success: true, verifyLatencyMs: Date.now() - startTime };
  } catch (error) {
    return {
      success: false,
      error: `发送图片异常: ${error instanceof Error ? error.message : String(error)}`,
      isPreTrigger: !sendMayHaveTriggered,
      verifyLatencyMs: Date.now() - startTime,
    };
  }
}
