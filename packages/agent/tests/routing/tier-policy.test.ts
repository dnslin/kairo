import { describe, it, expect } from 'vitest';
import { resolveModelTier, type NormalizedModelTierInput } from '../../src/routing/tier-policy.js';

const RULES_VERSION = 'v1.0';

describe('ModelTierPolicy (resolveModelTier)', () => {
  describe('Rule 1: 视觉能力优先 (VISION)', () => {
    it('视觉模态附件缺少完整可信文本表示时，稳定返回 VISION', () => {
      const input: NormalizedModelTierInput = {
        text: '请查看这个文件',
        attachments: [
          {
            mediaType: 'image/png',
            filename: 'screenshot.png',
            isVisual: true,
            hasCompleteTrustedText: false,
          },
        ],
      };
      expect(resolveModelTier(input, RULES_VERSION)).toBe('VISION');
    });

    it('仅提供 mediaType: image/png 或 image 扩展名且无 isVisual 时，稳定识别为视觉模态并返回 VISION', () => {
      const inputMimeOnly: NormalizedModelTierInput = {
        text: '请查看这个文件',
        attachments: [
          {
            mediaType: 'image/png',
            hasCompleteTrustedText: false,
          },
        ],
      };
      expect(resolveModelTier(inputMimeOnly, RULES_VERSION)).toBe('VISION');

      const inputExtOnly: NormalizedModelTierInput = {
        text: '请查看这个文件',
        attachments: [
          {
            filename: 'photo.jpeg',
            hasCompleteTrustedText: false,
          },
        ],
      };
      expect(resolveModelTier(inputExtOnly, RULES_VERSION)).toBe('VISION');
    });

    it('文本明确要求分析图片内容、图表关系、颜色、位置或版面时，稳定返回 VISION', () => {
      const inputs: NormalizedModelTierInput[] = [
        { text: '请分析这张图表中的趋势关系' },
        { text: '帮我看看这个UI截图中的按钮颜色和排版布局' },
        { text: '识别图片中的文字并分析版面位置' },
      ];

      for (const input of inputs) {
        expect(resolveModelTier(input, RULES_VERSION)).toBe('VISION');
      }
    });
    it('普通英文单词中包含 ui/guide/fruit 字符时不误判为视觉意图', () => {
      // guide me, build a service -> 包含 ui 字母组合，但不为独立的视觉 UI 关键词
      expect(resolveModelTier({ text: 'guide me to build a service' }, RULES_VERSION)).toBe('DEEP');
    });

    it('普通纯文本附件不会因附件存在而错误选择 VISION', () => {
      const input: NormalizedModelTierInput = {
        text: '你好',
        attachments: [
          {
            mediaType: 'text/plain',
            filename: 'notes.txt',
            isVisual: false,
            hasCompleteTrustedText: true,
            trustedText: '会议记录',
          },
        ],
      };
      // 简单问候 + 纯文本附件 -> FAST
      expect(resolveModelTier(input, RULES_VERSION)).toBe('FAST');
    });
    it('视觉附件若已具备完整可信文本表示且文本未要求视觉属性，不得仅因是附件而进入 VISION', () => {
      const input: NormalizedModelTierInput = {
        text: '查询张三的主管',
        attachments: [
          {
            mediaType: 'image/png',
            filename: 'doc-scan.png',
            isVisual: true,
            hasCompleteTrustedText: true, // 已有完整 OCR/可信文本
            trustedText: '员工查询单：张三',
          },
        ],
      };
      // 组织查询且不需要视觉属性 -> FAST
      expect(resolveModelTier(input, RULES_VERSION)).toBe('FAST');
    });
  });

  describe('Rule 2: 显式复杂文本规则 (DEEP)', () => {
    it('代码分析、复杂推理和多步骤方案综合等显式复杂文本返回 DEEP', () => {
      const inputs: NormalizedModelTierInput[] = [
        { text: '请帮我做一段 TypeScript 代码重构和架构设计方案' },
        { text: '分析这个分布式系统在高并发场景下的死锁原因和复杂推理' },
        { text: '制定一个跨部门多步骤系统迁移方案并综合各方影响' },
      ];

      for (const input of inputs) {
        expect(resolveModelTier(input, RULES_VERSION)).toBe('DEEP');
      }
    });
  });

  describe('Rule 3: 显式简单文本规则 (FAST)', () => {
    it('简单问候、直接组织查询和简单操作性请求返回 FAST', () => {
      const inputs: NormalizedModelTierInput[] = [
        { text: '你好' },
        { text: '早上好！' },
        { text: 'Hi, hello' },
        { text: '查询员工李四的所属部门' },
        { text: '查一下王五的直属主管是谁' },
      ];

      for (const input of inputs) {
        expect(resolveModelTier(input, RULES_VERSION)).toBe('FAST');
      }
    });
  });

  describe('Rule 4: 唯一默认路径 (DEEP)', () => {
    it('未命中显式规则的未知文本，固定默认选择 DEEP', () => {
      const inputs: NormalizedModelTierInput[] = [
        { text: '把今天讨论的纪要整理一下发给我' },
        { text: '明天上午十点准备一个会议室' },
        { text: '一些未知的业务咨询内容' },
        { text: 'hello explain quantum physics' }, // 问候后跟随复杂/未知请求，不误走纯问候 FAST
      ];

      for (const input of inputs) {
        expect(resolveModelTier(input, RULES_VERSION)).toBe('DEEP');
      }
    });
  });

  describe('优先级与冲突解决', () => {
    it('VISION 优先于 DEEP：当文本同时包含复杂分析与视觉属性需求时，选择 VISION', () => {
      const input: NormalizedModelTierInput = {
        text: '请分析这张架构图的复杂推理和代码实现',
      };
      expect(resolveModelTier(input, RULES_VERSION)).toBe('VISION');
    });

    it('DEEP 优先于 FAST：当文本同时包含问候与复杂代码分析时，选择 DEEP', () => {
      const input: NormalizedModelTierInput = {
        text: '你好，请帮我分析这段复杂的分布式系统代码并重构架构设计',
      };
      expect(resolveModelTier(input, RULES_VERSION)).toBe('DEEP');
    });
  });

  describe('确定性与纯函数契约', () => {
    it('相同规范化输入和同一 rulesVersion 多次运行必须得到严格相同的结果', () => {
      const input: NormalizedModelTierInput = {
        text: '查询员工张三的电话',
      };

      const results = Array.from({ length: 20 }, () => resolveModelTier(input, RULES_VERSION));
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe('FAST');
    });
  });
});
