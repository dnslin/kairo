import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { MultiModalRouter } from '../../src/multimodal/router.js';
import type { ConsolidatedMessage } from '../../src/types/index.js';

describe('MultiModalRouter 多模态附件感知与 OCR 降级测试', () => {
  const router = new MultiModalRouter();

  it('应准确检测消息中的本地文件路径、Base64 和 URL 图片', () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '王工',
      content:
        '这是截图 data/media/2026/08/screenshot_01.png 和网络图片 https://example.com/logo.jpg\n还有一张 data:image/png;base64,iVBORw0KGgoAAASUhEUgAA',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          sessionName: '测试群',
          sessionType: 'group',
          sender: '王工',
          content: '这是截图',
          time: '12:00',
          isMe: false,
          timestamp: 1787200000000,
          images: [
            {
              filePath: 'C:\\cache\\images\\diagram.png',
              width: 800,
              height: 600,
              size: 45000,
            },
          ],
        },
      ],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const images = router.detectImages(msg);
    expect(images.length).toBe(4);

    const types = images.map(i => i.type);
    expect(types).toContain('file_path');
    expect(types).toContain('url');
    expect(types).toContain('base64');
  });

  it('安全沙箱约束：正文中出现的任意绝对路径不应被识别为本地文件，仅支持受控 data/media 与 URL', () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '黑客',
      content:
        '尝试读取 C:\\Windows\\System32\\calc.png 和 data/media/../../etc/passwd.png 以及 https://safe.com/pic.png',
      messageCount: 1,
      messages: [],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const images = router.detectImages(msg);
    expect(images.length).toBe(1);
    expect(images[0]?.type).toBe('url');
    expect(images[0]?.data).toBe('https://safe.com/pic.png');
  });

  it('当主模型支持 Vision 时，应构建标准多模态 Content Parts', async () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '李四',
      content: '请分析这张架构图',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          sessionName: '测试群',
          sessionType: 'group',
          sender: '李四',
          content: '请分析这张架构图',
          time: '12:00',
          isMe: false,
          timestamp: 1787200000000,
          images: [
            {
              url: 'https://images.example.com/arch.png',
            },
          ],
        },
      ],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const result = await router.process(msg, { modelSupportsVision: true });
    expect(result.hasImages).toBe(true);
    expect(result.multiModalParts).toBeDefined();
    expect(result.multiModalParts?.length).toBe(2);
    expect(result.multiModalParts?.[0]).toEqual({
      type: 'text',
      text: '请分析这张架构图',
    });
    expect(result.multiModalParts?.[1]).toEqual({
      type: 'image_url',
      imageUrl: {
        url: 'https://images.example.com/arch.png',
        detail: 'auto',
      },
    });
    expect(result.ocrPerformed).toBe(false);
  });

  it('当主模型支持 Vision 且图片为本地文件时，应自动读取并转换为 Data URI', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-img-test-'));
    const tempImgPath = path.join(tempDir, 'test.png');
    const samplePngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fs.writeFileSync(tempImgPath, Buffer.from(samplePngBase64, 'base64'));

    try {
      const msg: ConsolidatedMessage = {
        sessionId: 'sess_1',
        sessionName: '测试群',
        sessionType: 'group',
        sender: '李四',
        content: '请看本地图片',
        messageCount: 1,
        messages: [
          {
            id: 'm1',
            sessionId: 'sess_1',
            sessionName: '测试群',
            sessionType: 'group',
            sender: '李四',
            content: '请看本地图片',
            time: '12:00',
            isMe: false,
            timestamp: 1787200000000,
            images: [
              {
                filePath: tempImgPath,
              },
            ],
          },
        ],
        firstReceivedAt: 1787200000000,
        lastReceivedAt: 1787200000000,
        messageIds: ['m1'],
      };

      const result = await router.process(msg, { modelSupportsVision: true });
      expect(result.hasImages).toBe(true);
      expect(result.multiModalParts?.length).toBe(2);
      const imgPart = result.multiModalParts?.[1];
      expect(imgPart?.type).toBe('image_url');
      if (imgPart?.type === 'image_url') {
        expect(imgPart.imageUrl.url.startsWith('data:image/png;base64,')).toBe(true);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('当 KK9ImageInfo 传入 file:// URL 时，应正确将其解析并读取转为 Data URI', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-file-url-'));
    const tempImgPath = path.join(tempDir, 'file_url_test.png');
    const samplePngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fs.writeFileSync(tempImgPath, Buffer.from(samplePngBase64, 'base64'));

    try {
      const fileUrl = `file:///${tempImgPath.replace(/\\/g, '/')}`;
      const msg: ConsolidatedMessage = {
        sessionId: 'sess_1',
        sessionName: '测试群',
        sessionType: 'group',
        sender: '李四',
        content: '请看 file:// 图片',
        messageCount: 1,
        messages: [
          {
            id: 'm1',
            sessionId: 'sess_1',
            sessionName: '测试群',
            sessionType: 'group',
            sender: '李四',
            content: '请看 file:// 图片',
            time: '12:00',
            isMe: false,
            timestamp: 1787200000000,
            images: [
              {
                url: fileUrl,
              },
            ],
          },
        ],
        firstReceivedAt: 1787200000000,
        lastReceivedAt: 1787200000000,
        messageIds: ['m1'],
      };

      const result = await router.process(msg, { modelSupportsVision: true });
      expect(result.hasImages).toBe(true);
      expect(result.multiModalParts?.length).toBe(2);
      const imgPart = result.multiModalParts?.[1];
      expect(imgPart?.type).toBe('image_url');
      if (imgPart?.type === 'image_url') {
        expect(imgPart.imageUrl.url.startsWith('data:image/png;base64,')).toBe(true);
        expect(imgPart.imageUrl.url.startsWith('file://')).toBe(false);
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
  it('当本地图片文件不存在时，不应在 Vision payload 中注入裸本地路径，应优雅跳过并提示', async () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '李四',
      content: '请看这张不存在的本地图片',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          sessionName: '测试群',
          sessionType: 'group',
          sender: '李四',
          content: '请看这张不存在的本地图片',
          time: '12:00',
          isMe: false,
          timestamp: 1787200000000,
          images: [
            {
              filePath: 'C:\\non_existent_dir_12345\\missing_image.png',
            },
          ],
        },
      ],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const result = await router.process(msg, { modelSupportsVision: true });
    expect(result.hasImages).toBe(true);
    // 因为图片不存在且没有成功转为 Data URI，不应生成 image_url 节点
    expect(result.multiModalParts).toBeUndefined();
    // 文本上下文应包含缺失提示
    expect(result.enhancedContent).toContain('missing_image.png');
    expect(result.enhancedContent).toContain('本地图片文件不存在或无法读取，已跳过视觉输入');
  });

  it('当主模型为纯文本模型时，应调用 OCR 引擎降级提取文字并注入提示词', async () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '赵六',
      content: '帮忙看看报错截图',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          sessionName: '测试群',
          sessionType: 'group',
          sender: '赵六',
          content: '帮忙看看报错截图',
          time: '12:00',
          isMe: false,
          timestamp: 1787200000000,
          images: [
            {
              filePath: 'C:\\images\\error_log.png',
            },
          ],
        },
      ],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const mockOcrEngine = () => {
      return Promise.resolve({
        text: 'Error 500: Database connection pool exhausted',
        confidence: 0.98,
      });
    };

    const result = await router.process(msg, {
      modelSupportsVision: false,
      ocrEngine: mockOcrEngine,
    });

    expect(result.hasImages).toBe(true);
    expect(result.ocrPerformed).toBe(true);
    expect(result.ocrResults.length).toBe(1);
    expect(result.ocrResults[0]?.text).toContain('Database connection pool exhausted');
    expect(result.enhancedContent).toContain('帮忙看看报错截图');
    expect(result.enhancedContent).toContain('[用户附件数据 - 图片文字识别 [error_log.png]]:');
    expect(result.enhancedContent).toContain('Error 500: Database connection pool exhausted');
  });

  it('当没有 OCR 引擎且为纯文本模型时，应注入图片占位提示信息', async () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '赵六',
      content: '发了张图 data/media/pic.png',
      messageCount: 1,
      messages: [],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const result = await router.process(msg, { modelSupportsVision: false });
    expect(result.hasImages).toBe(true);
    expect(result.ocrPerformed).toBe(true);
    expect(result.enhancedContent).toContain(
      '[用户附件数据 - 图片附件] pic.png (注: 当前推理模型为纯文本模型，OCR 未提取到文字内容)'
    );
  });

  it('应同时支持文件卡片与多模态图片的联合增强', async () => {
    const msg: ConsolidatedMessage = {
      sessionId: 'sess_1',
      sessionName: '测试群',
      sessionType: 'group',
      sender: '周七',
      content: '附件已发送',
      messageCount: 1,
      messages: [
        {
          id: 'm1',
          sessionId: 'sess_1',
          sessionName: '测试群',
          sessionType: 'group',
          sender: '周七',
          content: '附件已发送',
          time: '12:00',
          isMe: false,
          timestamp: 1787200000000,
          fileInfo: {
            fileName: '财务对账单.xlsx',
            fileSize: '5.2MB',
          },
          images: [
            {
              url: 'https://cdn.example.com/sign.png',
            },
          ],
        },
      ],
      firstReceivedAt: 1787200000000,
      lastReceivedAt: 1787200000000,
      messageIds: ['m1'],
    };

    const result = await router.process(msg, { modelSupportsVision: true });
    expect(result.hasFileCards).toBe(true);
    expect(result.hasImages).toBe(true);
    expect(result.enhancedContent).toContain('财务对账单.xlsx (5.2MB) [电子表格/数据分析]');
    expect(result.multiModalParts?.length).toBe(2);
  });
});
