import EventEmitter from 'node:events';
import type {
  FormattedText,
  KK9Driver,
  KK9Message,
  KK9RecalledEvent,
  SendResult,
} from '@kkbot/driver';
import type { KKBotStore, SessionMode } from '@kkbot/store';
import {
  createRegisterProactiveScheduleTool,
  type AgentMemoryManager,
  type ApprovalManager,
  type EmployeeOrgContext,
  type KkbotAgentRuntime,
  type LeaderApprovalRouter,
  type LLMMessage,
  type StatefulApprovalMatcher,
  type UserProfilePreference,
} from '@kkbot/agent';
import type {
  ConsolidatedMessage,
  CoordinatorConfig,
  CoordinatorDispatchResult,
  CoordinatorEvents,
  DispatchReplyOptions,
  InFlightSession,
  PendingBucket,
  SessionCoordinatorOptions,
} from './types/index.js';
import type { ProactiveScheduleManager } from './schedule/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('session-coordinator');

const DEFAULT_DEBOUNCE_MS = 1500; // 1.5 秒
const DEFAULT_MAX_WAIT_MS = 5000; // 5 秒
const DEFAULT_TAKEOVER_DURATION_MS = 10 * 60 * 1000; // 10 分钟 (600,000ms)
const MAX_BOT_SENT_IDS = 5000;

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface SessionCoordinator {
  on<U extends keyof CoordinatorEvents>(event: U, listener: CoordinatorEvents[U]): this;
  emit<U extends keyof CoordinatorEvents>(
    event: U,
    ...args: Parameters<CoordinatorEvents[U]>
  ): boolean;
}

