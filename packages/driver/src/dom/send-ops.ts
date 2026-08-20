import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import mime from 'mime-types';
import { renderCardToBase64 } from '../canvas/renderer.js';
import type { CdpClient } from '../cdp/client.js';
import type {
  CardData,
  FormattedText,
  KK9ReplyTarget,
  PreSendCheckResult,
  SelectorsConfig,
  SendCardOptions,
  SendFileOptions,
  SendOptions,
  SendResult,
} from '../types/index.js';
import { SendError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';
import { VUE_SCROLLER_HELPERS_SCRIPT } from './helpers.js';
import { parseFormattedTextToKK } from './rich-text.js';

const log = createChildLogger('send-ops');

const MAX_IMAGE_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB

function buildMentionNodes(mentions?: SendOptions['mentions']): Array<Record<string, unknown>> {
  if (!mentions) return [];
  const list = Array.isArray(mentions) ? mentions : [mentions];
  const nodes: Array<Record<string, unknown>> = [];

  for (const m of list) {
    if (m === 'all' || m === '全体成员' || m === '所有人') {
      nodes.push({
        type: 2,
        replyMemberID: 0,
        replyMemberType: 1,
        replyMemberName: '全体成员',
      });
    } else if (typeof m === 'string') {
      nodes.push({
        type: 2,
        replyMemberID: 0,
        replyMemberType: 0,
        replyMemberName: m.replace(/^@/, ''),
      });
    } else if (typeof m === 'object' && m !== null) {
      nodes.push({
        type: 2,
        replyMemberID: Number(m.uid) || 0,
        replyMemberType: 0,
        replyMemberName: m.name.replace(/^@/, ''),
      });
    }
  }

  return nodes;
}

export class SendOps {
  constructor(
    private readonly cdp: CdpClient,
    private readonly selectors: SelectorsConfig
  ) {}

  /**
   * 发送前原子状态安全校验（防串线）
   */
  public async checkPreSendState(expectedSessionId: string): Promise<PreSendCheckResult> {
    const script = `
      (() => {
        ${VUE_SCROLLER_HELPERS_SCRIPT}
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
        const scrollerItems = getVueScrollerItems('${this.selectors.virtualScroller || '.vue-recycle-scroller'}');
        const { item: matchedItem } = findVueSessionItem(scrollerItems, expected);
        const expectedName = matchedItem?.typeName || matchedItem?.name || expected;
        const expectedUuid = matchedItem?.sesUUID || expected;

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
   * 激活引用/回复目标
   */
  public async activateQuoteTarget(replyTo: string | KK9ReplyTarget): Promise<boolean> {
    const targetObj =
      typeof replyTo === 'string' ? { content: replyTo, messageId: replyTo } : replyTo;
    const script = `
      (() => {
        const target = ${JSON.stringify(targetObj)};

        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        if (!editor) return false;

        // 在 DOM 或 Vue 组件中查找目标消息并激活引用条
        const msgItems = Array.from(document.querySelectorAll('.rcd-item, .message-item, .msg-item'));
        for (let i = msgItems.length - 1; i >= 0; i--) {
          const item = msgItems[i];
          const vMsg = item.__vue__?.msgitem || item.__vue__?.message;
          const text = item.textContent || '';
          if (vMsg && (vMsg.id == target.messageId || (target.content && text.includes(target.content)))) {
            if (typeof editor.insertReplyMsg === 'function') {
              editor.insertReplyMsg(vMsg);
              return true;
            }
          }
        }

        return false;
      })()
    `;

    try {
      const res = await this.cdp.evaluate<boolean>(script);
      return Boolean(res);
    } catch (err) {
      log.warn({ err: String(err) }, '激活引用消息目标异常');
      return false;
    }
  }

  /**
   * 发送纯文本消息（支持 @ 提及、引用/回复与 DOM 回读验证闭环）
   */
  public async sendText(text: string, options: SendOptions = {}): Promise<SendResult> {
    return this.sendRichText(text, options);
  }

  /**
   * 发送富文本格式化消息（支持 @ 提及、颜色、字号、加粗、斜体、下划线、Markdown 格式）
   */
  public async sendRichText(
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const parsed = parseFormattedTextToKK(content);
    if (!parsed.plainText.trim() && !options.mentions) {
      return { success: false, error: '富文本内容不能为空' };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason} (${check.details})` };
      }
    }

    if (options.replyTo) {
      return this.sendReply(options.replyTo, content, options);
    }

    const mentionNodes = buildMentionNodes(options.mentions);

    const script = `
      (() => {
        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        if (editor && typeof editor.sendMessage === 'function') {
          const contentNodes = [];
          const mentionNodes = ${JSON.stringify(mentionNodes)};
          for (const mn of mentionNodes) {
            contentNodes.push(mn);
            contentNodes.push({ type: 0, text: ' ' });
          }
          if (${JSON.stringify(parsed.plainText)}) {
            contentNodes.push({ type: 0, text: ${JSON.stringify(parsed.plainText)} });
          }

          const payload = {
            type: 'PicText',
            content: contentNodes,
            font: ${JSON.stringify(parsed.font)}
          };
          editor.sendMessage(payload);
          return { success: true, method: 'vue_native_pictext' };
        }

        // 降级回退
        const input = document.querySelector('${this.selectors.inputBox}') || document.querySelector('.chat-sendArea');
        if (!input) return { success: false, error: '未找到输入框元素' };

        input.focus();
        input.textContent = ${JSON.stringify(parsed.plainText)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        const sendBtn = document.querySelector('.sendMsg-btn a.button') ||
          document.querySelector('${this.selectors.sendButton}') ||
          document.querySelector('.sendMsg-btn');
        if (sendBtn) {
          if (typeof sendBtn.click === 'function') sendBtn.click();
          else sendBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return { success: true, method: 'dom_click' };
        }

        return { success: false, error: '未找到发送按钮' };
      })()
    `;

    const startTime = Date.now();
    try {
      await this.cdp.bringToFront();

      const injectRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!injectRes?.success) {
        return { success: false, error: injectRes?.error || '注入富文本失败' };
      }

      const verifyTimeout = options.verifyTimeoutMs ?? 5000;
      const verified = await this.verifyTextSent(parsed.plainText || '@', verifyTimeout);
      const latency = Date.now() - startTime;

      if (!verified) {
        log.warn({ text: parsed.plainText, latency }, '富文本已发送但在回读超时内未能确认上屏');
        return {
          success: false,
          error: '富文本已触发发送但在指定超时内未能确认消息上屏',
          verifyLatencyMs: latency,
        };
      }
      const messageId =
        (await this.fetchLastSentMessageId(parsed.plainText)) ||
        (await this.fetchLastSentMessageId()) ||
        `msg_${Date.now()}`;
      return {
        success: true,
        messageId,
        recall: () => this.recallMessage(messageId, options.targetSessionId),
        verifyLatencyMs: latency,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送富文本异常');
      throw new SendError(`发送富文本异常: ${errorMsg}`, err instanceof Error ? err : undefined);
    }
  }

  /**
   * 发送回复/引用消息
   */
  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options: SendOptions = {}
  ): Promise<SendResult> {
    const parsed = parseFormattedTextToKK(content);
    if (!parsed.plainText.trim()) {
      return { success: false, error: '回复内容不能为空' };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason} (${check.details})` };
      }
    }

    const targetObj =
      typeof replyTo === 'string' ? { content: replyTo, messageId: replyTo } : replyTo;
    const mentionNodes = buildMentionNodes(options.mentions);

    const script = `
      (() => {
        const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
        if (!editor || typeof editor.sendMessage !== 'function') {
          return { success: false, error: '未找到编辑器实例' };
        }

        const target = ${JSON.stringify(targetObj)};
        const mentionNodes = ${JSON.stringify(mentionNodes)};

        // 在 DOM 或 Vue 中查找被引用的目标消息
        let targetMsg = null;
        const msgItems = Array.from(document.querySelectorAll('.rcd-item, .message-item, .msg-item'));
        for (let i = msgItems.length - 1; i >= 0; i--) {
          const item = msgItems[i];
          const vMsg = item.__vue__?.msgitem || item.__vue__?.message;
          const text = item.textContent || '';
          if (vMsg && (vMsg.id == target.messageId || (target.content && text.includes(target.content)))) {
            targetMsg = vMsg;
            break;
          }
        }

        if (!targetMsg && editor.activedSes?.lastMessage) {
          targetMsg = editor.activedSes.lastMessage;
        }

        const replyContentNodes = [];
        for (const mn of mentionNodes) {
          replyContentNodes.push(mn);
          replyContentNodes.push({ type: 0, text: ' ' });
        }
        replyContentNodes.push({ type: 0, text: ${JSON.stringify(parsed.plainText)} });

        if (targetMsg) {
          const replyPayload = {
            type: 'Reply',
            replyedID: targetMsg.sender || 0,
            replyedName: targetMsg.senderName || '',
            replyedNameEN: targetMsg.senderNameEN || targetMsg.senderName || '',
            replyedNameTC: targetMsg.senderNameTC || targetMsg.senderName || '',
            replyedMsgId: targetMsg.id || 0,
            replyedMsgIndex: targetMsg.msgIdx || 0,
            replyedContentType: targetMsg.contentType || 4,
            replyedContent: targetMsg.content?.replyContent || targetMsg.content || '',
            replyContent: {
              content: replyContentNodes,
              font: ${JSON.stringify(parsed.font)}
            }
          };
          editor.sendMessage(replyPayload);
          if (typeof editor.cancelReply === 'function') editor.cancelReply();
          return { success: true, method: 'vue_native_reply' };
        } else {
          // 兜底发送带样式的 PicText
          const payload = {
            type: 'PicText',
            content: replyContentNodes,
            font: ${JSON.stringify(parsed.font)}
          };
          editor.sendMessage(payload);
          return { success: true, method: 'vue_native_pictext_fallback' };
        }
      })()
    `;

    const startTime = Date.now();
    try {
      await this.cdp.bringToFront();

      const sendRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(script);
      if (!sendRes?.success) {
        return { success: false, error: sendRes?.error || '发送回复消息失败' };
      }

      const verifyTimeout = options.verifyTimeoutMs ?? 5000;
      const verified = await this.verifyTextSent(parsed.plainText, verifyTimeout);
      const latency = Date.now() - startTime;

      if (!verified) {
        log.warn({ text: parsed.plainText, latency }, '回复消息已发送但在回读超时内未能确认上屏');
        return {
          success: false,
          error: '回复消息已触发发送但在指定超时内未能确认消息上屏',
          verifyLatencyMs: latency,
        };
      }
      const messageId =
        (await this.fetchLastSentMessageId(parsed.plainText)) ||
        (await this.fetchLastSentMessageId()) ||
        `msg_${Date.now()}`;
      return {
        success: true,
        messageId,
        recall: () => this.recallMessage(messageId, options.targetSessionId),
        verifyLatencyMs: latency,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送回复消息异常');
      throw new SendError(`发送回复消息异常: ${errorMsg}`, err instanceof Error ? err : undefined);
    }
  }

  /**
   * 发送本地文件（通过 KK9 原生 File 协议分发并验证回读）
   */
  public async sendFile(filePath: string, options: SendFileOptions = {}): Promise<SendResult> {
    const fullPath = path.resolve(filePath);
    if (!fs.existsSync(fullPath)) {
      return { success: false, error: `文件不存在: ${fullPath}` };
    }

    const stats = fs.statSync(fullPath);
    if (stats.isDirectory()) {
      return { success: false, error: `不能发送目录: ${fullPath}` };
    }
    if (stats.size > MAX_FILE_SIZE_BYTES) {
      return { success: false, error: `文件大小超出限制 (100MB): ${stats.size} bytes` };
    }

    if (options.targetSessionId) {
      const check = await this.checkPreSendState(options.targetSessionId);
      if (!check.canSend) {
        return { success: false, error: `发送前检查未通过: ${check.reason}` };
      }
    }

    const fileName = path.basename(fullPath);
    const mimeType = mime.lookup(fullPath) || 'application/octet-stream';
    const startTime = Date.now();

    try {
      await this.cdp.bringToFront();

      // 原生 Vue File 协议分发
      const injectScript = `
        (() => {
          const editor = document.querySelector('.chat-editor, .chat-sendArea')?.__vue__;
          if (editor && typeof editor.sendMessage === 'function') {
            const filePayload = {
              type: 'File',
              mimetype: ${JSON.stringify(mimeType)},
              filepath: ${JSON.stringify(fullPath)},
              size: ${JSON.stringify(String(stats.size))},
              isValid: true,
              filename: ${JSON.stringify(fileName)}
            };
            editor.sendMessage(filePayload);
            return { success: true, method: 'vue_native_file_send' };
          }

          return { success: false, error: '未找到编辑器实例' };
        })()
      `;

      const injectRes = await this.cdp.evaluate<{ success: boolean; error?: string }>(injectScript);
      if (!injectRes?.success) {
        return { success: false, error: injectRes?.error || '文件发送初始化失败' };
      }

      const verifyTimeout = options.verifyTimeoutMs ?? 8000;
      const verified = await this.verifyFileSent(fileName, verifyTimeout);
      const latency = Date.now() - startTime;

      if (!verified) {
        log.warn({ fileName, latency }, '文件已发送但在指定时间内未能在聊天区域确认文件卡片');
        return {
          success: false,
          error: '文件已触发发送但在指定超时内未能确认文件卡片上屏',
          verifyLatencyMs: latency,
        };
      }
      const messageId = (await this.fetchLastSentMessageId()) || `msg_${Date.now()}`;
      return {
        success: true,
        messageId,
        recall: () => this.recallMessage(messageId, options.targetSessionId),
        verifyLatencyMs: latency,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送文件异常');
      throw new SendError(`发送文件异常: ${errorMsg}`, err instanceof Error ? err : undefined);
    }
  }

  /**
   * 发送本地图片（通过渲染进程 Clipboard API 写入与跨平台按键模拟）
   */
  public async sendImage(imagePath: string, options: SendOptions = {}): Promise<SendResult> {
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

      await sleep(400);

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
      const messageId = (await this.fetchLastSentMessageId()) || `msg_${Date.now()}`;
      return {
        success: true,
        messageId,
        recall: () => this.recallMessage(messageId, options.targetSessionId),
        verifyLatencyMs: latency,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送图片异常');
      throw new SendError(`发送图片异常: ${errorMsg}`, err instanceof Error ? err : undefined);
    }
  }

  /**
   * 发送 Canvas 2D 视觉卡片（远程 CDP 渲染 -> 临时缓存 -> 图片发送上屏 -> 临时文件安全清理）
   *
   * @param card 卡片结构化数据模型
   * @param options 发送与渲染配置选项
   * @returns 发送结果实体 (含 messageId 与 recall 快捷撤回函数)
   */
  public async sendCard(card: CardData, options: SendCardOptions = {}): Promise<SendResult> {
    let tempFilePath: string | null = null;

    try {
      // 1. 调用 renderCardToBase64 远程渲染生成 Base64 PNG 数据
      const dataUrl = await renderCardToBase64(this.cdp, card, options);
      const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
      const buffer = Buffer.from(base64Data, 'base64');

      // 2. 将 Base64 写入系统临时缓存目录
      const tempDir = path.join(os.tmpdir(), 'kkbot-cards');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }
      tempFilePath = path.join(
        tempDir,
        `card-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`
      );
      fs.writeFileSync(tempFilePath, buffer);

      // 3. 复用已有的 sendImage 进行可靠上屏校验与消息发送
      const result = await this.sendImage(tempFilePath, options);
      return result;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log.error({ err: errorMsg }, '发送 Canvas 视觉卡片异常');
      if (err instanceof SendError) {
        throw err;
      }
      throw new SendError(
        `发送 Canvas 视觉卡片异常: ${errorMsg}`,
        err instanceof Error ? err : undefined
      );
    } finally {
      // 4. 无论成功或失败均安全回收临时图片文件，杜绝磁盘垃圾泄漏
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        try {
          fs.unlinkSync(tempFilePath);
        } catch (cleanupErr) {
          log.warn({ err: String(cleanupErr), path: tempFilePath }, '临时卡片文件清理失败');
        }
      }
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

      await sleep(200);
    }
    return false;
  }

  private async verifyFileSent(fileName: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const script = `
        (() => {
          const targetName = ${JSON.stringify(fileName)};
          const items = document.querySelectorAll('.file-detail-info, .file-name-text, .file-content, .msg-content');
          const lastFew = Array.from(items).slice(-8);
          return lastFew.some(item => {
            return item.textContent && item.textContent.includes(targetName);
          });
        })()
      `;

      try {
        const found = await this.cdp.evaluate<boolean>(script);
        if (found) return true;
      } catch {
        // 忽略轮询临时错误
      }

      await sleep(300);
    }
    return false;
  }

  private async verifyTextSent(text: string, timeoutMs: number): Promise<boolean> {
    const prefix = text.slice(0, 15);
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const script = `
        (() => {
          const items = document.querySelectorAll('${this.selectors.messageItem}');
          const lastFew = Array.from(items).slice(-6);
          return lastFew.some(item => {
            const isMe = item.matches('${this.selectors.messageIsMe}') ||
              item.classList.contains('rcd-msg-right') ||
              item.classList.contains('is-me') ||
              item.querySelector('.rcd-msg-right') !== null;
            const textContent = item.textContent || '';
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawContent = typeof vueMsg?.content === 'string' ? vueMsg.content : JSON.stringify(vueMsg?.content || '');
            return isMe && (textContent.includes(${JSON.stringify(prefix)}) || rawContent.includes(${JSON.stringify(prefix)}));
          });
        })()
      `;
      try {
        const verified = await this.cdp.evaluate<boolean>(script);
        if (verified) return true;
      } catch {
        // 忽略轮询临时错误
      }

      await sleep(200);
    }
    return false;
  }

  /**
   * 获取最后一条自己发送的消息 ID 或指纹
   */
  private async fetchLastSentMessageId(matchingText?: string): Promise<string | undefined> {
    const script = `
      (() => {
        const targetText = ${JSON.stringify(matchingText ? matchingText.slice(0, 30) : '')};
        const items = document.querySelectorAll('${this.selectors.messageItem}');
        for (let i = items.length - 1; i >= 0; i--) {
          const item = items[i];
          const isMe = item.matches('${this.selectors.messageIsMe}') ||
            item.classList.contains('rcd-msg-right') ||
            item.classList.contains('rcd-msg-me') ||
            item.classList.contains('is-me') ||
            item.querySelector('${this.selectors.messageIsMe}') !== null;
          if (isMe) {
            const content = item.querySelector('${this.selectors.messageContent}')?.textContent || item.textContent || '';
            if (!targetText || content.includes(targetText)) {
              const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
              const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');
              if (rawId) return String(rawId).replace(/^msg-/, '');
            }
          }
        }
        return null;
      })()
    `;
    try {
      const rawId = await this.cdp.evaluate<string | null>(script);
      return rawId || undefined;
    } catch {
      return undefined;
    }
  }
  /**
   * 消息撤回 (Recall / CancelMessage)
   * 包含所有权校验与 120 秒时效守卫
   */
  public async recallMessage(messageId: string, sessionId?: string): Promise<boolean> {
    if (!messageId) return false;

    try {
      // 1. 查找目标消息并验证所有权与时效
      const checkScript = `
        (() => {
          const targetId = ${JSON.stringify(messageId)};
          const items = document.querySelectorAll('${this.selectors.messageItem}');
          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');

            const isMe = item.matches('${this.selectors.messageIsMe}') ||
              item.classList.contains('rcd-msg-right') ||
              item.classList.contains('rcd-msg-me') ||
              item.classList.contains('is-me') ||
              item.querySelector('${this.selectors.messageIsMe}') !== null ||
              Boolean(vueMsg?.isMe) ||
              Boolean(vueMsg?.isFromSelf);

            const sender = item.querySelector('${this.selectors.messageSender}')?.textContent?.trim() || vueMsg?.senderName || '';
            const time = item.querySelector('${this.selectors.messageTime}')?.textContent?.trim() || '';
            let sendTime = 0;
            if (vueMsg && vueMsg.sendTime) {
              const n = Number(vueMsg.sendTime);
              sendTime = n < 10000000000 ? n * 1000 : n;
            } else if (vueMsg && vueMsg.time) {
              const p = new Date(vueMsg.time).getTime();
              if (!isNaN(p)) sendTime = p;
            }

            if (targetId && (rawId === targetId || item.id === targetId || String(targetId).includes(String(rawId)) || (rawId && String(rawId).includes(String(targetId))))) {
              return {
                isMe,
                sender,
                time,
                timestamp: sendTime || Date.now(),
              };
            }
          }
          return null;
        })()
      `;

      const msgInfo = await this.cdp.evaluate<{
        isMe: boolean;
        sender?: string;
        time?: string;
        timestamp?: number;
      } | null>(checkScript);

      if (!msgInfo) {
        log.warn({ messageId, sessionId }, '未找到待撤回的目标消息，取消撤回');
        return false;
      }

      // 所有权安全校验：仅允许撤回自己发出的消息
      if (!msgInfo.isMe) {
        log.warn({ messageId, sender: msgInfo.sender }, '尝试撤回非自己发出的消息，安全拦截');
        return false;
      }

      // 时效安全防护：超过 120 秒拒绝撤回
      if (msgInfo.timestamp) {
        let ts = msgInfo.timestamp;
        if (ts < 10_000_000_000) {
          ts *= 1000;
        }
        const elapsedMs = Date.now() - ts;
        if (elapsedMs > 120_000) {
          log.warn({ messageId, elapsedMs }, '消息已超过 2 分钟时效限制，拒绝撤回');
          return false;
        }
      }

      // 2. 执行底层原生撤回 (CancelMessage)
      const recallScript = `
        (async () => {
          const targetId = ${JSON.stringify(messageId)};
          const targetSessionId = ${JSON.stringify(sessionId || '')};

          const items = document.querySelectorAll('${this.selectors.messageItem}');
          let matchedItem = null;
          let matchedVueMsg = null;

          for (let i = items.length - 1; i >= 0; i--) {
            const item = items[i];
            const vueMsg = item.__vue__?.msgitem || item.__vue__?.message;
            const rawId = vueMsg?.id || vueMsg?.msgID || item.getAttribute('id') || item.getAttribute('data-msg-id') || item.getAttribute('data-id');
            const cleanRawId = rawId ? String(rawId).replace(/^msg-/, '') : '';
            const cleanTargetId = String(targetId).replace(/^msg-/, '');

            if (targetId && (rawId === targetId || cleanRawId === cleanTargetId || item.id === targetId || item.id === ('msg-' + targetId))) {
              matchedItem = item;
              matchedVueMsg = vueMsg;
              break;
            }
          }

          const app = document.querySelector('#app')?.__vue__;
          const main = document.querySelector('.main-page')?.__vue__;
          const bus = main?.$bus || app?.$bus;
          const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
          const sesUUID = editor?.activedSes?.sesUUID || targetSessionId;
          const sessionID = matchedVueMsg?.sessionID || editor?.activedSes?.id || targetSessionId;
          const msgID = matchedVueMsg?.id || matchedVueMsg?.msgID || Number(targetId) || targetId;
          const msgIdx = matchedVueMsg?.msgIdx || 0;

          // 优先链路: 通过 Electron ipcRenderer 原生通道发送 cancelMessage 并派发 revokeMsg
          const ipc = window.ipcRenderer || (window.require ? window.require('electron')?.ipcRenderer : null);
          if (ipc && typeof ipc.send === 'function') {
            const key = '__kkbotRecallReqId';
            const current = typeof window[key] === 'number' ? window[key] : 900000;
            window[key] = current + 1;
            const requestId = current + 1;
            const replyChannel = 'data-' + requestId;

            const ipcPromise = new Promise(resolve => {
              ipc.once(replyChannel, (_event, payload) => resolve(payload));
              ipc.send('data', {
                id: requestId,
                args: ['cancelMessage', {
                  type: 'own',
                  sessionID,
                  msgID,
                  msgIdx
                }],
                progress: false
              });
            });

            const ipcRes = await ipcPromise;
            if (ipcRes && (ipcRes.code === 0 || ipcRes.code === undefined)) {
              if (bus && sesUUID) {
                bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
              }
              return { success: true, method: 'ipc_cancelMessage' };
            }
          }

          // 降级链路 1: 通过 Vue chatContent.addRevokeMsg / onCancelMessage
          function findChatContentVm(vm) {
            if (!vm) return null;
            if (vm.$options?._componentTag === 'chat-content' || vm.$options?.name === 'chat-content') return vm;
            if (vm.$children) {
              for (const c of vm.$children) {
                const res = findChatContentVm(c);
                if (res) return res;
              }
            }
            return null;
          }
          const chatContent = findChatContentVm(app);
          if (chatContent && typeof chatContent.addRevokeMsg === 'function') {
            await chatContent.addRevokeMsg({ byAdmin: 0, msgID, msgIdex: msgIdx });
            return { success: true, method: 'chat_content_addRevokeMsg' };
          }

          // 降级链路 2: 通过 $bus 广播
          if (bus && sesUUID) {
            bus.$emit(sesUUID + '-revokeMsg', { msgID, msgIdx });
            bus.$emit('CancelMessage', { byAdmin: 0, event: 'CancelMessage', msgID, msgIdex: msgIdx });
            return { success: true, method: 'bus_revokeMsg' };
          }

          return { success: false, error: '未找到可用的底层撤回通道' };
        })()
      `;

      const res = await this.cdp.evaluate<{ success: boolean; error?: string }>(recallScript);
      return Boolean(res?.success);
    } catch (err) {
      log.error({ err: String(err), messageId }, '执行消息撤回异常');
      return false;
    }
  }
}
