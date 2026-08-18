import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { MessageOps, readImageAsBase64, saveImageToFile } from '../src/dom/message-ops.js';
import { DEFAULT_SELECTORS } from '../src/dom/selectors.js';
import type { KK9ImageInfo } from '../src/types/index.js';

describe('MessageOps 消息指纹与解析测试', () => {
  describe('generateFingerprint', () => {
    it('相同输入应生成完全相同的 SHA-256 指纹', () => {
      const fp1 = MessageOps.generateFingerprint('session_123', '张三', '10:00', '你好');
      const fp2 = MessageOps.generateFingerprint('session_123', '张三', '10:00', '你好');
      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64);
    });

    it('不同字段组合使用空字符隔离，不应产生哈希碰撞', () => {
      const fpA = MessageOps.generateFingerprint('session_1', '2张三', '10:00', '你好');
      const fpB = MessageOps.generateFingerprint('session_12', '张三', '10:00', '你好');
      expect(fpA).not.toBe(fpB);
    });

    it('时间或内容微小变动指纹应彻底改变', () => {
      const fp1 = MessageOps.generateFingerprint('session_1', '张三', '10:00', '你好');
      const fp2 = MessageOps.generateFingerprint('session_1', '张三', '10:01', '你好');
      expect(fp1).not.toBe(fp2);
    });
  });

  describe('readImageAsBase64 and saveImageToFile', () => {
    it('应能正确将图片读取为 Base64 Data URL 并另存为指定路径', () => {
      const tmpSrc = path.resolve('tmp_test_src.png');
      const tmpDst = path.resolve('tmp_test_dst.png');
      fs.writeFileSync(tmpSrc, Buffer.from('fake_png_data'));

      try {
        const imageInfo: KK9ImageInfo = {
          filePath: tmpSrc,
          mimeType: 'image/png',
        };

        const base64 = readImageAsBase64(imageInfo);
        expect(base64).toContain('data:image/png;base64,');

        const saved = saveImageToFile(imageInfo, tmpDst);
        expect(saved).toBe(true);
        expect(fs.existsSync(tmpDst)).toBe(true);
      } finally {
        if (fs.existsSync(tmpSrc)) fs.unlinkSync(tmpSrc);
        if (fs.existsSync(tmpDst)) fs.unlinkSync(tmpDst);
      }
    });

    it('不存在的文件应安全返回 null / false', () => {
      const imageInfo: KK9ImageInfo = {
        filePath: './non_existent_path_xyz.png',
      };

      expect(readImageAsBase64(imageInfo)).toBeNull();
      expect(saveImageToFile(imageInfo, './anywhere.png')).toBe(false);
    });
  });

  describe('getRecentMessages 群聊、多人@提及、引用回复、图文混排与文件卡片解析', () => {
    it('应正确解析群聊消息发送者、UID与多人@提及信息', async () => {
      const mockRawMessages = [
        {
          sender: '群员李四',
          senderId: 'user_456',
          time: '14:20',
          content: '@机器人 @陈鹏 @王治 请查一下报表',
          isMe: false,
          messageType: 'text',
          atMe: true,
          atAll: false,
          mentions: {
            isAtMe: true,
            isAtAll: false,
            mentionedUsers: ['机器人', '陈鹏', '王治'],
          },
        },
      ];

      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue(mockRawMessages),
      } as unknown as CdpClient;

      const ops = new MessageOps(mockCdp, DEFAULT_SELECTORS);
      const messages = await ops.getRecentMessages(10, {
        id: 'group_999',
        name: '测试123',
        type: 'group',
        unread: true,
      });

      expect(messages).toHaveLength(1);
      const msg = messages[0]!;
      expect(msg.sessionId).toBe('group_999');
      expect(msg.sessionName).toBe('测试123');
      expect(msg.sessionType).toBe('group');
      expect(msg.sender).toBe('群员李四');
      expect(msg.senderId).toBe('user_456');
      expect(msg.atMe).toBe(true);
      expect(msg.mentions?.mentionedUsers).toEqual(['机器人', '陈鹏', '王治']);
      expect(msg.id).toHaveLength(64);
    });

    it('应正确解析图文混排与单图片消息详情', async () => {
      const mockRawMessages = [
        {
          sender: '赵六',
          time: '15:00',
          content: '请查看故障现场截图： [图片]',
          isMe: false,
          messageType: 'rich-text',
          images: [
            {
              filePath: 'C:\\Users\\test\\file-cache\\image\\error_pic.png',
              url: 'file:///C:/Users/test/file-cache/image/error_pic.png',
              width: 1920,
              height: 1080,
              mimeType: 'image/png',
              size: 204800,
            },
          ],
        },
      ];

      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue(mockRawMessages),
      } as unknown as CdpClient;

      const ops = new MessageOps(mockCdp, DEFAULT_SELECTORS);
      const messages = await ops.getRecentMessages(5);

      expect(messages).toHaveLength(1);
      const msg = messages[0]!;
      expect(msg.images).toHaveLength(1);
      expect(msg.images![0]!.filePath).toContain('error_pic.png');
      expect(msg.images![0]!.width).toBe(1920);
      expect(msg.images![0]!.mimeType).toBe('image/png');
    });

    it('应正确解析引用/回复消息元数据', async () => {
      const mockRawMessages = [
        {
          sender: '王五',
          time: '15:30',
          content: '同意这个方案',
          isMe: false,
          messageType: 'quote',
          replyTo: {
            replyToSender: '赵六',
            replyToContent: '建议采用方案B',
            replyToId: 'msg-12345',
          },
        },
      ];

      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue(mockRawMessages),
      } as unknown as CdpClient;

      const ops = new MessageOps(mockCdp, DEFAULT_SELECTORS);
      const messages = await ops.getRecentMessages(5);

      expect(messages).toHaveLength(1);
      const msg = messages[0]!;
      expect(msg.messageType).toBe('quote');
      expect(msg.replyTo?.replyToSender).toBe('赵六');
      expect(msg.replyTo?.replyToContent).toBe('建议采用方案B');
      expect(msg.replyTo?.replyToId).toBe('msg-12345');
    });

    it('应正确解析文件卡片消息', async () => {
      const mockRawMessages = [
        {
          sender: '王五',
          time: '16:00',
          content: '[文件: 需求方案.docx]',
          isMe: false,
          messageType: 'file',
          fileInfo: {
            fileName: '需求方案.docx',
            fileSize: '2.5MB',
            fileExt: 'docx',
          },
        },
      ];

      const mockCdp = {
        evaluate: vi.fn().mockResolvedValue(mockRawMessages),
      } as unknown as CdpClient;

      const ops = new MessageOps(mockCdp, DEFAULT_SELECTORS);
      const messages = await ops.getRecentMessages(5);

      expect(messages).toHaveLength(1);
      const msg = messages[0]!;
      expect(msg.messageType).toBe('file');
      expect(msg.fileInfo?.fileName).toBe('需求方案.docx');
      expect(msg.fileInfo?.fileSize).toBe('2.5MB');
      expect(msg.fileInfo?.fileExt).toBe('docx');
    });
  });
});
