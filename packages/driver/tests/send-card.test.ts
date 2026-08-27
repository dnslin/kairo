import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import { SendOps } from '../src/dom/send-ops.js';
import { KK9Driver } from '../src/driver.js';
import type {
  AlertCardParams,
  CardData,
  DecisionCardParams,
  ReportCardParams,
  SendCardOptions,
  SendResult,
} from '../src/types/index.js';
import { SendError } from '../src/utils/errors.js';

describe('SendOps & KK9Driver Canvas 视觉卡片发送流水线测试', () => {
  const dummyBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const dummyDataUrl = `data:image/png;base64,${dummyBase64}`;

  const validCard: CardData = {
    header: {
      title: '测试决策卡片',
      subtitle: '自动化测试',
      icon: '📌',
    },
    fields: [
      { label: '发起人', value: '张三' },
      { label: '事项', value: '发布生产版本' },
    ],
    actions: [{ text: '选择方案', variant: 'primary', replyCommand: '1' }],
  };

  describe('SendOps.sendCard', () => {
    it('sendCard 成功渲染、生成临时文件、发送并安全回收临时文件', async () => {
      let createdTempFilePath: string | null = null;
      let fileExistedDuringSend = false;

      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation((script: string) => {
          // 1. Canvas 渲染脚本 evaluate
          if (script.includes('toDataURL')) {
            return dummyDataUrl;
          }
          // 2. 剪贴板写入 evaluate
          if (script.includes('navigator.clipboard.write')) {
            // 此时临时文件应该已被写入磁盘
            const tempDir = path.join(os.tmpdir(), 'kkbot-cards');
            if (fs.existsSync(tempDir)) {
              const files = fs.readdirSync(tempDir);
              const cardFiles = files.filter(f => f.startsWith('card-') && f.endsWith('.png'));
              if (cardFiles.length > 0) {
                fileExistedDuringSend = true;
                createdTempFilePath = path.join(tempDir, cardFiles[0]!);
              }
            }
            return { success: true };
          }
          // 3. 等待输入框图片挂载 evaluate
          if (script.includes('chat-sendArea') && script.includes('ready: true')) {
            return { ready: true };
          }
          // 4. 点击发送按钮 evaluate
          if (script.includes('sendMsg-btn') || script.includes('button')) {
            return { success: true };
          }
          // 5. 回读校验（输入框清空）
          if (script.includes('hasImgInInput')) {
            return true;
          }
          // 6. 获取最后发送消息 ID
          if (script.includes('getLastSentMessageId') || script.includes('rcd-item')) {
            return 'msg_card_12345';
          }
          return true;
        }),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendCard(validCard);

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
      expect(fileExistedDuringSend).toBe(true);

      // 发送完成后临时文件必须已被删除回收
      if (createdTempFilePath) {
        expect(fs.existsSync(createdTempFilePath)).toBe(false);
      }
    });

    it('sendCard 成功后执行 recall() 能够正确触发消息撤回', async () => {
      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('toDataURL')) return dummyDataUrl;
          if (script.includes('navigator.clipboard.write')) return { success: true };
          if (script.includes('ready: true')) return { ready: true };
          if (script.includes('sendMsg-btn')) return { success: true };
          if (script.includes('hasImgInInput')) return true;
          if (
            script.includes('fetchLastSentMessageId') ||
            script.includes('getLastSentMessageId') ||
            (script.includes('rcd-item') && !script.includes('isMe'))
          ) {
            return 'msg_card_recall_test';
          }
          // 撤回所有权与时效校验脚本 (checkScript)
          if (script.includes('isMe') && script.includes('sendTime')) {
            return { isMe: true, sender: '我', time: '12:00', timestamp: Date.now() - 1000 };
          }
          // 底层原生撤回脚本 (recallScript)
          if (
            script.includes('cancelMsg') ||
            script.includes('CancelMessage') ||
            script.includes('delMsg')
          ) {
            return { success: true, method: 'vue_native_cancel' };
          }
          return { success: true };
        }),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendCard(validCard);

      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
      expect(res.recall).toBeUndefined();
    });

    it('CDP 渲染 Canvas 失败时应抛出 SendError 并且不残留临时文件', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockRejectedValue(new Error('CDP Context destroyed')),
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);

      await expect(ops.sendCard(validCard)).rejects.toThrow(SendError);

      const tempDir = path.join(os.tmpdir(), 'kkbot-cards');
      if (fs.existsSync(tempDir)) {
        const files = fs.readdirSync(tempDir).filter(f => f.startsWith('card-'));
        expect(files.length).toBe(0);
      }
    });

    it('剪贴板写入或发送失败时应安全回收临时文件并返回失败结果', async () => {
      let recordedTempFile: string | null = null;

      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('toDataURL')) return dummyDataUrl;
          if (script.includes('navigator.clipboard.write')) {
            const tempDir = path.join(os.tmpdir(), 'kkbot-cards');
            if (fs.existsSync(tempDir)) {
              const files = fs.readdirSync(tempDir).filter(f => f.startsWith('card-'));
              if (files.length > 0) recordedTempFile = path.join(tempDir, files[0]!);
            }
            return { success: false, error: 'Clipboard write permission denied' };
          }
          return true;
        }),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendCard(validCard);

      expect(res.success).toBe(false);
      expect(res.error).toContain('剪贴板写入失败');

      if (recordedTempFile) {
        expect(fs.existsSync(recordedTempFile)).toBe(false);
      }
    });

    it('前置会话检查不匹配时应中止发送并清理临时文件', async () => {
      const mockCdp = {
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('toDataURL')) return dummyDataUrl;
          if (script.includes('findVueSessionItem')) {
            return { canSend: false, reason: 'session_switched' };
          }
          return true;
        }),
        bringToFront: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const res = await ops.sendCard(validCard, { targetSessionId: 'ses_mismatch' });

      expect(res.success).toBe(false);
      expect(res.error).toContain('发送前检查未通过');
    });

    it('透传 options 渲染参数与回复/提及参数', async () => {
      let capturedScript = '';
      const mockCdp = {
        bringToFront: vi.fn().mockResolvedValue(undefined),
        evaluate: vi.fn().mockImplementation((script: string) => {
          if (script.includes('toDataURL')) {
            capturedScript = script;
            return dummyDataUrl;
          }
          if (script.includes('navigator.clipboard.write')) return { success: true };
          if (script.includes('ready: true')) return { ready: true };
          if (script.includes('sendMsg-btn')) return { success: true };
          if (script.includes('hasImgInInput')) return true;
          return 'msg_card_opt_test';
        }),
        dispatchKeyEvent: vi.fn().mockResolvedValue(undefined),
      } as unknown as CdpClient;

      const ops = new SendOps(mockCdp, DEFAULT_SELECTORS);
      const options: SendCardOptions = {
        dpr: 3,
        width: 520,
        backgroundColor: '#F7F8FA',
        verifyTimeoutMs: 3000,
        replyTo: { messageId: 'msg-999', sender: '李四', content: '原始消息' },
      };

      const res = await ops.sendCard(validCard, options);
      expect(res.success).toBe(false);
      expect(res.isPreTrigger).toBe(false);
      expect(res.messageId).toBeUndefined();
      expect(capturedScript).toContain('"dpr":3');
      expect(capturedScript).toContain('"width":520');
      expect(capturedScript).toContain('"backgroundColor":"#F7F8FA"');
    });
  });

  describe('KK9Driver 卡片高层方法与模板快捷发送', () => {
    it('driver.sendCard 应委托至 sendOps.sendCard', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
      });

      const internal = driver as unknown as {
        sendOps: { sendCard: (card: CardData, options?: SendCardOptions) => Promise<SendResult> };
      };
      internal.sendOps.sendCard = vi
        .fn()
        .mockResolvedValue({ success: true, messageId: 'msg_001' });

      const options: SendCardOptions = { width: 480 };
      const res = await driver.sendCard(validCard, options);

      expect(res.success).toBe(true);
      expect(internal.sendOps.sendCard).toHaveBeenCalledWith(validCard, options);
    });

    it('driver.sendAlertCard 自动构建告警卡片并发送', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
      });

      const internal = driver as unknown as {
        sendOps: { sendCard: (card: CardData, options?: SendCardOptions) => Promise<SendResult> };
      };
      internal.sendOps.sendCard = vi
        .fn()
        .mockResolvedValue({ success: true, messageId: 'msg_alert_01' });

      const params: AlertCardParams = {
        title: 'Redis 内存水位过高告警',
        severity: 'critical',
        service: 'cache-cluster-01',
        metrics: [{ name: 'Memory Usage', value: '96.8%', threshold: '85%' }],
      };

      const res = await driver.sendAlertCard(params);
      expect(res.success).toBe(true);
      expect(internal.sendOps.sendCard).toHaveBeenCalledOnce();

      const calledCard = vi.mocked(internal.sendOps.sendCard).mock.calls[0]![0];
      expect(calledCard.header.title).toBe('Redis 内存水位过高告警');
      expect(calledCard.theme).toBe('danger');
    });

    it('driver.sendReportCard 自动构建报告卡片并发送', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
      });

      const internal = driver as unknown as {
        sendOps: { sendCard: (card: CardData, options?: SendCardOptions) => Promise<SendResult> };
      };
      internal.sendOps.sendCard = vi
        .fn()
        .mockResolvedValue({ success: true, messageId: 'msg_rep_01' });

      const params: ReportCardParams = {
        title: '每日构建巡检报告',
        status: 'success',
        duration: '42s',
        metrics: [{ label: '通过率', value: '100%' }],
      };

      const res = await driver.sendReportCard(params);
      expect(res.success).toBe(true);
      expect(internal.sendOps.sendCard).toHaveBeenCalledOnce();

      const calledCard = vi.mocked(internal.sendOps.sendCard).mock.calls[0]![0];
      expect(calledCard.header.title).toBe('每日构建巡检报告');
      expect(calledCard.theme).toBe('success');
    });

    it('driver.sendDecisionCard 自动构建决策卡片并发送', async () => {
      const driver = new KK9Driver({
        cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
      });

      const internal = driver as unknown as {
        sendOps: { sendCard: (card: CardData, options?: SendCardOptions) => Promise<SendResult> };
      };
      internal.sendOps.sendCard = vi
        .fn()
        .mockResolvedValue({ success: true, messageId: 'msg_dec_01' });

      const params: DecisionCardParams = {
        title: '技术选型决策评审',
        options: [
          { key: '1', title: '方案 A: 自研架构', recommended: true },
          { key: '2', title: '方案 B: 开源托管' },
        ],
      };

      const res = await driver.sendDecisionCard(params);
      expect(res.success).toBe(true);
      expect(internal.sendOps.sendCard).toHaveBeenCalledOnce();

      const calledCard = vi.mocked(internal.sendOps.sendCard).mock.calls[0]![0];
      expect(calledCard.header.title).toBe('技术选型决策评审');
      expect(calledCard.actions?.length).toBe(2);
    });
  });
});
