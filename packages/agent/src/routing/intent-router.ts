import type { ConsolidatedMessage, LLMProvider } from '../types/index.js';
import type {
  IntentClassificationResult,
  IntentFeatures,
  IntentRouterOptions,
  IntentRule,
  ModelEndpointConfig,
  ModelIntentLevel,
} from './types.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('intent-model-router');

/**
 * 极速轻量意图关键词 (日常问候、确认、简单组织查询)
 */
const FAST_CHITCHAT_KEYWORDS = [
  '你好',
  '您好',
  '在吗',
  '在么',
  '早',
  '早安',
  '早上好',
  '下午好',
  '晚上好',
  '嗨',
  'hi',
  'hello',
  'hey',
  '谢谢',
  '多谢',
  '感谢',
  '收到',
  '好的',
  '好的收到',
  'ok',
  '了解',
  '明白',
  '行',
  '再见',
  '拜拜',
];

const FAST_ORG_QUERY_KEYWORDS = [
  '工位',
  '电话',
  '手机',
  '分机',
  '座机',
  '部门',
  '在哪个组',
  '在哪个部门',
  '在哪个',
  '查一下',
  '找人',
  '找谁',
  '谁负责',
  '谁是',
  '联系方式',
  '邮箱',
  '工号',
  '领导是谁',
  '直属领导',
];

/**
 * 深度推理意图关键词 (代码排错、长文档对比、故障分析、多步决策)
 */
const DEEP_REASONING_KEYWORDS = [
  // 代码与排错
  '报错',
  'typeerror',
  'nullpointer',
  'syntaxerror',
  'exception',
  'error:',
  '排错',
  '调试',
  '排查异常',
  '优化算法',
  '代码审查',
  '死锁',
  '内存泄漏',
  'cpu 飙高',
  'oom',
  '堆栈',
  '崩溃',
  'dump',
  // 文档对比与分析
  '对比',
  '总结',
  '详细分析',
  '优缺点',
  '优劣',
  '异同',
  '方案对比',
  '评审',
  '优劣势',
  '深度解读',
  '长文提炼',
  // 故障与根因
  '故障',
  '报警',
  '慢查',
  '慢查询',
  '宕机',
  '不可用',
  '复盘',
  '根因',
  'rca',
  '熔断',
  '降级策略',
  // 多步规划与决策
  '规划',
  '架构设计',
  '实施步骤',
  '重构方案',
  '迁移计划',
  '方案设计',
  '落地计划',
  '技术选型',
];

/**
 * 意图驱动的动态模型分流路由器 (Cost-Effective Model Routing)
 * 将日常问候、工位查询与简单闲聊分流至 FAST 极速模型 (降低 70%+ Token 成本，300ms 响应)；
 * 将排错、代码分析、长文对比与故障决策分流至 DEEP 深度推理模型。
 */
export class IntentModelRouter {
  private fastModel?: ModelEndpointConfig;
  private deepModel?: ModelEndpointConfig;
  private backupModels: ModelEndpointConfig[] = [];
  private customRules: IntentRule[] = [];
  private defaultIntent: ModelIntentLevel;
  private longTextThreshold: number;
  private defaultTimeoutMs: number;

  constructor(options?: IntentRouterOptions) {
    this.defaultIntent = options?.defaultIntent ?? 'FAST';
    this.longTextThreshold = options?.longTextThreshold ?? 300;
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 15000;

    if (options?.fastModel) {
      this.setFastModel(options.fastModel);
    }
    if (options?.deepModel) {
      this.setDeepModel(options.deepModel);
    }
    if (options?.backupModels) {
      this.backupModels = [...options.backupModels];
    }
    if (options?.customRules) {
      this.customRules = [...options.customRules].sort(
        (a, b) => (b.priority ?? 0) - (a.priority ?? 0)
      );
    }
  }

  /**
   * 规范化模型端点实体
   */
  private normalizeEndpoint(
    model: ModelEndpointConfig | LLMProvider,
    defaultId: string,
    defaultName: string,
    intentLevel: ModelIntentLevel
  ): ModelEndpointConfig {
    if (typeof (model as ModelEndpointConfig).id === 'string') {
      const cfg = model as ModelEndpointConfig;
      return {
        ...cfg,
        intentLevel: cfg.intentLevel || intentLevel,
        timeoutMs: cfg.timeoutMs ?? this.defaultTimeoutMs,
      };
    }
    return {
      id: defaultId,
      name: defaultName,
      provider: model as LLMProvider,
      intentLevel,
      timeoutMs: this.defaultTimeoutMs,
    };
  }

  /**
   * 配置极速轻量模型端点 (FAST)
   */
  public setFastModel(model: ModelEndpointConfig | LLMProvider): void {
    this.fastModel = this.normalizeEndpoint(
      model,
      'fast-primary',
      'Fast-Lightweight-Model',
      'FAST'
    );
  }

  /**
   * 配置深度推理模型端点 (DEEP)
   */
  public setDeepModel(model: ModelEndpointConfig | LLMProvider): void {
    this.deepModel = this.normalizeEndpoint(
      model,
      'deep-primary',
      'Deep-Reasoning-Model',
      'DEEP'
    );
  }