/**
 * SessionCoordinator
 * 上层业务会话编排器：深度协同 @kkbot/driver、@kkbot/store 与 @kkbot/agent 认知微内核，
 * 负责智能短消息防抖合并队列、撤回即时熔断、50ms 在途瞬时打断重聚、双通道主管 IM 审批闭环与视觉红点守卫
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class SessionCoordinator extends EventEmitter {
  public readonly driver: KK9Driver;
  public readonly store: KKBotStore;
  public readonly agentRuntime?: KkbotAgentRuntime;
  public readonly memoryManager?: AgentMemoryManager;
  public readonly approvalManager?: ApprovalManager;
  public readonly leaderRouter?: LeaderApprovalRouter;
  public readonly statefulMatcher?: StatefulApprovalMatcher;
  public readonly scheduleManager?: ProactiveScheduleManager;

  public readonly config: Required<
    Omit<CoordinatorConfig, 'onConsolidatedMessage' | 'knowledgeRetriever'>
  > & {
    onConsolidatedMessage?: (
      message: ConsolidatedMessage
    ) => Promise<void | CoordinatorDispatchResult> | void;
    knowledgeRetriever?: (
      query: string,
      sessionId: string
    ) => Promise<string[] | undefined> | string[] | undefined;
  };

  /** 各会话防抖队列桶映射表 (sessionId -> PendingBucket) */
  private readonly buckets = new Map<string, PendingBucket>();
  /** 活跃中的大模型在途生成会话锁映射表 (sessionId -> InFlightSession) */
  private readonly inFlightSessions = new Map<string, InFlightSession>();
  /** 记录 Bot 自身发出的消息 ID (用于回显防抖识别与过滤) */
  private readonly botSentMessageIds = new Set<string>();
  /** 记录已被撤回的消息 ID 集合 (用于防止消息存储与撤回并发竞争) */
  private readonly recalledMessageIds = new Set<string>();
  /** 记录各会话在内存中的人工退避截止时间 (sessionId -> timestamp) */
  private readonly takeoverUntilMap = new Map<string, number>();
  /** 记录各会话在内存中的工作模式缓存 (sessionId -> mode) */
  private readonly sessionModeMap = new Map<string, SessionMode>();
  /** 运行状态标记 */
  private isRunning = false;
  /**
   * 获取当前编排器运行状态
   */
  public get isRunningCoordinator(): boolean {
    return this.isRunning;
  }

  /** 全局串行发送临界区排队锁 (防止并发跨会话发送导致会话切换串线) */
  private sendMutex = Promise.resolve();

  private readonly boundHandleMessage: (msg: KK9Message) => void;
  private readonly boundHandleRecalled: (evt: KK9RecalledEvent) => void;

  constructor(options: SessionCoordinatorOptions) {
    super();
    this.driver = options.driver;
    this.store = options.store;
    this.agentRuntime = options.agentRuntime;
    this.memoryManager = options.memoryManager;
    this.approvalManager = options.approvalManager;
    this.leaderRouter = options.leaderRouter;
    this.statefulMatcher = options.statefulMatcher;
    this.scheduleManager = options.scheduleManager;

    this.config = {
      debounceMs: options.config?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxWaitMs: options.config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      takeoverDurationMs: options.config?.takeoverDurationMs ?? DEFAULT_TAKEOVER_DURATION_MS,
      autoMarkRead: options.config?.autoMarkRead ?? true,
      enableHitlRouter: options.config?.enableHitlRouter ?? true,
      onConsolidatedMessage: options.config?.onConsolidatedMessage,
      knowledgeRetriever: options.config?.knowledgeRetriever,
    };

    // 显式绑定 scheduleManager 的全局串行分发通道 (带 sendMutex 锁、自动会话切换与红点守护)
    if (this.scheduleManager && typeof this.scheduleManager.bindDispatchReply === 'function') {
      this.scheduleManager.bindDispatchReply((sid, content, opt) =>
        this.dispatchReply(sid, content, opt)
      );
    }

    // 若同时装配了 scheduleManager 与 agentRuntime，自动在工具中心注册 register_proactive_schedule
    if (this.scheduleManager && this.agentRuntime) {
      const registry = this.agentRuntime.getToolRegistry?.();
      if (registry && typeof registry.register === 'function') {
        try {
          const schedTool = createRegisterProactiveScheduleTool({
            scheduleManager: this.scheduleManager,
          });
          registry.register(schedTool, { override: true });
          log.info('已自动在 Agent 工具注册中心装配 register_proactive_schedule 工具');
        } catch (regErr) {
          log.debug({ regErr }, '自动装配 register_proactive_schedule 工具告警');
        }
      }
    }

    this.boundHandleMessage = (msg: KK9Message): void => {
      this.handleInboundMessage(msg).catch(err => {
        log.error(
          { err, sessionId: msg.sessionId, messageId: msg.id },
          '处理入站消息发生未捕获异常'
        );
      });
    };
    this.boundHandleRecalled = (evt: KK9RecalledEvent): void => {
      this.handleRecalled(evt).catch(err => {
        log.error(
          { err, sessionId: evt.sessionId, messageId: evt.messageId },
          '处理撤回事件发生未捕获异常'
        );
      });
    };
    // 自动装配 ApprovalManager 与 AgentRuntime 工具执行器 (显式保留 applicantId -> senderId 鉴权契约)
    if (this.approvalManager && this.agentRuntime) {
      const toolRegistry = this.agentRuntime.getToolRegistry();
      if (toolRegistry) {
        this.approvalManager.setToolExecutor(async (toolName, toolArgs, ctx) => {
          const tool = toolRegistry.get(toolName);
          if (!tool) {
            throw new Error(`未找到工具: ${toolName}`);
          }
          const effectiveSenderId =
            'applicantId' in ctx && typeof ctx.applicantId === 'string'
              ? ctx.applicantId
              : ctx.senderId;
          return tool.execute(toolArgs, {
            senderId: effectiveSenderId,
            threadId: ctx.threadId,
            approvedTaskId: ctx.approvalTaskId,
            idempotencyKey: ctx.idempotencyKey,
          });
        });
      }
    }

    // 绑定 ScheduleManager 事件代理
    if (this.scheduleManager) {
      this.scheduleManager.on('triggered', s => this.emit('schedule_triggered', s));
      this.scheduleManager.on('executed', (s, r) => this.emit('schedule_executed', s, r));
      this.scheduleManager.on('failed', (s, e) => this.emit('schedule_failed', s, e));
    }
  }

  /**
   * 启动会话编排器，挂载底层 Driver 事件监听并启动主动推送调度器
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }

    this.driver.on('message', this.boundHandleMessage);
    this.driver.on('recalled', this.boundHandleRecalled);

    if (this.scheduleManager) {
      try {
        await this.scheduleManager.start();
      } catch (err) {
        // 启动失败安全回滚：解绑 Driver 监听并恢复未运行状态，允许后续重试启动
        this.driver.off('message', this.boundHandleMessage);
        this.driver.off('recalled', this.boundHandleRecalled);
        this.isRunning = false;
        log.error({ err }, 'SessionCoordinator 启动主动调度管理器失败，已安全回滚');
        throw err;
      }
    }

    this.isRunning = true;

    log.info(
      {
        debounceMs: this.config.debounceMs,
        maxWaitMs: this.config.maxWaitMs,
        takeoverDurationMs: this.config.takeoverDurationMs,
        hasAgent: Boolean(this.agentRuntime),
        hasHitl: Boolean(this.approvalManager && this.statefulMatcher),
      },
      'SessionCoordinator 已成功启动'
    );
  }

  /**
   * 停止会话编排器，解绑事件监听并清理所有待处理定时器与在途中断
   */
  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    this.driver.off('message', this.boundHandleMessage);
    this.driver.off('recalled', this.boundHandleRecalled);

    // 中断所有在途生成会话
    for (const [sessionId, inFlight] of this.inFlightSessions.entries()) {
      inFlight.abortController.abort();
      this.inFlightSessions.delete(sessionId);
    }

    // 清理所有待处理的防抖定时器
    for (const [sessionId, bucket] of this.buckets.entries()) {
      if (bucket.debounceTimer) {
        clearTimeout(bucket.debounceTimer);
      }
      if (bucket.maxWaitTimer) {
        clearTimeout(bucket.maxWaitTimer);
      }
      this.buckets.delete(sessionId);
    }

    if (this.scheduleManager) {
      await this.scheduleManager.stop();
    }

    log.info('SessionCoordinator 已安全停止');
  }

  /**
   * 当前处于待处理防抖状态的会话数量
   */
  public get pendingSessionCount(): number {
    return this.buckets.size;
  }

  /**
   * 当前处于在途大模型生成的会话数量
   */
  public get inFlightSessionCount(): number {
    return this.inFlightSessions.size;
  }

  /**
   * 获取指定会话当前排队中的未合并消息快照
   * @param sessionId 会话 ID
   */
  public getPendingQueue(sessionId: string): KK9Message[] {
    const bucket = this.buckets.get(sessionId);
    return bucket ? [...bucket.messages] : [];
  }

  /**
   * 获取指定会话当前在途请求快照
   */
  public getInFlightSession(sessionId: string): InFlightSession | undefined {
    return this.inFlightSessions.get(sessionId);
  }

  /**
   * 判断指定会话当前是否有在途大模型生成正在进行
   */
  public hasInFlightSession(sessionId: string): boolean {
    return this.inFlightSessions.has(sessionId);
  }

  /**
   * 判定指定会话当前是否处于人工接管退避状态
   * @param sessionId 会话 ID
   * @param now 可选当前时间戳
   */
  public async isTakeoverActive(sessionId: string, now?: number): Promise<boolean> {
    const memUntil = this.takeoverUntilMap.get(sessionId);
    const currentTime = now ?? Date.now();
    if (memUntil !== undefined) {
      return memUntil > currentTime;
    }
    return this.store.sessions.isTakeoverActive(sessionId, now);
  }

  /**
   * 手动为会话设置人工接管退避期
   * @param sessionId 会话 ID
   * @param durationMs 退避持续时长毫秒数，默认配置值 (10分钟)
   */
  public async setTakeover(sessionId: string, durationMs?: number): Promise<void> {
    const duration = durationMs ?? this.config.takeoverDurationMs;
    const takeoverUntil = Date.now() + duration;
    this.takeoverUntilMap.set(sessionId, takeoverUntil);

    // 中断在途生成
    const inFlight = this.inFlightSessions.get(sessionId);
    if (inFlight) {
      inFlight.abortController.abort();
      this.inFlightSessions.delete(sessionId);
    }

    this.clearPendingBucket(sessionId);
    this.emit('takeover', sessionId, takeoverUntil);
    await this.store.sessions.upsertSession({ id: sessionId });
    await this.store.sessions.setTakeoverUntil(sessionId, takeoverUntil);
    log.info({ sessionId, takeoverUntil, duration }, '手动设置人工接管退避期');
  }

  /**
   * 手动解除会话的人工接管退避状态
   * @param sessionId 会话 ID
   */
  public async clearTakeover(sessionId: string): Promise<void> {
    this.takeoverUntilMap.set(sessionId, 0);
    await this.store.sessions.setTakeoverUntil(sessionId, 0);
    log.info({ sessionId }, '已解除人工接管退避状态');
  }

  /**
   * 设置会话工作模式
   */
  public async setSessionMode(sessionId: string, mode: SessionMode): Promise<void> {
    this.sessionModeMap.set(sessionId, mode);
    await this.store.sessions.setSessionMode(sessionId, mode);
  }

  /**
   * 核心入站消息处理流
   * 严格保证在执行任何异步前，优先同步 0ms 切断同一会话在途大模型生成，杜绝 Token 浪费
   * @param msg 入站消息实体
   */
  public async handleInboundMessage(msg: KK9Message): Promise<void> {
    const sessionId = msg.sessionId;

    // 0. 【首要原则：0ms 瞬时同步中断】若当前会话存在大模型在途生成，立即同步切断
    const inFlight = this.inFlightSessions.get(sessionId);
    if (inFlight) {
      inFlight.abortController.abort();
      this.inFlightSessions.delete(sessionId);
      const elapsedMs = Date.now() - inFlight.startedAt;
      log.info(
        { sessionId, elapsedMs, newMessageId: msg.id },
        '大模型生成中检测到同一会话收到新消息，0ms 同步切断在途请求'
      );
      this.emit('in_flight_aborted', sessionId, elapsedMs, 'new_inbound_message');
    }

    // 1. 处理人类或 Bot 自身发出的消息 (isMe: true)
    if (msg.isMe) {
      // 检查是否为 Bot 自身通过 coordinator 发出的消息回显
      if (this.botSentMessageIds.has(msg.id)) {
        this.botSentMessageIds.delete(msg.id);
        log.debug({ sessionId, messageId: msg.id }, '识别为 Bot 自身发出的消息回显，安全忽略');
        return;
      }

      // 非 Bot 发送的 isMe 消息 -> 人类操作员在客户端打字介入 (Human Takeover)
      log.info(
        { sessionId, messageId: msg.id, sender: msg.sender, content: msg.content },
        '检测到人类操作员在客户端发送消息，触发人机协同退避'
      );

      // 立即清空该会话的防抖队列，取消 Bot 待发出的自动回复
      this.clearPendingBucket(sessionId);

      // 设置 10 分钟退避截止时间并在内存中同步生效
      const takeoverUntil = Date.now() + this.config.takeoverDurationMs;
      this.takeoverUntilMap.set(sessionId, takeoverUntil);
      this.emit('takeover', sessionId, takeoverUntil, msg);

      try {
        await this.store.sessions.upsertSession({
          id: sessionId,
          name: msg.sessionName,
          type: msg.sessionType,
        });
        await this.store.sessions.setTakeoverUntil(sessionId, takeoverUntil);
      } catch (err) {
        if (!this.isRunning) return;
        log.warn({ err, sessionId }, '更新人类介入会话状态异常');
      }
      await this.persistInboundMessage(msg, takeoverUntil, true);
      return;
    }

    // 2. 处理客户或外部成员发出的消息 (isMe: false)
    const now = msg.timestamp || Date.now();

    // 检查是否处于人工退避期（内存优先检测）
    const memTakeover = this.takeoverUntilMap.get(sessionId) ?? 0;
    if (memTakeover > now) {
      log.info({ sessionId, messageId: msg.id }, '会话处于人工退避期，抑制自动回复并保持静默');
      this.emit('suppressed', sessionId, 'human_takeover', msg);
      await this.persistInboundMessage(msg, now, false);
      return;
    }

    // 检查会话是否被禁用（内存优先检测）
    const memMode = this.sessionModeMap.get(sessionId);
    if (memMode === 'disabled') {
      log.info({ sessionId, messageId: msg.id }, '会话已禁用自动应答，抑制回复');
      this.emit('suppressed', sessionId, 'session_disabled', msg);
      await this.persistInboundMessage(msg, now, false);
      return;
    }

    // 3. 检查是否为直属主管在私聊窗口中回复 HITL 审批指令 (严格限制为 private 会话且具有可信 senderId，杜绝群聊越权与身份冒用)
    if (
      this.config.enableHitlRouter &&
      this.statefulMatcher &&
      this.approvalManager &&
      msg.sessionType === 'private' &&
      Boolean(msg.senderId)
    ) {
      const deciderId = msg.senderId!;
      const matchRes = await this.statefulMatcher.match(deciderId, msg.content);

      if (matchRes.matched && matchRes.task) {
        const task = matchRes.task;
        const approved = matchRes.action === 'approve';
        log.info(
          { deciderId, taskId: task.id, approved, rawInput: msg.content },
          '主管在私聊中回复审批决议，开始执行跨会话决议流转'
        );

        await this.persistInboundMessage(msg, now, false);

        // 执行决议并自动触发关联 Mastra Workflow resume
        // 执行决议并自动触发关联 Mastra Workflow resume (内部自动执行高危工具并记录结果)
        const resolvedTask = await this.approvalManager.resolveTask({
          taskId: task.id,
          approved,
          deciderId,
          reason: msg.content,
        });

        // 1) 主管私聊窗口回复
        const supervisorReply = approved
          ? `✅ 已为您批准【${task.applicantName || task.applicantId}】提交的【${task.toolName}】操作。`
          : `❌ 已为您驳回【${task.applicantName || task.applicantId}】提交的【${task.toolName}】操作。`;

        await this.dispatchReply(msg.sessionId, supervisorReply);

        // 2) 跨会话向申请人员工的原会话 (task.threadId) 推送执行结果 (固定 markRead: false 保护申请人红点)
        let applicantNotification: string;
        if (approved) {
          const rawResult = resolvedTask.toolExecutionResult;
          let resultSummary = '操作执行成功';
          if (rawResult !== undefined && rawResult !== null) {
            resultSummary =
              typeof rawResult === 'string'
                ? rawResult
                : typeof rawResult === 'number' || typeof rawResult === 'boolean'
                  ? String(rawResult)
                  : JSON.stringify(rawResult);
          }
          applicantNotification = `🎉 您的直属主管【${resolvedTask.leaderName || deciderId}】已批准操作【${task.toolName}】。\n执行结果：${resultSummary}`;
        } else {
          applicantNotification = `⚠️ 您的直属主管【${resolvedTask.leaderName || deciderId}】已驳回操作【${task.toolName}】。`;
        }

        await this.dispatchReply(task.threadId, applicantNotification, { markRead: false });

        this.emit('approval_resolved', deciderId, resolvedTask, approved);
        return;
      } else if (matchRes.promptMessage) {
        log.info({ deciderId }, '主管有多笔待办任务或指令需消歧，回复引导提示');
        await this.persistInboundMessage(msg, now, false);
        await this.dispatchReply(msg.sessionId, matchRes.promptMessage);
        return;
      }
    }

    // 4. 若此前存在被打断的在途会话，将旧消息与新消息归并重聚 (In-Flight Regroup)
    if (inFlight) {
      log.info(
        { sessionId, messageCount: inFlight.message.messages.length },
        '将此前在途打断消息与新到达消息归并重聚'
      );
      this.regroupInFlightMessage(sessionId, inFlight.message, msg);
      await this.persistInboundMessage(msg, now, false);
      return;
    }

    // 5. 正常进入短消息防抖合并队列 (Debounce Queue) - 同步执行！
    this.enqueueMessage(msg);

    // 异步持久化
    await this.persistInboundMessage(msg, now, false);
  }

  /**
   * 异步持久化入站消息与更新会话活跃时间
   */
  private async persistInboundMessage(
    msg: KK9Message,
    now: number,
    isFromSelf: boolean
  ): Promise<void> {
    try {
      const sessionId = msg.sessionId;
      await this.store.sessions.upsertSession({
        id: sessionId,
        name: msg.sessionName,
        type: msg.sessionType,
      });
      await this.store.sessions.touchMessageTime(sessionId, now);

      await this.store.messages.saveMessage({
        sessionId,
        messageId: msg.id,
        sender: msg.sender || (isFromSelf ? '自己' : ''),
        senderId: msg.senderId,
        content: msg.content,
        messageType: msg.messageType || 'text',
        isFromSelf,
        isRecalled: this.recalledMessageIds.has(`${sessionId}:${msg.id}`),
        createdAt: msg.timestamp || now,
      });
    } catch (err) {
      if (!this.isRunning) return;
      log.warn({ err, sessionId: msg.sessionId, messageId: msg.id }, '持久化入站消息异常');
    }
  }

  /**
   * 消息撤回事件处理 (Recall Fusion)
   * @param event 消息撤回事件元数据
   */
  public async handleRecalled(event: KK9RecalledEvent): Promise<void> {
    const { sessionId, messageId } = event;
    log.info({ sessionId, messageId }, '收到消息撤回事件，执行即时熔断检查');

    this.recalledMessageIds.add(`${sessionId}:${messageId}`);

    // 若在途生成中包含被撤回消息，立即中断
    const inFlight = this.inFlightSessions.get(sessionId);
    if (inFlight) {
      const containsRecalled = inFlight.message.messages.some(m => m.id === messageId);
      if (containsRecalled) {
        log.info({ sessionId, messageId }, '在途生成任务包含被撤回消息，立即 50ms 瞬时中断');
        inFlight.abortController.abort();
        this.inFlightSessions.delete(sessionId);
        const elapsedMs = Date.now() - inFlight.startedAt;
        this.emit('in_flight_aborted', sessionId, elapsedMs, 'message_recalled');
      }
    }

    // 1. 同步剔除防抖队列中的消息
    const bucket = this.buckets.get(sessionId);
    if (bucket) {
      const originalCount = bucket.messages.length;
      bucket.messages = bucket.messages.filter(m => {
        const rawMsgId =
          (m.raw?.['messageId'] as string | undefined) ||
          (m.raw?.['msgID'] as string | undefined) ||
          (m.raw?.['id'] as string | undefined);
        return m.id !== messageId && rawMsgId !== messageId;
      });

      const remainingCount = bucket.messages.length;

      if (remainingCount < originalCount) {
        log.info(
          { sessionId, messageId, originalCount, remainingCount },
          '防抖队列中匹配到被撤回消息并完成即时剔除'
        );
        this.emit('recall_fused', sessionId, messageId, remainingCount);

        // 若队列中全部消息被撤回，执行静默熔断
        if (remainingCount === 0) {
          log.info({ sessionId }, '防抖队列消息已全部被撤回，执行静默熔断取消后续流程');
          this.clearPendingBucket(sessionId);
          this.emit('suppressed', sessionId, 'recalled');
        }
      }
    }

    // 2. 异步在 Store 中标记已撤回
    await this.store.messages.markMessageRecalled(sessionId, messageId);
  }

  /**
   * 回复消息分发与视觉红点守卫中枢
   * @param sessionId 目标会话 ID
   * @param replyContent 待回复的内容 (纯文本、富文本片段或 HTML)
   * @param options 发送选项与会话模式覆盖
   */
  public async dispatchReply(
    sessionId: string,
    replyContent: FormattedText,
    options: DispatchReplyOptions = {}
  ): Promise<CoordinatorDispatchResult> {
    const memMode = this.sessionModeMap.get(sessionId);
    const sessionRecord = await this.store.sessions.getSession(sessionId);
    const effectiveMode = options.mode ?? memMode ?? sessionRecord?.mode ?? 'auto';

    // 1. 草稿模式守护：保存草稿并坚决保留视觉红点
    if (effectiveMode === 'draft') {
      log.info({ sessionId }, '会话处于 draft 草稿模式，保存草稿记录并坚决保留红点');
      const contentStr =
        typeof replyContent === 'string' ? replyContent : JSON.stringify(replyContent);

      await this.store.messages.saveMessage({
        sessionId,
        sender: '自己',
        content: contentStr,
        messageType: typeof replyContent === 'string' ? 'text' : 'rich-text',
        isFromSelf: true,
        isRecalled: false,
        createdAt: Date.now(),
      });

      const result: CoordinatorDispatchResult = {
        action: 'draft_created',
        success: true,
        sessionId,
        redDotCleared: false,
      };
      this.emit('reply_dispatched', sessionId, result);
      return result;
    }

    // 2. 人机退避守护：退避期内拦截自动发送并坚决保留红点
    if (await this.isTakeoverActive(sessionId)) {
      log.warn({ sessionId }, '会话处于人工接管退避期，拦截自动回复发送，坚决保留红点');
      const result: CoordinatorDispatchResult = {
        action: 'suppressed',
        success: false,
        sessionId,
        error: 'human_takeover_active',
        redDotCleared: false,
      };
      this.emit('reply_dispatched', sessionId, result);
      return result;
    }

    // 3. 禁用模式守护
    if (effectiveMode === 'disabled') {
      log.info({ sessionId }, '会话已被禁用，跳过自动回复并保留红点');
      const result: CoordinatorDispatchResult = {
        action: 'suppressed',
        success: false,
        sessionId,
        error: 'session_disabled',
        redDotCleared: false,
      };
      this.emit('reply_dispatched', sessionId, result);
      return result;
    }

    // 4. 自动发送模式 (auto)：在全局串行临界区中执行会话切换与消息发送
    const sendResult = await this.executeWithSendLock(async () => {
      // 4.1 会话安全切换 (Fail-Closed 安全防线)：若目标会话不是当前活跃会话，先切换到目标会话以保证 checkPreSendState 通过
      if (typeof this.driver.selectSession === 'function') {
        try {
          const current = await this.driver.getCurrentSession?.();
          if (!current || current.id !== sessionId) {
            log.debug(
              { targetSessionId: sessionId, currentSessionId: current?.id },
              '切换目标会话以执行发送'
            );
            const switched = await this.driver.selectSession(sessionId);
            if (!switched) {
              log.error(
                { targetSessionId: sessionId, currentSessionId: current?.id },
                '切换目标会话失败 (selectSession 返回 false)，执行 Fail-Closed 安全拦截拒绝发送'
              );
              return {
                success: false,
                error: `切换目标会话失败: selectSession [${sessionId}] 返回 false`,
              };
            }
          }
        } catch (selErr) {
          const errMsg = selErr instanceof Error ? selErr.message : String(selErr);
          log.error(
            { selErr: errMsg, sessionId },
            '切换目标会话抛出异常，执行 Fail-Closed 安全拦截拒绝发送'
          );
          return {
            success: false,
            error: `切换目标会话异常: ${errMsg}`,
          };
        }
      }
      // 4.2 执行底层消息发送
      let res: SendResult;
      try {
        if (typeof replyContent === 'string') {
          res = await this.driver.sendText(replyContent, {
            ...options,
            targetSessionId: sessionId,
          });
        } else {
          res = await this.driver.sendRichText(replyContent, {
            ...options,
            targetSessionId: sessionId,
          });
        }
      } catch (err) {
        log.error({ sessionId, err: String(err) }, '调用 Driver 发送消息异常');
        res = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
      return res;
    });
    // 记录 Bot 发送的消息 ID，防止自身回显触发退避
    if (sendResult.messageId) {
      this.botSentMessageIds.add(sendResult.messageId);
      if (this.botSentMessageIds.size > MAX_BOT_SENT_IDS) {
        const firstKey = this.botSentMessageIds.values().next().value;
        if (firstKey) {
          this.botSentMessageIds.delete(firstKey);
        }
      }
    }

    // 发送成功分支：更新回复时间戳、写入消息历史并执行视觉红点消除
    if (sendResult.success) {
      const now = Date.now();
      await this.store.sessions.upsertSession({ id: sessionId });
      await this.store.sessions.touchReplyTime(sessionId, now);
      await this.store.messages.saveMessage({
        sessionId,
        messageId: sendResult.messageId,
        sender: '自己',
        content: typeof replyContent === 'string' ? replyContent : JSON.stringify(replyContent),
        messageType: typeof replyContent === 'string' ? 'text' : 'rich-text',
        isFromSelf: true,
        isRecalled: false,
        createdAt: now,
      });

      // 视觉红点守卫：仅在自动回复发送成功且明确允许清除红点时消除红点
      let redDotCleared = false;
      const shouldMarkRead = options.markRead ?? this.config.autoMarkRead;
      if (shouldMarkRead) {
        try {
          redDotCleared = await this.driver.markSessionRead(sessionId);
          log.debug({ sessionId, redDotCleared }, '自动回复发送成功，已执行消除会话红点');
        } catch (err) {
          log.warn({ sessionId, err: String(err) }, '消除会话红点调用失败');
        }
      }

      const result: CoordinatorDispatchResult = {
        action: 'message_sent',
        success: true,
        sessionId,
        messageId: sendResult.messageId,
        redDotCleared,
      };
      this.emit('reply_dispatched', sessionId, result);
      return result;
    }

    // 发送失败分支：坚决保留红点避免人工漏单
    log.error({ sessionId, error: sendResult.error }, '自动回复发送失败，坚决保留红点');
    const failResult: CoordinatorDispatchResult = {
      action: 'send_failed',
      success: false,
      sessionId,
      error: sendResult.error,
      redDotCleared: false,
    };
    this.emit('reply_dispatched', sessionId, failResult);
    return failResult;
  }
  /**
   * 全局串行发送临界区锁 (排队执行会话切换与发送，防止并发串线)
   */
  private async executeWithSendLock<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.sendMutex.then(fn, fn);
    this.sendMutex = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  /**
   * 显式手动触发指定会话的防抖聚合
   * @param sessionId 会话 ID
   */
  public async flushSession(sessionId: string): Promise<void> {
    await this.flush(sessionId);
  }

  /**
   * 显式触发所有会话的防抖聚合（用于关闭前排空）
   */
  public async flushAll(): Promise<void> {
    const sessionIds = Array.from(this.buckets.keys());
    for (const sessionId of sessionIds) {
      await this.flush(sessionId);
    }
  }

  /**
   * 排空所有待处理消息并返回，不触发后续 onConsolidatedMessage 或 Agent 回调
   */
  public drain(): Map<string, KK9Message[]> {
    const result = new Map<string, KK9Message[]>();
    for (const [sessionId, bucket] of this.buckets.entries()) {
      if (bucket.debounceTimer) {
        clearTimeout(bucket.debounceTimer);
      }
      if (bucket.maxWaitTimer) {
        clearTimeout(bucket.maxWaitTimer);
      }
      result.set(sessionId, [...bucket.messages]);
      this.buckets.delete(sessionId);
    }
    return result;
  }

  /**
   * 消息压入待合并队列并重置防抖计时器
   */
  /**
   * 获取或初始化会话的防抖待处理桶
   */
  private getOrCreatePendingBucket(
    sessionId: string,
    sampleMsg: KK9Message,
    firstReceivedAt = Date.now()
  ): PendingBucket {
    let bucket = this.buckets.get(sessionId);
    if (!bucket) {
      bucket = {
        sessionId,
        sessionName: sampleMsg.sessionName,
        sessionType: sampleMsg.sessionType,
        sender: sampleMsg.sender,
        senderId: sampleMsg.senderId,
        messages: [],
        debounceTimer: null,
        maxWaitTimer: null,
        firstReceivedAt,
      };
      this.buckets.set(sessionId, bucket);

      // 设置最长等待时间定时器 (防止高频连发导致无限延迟)
      bucket.maxWaitTimer = setTimeout(() => {
        this.flush(sessionId).catch(err => {
          log.error({ err, sessionId }, '执行最长等待超时防抖合并异常');
        });
      }, this.config.maxWaitMs);
    }
    return bucket;
  }

  /**
   * 重置滑动窗口防抖计时器
   */
  private resetDebounceTimer(
    bucket: PendingBucket,
    errorContext = '执行滑动窗口防抖合并异常'
  ): void {
    if (bucket.debounceTimer) {
      clearTimeout(bucket.debounceTimer);
    }
    bucket.debounceTimer = setTimeout(() => {
      this.flush(bucket.sessionId).catch(err => {
        log.error({ err, sessionId: bucket.sessionId }, errorContext);
      });
    }, this.config.debounceMs);
  }

  /**
   * 将新消息压入会话防抖队列
   */
  private enqueueMessage(msg: KK9Message): void {
    const sessionId = msg.sessionId;
    const bucket = this.getOrCreatePendingBucket(sessionId, msg);
    bucket.messages.push(msg);
    this.resetDebounceTimer(bucket, '执行滑动窗口防抖合并异常');

    log.debug(
      { sessionId, queueLength: bucket.messages.length, debounceMs: this.config.debounceMs },
      '新消息压入防抖队列'
    );
    this.emit('message_queued', sessionId, msg, bucket.messages.length);
  }

  /**
   * 将在途任务消息与新消息自动归并入防抖桶
   */
  private regroupInFlightMessage(
    sessionId: string,
    inFlightMessage: ConsolidatedMessage,
    newMsg: KK9Message
  ): void {
    const bucket = this.getOrCreatePendingBucket(
      sessionId,
      newMsg,
      inFlightMessage.firstReceivedAt || Date.now()
    );

    // 归并在途任务消息 (指纹去重)
    const existingIds = new Set(bucket.messages.map(m => m.id));
    for (const m of inFlightMessage.messages) {
      if (!existingIds.has(m.id)) {
        bucket.messages.push(m);
        existingIds.add(m.id);
      }
    }

    // 追加新消息
    if (!existingIds.has(newMsg.id)) {
      bucket.messages.push(newMsg);
    }

    // 重置防抖计时器
    this.resetDebounceTimer(bucket, '执行重聚防抖合并异常');
    this.emit('in_flight_regrouped', sessionId, bucket.messages.length);
  }

  /**
   * 触发防抖合并并将聚合消息传递给处理流水线
   */
  private async flush(sessionId: string): Promise<void> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.messages.length === 0) {
      this.clearPendingBucket(sessionId);
      return;
    }

    // 从活跃桶移除并清理定时器
    this.clearPendingBucket(sessionId);

    // 再次确认退避状态
    if (await this.isTakeoverActive(sessionId)) {
      log.info({ sessionId }, '防抖到期时会话处于人工退避状态，静默放弃合并处理');
      this.emit('suppressed', sessionId, 'human_takeover');
      return;
    }

    const messages = bucket.messages;
    const content = messages.map(m => m.content).join('\n');
    const messageIds = messages.map(m => m.id);
    const atMe = messages.some(m => m.atMe || m.mentions?.isAtMe);
    const atAll = messages.some(m => m.atAll || m.mentions?.isAtAll);
    const lastMsg = messages[messages.length - 1];
    const lastReceivedAt = lastMsg?.timestamp || Date.now();

    const consolidated: ConsolidatedMessage = {
      sessionId: bucket.sessionId,
      sessionName: bucket.sessionName,
      sessionType: bucket.sessionType,
      sender: lastMsg?.sender || bucket.sender,
      senderId: lastMsg?.senderId || bucket.senderId,
      content,
      messageCount: messages.length,
      messages,
      firstReceivedAt: bucket.firstReceivedAt,
      lastReceivedAt,
      messageIds,
      atMe: atMe || undefined,
      atAll: atAll || undefined,
    };

    log.info(
      {
        sessionId,
        messageCount: consolidated.messageCount,
        contentPreview: content.slice(0, 60),
      },
      '短消息防抖合并完成，派发 ConsolidatedMessage'
    );

    this.emit('consolidated', consolidated);

    // 触发自定义回调
    if (typeof this.config.onConsolidatedMessage === 'function') {
      try {
        await this.config.onConsolidatedMessage(consolidated);
      } catch (err) {
        log.error({ sessionId, err: String(err) }, '执行 onConsolidatedMessage 回调异常');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 若配置了 Agent 认知微内核 Runtime，执行全链路智能生成
    if (this.agentRuntime) {
      const abortController = new AbortController();
      const inFlight: InFlightSession = {
        sessionId,
        abortController,
        startedAt: Date.now(),
        message: consolidated,
      };
      this.inFlightSessions.set(sessionId, inFlight);
      this.emit('agent_started', sessionId, consolidated);

      const execPromise = this.executeAgentPipeline(
        sessionId,
        consolidated,
        abortController.signal
      );
      inFlight.promise = execPromise;
      try {
        await execPromise;
      } catch (err) {
        log.error({ sessionId, err }, 'Agent 流水线执行发生异常');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (this.inFlightSessions.get(sessionId) === inFlight) {
          this.inFlightSessions.delete(sessionId);
        }
      }
    }
  }

  /**
   * 执行 Agent 认知微内核全链路流水线
   */
  private async executeAgentPipeline(
    sessionId: string,
    consolidated: ConsolidatedMessage,
    signal: AbortSignal
  ): Promise<void> {
    if (signal.aborted) {
      this.emit('agent_aborted', sessionId);
      return;
    }

    // 1. 调取员工组织与岗位上下文
    let employeeContext: EmployeeOrgContext | undefined = undefined;
    if (consolidated.senderId) {
      try {
        const emp = await this.store.org.getEmployeeById(consolidated.senderId);
        if (emp) {
          const primaryDept = emp.departments?.find(d => d.isPrimary) || emp.departments?.[0];
          employeeContext = {
            employeeId: String(emp.id),
            name: emp.name,
            department: primaryDept?.deptName,
            jobTitle: primaryDept?.position ?? undefined,
          };
        }
      } catch (err) {
        log.debug({ err, senderId: consolidated.senderId }, '查询员工档案异常');
      }
    }

    // 2. 调取 3-Tier 记忆与 RAG 知识库上下文 (L1 消息历史 / L2 滚动摘要 / L3 实体画像 / RAG 知识切片)
    let historyMessages: LLMMessage[] | undefined = undefined;
    let retrievedFacts: string[] | undefined = undefined;
    let userProfile: UserProfilePreference | undefined = undefined;

    // 知识库 RAG 检索 (注入 Layer 4 事实层)
    if (this.config.knowledgeRetriever) {
      try {
        const kbFacts = await this.config.knowledgeRetriever(consolidated.content, sessionId);
        if (kbFacts && kbFacts.length > 0) {
          retrievedFacts = [...(retrievedFacts ?? []), ...kbFacts];
        }
      } catch (kbErr) {
        log.warn({ kbErr, sessionId }, '知识库 RAG 检索异常');
      }
    }

    if (this.memoryManager) {
      try {
        const memCtx = await this.memoryManager.getContext({
          threadId: sessionId,
          resourceId: consolidated.senderId,
        });

        // L1 短期历史 (排除当前批次 consolidated.messageIds，按 user/assistant 角色格式化)
        const previousL1 =
          memCtx.l1Window?.messages.filter(
            m => !consolidated.messageIds.includes(m.messageId ?? String(m.id))
          ) ?? [];
        if (previousL1.length > 0) {
          historyMessages = previousL1.map(m => ({
            role: m.isFromSelf ? 'assistant' : 'user',
            content: m.content,
          }));
        }

        // L2 滚动工作摘要 (放入 Layer 4 事实上下文)
        if (memCtx.l2Summary?.summary?.trim()) {
          const summaryFact = `【前序对话工作摘要】: ${memCtx.l2Summary.summary.trim()}`;
          retrievedFacts = retrievedFacts ? [...retrievedFacts, summaryFact] : [summaryFact];
        }

        // L3 实体画像与偏好 (放入 Layer 2 用户画像)
        if (memCtx.l3Profile) {
          userProfile = {
            nickname: memCtx.l3Profile.name ?? undefined,
            customPreferences:
              memCtx.l3Profile.preferences && Object.keys(memCtx.l3Profile.preferences).length > 0
                ? (memCtx.l3Profile.preferences as Record<string, string>)
                : undefined,
          };
        }
      } catch (err) {
        log.warn({ err, sessionId }, '调取 3-Tier 记忆上下文异常');
      }
    }

    // 3. 调用 Agent 认知微内核执行
    const agentRes = await this.agentRuntime!.execute(sessionId, consolidated, {
      signal,
      employeeContext,
      userProfile,
      historyMessages,
      retrievedFacts,
    });

    // 释放当前会话在途生成锁 (CAS 身份校验：仅当当前锁仍属于本次执行时才删除，防止误删新一轮重聚锁)
    const currentInFlight = this.inFlightSessions.get(sessionId);
    if (currentInFlight && currentInFlight.abortController.signal === signal) {
      this.inFlightSessions.delete(sessionId);
    }

    // 检查是否已被打断
    if (signal.aborted || agentRes.aborted) {
      log.info({ sessionId }, '大模型生成已被 50ms 瞬时打断，放弃发送本次回复');
      this.emit('agent_aborted', sessionId);
      return;
    }
    // 4. 处理高危工具 HITL 审批挂起分支
    if (
      agentRes.finishReason === 'tool_calls' &&
      agentRes.toolCalls.some(t => t.status === 'suspended')
    ) {
      log.info({ sessionId }, '工具调用触发 HITL 审批挂起，开始向直属主管推送私聊通知');

      for (const tc of agentRes.toolCalls) {
        if (tc.status === 'suspended' && tc.approvalTaskId && this.approvalManager) {
          try {
            const task = await this.approvalManager.getTaskById(tc.approvalTaskId);
            if (task) {
              if (this.leaderRouter && task.leaderId) {
                const notif = this.leaderRouter.formatApprovalNotification(task);
                // 统一收口至 dispatchReply 进行串行锁排队、自动会话切换与红点保留
                await this.dispatchReply(task.leaderId, notif.text, { markRead: false });
                this.emit('approval_notified', task.leaderId, task);
                log.info(
                  { leaderId: task.leaderId, taskId: task.id },
                  '已向直属主管发送私聊审批通知卡片'
                );
              }
              this.emit('approval_suspended', sessionId, task);
            }
          } catch (err) {
            log.error({ err, taskId: tc.approvalTaskId }, '处理审批挂起通知异常');
          }
        }
      }

      // 向申请人员工会话发送挂起中回复，并且严格保留红点 (markRead: false)！
      await this.dispatchReply(sessionId, agentRes.content, { markRead: false });
      this.emit('agent_completed', sessionId, agentRes);
      return;
    }

    // 5. 正常回复发送与红点消除
    if (agentRes.content) {
      const dispatchRes = await this.dispatchReply(sessionId, agentRes.content);
      if (dispatchRes.success && this.memoryManager) {
        // 统一由 Store 持久化消息历史，此处仅异步尝试触发 L2 滚动摘要提炼 (显式 catch 避免未捕获拒绝)
        void this.memoryManager.maybeTriggerAsyncSummary(sessionId).catch(memErr => {
          log.warn({ memErr, sessionId }, '触发 3-Tier 异步摘要异常');
        });
      }
    }
    this.emit('agent_completed', sessionId, agentRes);
  }

  /**
   * 清除指定会话的防抖待处理桶及其定时器
   */
  private clearPendingBucket(sessionId: string): void {
    const bucket = this.buckets.get(sessionId);
    if (bucket) {
      if (bucket.debounceTimer) {
        clearTimeout(bucket.debounceTimer);
        bucket.debounceTimer = null;
      }
      if (bucket.maxWaitTimer) {
        clearTimeout(bucket.maxWaitTimer);
        bucket.maxWaitTimer = null;
      }
      this.buckets.delete(sessionId);
    }
  }
}

/**
 * 工厂函数：创建 SessionCoordinator 实例
 */
export function createSessionCoordinator(options: SessionCoordinatorOptions): SessionCoordinator {
  return new SessionCoordinator(options);
}
