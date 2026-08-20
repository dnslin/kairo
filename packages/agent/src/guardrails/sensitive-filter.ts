import type { SensitiveCheckResult, SensitiveFilterResult } from '../types/index.js';

/**
 * 默认内置越狱/提示词注入匹配正则规则
 */
export const DEFAULT_JAILBREAK_PATTERNS: RegExp[] = [
  /ignore\s+(?:all\s+|previous\s+|above\s+|prior\s+)*(?:instructions|directions|prompts|rules|constraints)/i,
  /disregard\s+(?:all\s+|previous\s+|above\s+|prior\s+)*(?:instructions|directions|prompts|rules)/i,
  /忽略(?:所有|之前|以上|原有的|全部)*(?:指令|要求|提示词|规则|设定|约束)/i,
  /忘记(?:所有|之前|以上|原有的|全部)*(?:指令|要求|提示词|规则|设定|约束)/i,
  /(?:you\s+are\s+now\s+in\s+dan\s+mode|dan\s+mode|do\s+anything\s+now)/i,
  /(?:进入\s*dan\s*模式|无限制模式|开发者调试模式越狱)/i,
  /(?:output|print|show|repeat)\s+(?:your\s+)?(?:system\s+prompt|initial\s+prompt|instructions\s+above)/i,
  /(?:输出|打印|显示|复述|告诉我)(?:你的)?(?:系统提示词|初始设定|system\s*prompt|人设要求)/i,
  /(?:bypass|override)\s+(?:safety|security|content)\s+filters?/i,
  /(?:绕过|突破)(?:安全|合规|敏感词|内容审查)限制/i,
];

/**
 * 双向敏感词与安全合规过滤器
 * 负责入站越狱/提示词注入拦截，以及出站敏感信息与违禁词脱敏。
 */
export class SensitiveFilter {
  private jailbreakPatterns: RegExp[];
  private sensitiveKeywords: Set<string>;
  private sensitivePatterns: RegExp[];
  private maskChar: string;

  constructor(options?: {
    jailbreakPatterns?: RegExp[];
    sensitiveKeywords?: string[];
    sensitivePatterns?: RegExp[];
    maskChar?: string;
  }) {
    this.jailbreakPatterns = [
      ...DEFAULT_JAILBREAK_PATTERNS,
      ...(options?.jailbreakPatterns ?? []),
    ];
    this.sensitiveKeywords = new Set(options?.sensitiveKeywords ?? []);
    this.sensitivePatterns = options?.sensitivePatterns ?? [];
    this.maskChar = options?.maskChar ?? '*';
  }

  /**
   * 入站文本安全性检测 (主要针对提示词注入与越狱攻击)
   */
  public checkInbound(text: string): SensitiveCheckResult {
    if (!text) {
      return { safe: true, matchedPatterns: [] };
    }

    const matchedPatterns: string[] = [];

    for (const pattern of this.jailbreakPatterns) {
      if (pattern.test(text)) {
        matchedPatterns.push(pattern.source);
      }
    }

    const safe = matchedPatterns.length === 0;
    return {
      safe,
      reason: safe ? undefined : `检测到潜在的提示词注入或越狱指令: ${matchedPatterns.join('; ')}`,
      matchedPatterns,
    };
  }

  /**
   * 出站只读合规检测
   */
  public checkOutbound(text: string): SensitiveCheckResult {
    if (!text) {
      return { safe: true, matchedKeywords: [], matchedPatterns: [] };
    }

    const matchedKeywords: string[] = [];
    const matchedPatterns: string[] = [];

    for (const keyword of this.sensitiveKeywords) {
      if (text.includes(keyword)) {
        matchedKeywords.push(keyword);
      }
    }

    for (const pattern of this.sensitivePatterns) {
      // 避免带 g 标志的正则在 test() 时保持 lastIndex 状态
      const flags = pattern.flags.replace('g', '');
      const nonGlobalRegex = new RegExp(pattern.source, flags);
      if (nonGlobalRegex.test(text)) {
        matchedPatterns.push(pattern.source);
      }
    }

    const safe = matchedKeywords.length === 0 && matchedPatterns.length === 0;
    return {
      safe,
      reason: safe ? undefined : '检测到出站包含敏感词或违规模式',
      matchedKeywords,
      matchedPatterns,
    };
  }

  /**
   * 出站敏感词脱敏替换
   */
  public filterOutbound(text: string): SensitiveFilterResult {
    if (!text) {
      return {
        safe: true,
        filteredText: '',
        matchedRules: [],
        replacedCount: 0,
      };
    }

    let filteredText = text;
    const matchedRules: string[] = [];
    let replacedCount = 0;

    // 1. 敏感词字典替换 (按词长降序排列优先替换长词)
    const sortedKeywords = Array.from(this.sensitiveKeywords).sort(
      (a, b) => b.length - a.length
    );

    for (const keyword of sortedKeywords) {
      if (!keyword) continue;
      if (filteredText.includes(keyword)) {
        matchedRules.push(keyword);
        const mask = this.maskChar.repeat(keyword.length);
        // 全局替换
        while (filteredText.includes(keyword)) {
          filteredText = filteredText.replace(keyword, mask);
          replacedCount++;
        }
      }
    }

    // 2. 敏感正则替换
    for (const pattern of this.sensitivePatterns) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const globalPattern = new RegExp(pattern.source, flags);

      filteredText = filteredText.replace(globalPattern, (matched) => {
        matchedRules.push(pattern.source);
        replacedCount++;
        return this.maskChar.repeat(Math.max(3, Math.min(matched.length, 10)));
      });
    }

    return {
      safe: true,
      filteredText,
      matchedRules: Array.from(new Set(matchedRules)),
      replacedCount,
    };
  }

  /**
   * 动态添加越狱匹配正则
   */
  public addJailbreakPattern(pattern: RegExp): void {
    this.jailbreakPatterns.push(pattern);
  }

  /**
   * 动态添加敏感词
   */
  public addKeyword(keyword: string): void {
    if (keyword) {
      this.sensitiveKeywords.add(keyword);
    }
  }

  /**
   * 动态添加出站脱敏正则
   */
  public addPattern(pattern: RegExp): void {
    this.sensitivePatterns.push(pattern);
  }

  /**
   * 全量重置敏感词列表
   */
  public setKeywords(keywords: string[]): void {
    this.sensitiveKeywords = new Set(keywords);
  }
}
