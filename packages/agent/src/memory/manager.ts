import type { Client } from '@libsql/client';
import {
  closeDatabase,
  createDatabaseClient,
  MessageRepository,
  type SessionMessage,
} from '@kkbot/store';
import { LibSQLStore } from '@mastra/libsql';
import { Memory } from '@mastra/memory';
import type {
  L1MessageWindow,
  L2WorkingSummary,
  L3ColleagueProfile,
  MemoryConfig,
  MemoryContextOptions,
  MemoryContextResult,
  SaveMemoryMessageInput,
  UpdateColleagueProfileInput,
} from './types.js';
import { initMemorySchema } from './schema.js';
import type { LLMMessage, LLMProvider } from '../types/index.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('memory-manager');

/**
 * 数据库存储的 L2 摘要行结构
 */
interface WorkingSummaryRow {
  thread_id: string;
  summary: string;
  message_count: number;
  last_message_id: string | null;
  last_summarized_at: number;
  updated_at: number;
}

/**
 * 数据库存储的 L3 画像行结构
 */
interface ColleagueProfileRow {
  resource_id: string;
  name: string | null;
  department: string | null;
  position: string | null;
  preferences: string;
  key_facts: string;
  recent_topics: string;
  raw_summary: string | null;
  updated_at: number;
}

/**
 * KKBot 3-Tier 记忆管理核心引擎
 * 统一调度：
 * - L1: 短期会话滑动窗口 (以 threadId 物理隔离，SQL 层面自动剔除 is_recalled = 1 撤回消息)
 * - L2: 滚动工作记忆摘要 (以 threadId 物理隔离，长对话增量异步提炼压缩)
 * - L3: 员工实体画像与长期协同 (以 resourceId 物理隔离，跨会话偏好持久化与多话题平滑过渡)
 */
export class AgentMemoryManager {
  private client: Client | null = null;
  private messageRepo: MessageRepository | null = null;
  private mastraMemory: Memory | null = null;
  private mastraStorage: LibSQLStore | null = null;
  private isClientOwned = false;
  private initialized = false;

  private readonly config: MemoryConfig;
  private readonly l1WindowSize: number;
  private readonly l2SummaryThreshold: number;
  private readonly llmProvider?: LLMProvider;
  private readonly l3Enabled: boolean;

  constructor(config?: MemoryConfig) {
    this.config = config ?? {};
    this.l1WindowSize = config?.l1WindowSize ?? 20;
    this.l2SummaryThreshold = config?.l2SummaryThreshold ?? 10;
    this.llmProvider = config?.llmProvider;
    this.l3Enabled = config?.l3Enabled ?? true;

    if (config?.client) {
      this.client = config.client;
      this.isClientOwned = false;
    }
  }

  /**
   * 初始化数据库连接、表结构与 Mastra 记忆底座
   */
  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      // 1. 建立或复用 LibSQL Client
      if (!this.client) {
        log.debug('未传入共享 Client，正在建立独立 LibSQL 数据库连接...');
        this.client = await createDatabaseClient(this.config.database);
        this.isClientOwned = true;
      }

      // 2. 初始化表结构 (基础表 + L2/L3 专属表)
      if (this.config.autoInitSchema !== false) {
        await initMemorySchema(this.client);
      }

      // 3. 初始化消息仓储
      this.messageRepo = new MessageRepository(this.client);

      // 4. 初始化 Mastra 记忆实例 (与 LibSQLStore 联动)
      try {
        const dbPath = this.config.database?.path ?? ':memory:';
        this.mastraStorage = new LibSQLStore({
          id: 'kkbot-memory-storage',
          url: dbPath.startsWith('file:') ? dbPath : `file:${dbPath}`,
        });
        this.mastraMemory = new Memory({
          storage: this.mastraStorage,
          options: {
            lastMessages: this.l1WindowSize,
            workingMemory: {
              enabled: true,
              scope: 'thread',
            },
            observationalMemory: {
              enabled: this.l3Enabled,
              scope: 'resource',
            },
          },
        });
      } catch (mastraErr) {
        log.debug({ err: mastraErr }, '初始化 Mastra 辅助组件完成');
      }