  /**
   * 添加全局备用容灾模型端点 (Failover Backup)
   */
  public addBackupModel(model: ModelEndpointConfig): void {
    this.backupModels.push({
      ...model,
      isBackup: true,
      timeoutMs: model.timeoutMs ?? this.defaultTimeoutMs,
    });
  }

  /**
   * 注册自定义意图判定规则 (按优先级插入)
   */
  public registerRule(rule: IntentRule): void {
    this.customRules.push(rule);
    this.customRules.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  /**
   * 提取消息的意图特征
   */
  public extractFeatures(
    input: ConsolidatedMessage | string
  ): { content: string; features: IntentFeatures; rawMessage?: ConsolidatedMessage } {
    let content = '';
    let rawMessage: ConsolidatedMessage | undefined;

    if (typeof input === 'string') {
      content = input.trim();
    } else {
      content = input.content.trim();
      rawMessage = input;
    }

    const lower = content.toLowerCase();
    const charCount = content.length;
    const hasCode =
      content.includes('```') ||
      /function\s+\w+|class\s+\w+|const\s+\w+\s*=|def\s+\w+\(|import\s+.*from/i.test(
        content
      );

    const hasImages = rawMessage
      ? Boolean(
          rawMessage.messages?.some(
            (m) => m.images && m.images.length > 0
          )
        ) ||
        /(?:data\/media\/|\.png|\.jpg|\.jpeg|\.webp|\.gif|data:image\/)/i.test(
          content
        )
      : /(?:data\/media\/|\.png|\.jpg|\.jpeg|\.webp|\.gif|data:image\/)/i.test(
          content
        );

    const hasFileCards = rawMessage
      ? Boolean(rawMessage.messages?.some((m) => m.fileInfo)) ||
        /\[(?:文件|附件)\]|收到文件/i.test(content)
      : /\[(?:文件|附件)\]|收到文件/i.test(content);

    const hasMultiModal = hasImages || hasFileCards;
    // 检查是否为极速问候/闲聊
    const isChitchat =
      charCount < 50 &&
      FAST_CHITCHAT_KEYWORDS.some((kw) => lower.includes(kw));

    // 检查是否为员工/工位/电话查询
    const isOrgQuery =
      charCount < 60 &&
      FAST_ORG_QUERY_KEYWORDS.some((kw) => lower.includes(kw));

    // 检查是否包含深度推理/排错/对比关键词
    const hasReasoningKeywords = DEEP_REASONING_KEYWORDS.some((kw) =>
      lower.includes(kw)
    );

    return {
      content,
      rawMessage,
      features: {
        charCount,
        hasCode,
        hasImages,
        hasFileCards,
        hasMultiModal,
        isChitchat,
        isOrgQuery,
        hasReasoningKeywords,
      },
    };
  }

  /**
   * 意图复杂度分类判定
   */
  public async classify(
    input: ConsolidatedMessage | string
  ): Promise<IntentClassificationResult> {
    const { content, features, rawMessage } = this.extractFeatures(input);
    const lower = content.toLowerCase();
    const matchedKeywords: string[] = [];

    // 1. 优先评估自定义规则
    for (const rule of this.customRules) {
      try {
        const isMatched = await rule.match(rawMessage || content);
        if (isMatched) {
          log.info(
            { ruleName: rule.name, targetLevel: rule.intentLevel },
            '命中了自定义意图路由规则'
          );
          return {
            intentLevel: rule.intentLevel,
            reason: `命中了自定义规则: ${rule.name}`,
            confidence: 0.95,
            matchedKeywords: [rule.name],
            estimatedComplexity: rule.intentLevel === 'DEEP' ? 80 : 20,
            features,
          };
        }
      } catch (err) {
        log.warn(
          { ruleName: rule.name, err: err instanceof Error ? err.message : String(err) },
          '评估自定义规则异常，跳过'
        );
      }
    }

    // 2. 启发式特征提取与复杂度打分 (0 ~ 100)
    let complexityScore = 10;

    // 代码块强制进入 DEEP
    if (features.hasCode) {
      complexityScore += 60;
      matchedKeywords.push('code_block');
    }

    // 收集命中的深度推理关键词
    for (const kw of DEEP_REASONING_KEYWORDS) {
      if (lower.includes(kw)) {
        matchedKeywords.push(kw);
        complexityScore += 25;
      }
    }

    // 文本超长增加复杂度
    if (features.charCount > this.longTextThreshold) {
      complexityScore += 30;
      matchedKeywords.push('long_text');
    }

    // 多模态附件略微增加复杂度
    if (features.hasMultiModal) {
      complexityScore += 15;
    }

    // 若命中日常闲聊或问候，降低复杂度
    if (features.isChitchat) {
      complexityScore = Math.max(5, complexityScore - 40);
      matchedKeywords.push('chitchat');
    }

    // 若命中简单工位查询，降低复杂度
    if (features.isOrgQuery) {
      complexityScore = Math.max(5, complexityScore - 30);
      matchedKeywords.push('org_query');
    }

    // 3. 最终意图决策
    if (features.hasCode || complexityScore >= 50) {
      return {
        intentLevel: 'DEEP',
        reason: `检测到复杂推理需求 (复杂度得分: ${complexityScore}, 关键词: ${matchedKeywords.join(', ') || '无'})`,
        confidence: Math.min(0.99, 0.6 + (complexityScore / 200)),
        matchedKeywords,
        estimatedComplexity: Math.min(100, complexityScore),
        features,
      };
    }

    if (features.isChitchat || features.isOrgQuery || complexityScore < 40) {
      return {
        intentLevel: 'FAST',
        reason: `日常问候/工位查询/轻量交互 (复杂度得分: ${complexityScore}, 降低 Token 成本 70%+)`,
        confidence: 0.9,
        matchedKeywords,
        estimatedComplexity: Math.min(100, complexityScore),
        features,
      };
    }

    return {
      intentLevel: this.defaultIntent,
      reason: `未触发显著特征，回退到默认意图: ${this.defaultIntent}`,
      confidence: 0.7,
      matchedKeywords,
      estimatedComplexity: complexityScore,
      features,
    };
  }

  /**
   * 执行路由选择，返回主候选模型与备用候选链
   */
  public async route(
    input: ConsolidatedMessage | string
  ): Promise<{
    selectedModel: ModelEndpointConfig;
    classification: IntentClassificationResult;
    candidateChain: ModelEndpointConfig[];
  }> {
    const classification = await this.classify(input);
    const { intentLevel, features } = classification;

    // 收集所有可用配置模型
    const allConfigured: ModelEndpointConfig[] = [];
    if (this.fastModel) allConfigured.push(this.fastModel);
    if (this.deepModel && !allConfigured.some((m) => m.id === this.deepModel?.id)) {
      allConfigured.push(this.deepModel);
    }
    for (const backup of this.backupModels) {
      if (!allConfigured.some((m) => m.id === backup.id)) {
        allConfigured.push(backup);
      }
    }

    if (allConfigured.length === 0) {
      throw new Error(
        '未配置任何可用的 LLM 模型端点 (fastModel 与 deepModel 均未初始化)'
      );
    }

    let primary: ModelEndpointConfig | undefined;
    const chain: ModelEndpointConfig[] = [];

    // 检查是否存在多模态媒体 (图片/附件) 且有 Vision 端点可用
    const visionModels = allConfigured.filter((m) => m.supportsVision);

    if (features.hasImages && visionModels.length > 0) {
      // 存在图片媒体且配置了具备 Vision 能力的模型：优先提升 Vision 端点
      if (intentLevel === 'DEEP') {
        primary = visionModels.find((m) => m.intentLevel === 'DEEP') || visionModels[0];
      } else {
        primary = visionModels.find((m) => m.intentLevel === 'FAST') || visionModels[0];
      }

      if (primary) {
        chain.push(primary);
      }

      // 添加其余 Vision 模型
      for (const vm of visionModels) {
        if (!chain.some((m) => m.id === vm.id)) {
          chain.push(vm);
        }
      }

      // 添加非 Vision 模型作为备用降级链 (纯文本 + OCR 兜底)
      for (const model of allConfigured) {
        if (!chain.some((m) => m.id === model.id)) {
          chain.push(model);
        }
      }

      log.info(
        {
          intentLevel,
          selectedModel: primary?.name,
          visionModelCount: visionModels.length,
          candidateChain: chain.map((c) => c.name),
        },
        '检测到多模态附件，已优先路由至 Vision 模型端点'
      );
    } else {
      // 纯文本交互或无 Vision 模型可用：按意图复杂度构建常规候选链
      let secondary: ModelEndpointConfig | undefined;

      if (intentLevel === 'FAST') {
        primary = this.fastModel || this.deepModel;
        secondary = this.deepModel;
      } else {
        primary = this.deepModel || this.fastModel;
        secondary = this.fastModel;
      }

      if (primary) {
        chain.push(primary);
      }
      if (secondary && secondary.id !== primary?.id && !chain.some((m) => m.id === secondary?.id)) {
        chain.push(secondary);
      }
      for (const backup of this.backupModels) {
        if (!chain.some((m) => m.id === backup.id)) {
          chain.push(backup);
        }
      }
    }

    if (!primary) {
      primary = chain[0]!;
    }

    log.info(
      {
        intentLevel,
        selectedModel: primary.name,
        candidateChain: chain.map((c) => c.name),
        reason: classification.reason,
      },
      '完成意图识别与模型路由决策'
    );

    return {
      selectedModel: primary,
      classification,
      candidateChain: chain,
    };
  }

  public getFastModel(): ModelEndpointConfig | undefined {
    return this.fastModel;
  }

  public getDeepModel(): ModelEndpointConfig | undefined {
    return this.deepModel;
  }

  public getBackupModels(): ModelEndpointConfig[] {
    return [...this.backupModels];
  }
}
