import EventEmitter from 'node:events';
import type {
  FormattedText,
  KK9Driver,
  KK9Message,
  KK9RecalledEvent,
  SendResult,
} from '@kkbot/driver';
import type { KKBotStore } from '@kkbot/store';
import type {
  ConsolidatedMessage,
  CoordinatorConfig,
  CoordinatorDispatchResult,
  CoordinatorEvents,
  DispatchReplyOptions,
  PendingBucket,
} from './types/index.js';
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
 * 上层业务会话编排器：协同 @kkbot/driver 与 @kkbot/store，
 * 负责智能短消息防抖合并队列、撤回即时熔断、人机协同退避与视觉红点守卫
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class SessionCoordinator extends EventEmitter {
  public readonly driver: KK9Driver;
  public readonly store: KKBotStore;
  public readonly config: Required<Omit<CoordinatorConfig, 'onConsolidatedMessage'>> & {
    onConsolidatedMessage?: (
      message: ConsolidatedMessage
    ) => Promise<void | CoordinatorDispatchResult> | void;
  };

  /** 各会话防抖队列桶映射表 (sessionId -> PendingBucket) */
  private readonly buckets = new Map<string, PendingBucket>();
  /** 记录 Bot 自身发出的消息 ID (用于回显防抖识别与过滤) */
  private readonly botSentMessageIds = new Set<string>();
  /** 运行状态标记 */
  private isRunning = false;

  private readonly boundHandleMessage: (msg: KK9Message) => void;
  private readonly boundHandleRecalled: (evt: KK9RecalledEvent) => void;

  constructor(options: { driver: KK9Driver; store: KKBotStore; config?: CoordinatorConfig }) {
    super();
    this.driver = options.driver;
    this.store = options.store;
    this.config = {
      debounceMs: options.config?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxWaitMs: options.config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      takeoverDurationMs: options.config?.takeoverDurationMs ?? DEFAULT_TAKEOVER_DURATION_MS,
      autoMarkRead: options.config?.autoMarkRead ?? true,
      onConsolidatedMessage: options.config?.onConsolidatedMessage,
    };

    this.boundHandleMessage = (msg: KK9Message): void => {
      this.handleInboundMessage(msg);
    };
    this.boundHandleRecalled = (evt: KK9RecalledEvent): void => {
      this.handleRecalled(evt);
    };
  }

  /**
   * 启动会话编排器，挂载底层 Driver 事件监听
   */
  public start(): void {
    if (this.isRunning) {
      return;
    }
    this.isRunning = true;
    this.driver.on('message', this.boundHandleMessage);
    this.driver.on('recalled', this.boundHandleRecalled);
    log.info(
      {
        debounceMs: this.config.debounceMs,
        maxWaitMs: this.config.maxWaitMs,
        takeoverDurationMs: this.config.takeoverDurationMs,
      },
      'SessionCoordinator 已成功启动'
    );
  }

  /**
   * 停止会话编排器，解绑事件监听并清理所有待处理定时器
   */
  public stop(): void {
    if (!this.isRunning) {
      return;
    }
    this.isRunning = false;
    this.driver.off('message', this.boundHandleMessage);
    this.driver.off('recalled', this.boundHandleRecalled);

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

    log.info('SessionCoordinator 已安全停止');
  }

  /**
   * 当前处于待处理防抖状态的会话数量
   */
  public get pendingSessionCount(): number {
    return this.buckets.size;
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
   * 判定指定会话当前是否处于人工接管退避状态
   * @param sessionId 会话 ID
   * @param now 可选当前时间戳
   */
  public isTakeoverActive(sessionId: string, now?: number): boolean {
    return this.store.sessions.isTakeoverActive(sessionId, now);
  }

  /**
   * 手动为会话设置人工接管退避期
   * @param sessionId 会话 ID
   * @param durationMs 退避持续时长毫秒数，默认配置值 (10分钟)
   */
  public setTakeover(sessionId: string, durationMs?: number): void {
    const duration = durationMs ?? this.config.takeoverDurationMs;
    const takeoverUntil = Date.now() + duration;
    this.clearPendingBucket(sessionId);
    this.store.sessions.upsertSession({ id: sessionId });
    this.store.sessions.setTakeoverUntil(sessionId, takeoverUntil);
    log.info({ sessionId, takeoverUntil, duration }, '手动设置人工接管退避期');
    this.emit('takeover', sessionId, takeoverUntil);
  }

  /**
   * 手动解除会话的人工接管退避状态
   * @param sessionId 会话 ID
   */
  public clearTakeover(sessionId: string): void {
    this.store.sessions.setTakeoverUntil(sessionId, 0);
    log.info({ sessionId }, '已解除人工接管退避状态');
  }

  /**
   * 核心入站消息处理流
   * @param msg 入站消息实体
   */
  public handleInboundMessage(msg: KK9Message): void {
    const sessionId = msg.sessionId;

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

      // 设置 10 分钟退避截止时间
      const takeoverUntil = Date.now() + this.config.takeoverDurationMs;
      this.store.sessions.upsertSession({
        id: sessionId,
        name: msg.sessionName,
        type: msg.sessionType,
      });
      this.store.sessions.setTakeoverUntil(sessionId, takeoverUntil);

      // 保存人类发出的消息到 Store
      this.store.messages.saveMessage({
        sessionId,
        messageId: msg.id,
        sender: msg.sender || '自己',
        senderId: msg.senderId,
        content: msg.content,
        messageType: msg.messageType || 'text',
        isFromSelf: true,
        isRecalled: false,
        createdAt: msg.timestamp || Date.now(),
      });

      this.emit('takeover', sessionId, takeoverUntil, msg);
      return;
    }

    // 2. 处理客户或外部成员发出的消息 (isMe: false)
    // 确保会话存在并更新消息活动时间
    const now = msg.timestamp || Date.now();
    this.store.sessions.upsertSession({
      id: sessionId,
      name: msg.sessionName,
      type: msg.sessionType,
    });
    this.store.sessions.touchMessageTime(sessionId, now);

    // 持久化消息到 Store
    this.store.messages.saveMessage({
      sessionId,
      messageId: msg.id,
      sender: msg.sender,
      senderId: msg.senderId,
      content: msg.content,
      messageType: msg.messageType || 'text',
      isFromSelf: false,
      isRecalled: false,
      createdAt: now,
    });

    // 检查是否处于人工退避期
    if (this.isTakeoverActive(sessionId, now)) {
      log.info({ sessionId, messageId: msg.id }, '会话处于人工退避期，抑制自动回复并保持静默');
      this.emit('suppressed', sessionId, 'human_takeover', msg);
      return;
    }

    // 检查会话是否被禁用
    const sessionRecord = this.store.sessions.getSession(sessionId);
    if (sessionRecord && sessionRecord.mode === 'disabled') {
      log.info({ sessionId, messageId: msg.id }, '会话已禁用自动应答，抑制回复');
      this.emit('suppressed', sessionId, 'session_disabled', msg);
      return;
    }

    // 3. 进入短消息防抖合并队列 (Debounce Queue)
    this.enqueueMessage(msg);
  }

  /**
   * 消息撤回事件处理 (Recall Fusion)
   * @param event 消息撤回事件元数据
   */
  public handleRecalled(event: KK9RecalledEvent): void {
    const { sessionId, messageId } = event;
    log.info({ sessionId, messageId }, '收到消息撤回事件，执行即时熔断检查');

    // 1. 在 Store 中标记已撤回
    this.store.messages.markMessageRecalled(sessionId, messageId);

    // 2. 检查防抖队列并进行剔除
    const bucket = this.buckets.get(sessionId);
    if (!bucket) {
      return;
    }

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
    const sessionRecord = this.store.sessions.getSession(sessionId);
    const effectiveMode = options.mode ?? sessionRecord?.mode ?? 'auto';

    // 1. 草稿模式守护：保存草稿并坚决保留视觉红点
    if (effectiveMode === 'draft') {
      log.info({ sessionId }, '会话处于 draft 草稿模式，保存草稿记录并坚决保留红点');
      const contentStr =
        typeof replyContent === 'string' ? replyContent : JSON.stringify(replyContent);

      this.store.messages.saveMessage({
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
    if (this.isTakeoverActive(sessionId)) {
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

    // 4. 自动发送模式 (auto)：执行发送与红点消除
    let sendResult: SendResult;
    try {
      if (typeof replyContent === 'string') {
        sendResult = await this.driver.sendText(replyContent, {
          ...options,
          targetSessionId: sessionId,
        });
      } else {
        sendResult = await this.driver.sendRichText(replyContent, {
          ...options,
          targetSessionId: sessionId,
        });
      }
    } catch (err) {
      log.error({ sessionId, err: String(err) }, '调用 Driver 发送消息异常');
      sendResult = {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }

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
      this.store.sessions.upsertSession({ id: sessionId });
      this.store.sessions.touchReplyTime(sessionId, now);
      this.store.messages.saveMessage({
        sessionId,
        messageId: sendResult.messageId,
        sender: '自己',
        content: typeof replyContent === 'string' ? replyContent : JSON.stringify(replyContent),
        messageType: typeof replyContent === 'string' ? 'text' : 'rich-text',
        isFromSelf: true,
        isRecalled: false,
        createdAt: now,
      });

      // 视觉红点守卫：仅在自动回复发送成功后消除红点
      let redDotCleared = false;
      if (this.config.autoMarkRead) {
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
   * 排空所有待处理消息并返回，不触发后续 onConsolidatedMessage 回调
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
  private enqueueMessage(msg: KK9Message): void {
    const sessionId = msg.sessionId;
    let bucket = this.buckets.get(sessionId);

    if (!bucket) {
      bucket = {
        sessionId,
        sessionName: msg.sessionName,
        sessionType: msg.sessionType,
        sender: msg.sender,
        senderId: msg.senderId,
        messages: [],
        debounceTimer: null,
        maxWaitTimer: null,
        firstReceivedAt: Date.now(),
      };
      this.buckets.set(sessionId, bucket);

      // 设置最长等待时间定时器 (防止高频连发导致无限延迟)
      bucket.maxWaitTimer = setTimeout(() => {
        void this.flush(sessionId);
      }, this.config.maxWaitMs);
    }

    bucket.messages.push(msg);

    // 重置 1.5 秒滑动窗口防抖定时器
    if (bucket.debounceTimer) {
      clearTimeout(bucket.debounceTimer);
    }
    bucket.debounceTimer = setTimeout(() => {
      void this.flush(sessionId);
    }, this.config.debounceMs);

    log.debug(
      { sessionId, queueLength: bucket.messages.length, debounceMs: this.config.debounceMs },
      '新消息压入防抖队列'
    );
    this.emit('message_queued', sessionId, msg, bucket.messages.length);
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
    if (this.isTakeoverActive(sessionId)) {
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

    if (typeof this.config.onConsolidatedMessage === 'function') {
      try {
        await this.config.onConsolidatedMessage(consolidated);
      } catch (err) {
        log.error({ sessionId, err: String(err) }, '执行 onConsolidatedMessage 回调异常');
        this.emit('error', err instanceof Error ? err : new Error(String(err)));
      }
    }
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
export function createSessionCoordinator(options: {
  driver: KK9Driver;
  store: KKBotStore;
  config?: CoordinatorConfig;
}): SessionCoordinator {
  return new SessionCoordinator(options);
}