      this.initialized = true;
      log.info('AgentMemoryManager 3-Tier 记忆管理器初始化完成');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, 'AgentMemoryManager 初始化失败');
      throw err;
    }
  }

  /**
   * 安全关闭数据库连接与清理资源
   */
  public close(): Promise<void> {
    if (this.isClientOwned && this.client) {
      closeDatabase(this.client);
      this.client = null;
    }
    this.initialized = false;
    return Promise.resolve();
  }

  /**
   * 确保记忆引擎已成功初始化
   */
  private ensureInitialized(): { client: Client; messageRepo: MessageRepository } {
    if (!this.initialized || !this.client || !this.messageRepo) {
      throw new Error('AgentMemoryManager 尚未初始化，请先调用 init() 方法');
    }
    return { client: this.client, messageRepo: this.messageRepo };
  }

  /**
   * 获取底层 Mastra Memory 实例 (若已配置)
   */
  public getMastraMemory(): Memory | null {
    return this.mastraMemory;
  }

  // =========================================================================
  // 1. L1 短期会话消息滑动窗口 (带 is_recalled = 1 物理撤回过滤)
  // =========================================================================

  /**
   * 保存单条会话消息至 L1 历史
   */
  public async saveMessage(input: SaveMemoryMessageInput): Promise<SessionMessage> {
    const { messageRepo } = this.ensureInitialized();
    return messageRepo.saveMessage({
      sessionId: input.threadId,
      sender: input.sender,
      content: input.content,
      senderId: input.senderId,
      messageId: input.messageId,
      messageType: input.messageType,
      isFromSelf: input.isFromSelf,
      isRecalled: input.isRecalled,
      replyTargetId: input.replyTargetId,
      createdAt: input.createdAt,
    });
  }

  /**
   * 批量保存会话消息至 L1 历史
   */
  public async saveMessages(inputs: SaveMemoryMessageInput[]): Promise<SessionMessage[]> {
    const { messageRepo } = this.ensureInitialized();
    return messageRepo.saveMessages(
      inputs.map((input) => ({
        sessionId: input.threadId,
        sender: input.sender,
        content: input.content,
        senderId: input.senderId,
        messageId: input.messageId,
        messageType: input.messageType,
        isFromSelf: input.isFromSelf,
        isRecalled: input.isRecalled,
        replyTargetId: input.replyTargetId,
        createdAt: input.createdAt,
      }))
    );
  }

  /**
   * 标记指定会话中的消息为已撤回
   * @param threadId 会话 ID (对应 sessionId)
   * @param messageId 客户端原生消息 ID
   */
  public async markMessageRecalled(
    threadId: string,
    messageId: string
  ): Promise<boolean> {
    const { messageRepo } = this.ensureInitialized();
    return messageRepo.markMessageRecalled(threadId, messageId);
  }

  /**
   * 获取 L1 短期滑动窗口消息 (自动在 SQL 层面严格过滤已撤回消息)
   * @param threadId 会话 ID (sessionId)
   * @param limit 限制条数 (默认使用配置的 l1WindowSize)
   */
  public async getL1Window(
    threadId: string,
    limit?: number
  ): Promise<L1MessageWindow> {
    const { client, messageRepo } = this.ensureInitialized();
    const effectiveLimit = limit ?? this.l1WindowSize;

    // 1. 获取未撤回的消息列表 (按时序递增排列)
    const messages = await messageRepo.getSessionHistory(threadId, {
      limit: effectiveLimit,
      includeRecalled: false,
      order: 'asc',
    });

    // 2. 统计被过滤的撤回消息数量 (精准感知数据清洗效果)
    const recalledCountRes = await client.execute({
      sql: 'SELECT COUNT(*) as count FROM session_messages WHERE session_id = ? AND is_recalled = 1',
      args: [threadId],
    });
    const filteredRecalledCount = Number(recalledCountRes.rows[0]?.count ?? 0);

    // 3. 格式化为可读文本
    const formattedText = messages
      .map((msg) => `${msg.sender}: ${msg.content}`)
      .join('\n');

    return {
      threadId,
      messages,
      totalCount: messages.length,
      filteredRecalledCount,
      formattedText,
    };
  }

  // =========================================================================
  // 2. L2 会话级增量滚动工作摘要 (Working Memory)
  // =========================================================================

  /**
   * 获取会话当前存储的 L2 滚动工作摘要
   * @param threadId 会话 ID
   */
  public async getL2Summary(threadId: string): Promise<L2WorkingSummary | null> {
    const { client } = this.ensureInitialized();
    const res = await client.execute({
      sql: 'SELECT thread_id, summary, message_count, last_message_id, last_summarized_at, updated_at FROM agent_working_summaries WHERE thread_id = ?',
      args: [threadId],
    });

    if (res.rows.length === 0) {
      return null;
    }

    const row = res.rows[0] as unknown as WorkingSummaryRow;
    return {
      threadId: String(row.thread_id),
      summary: String(row.summary),
      messageCountCovered: Number(row.message_count),
      lastMessageId: row.last_message_id ? String(row.last_message_id) : null,
      lastSummarizedAt: Number(row.last_summarized_at),
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * 手动更新或写入 L2 工作摘要
   */
  public async updateL2Summary(
    threadId: string,
    summary: string,
    messageCountCovered: number = 0,
    lastMessageId?: string | null
  ): Promise<L2WorkingSummary> {
    const { client } = this.ensureInitialized();
    const now = Date.now();
    const msgId = lastMessageId ?? null;

    await client.execute({
      sql: `INSERT INTO agent_working_summaries (
        thread_id, summary, message_count, last_message_id, last_summarized_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id) DO UPDATE SET
        summary = excluded.summary,
        message_count = excluded.message_count,
        last_message_id = excluded.last_message_id,
        last_summarized_at = excluded.last_summarized_at,
        updated_at = excluded.updated_at`,
      args: [threadId, summary, messageCountCovered, msgId, now, now],
    });

    return {
      threadId,
      summary,
      messageCountCovered,
      lastMessageId: msgId,
      lastSummarizedAt: now,
      updatedAt: now,
    };
  }

  /**
   * 对指定会话执行增量长对话摘要压缩
   * @param threadId 会话 ID
   */
  public async summarizeThread(threadId: string): Promise<L2WorkingSummary> {
    const { messageRepo } = this.ensureInitialized();

    // 1. 获取会话全部未撤回消息
    const messages = await messageRepo.getSessionHistory(threadId, {
      includeRecalled: false,
      order: 'asc',
    });

    if (messages.length === 0) {
      return (
        (await this.getL2Summary(threadId)) ?? {
          threadId,
          summary: '',
          messageCountCovered: 0,
          lastMessageId: null,
          lastSummarizedAt: Date.now(),
          updatedAt: Date.now(),
        }
      );
    }

    // 2. 获取旧摘要 (若存在)
    const existingSummary = await this.getL2Summary(threadId);

    // 3. 构建提炼输入
    const messagesText = messages
      .map((m) => `[${m.sender}]: ${m.content}`)
      .join('\n');

    let newSummaryContent = '';

    if (this.llmProvider) {
      const systemPrompt = `你是一个企业级 IM 机器人的专业记忆摘要引擎。
请提炼以下长对话的核心业务事实、用户关键诉求、已办结事项与待办事项，形成一份精炼客观的会话事实摘要。
要求：
- 语言简练严谨，直接输出事实，不要添加开场白与寒暄；
- 保留工单号、系统名、人名、关键决策等事实性信息；
- 长度控制在 200 字以内。`;

      const userPrompt = `${existingSummary ? `【前期工作摘要】\n${existingSummary.summary}\n\n` : ''}【最新会话对话流】\n${messagesText}\n\n请提炼以下会话的核心事实摘要：`;

      const chatMessages: LLMMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ];

      const llmResult = await this.llmProvider.chat(chatMessages);
      newSummaryContent = llmResult.content.trim();
    } else {
      // 无 LLM 时的启发式结构化事实摘要
      const latestMsg = messages[messages.length - 1];
      const latestSender = latestMsg?.sender ?? '未知用户';
      const latestContent = latestMsg?.content?.slice(0, 50) ?? '';
      newSummaryContent = `【工作摘要】会话累计 ${messages.length} 条有效消息。最新进展：${latestSender} 发送 "${latestContent}"`;
    }
    const lastMsg = messages[messages.length - 1];
    const lastMsgId = lastMsg?.messageId ?? (lastMsg ? String(lastMsg.id) : null);
    return this.updateL2Summary(
      threadId,
      newSummaryContent,
      messages.length,
      lastMsgId
    );
  }

  /**
   * 检查消息条数是否达到阈值，若达到则在后台异步触发增量摘要更新 (非阻塞主链路)
   * @param threadId 会话 ID
   */
  public async maybeTriggerAsyncSummary(threadId: string): Promise<boolean> {
    const { client } = this.ensureInitialized();

    const countRes = await client.execute({
      sql: 'SELECT COUNT(*) as count FROM session_messages WHERE session_id = ? AND is_recalled = 0',
      args: [threadId],
    });
    const totalCount = Number(countRes.rows[0]?.count ?? 0);

    if (totalCount >= this.l2SummaryThreshold) {
      // 异步在后台执行摘要生成，不阻塞调用方
      void (async (): Promise<void> => {
        try {
          await this.summarizeThread(threadId);
          log.debug({ threadId, totalCount }, '异步增量滚动摘要生成成功');
        } catch (err) {
          log.warn({ threadId, err }, '后台异步生成工作摘要异常');
        }
      })();
      return true;
    }

    return false;
  }

  // =========================================================================
  // 3. L3 员工实体画像与长期协同档案 (按 resourceId 物理隔离)
  // =========================================================================

  /**
   * 获取指定员工的 L3 长期协同实体画像
   * @param resourceId 员工 UID (对应 KK9 senderId)
   */
  public async getL3Profile(resourceId: string): Promise<L3ColleagueProfile> {
    const { client } = this.ensureInitialized();

    const res = await client.execute({
      sql: `SELECT resource_id, name, department, position, preferences,
                   key_facts, recent_topics, raw_summary, updated_at
            FROM agent_colleague_profiles
            WHERE resource_id = ?`,
      args: [resourceId],
    });

    if (res.rows.length === 0) {
      return {
        resourceId,
        preferences: {},
        keyFacts: [],
        recentTopics: [],
        updatedAt: Date.now(),
      };
    }

    const row = res.rows[0] as unknown as ColleagueProfileRow;

    let parsedPreferences: Record<string, unknown> = {};
    let parsedKeyFacts: string[] = [];
    let parsedRecentTopics: string[] = [];

    try {
      const raw = JSON.parse(row.preferences || '{}') as unknown;
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        parsedPreferences = raw as Record<string, unknown>;
      }
    } catch {
      parsedPreferences = {};
    }

    try {
      const raw = JSON.parse(row.key_facts || '[]') as unknown;
      if (Array.isArray(raw)) {
        parsedKeyFacts = raw.filter(
          (item): item is string => typeof item === 'string'
        );
      }
    } catch {
      parsedKeyFacts = [];
    }

    try {
      const raw = JSON.parse(row.recent_topics || '[]') as unknown;
      if (Array.isArray(raw)) {
        parsedRecentTopics = raw.filter(
          (item): item is string => typeof item === 'string'
        );
      }
    } catch {
      parsedRecentTopics = [];
    }

    return {
      resourceId: String(row.resource_id),
      name: row.name ? String(row.name) : undefined,
      department: row.department ? String(row.department) : undefined,
      position: row.position ? String(row.position) : undefined,
      preferences: parsedPreferences,
      keyFacts: parsedKeyFacts,
      recentTopics: parsedRecentTopics,
      rawSummary: row.raw_summary ? String(row.raw_summary) : undefined,
      updatedAt: Number(row.updated_at),
    };
  }

  /**
   * 更新或合并指定员工的 L3 长期画像
   */
  public async updateL3Profile(
    resourceId: string,
    input: UpdateColleagueProfileInput
  ): Promise<L3ColleagueProfile> {
    const { client } = this.ensureInitialized();
    const existing = await this.getL3Profile(resourceId);

    const mergedName = input.name ?? existing.name ?? null;
    const mergedDept = input.department ?? existing.department ?? null;
    const mergedPos = input.position ?? existing.position ?? null;
    const mergedPrefs = {
      ...existing.preferences,
      ...(input.preferences ?? {}),
    };
    const mergedFacts = input.keyFacts ?? existing.keyFacts;
    const mergedTopics = input.recentTopics ?? existing.recentTopics;
    const mergedSummary = input.rawSummary ?? existing.rawSummary ?? null;
    const now = Date.now();

    await client.execute({
      sql: `INSERT INTO agent_colleague_profiles (
        resource_id, name, department, position, preferences,
        key_facts, recent_topics, raw_summary, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(resource_id) DO UPDATE SET
        name = excluded.name,
        department = excluded.department,
        position = excluded.position,
        preferences = excluded.preferences,
        key_facts = excluded.key_facts,
        recent_topics = excluded.recent_topics,
        raw_summary = excluded.raw_summary,
        updated_at = excluded.updated_at`,
      args: [
        resourceId,
        mergedName,
        mergedDept,
        mergedPos,
        JSON.stringify(mergedPrefs),
        JSON.stringify(mergedFacts),
        JSON.stringify(mergedTopics),
        mergedSummary,
        now,
      ],
    });

    return {
      resourceId,
      name: mergedName ?? undefined,
      department: mergedDept ?? undefined,
      position: mergedPos ?? undefined,
      preferences: mergedPrefs,
      keyFacts: mergedFacts,
      recentTopics: mergedTopics,
      rawSummary: mergedSummary ?? undefined,
      updatedAt: now,
    };
  }

  /**
   * 为员工长期协同画像追加关键事实 (自动执行文本去重)
   */
  public async recordColleagueFact(
    resourceId: string,
    fact: string
  ): Promise<L3ColleagueProfile> {
    const cleanFact = fact.trim();
    if (!cleanFact) {
      return this.getL3Profile(resourceId);
    }

    const current = await this.getL3Profile(resourceId);
    if (!current.keyFacts.includes(cleanFact)) {
      const updatedFacts = [...current.keyFacts, cleanFact];
      return this.updateL3Profile(resourceId, { keyFacts: updatedFacts });
    }

    return current;
  }

  /**
   * 记录员工多轮话题平滑过渡 (维护最近讨论的 10 个话题)
   */
  public async recordTopicTransition(
    resourceId: string,
    newTopic: string
  ): Promise<L3ColleagueProfile> {
    const cleanTopic = newTopic.trim();
    if (!cleanTopic) {
      return this.getL3Profile(resourceId);
    }

    const current = await this.getL3Profile(resourceId);
    // 过滤掉同名话题后追加到末尾，保留最近 10 个
    const filteredTopics = current.recentTopics.filter((t) => t !== cleanTopic);
    const updatedTopics = [...filteredTopics, cleanTopic].slice(-10);

    return this.updateL3Profile(resourceId, { recentTopics: updatedTopics });
  }

  // =========================================================================
  // 4. 3-Tier 记忆上下文一键聚合与 Prompt 格式化组装
  // =========================================================================

  /**
   * 一键检索组装 3 级记忆上下文实体
   */
  public async getContext(
    options: MemoryContextOptions
  ): Promise<MemoryContextResult> {
    const threadId = options.threadId;
    const resourceId = options.resourceId;

    let l1Window: L1MessageWindow | undefined;
    let l2Summary: L2WorkingSummary | undefined;
    let l3Profile: L3ColleagueProfile | undefined;

    // 1. L1 检索
    if (options.includeL1 !== false) {
      l1Window = await this.getL1Window(threadId, options.l1Limit);
    }

    // 2. L2 检索
    if (options.includeL2 !== false) {
      const summary = await this.getL2Summary(threadId);
      if (summary) {
        l2Summary = summary;
      }
    }

    // 3. L3 检索
    if (options.includeL3 !== false && resourceId) {
      l3Profile = await this.getL3Profile(resourceId);
    }

    const result: MemoryContextResult = {
      threadId,
      resourceId,
      l1Window,
      l2Summary,
      l3Profile,
      combinedContext: '',
    };

    result.combinedContext = this.formatContextForPrompt(result);
    return result;
  }

  /**
   * 将 3-Tier 记忆上下文检索结果格式化为标准 Prompt 上下文文本
   */
  public formatContextForPrompt(result: MemoryContextResult): string {
    const sections: string[] = [];

    // 1. L3 画像部分
    if (result.l3Profile) {
      const p = result.l3Profile;
      const lines: string[] = ['### [L3 员工实体画像与长期协同背景]'];
      if (p.name) lines.push(`- 员工姓名: ${p.name}`);
      if (p.department) lines.push(`- 所属部门: ${p.department}`);
      if (p.position) lines.push(`- 岗位职称: ${p.position}`);

      const prefKeys = Object.keys(p.preferences);
      if (prefKeys.length > 0) {
        lines.push(
          `- 业务偏好: ${JSON.stringify(p.preferences, null, 0)}`
        );
      }

      if (p.keyFacts.length > 0) {
        lines.push(`- 长期协同事实:\n  * ${p.keyFacts.join('\n  * ')}`);
      }

      if (p.recentTopics.length > 0) {
        lines.push(`- 最近关注话题: ${p.recentTopics.join(', ')}`);
      }

      if (p.rawSummary) {
        lines.push(`- 认知画像摘要: ${p.rawSummary}`);
      }

      if (lines.length > 1) {
        sections.push(lines.join('\n'));
      }
    }

    // 2. L2 工作摘要部分
    if (result.l2Summary && result.l2Summary.summary.trim()) {
      sections.push(
        `### [L2 会话级滚动工作记忆摘要]\n${result.l2Summary.summary.trim()}`
      );
    }

    // 3. L1 历史消息部分
    if (result.l1Window && result.l1Window.messages.length > 0) {
      sections.push(
        `### [L1 会话近期对话历史]\n${result.l1Window.formattedText}`
      );
    }

    return sections.join('\n\n');
  }
}
