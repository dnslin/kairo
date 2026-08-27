import EventEmitter from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { RequestContext } from '@mastra/core/request-context';
import {
  createMessageIdentityKey,
  type FormattedText,
  type KK9Driver,
  type KK9Message,
  type KK9RecalledEvent,
  type SendResult,
} from '@kkbot/driver';

import type {
  ComplianceDeletionCommand,
  ComplianceDeletionRecord,
  ComplianceDeletionScope,
  DeliveryAdjudicationDecision,
  DeliveryStatus,
  Delivery,
  KKBotStore,
  MessageRawPayload,
  SessionMessage,
  MessageProcessingState,
  SessionMode,
} from '@kkbot/store';
import {
  type KKBotAgent,
  deriveUserMessageId,
  deriveAssistantMessageId,
  ensureMastraThread,
  createMastraTextMessage,
  removeMastraMessage,
  resetObservationalMemoryScope,
  type KKBotAgentRunResult,
  type KKBotRequestContextValues,
  type Memory,
} from '@kkbot/agent';
import type {
  ComplianceAuthorizationResult,
  ComplianceDeletionAuthorizer,
  ConsolidatedMessage,
  CoordinatorConfig,
  CoordinatorDispatchResult,
  CoordinatorEvents,
  CoordinatorFaultHooks,
  DispatchReplyOptions,
  InFlightSession,
  PendingBucket,
  SessionCoordinatorOptions,
  WorkAdmission,
} from './types/index.js';
import { createChildLogger } from './utils/logger.js';
import {
  DeliveryRecoveryScanner,
  type DeliveryRecoveryReport,
} from './recovery/delivery-recovery-scanner.js';
import { createMastraAgentInput } from './agent-input.js';

const log = createChildLogger('session-coordinator');

const DEFAULT_DEBOUNCE_MS = 1500; // 1.5 秒
const DEFAULT_MAX_WAIT_MS = 5000; // 5 秒
const DEFAULT_TAKEOVER_DURATION_MS = 10 * 60 * 1000; // 10 分钟 (600,000ms)
const MAX_BOT_SENT_KEYS = 5000;

/**
 * 组装规范化消息的多模态载荷与扩展元数据
 */
function assembleRawPayload(msg: KK9Message): MessageRawPayload | null {
  const payload: MessageRawPayload = {};
  let hasData = false;

  if (msg.raw && typeof msg.raw === 'object') {
    Object.assign(payload, msg.raw);
    hasData = true;
  }
  if (msg.mentions || msg.atMe || msg.atAll) {
    payload.mentions = {
      isAtMe: Boolean(msg.atMe || msg.mentions?.isAtMe),
      isAtAll: Boolean(msg.atAll || msg.mentions?.isAtAll),
      mentionedUsers: msg.mentions?.mentionedUsers || [],
    };
    hasData = true;
  }
  if (msg.replyTo) {
    payload.replyTo = {
      id: msg.replyTo.replyToId,
      replyToId: msg.replyTo.replyToId,
      sender: msg.replyTo.replyToSender,
      replyToSender: msg.replyTo.replyToSender,
      content: msg.replyTo.replyToContent,
      replyToContent: msg.replyTo.replyToContent,
    };
    hasData = true;
  }
  if (msg.fileInfo) {
    payload.fileInfo = {
      name: msg.fileInfo.fileName,
      fileName: msg.fileInfo.fileName,
      size: msg.fileInfo.fileSize,
      fileSize: msg.fileInfo.fileSize,
      extension: msg.fileInfo.fileExt,
      fileExt: msg.fileInfo.fileExt,
      path: msg.fileInfo.filePath,
      filePath: msg.fileInfo.filePath,
    };
    hasData = true;
  }
  if (msg.images && msg.images.length > 0) {
    payload.images = msg.images.map(img => ({
      url: img.url,
      path: img.filePath,
      width: img.width,
      height: img.height,
      mimeType: img.mimeType,
      size: img.size,
    }));
    hasData = true;
  }

  return hasData ? payload : null;
}
function resolveInboundOrigin(msg: KK9Message): NonNullable<KK9Message['origin']> {
  if (msg.origin) {
    return msg.origin;
  }
  if (msg.messageType === 'system') {
    return 'system';
  }

  const rawOrigin = msg.raw?.['origin'];
  if (
    rawOrigin === 'external' ||
    rawOrigin === 'operator' ||
    rawOrigin === 'bot_echo' ||
    rawOrigin === 'system' ||
    rawOrigin === 'unknown'
  ) {
    return rawOrigin;
  }

  if (typeof msg.isMe === 'boolean') {
    return msg.isMe ? 'unknown' : 'external';
  }
  if (typeof msg.raw?.['isMe'] === 'boolean') {
    return msg.raw['isMe'] ? 'unknown' : 'external';
  }
  return 'unknown';
}

function restrictConsolidatedToClaimedMessages(
  consolidated: ConsolidatedMessage,
  claimedMessageIds: string[]
): ConsolidatedMessage | null {
  const claimed = new Set(claimedMessageIds);
  const messages = consolidated.messages.filter(message =>
    claimed.has(message.messageId || message.id)
  );
  if (messages.length === 0) {
    return null;
  }

  const lastMessage = messages[messages.length - 1];
  return {
    ...consolidated,
    sender: lastMessage?.sender || consolidated.sender,
    senderId: lastMessage?.senderId || consolidated.senderId,
    content: messages.map(message => message.content).join('\n'),
    messageCount: messages.length,
    messages,
    firstReceivedAt: messages[0]?.timestamp ?? consolidated.firstReceivedAt,
    lastReceivedAt: lastMessage?.timestamp ?? consolidated.lastReceivedAt,
    messageIds: messages.map(message => message.messageId || message.id),
    atMe: messages.some(message => message.atMe || message.mentions?.isAtMe) || undefined,
    atAll: messages.some(message => message.atAll || message.mentions?.isAtAll) || undefined,
  };
}
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
 * 上层业务会话编排器：协同 @kkbot/driver、@kkbot/store 与 Mastra-native Agent，
 * 负责私聊防抖、撤回、人工接管、在途中断、串行发送和 Delivery 事实投影。
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class SessionCoordinator extends EventEmitter {
  public readonly admissionGate?: WorkAdmission;
  public readonly driver: KK9Driver;
  public readonly store: KKBotStore;
  public readonly agent?: KKBotAgent;
  public readonly mastraMemory?: Memory;
  public readonly mastraStorage?: unknown;
  public readonly complianceAuthorizer?: ComplianceDeletionAuthorizer;
  public readonly hooks?: CoordinatorFaultHooks;
  public readonly config: Required<Omit<CoordinatorConfig, 'onConsolidatedMessage'>> & {
    onConsolidatedMessage?: (
      message: ConsolidatedMessage
    ) => Promise<void | CoordinatorDispatchResult> | void;
  };

  /** 各会话防抖队列桶映射表 (sessionId -> PendingBucket) */
  private readonly buckets = new Map<string, PendingBucket>();
  /** 所有已启动的 flush→claim→Agent/Delivery 任务，Shutdown 必须等待其完成。 */
  private readonly activeFlushes = new Set<Promise<void>>();
  /** Driver 事件回调中尚未完成的入站 handler，Shutdown 必须等待其落定。 */
  private readonly activeInboundHandlers = new Set<Promise<void>>();
  private stopping = false;
  /** 活跃中的大模型在途生成会话锁映射表 (sessionId -> InFlightSession) */
  private readonly inFlightSessions = new Map<string, InFlightSession>();
  /** 记录 Bot 自身发出的消息身份键（sessionId:nativeMessageId），用于回显过滤 */
  private readonly botSentMessageKeys = new Set<string>();

  /** 记录已被撤回的消息 ID 集合 (用于防止消息存储与撤回并发竞争) */
  private readonly recalledMessageIds = new Set<string>();
  /** 记录已知已被墓碑化的消息集合 (sessionId:messageId -> 0ms 同步防复活与防误杀栅栏) */
  private readonly tombstoneCache = new Set<string>();
  /** 同一 startup generation 的短期入站 claim；最终幂等仍由 Raw Store 唯一约束证明。 */
  private readonly inboundClaims = new Set<string>();
  /** 记录各会话在内存中的人工退避截止时间 (sessionId -> timestamp) */
  private readonly takeoverUntilMap = new Map<string, number>();
  /** 记录各会话在内存中的工作模式缓存 (sessionId -> mode) */
  private readonly sessionModeMap = new Map<string, SessionMode>();
  /** 记录各会话在内存中的类型缓存 (sessionId -> sessionType) */
  private readonly sessionTypeMap = new Map<string, string>();
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
    this.admissionGate = options.admissionGate;
    this.store = options.store;
    this.agent = options.agent;
    this.mastraMemory = options.mastraMemory;
    this.mastraStorage = options.mastraStorage;
    this.complianceAuthorizer = options.complianceAuthorizer;
    if (this.agent && !this.mastraMemory) {
      throw new Error('装配 Mastra-native Agent 时必须同时传入协同的 mastraMemory 实例');
    }
    this.hooks = options.hooks;
    this.config = {
      debounceMs: options.config?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
      maxWaitMs: options.config?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
      takeoverDurationMs: options.config?.takeoverDurationMs ?? DEFAULT_TAKEOVER_DURATION_MS,
      maxRetries: options.config?.maxRetries ?? 2,
      autoMarkRead: options.config?.autoMarkRead ?? true,
      onConsolidatedMessage: options.config?.onConsolidatedMessage,
    };

    this.boundHandleMessage = (msg: KK9Message): void => {
      this.trackInbound(this.handleInboundMessage(msg), {
        sessionId: msg.sessionId,
        messageId: msg.id,
      });
    };
    this.boundHandleRecalled = (evt: KK9RecalledEvent): void => {
      this.trackInbound(this.handleRecalled(evt), {
        sessionId: evt.sessionId,
        messageId: evt.messageId,
      });
    };
  }

  /**
   * 启动会话编排器：先执行 Delivery 检查点恢复扫描，再挂载底层 Driver 事件监听。
   */
  public async start(): Promise<void> {
    if (this.isRunning) {
      return;
    }
    this.stopping = false;

    try {
      const recoveryReport = await this.runDeliveryRecoveryScan();
      if (recoveryReport.errors.length > 0) {
        const errDetails = recoveryReport.errors
          .map(e => `[${e.deliveryId}]: ${e.error}`)
          .join('; ');
        const errMsg = `SessionCoordinator 启动前恢复扫描发现错误，阻止系统启动 (Fail-Closed): ${errDetails}`;
        log.error({ errors: recoveryReport.errors }, errMsg);
        throw new Error(errMsg);
      }
    } catch (recErr) {
      log.error({ err: recErr }, 'SessionCoordinator 启动前 Delivery 恢复扫描失败，阻止启动');
      throw recErr;
    }

    try {
      const tombKeys = await this.store.tombstones.getAllTombstoneKeys();
      for (const key of tombKeys) {
        this.tombstoneCache.add(key);
        this.recalledMessageIds.add(key);
      }
    } catch (tombErr) {
      log.error({ err: tombErr }, 'SessionCoordinator 启动前预热墓碑栅栏失败，阻止系统启动');
      throw tombErr;
    }

    this.driver.on('message', this.boundHandleMessage);
    this.driver.on('recalled', this.boundHandleRecalled);
    this.isRunning = true;

    log.info(
      {
        debounceMs: this.config.debounceMs,
        maxWaitMs: this.config.maxWaitMs,
        takeoverDurationMs: this.config.takeoverDurationMs,
        hasAgent: Boolean(this.agent),
        hasMastraMemory: Boolean(this.mastraMemory),
      },
      'SessionCoordinator 已成功启动'
    );
  }

  /**
   * 停止会话编排器，解绑事件监听并清理所有待处理定时器与在途中断
   */
  public async stop(): Promise<void> {
    const wasRunning = this.isRunning;
    this.stopping = true;
    this.isRunning = false;
    if (wasRunning) {
      this.driver.off('message', this.boundHandleMessage);
      this.driver.off('recalled', this.boundHandleRecalled);
    }

    // 先阻止 timer 派发新 flush，再等待已经开始的整条任务链。
    for (const bucket of this.buckets.values()) {
      if (bucket.debounceTimer) {
        clearTimeout(bucket.debounceTimer);
        bucket.debounceTimer = null;
      }
      if (bucket.maxWaitTimer) {
        clearTimeout(bucket.maxWaitTimer);
        bucket.maxWaitTimer = null;
      }
    }
    this.buckets.clear();
    const shutdownErrors: Error[] = [];

    while (
      this.activeInboundHandlers.size > 0 ||
      this.activeFlushes.size > 0 ||
      this.inFlightSessions.size > 0
    ) {
      const waits: Promise<unknown>[] = [
        ...Array.from(this.activeInboundHandlers),
        ...Array.from(this.activeFlushes),
      ];
      for (const inFlight of this.inFlightSessions.values()) {
        inFlight.abortController.abort();
        if (inFlight.promise) {
          waits.push(inFlight.promise);
        }
      }
      if (waits.length === 0) {
        break;
      }
      const settledErrors = await Promise.all(
        waits.map(task =>
          task.then(
            () => null,
            error => (error instanceof Error ? error : new Error(String(error)))
          )
        )
      );
      for (const error of settledErrors) {
        if (error && !shutdownErrors.includes(error)) {
          shutdownErrors.push(error);
        }
      }
    }
    this.inFlightSessions.clear();

    if (shutdownErrors.length > 0) {
      throw new AggregateError(shutdownErrors, 'SessionCoordinator Shutdown 活动任务失败');
    }

    log.info('SessionCoordinator 已安全停止');
  }

  /**
   * 记录已知墓碑至内存同步栅栏 (用于 0ms 防复活与在途防误杀)
   */
  private recordTombstoneMemory(sessionId: string, messageId: string): void {
    const key = `${sessionId}:${messageId}`;
    this.tombstoneCache.add(key);
    this.recalledMessageIds.add(key);
  }
  private claimInboundMessage(key: string): boolean {
    if (this.inboundClaims.has(key)) {
      return false;
    }
    this.inboundClaims.add(key);
    if (this.inboundClaims.size > 10000) {
      const oldest = this.inboundClaims.values().next().value;
      if (oldest) {
        this.inboundClaims.delete(oldest);
      }
    }
    return true;
  }

  private releaseInboundMessage(key: string): void {
    this.inboundClaims.delete(key);
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
   * 严格规范化会话分流：
   * 1. sessionType = 'group' 是进入 Agent 链前的强制短路条件：
   *    调用 Store 按 (session_id, message_id) 幂等写入 KK Raw Store，写入完成后立即结束本次处理，绝不进入下游。
   * 2. sessionType = 'private' 进入一对一私聊主链路流程。
   * @param msg 入站消息实体
   */
  public async handleInboundMessage(
    msg: KK9Message,
    options: { compensation?: boolean } = {}
  ): Promise<void> {
    this.admissionGate?.assertOpen();
    const sessionId = msg.sessionId;
    const sessionType = msg.sessionType || 'private';
    this.sessionTypeMap.set(sessionId, sessionType);

    // 0. 【GroupSession 强制短路分流】：进入 Agent 链 / 防抖 / 在途中断前的绝对边界
    if (sessionType === 'group') {
      const messageId = msg.messageId || msg.id;
      const origin = resolveInboundOrigin(msg);
      log.debug(
        { sessionId, messageId, origin, sender: msg.sender },
        '捕获到 GroupSession 群聊消息，执行 Raw Store-only 幂等持久化并立即结束'
      );
      try {
        const replyTargetId =
          msg.replyTo?.replyToId ??
          (typeof msg.raw?.replyToId === 'string' ? msg.raw.replyToId : null);
        const savedMsg = await this.store.messages.saveMessage({
          sessionId,
          messageId,
          sender: msg.sender,
          senderId: msg.senderId,
          content: msg.content,
          messageType: msg.messageType || 'text',
          origin,
          rawPayload: assembleRawPayload(msg),
          replyTargetId,
          isFromSelf: msg.isMe,
          isRecalled: this.recalledMessageIds.has(`${sessionId}:${messageId}`),
          createdAt: msg.timestamp || Date.now(),
          processingState: 'raw_only',
        });
        this.emit('group_message_saved', sessionId, savedMsg, msg);
        await this.store.messages.markMessagesRawOnly(sessionId, [messageId]);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(
          {
            err: error,
            cause: error.cause,
            sessionId,
            messageId,
            origin,
          },
          'GroupSession 消息写入 KK Raw Store 失败，立即终止本次处理'
        );
        this.emit('group_message_save_failed', sessionId, msg, error);
        // 关键安全原则：写入失败时停止处理，不进入下游，不升级为 PrivateSession
        return;
      }
      // GroupSession 写入完成后立即结束本次处理！
      return;
    }

    // 1. PrivateSession 会话处理主流程
    await this.handlePrivateSessionMessage(msg, options);
  }
  /** 通过持久 Raw Store 查重后处理断线窗口补偿消息。 */
  public handleCompensationMessage(msg: KK9Message): Promise<void> {
    const task = (async (): Promise<void> => {
      await this.handleInboundMessage(msg, { compensation: true });
      await this.flushSession(msg.sessionId);
    })();
    return this.trackInboundTask(task);
  }
  /**
   * 一对一私聊消息处理主流程
   */
  public async handlePrivateSessionMessage(
    msg: KK9Message,
    options: { compensation?: boolean } = {}
  ): Promise<void> {
    const sessionId = msg.sessionId;
    const messageId = msg.messageId || msg.id;
    const messageKey = createMessageIdentityKey(sessionId, messageId);
    const tombstoneKey = messageKey;
    const origin = resolveInboundOrigin(msg);

    // 0. 【优先识别并过滤 Bot 回显】：严禁在过滤回显前 abort，避免回显误杀正在运行的 Run 或触发退避
    if (this.botSentMessageKeys.has(messageKey) || origin === 'bot_echo') {
      this.botSentMessageKeys.delete(messageKey);
      log.debug({ sessionId, messageId }, '识别为 Bot 自身发出的消息回显，安全忽略且不触发中断');
      return;
    }

    // 1. 【0ms 内存墓碑栅栏门禁】：若消息已知被墓碑化，0ms 瞬时静默抑制，严禁中断在途 Run，严禁触发退避与 Memory 写入
    if (this.tombstoneCache.has(tombstoneKey)) {
      log.info(
        { sessionId, messageId: msg.id },
        '消息命中内存墓碑栅栏，0ms 瞬时静默抑制，拒绝触发接管、中断在途 Run 与 Memory 写入'
      );
      this.emit('suppressed', sessionId, 'tombstoned', msg);
      return;
    }
    const claimKey = tombstoneKey;
    if (!this.claimInboundMessage(claimKey)) {
      log.debug({ sessionId, messageId }, '同代入站 claim 已存在，拒绝重复副作用');
      return;
    }

    const receivedAt = msg.timestamp || Date.now();
    const isOperator = origin === 'operator';
    let compensationSaved: SessionMessage | null = null;
    if (origin === 'unknown') {
      try {
        await this.persistInboundMessage(msg, receivedAt, msg.isMe, 'raw_only');
        log.info(
          { sessionId, messageId, isMe: msg.isMe },
          '入站消息来源未知，已仅写入 Raw Store 并禁止进入 Agent'
        );
        this.emit('suppressed', sessionId, 'unknown_source', msg);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        log.error({ err: error, sessionId, messageId }, '未知来源消息 Raw Store 写入失败');
        this.emitError(error);
      }
      return;
    }
    if (options.compensation) {
      try {
        const saved = await this.persistInboundMessage(msg, receivedAt, isOperator);
        const alreadyCompleted =
          saved.isNewlyInserted === false &&
          saved.processingState !== undefined &&
          saved.processingState !== 'pending';
        if (saved.isTombstoned || alreadyCompleted) {
          this.releaseInboundMessage(claimKey);
          if (saved.isTombstoned) {
            this.recordTombstoneMemory(sessionId, messageId);
            this.emit('suppressed', sessionId, 'tombstoned', msg);
          }
          return;
        }
        compensationSaved = saved;
      } catch (err) {
        this.releaseInboundMessage(claimKey);
        const error = err instanceof Error ? err : new Error(String(err));
        log.error(
          { err: error, sessionId, messageId },
          '补偿消息唯一准入失败，拒绝任何中断或接管副作用'
        );
        this.emitError(error);
        return;
      }
    }
    if (this.stopping) {
      this.releaseInboundMessage(claimKey);
      return;
    }

    // 2. 【0ms 瞬时同步中断在途 Run】：确认非墓碑消息后，立即切断在途只读请求
    const inFlight = this.inFlightSessions.get(sessionId);
    const isCompensationReplay = Boolean(
      options.compensation &&
      inFlight &&
      (inFlight.inputMessageIds?.includes(messageId) ||
        inFlight.message.messages.some(message => (message.messageId || message.id) === messageId))
    );
    if (isCompensationReplay) {
      this.releaseInboundMessage(claimKey);
      log.debug({ sessionId, messageId }, '补偿消息已属于当前在途 Run，跳过中断与重复接管');
      return;
    }
    if (inFlight) {
      inFlight.abortController.abort();
      this.inFlightSessions.delete(sessionId);
      const elapsedMs = Date.now() - inFlight.startedAt;
      const abortReason = isOperator ? 'human_takeover' : 'new_inbound_message';
      log.info(
        { sessionId, elapsedMs, newMessageId: msg.id, reason: abortReason },
        '检测到同一会话收到真实新消息/操作员介入，0ms 同步切断在途请求'
      );
      this.emit('in_flight_aborted', sessionId, elapsedMs, abortReason);
    }

    // 3. 处理人类操作员在客户端介入 (Human Takeover)
    if (isOperator) {
      log.info(
        { sessionId, messageId: msg.id, sender: msg.sender, content: msg.content },
        '检测到人类操作员在客户端发送消息，触发人机协同退避'
      );

      // 立即清空该会话的防抖队列，取消 Bot 待发出的自动回复
      this.clearPendingBucket(sessionId);

      // 设置 10 分钟退避截止时间并在内存中同步生效
      const takeoverUntil = receivedAt + this.config.takeoverDurationMs;
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

      if (!compensationSaved) {
        try {
          const saved = await this.persistInboundMessage(msg, receivedAt, true);
          if (saved.isTombstoned || saved.isNewlyInserted === false) {
            this.releaseInboundMessage(claimKey);
            return;
          }
        } catch (err) {
          this.releaseInboundMessage(claimKey);
          const error = err instanceof Error ? err : new Error(String(err));
          this.emitError(error);
          return;
        }
      }

      // 将 operator 真实消息以自身稳定 ID 写入 Mastra Thread (表达真实历史，不伪装成 Bot 回复)
      if (this.mastraMemory) {
        try {
          const resourceId = await this.resolveSessionResourceId(sessionId, {
            senderId: msg.senderId,
            isFromSelf: true,
            origin: 'operator',
          });
          if (resourceId) {
            await ensureMastraThread(this.mastraMemory, sessionId, resourceId);
            const opMsgId = deriveUserMessageId(sessionId, msg.messageId || msg.id);
            await this.mastraMemory.saveMessages({
              messages: [
                createMastraTextMessage({
                  id: opMsgId,
                  role: 'assistant',
                  content: msg.content,
                  threadId: sessionId,
                  resourceId,
                  createdAt: new Date(receivedAt),
                }),
              ],
            });
            if (typeof this.mastraMemory.settled === 'function') {
              await this.mastraMemory.settled();
            }
          }
        } catch (opMemErr) {
          log.error({ opMemErr, sessionId }, '保存 operator 消息至 Mastra Memory 异常');
        }
      }

      // 将处于 generated 的未发送 Delivery 安全置为 aborted
      try {
        const deliveries = await this.store.deliveries.getDeliveriesBySession(sessionId);
        for (const d of deliveries) {
          if (d.status === 'generated') {
            await this.store.deliveries.updateStatus(d.id, 'aborted', {
              errorCode: 'ABORTED_HUMAN_TAKEOVER: 操作员介入接管会话',
            });
            await this.hooks?.afterAbortedPersist?.(d.id);
          }
        }
      } catch (delivErr) {
        log.debug({ delivErr, sessionId }, '更新未发送 Delivery 状态告警');
      }

      await this.store.messages.markMessagesRawOnly(sessionId, [messageId]);
      return;
    }

    // 3. 处理客户或外部成员发出的消息 (isMe: false)
    const now = msg.timestamp || Date.now();

    // 检查是否处于人工退避期（内存优先检测）
    const memTakeover = this.takeoverUntilMap.get(sessionId) ?? 0;
    if (memTakeover > now) {
      log.info({ sessionId, messageId: msg.id }, '会话处于人工退避期，抑制自动回复并保持静默');
      this.emit('suppressed', sessionId, 'human_takeover', msg);
      if (!compensationSaved) {
        try {
          const saved = await this.persistInboundMessage(msg, now, false);
          if (saved.isTombstoned || saved.isNewlyInserted === false) {
            this.releaseInboundMessage(claimKey);
          }
        } catch (err) {
          this.releaseInboundMessage(claimKey);
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      await this.store.messages.markMessagesRawOnly(sessionId, [messageId]);
      return;
    }

    // 检查会话是否被禁用（内存优先检测）
    const memMode = this.sessionModeMap.get(sessionId);
    if (memMode === 'disabled') {
      log.info({ sessionId, messageId: msg.id }, '会话已禁用自动应答，抑制回复');
      this.emit('suppressed', sessionId, 'session_disabled', msg);
      if (!compensationSaved) {
        try {
          const saved = await this.persistInboundMessage(msg, now, false);
          if (saved.isTombstoned || saved.isNewlyInserted === false) {
            this.releaseInboundMessage(claimKey);
          }
        } catch (err) {
          this.releaseInboundMessage(claimKey);
          this.emitError(err instanceof Error ? err : new Error(String(err)));
        }
      }
      await this.store.messages.markMessagesRawOnly(sessionId, [messageId]);
      return;
    }

    const persistPromise: Promise<boolean> = compensationSaved
      ? Promise.resolve(true)
      : (async (): Promise<boolean> => {
          try {
            const saved = await this.persistInboundMessage(msg, now, false);
            if (!saved || saved.isTombstoned) {
              this.releaseInboundMessage(claimKey);
              return false;
            }
            const isNew = saved.isNewlyInserted !== false;
            if (!isNew) {
              this.releaseInboundMessage(claimKey);
            }
            return isNew;
          } catch (err) {
            this.releaseInboundMessage(claimKey);
            const error = err instanceof Error ? err : new Error(String(err));
            log.error(
              { err: error, sessionId, messageId: msg.id },
              'PrivateSession 原始消息写入 KK Raw Store 失败，终止本次处理'
            );
            this.emitError(error);
            return false;
          }
        })();

    // 6. 同步先放入防抖队列并绑定持久化 Promise（保证快照与即时撤回熔断有效）
    if (inFlight) {
      log.info(
        { sessionId, messageCount: inFlight.message.messages.length },
        '将此前在途打断消息与新到达消息归并重聚'
      );
      this.regroupInFlightMessage(sessionId, inFlight.message, msg, persistPromise);
    } else {
      this.enqueueMessage(msg, persistPromise);
    }

    // 等待本次消息 Raw Store 写入完成
    await persistPromise;
  }

  /**
   * 异步持久化入站消息与更新会话活跃时间
   */
  private async persistInboundMessage(
    msg: KK9Message,
    now: number,
    isFromSelf: boolean,
    processingState: MessageProcessingState = 'pending'
  ): Promise<SessionMessage> {
    const sessionId = msg.sessionId;
    try {
      await this.store.sessions.upsertSession({
        id: sessionId,
        name: msg.sessionName,
        type: msg.sessionType,
      });
      await this.store.sessions.touchMessageTime(sessionId, now);

      const replyTargetId =
        msg.replyTo?.replyToId ??
        (typeof msg.raw?.replyToId === 'string' ? msg.raw.replyToId : null);
      const savedMsg = await this.store.messages.saveMessage({
        sessionId,
        messageId: msg.messageId || msg.id,
        origin: resolveInboundOrigin(msg),
        sender: msg.sender || (isFromSelf ? '自己' : ''),
        senderId: msg.senderId,
        content: msg.content,
        messageType: msg.messageType || 'text',
        rawPayload: assembleRawPayload(msg),
        replyTargetId,
        isFromSelf,
        isRecalled: this.recalledMessageIds.has(`${sessionId}:${msg.messageId || msg.id}`),
        createdAt: msg.timestamp || now,
        processingState,
      });

      if (savedMsg.isTombstoned) {
        log.info(
          { sessionId, messageId: msg.id, tombstoneType: savedMsg.tombstoneType },
          '消息命中持久墓碑，静默抑制并不进入下游'
        );
        this.emit('suppressed', sessionId, 'tombstoned', msg);
      }
      return savedMsg;
    } catch (err) {
      log.error({ err, sessionId: msg.sessionId, messageId: msg.id }, '持久化入站消息异常');
      throw err;
    }
  }

  /**
   * 消息撤回事件处理 (MessageRecall)
   * 1. 记录持久墓碑 (type: recall) 与 Raw Store 撤回事实
   * 2. GroupSession: 仅更新 Raw Store 撤回事实，立即结束（不触碰 Memory / Agent）
   * 3. PrivateSession:
   *    - 防抖期：从 Pending Bucket 移除，不创建 user Memory
   *    - Run 期间：0ms 中断正在使用该消息的只读 Run
   *    - Mastra Thread：按稳定 message ID 从活动上下文安全移出 (deleteMessages)
   *    - Observational Memory：执行保守的 Scope Reset (Fail-Closed)
   *    - Delivery：可证明未发送时安全进入 aborted，unknown 保持人工门禁，已 sent 及其 Memory 严格保留
   * @param event 消息撤回事件元数据
   */
  public async handleRecalled(event: KK9RecalledEvent): Promise<void> {
    const { sessionId, messageId } = event;
    log.info({ sessionId, messageId }, '收到消息撤回事件，执行即时熔断与活动上下文清理');

    this.recordTombstoneMemory(sessionId, messageId);

    // 0. 同步瞬时判定会话类型 (通过内存缓存 0ms 判定，无需等待 DB I/O)
    const cachedType = this.sessionTypeMap.get(sessionId);

    // 1. 【0ms 瞬时同步中断 PrivateSession 在途 Run 与清空防抖队列】(在任何 DB I/O 前立即执行！)
    if (cachedType !== 'group') {
      // 1.1 若在途生成任务中包含被撤回消息，立即 0ms 瞬时同步中断
      const inFlight = this.inFlightSessions.get(sessionId);
      if (inFlight) {
        const containsRecalled =
          inFlight.inputMessageIds?.includes(messageId) ||
          inFlight.message.messages.some(m => m.id === messageId || m.messageId === messageId);
        if (containsRecalled) {
          log.info({ sessionId, messageId }, '在途生成任务包含被撤回消息，立即 0ms 瞬时同步中断');
          inFlight.abortController.abort();
          this.inFlightSessions.delete(sessionId);
          const elapsedMs = Date.now() - inFlight.startedAt;
          this.emit('in_flight_aborted', sessionId, elapsedMs, 'message_recalled');
        }
      }

      // 1.2 同步瞬时剔除防抖队列中的消息
      const bucket = this.buckets.get(sessionId);
      if (bucket) {
        const originalCount = bucket.messages.length;
        bucket.messages = bucket.messages.filter(m => {
          const rawMsgId =
            (m.raw?.['messageId'] as string | undefined) ||
            (m.raw?.['msgID'] as string | undefined) ||
            (m.raw?.['id'] as string | undefined);
          return m.id !== messageId && m.messageId !== messageId && rawMsgId !== messageId;
        });

        if (bucket.items) {
          bucket.items = bucket.items.filter(item => {
            const rawMsgId =
              (item.message.raw?.['messageId'] as string | undefined) ||
              (item.message.raw?.['msgID'] as string | undefined) ||
              (item.message.raw?.['id'] as string | undefined);
            return (
              item.message.id !== messageId &&
              item.message.messageId !== messageId &&
              rawMsgId !== messageId
            );
          });
        }

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
    }

    // 2. 持久化撤回墓碑（Fail-Closed 保证阻止重放复活）
    try {
      await this.store.tombstones.recordTombstone({
        sessionId,
        messageId,
        type: 'recall',
        operator: 'user',
        reason: 'MessageRecall',
      });
    } catch (tombErr) {
      const errorMsg = tombErr instanceof Error ? tombErr.message : String(tombErr);
      log.error({ err: tombErr, sessionId, messageId }, '记录撤回墓碑失败，终止撤回流程');
      throw new Error(
        `记录撤回墓碑失败 (sessionId=${sessionId}, messageId=${messageId}): ${errorMsg}`,
        {
          cause: tombErr,
        }
      );
    }

    // 3. 异步在 Store 中标记已撤回
    await this.store.messages.markMessageRecalled(sessionId, messageId);
    // 4. 【GroupSession 强制短路】：若确定为群聊，持久化完成后立即结束，不执行后续 Memory / Delivery 处理
    const sessionRecord = await this.store.sessions.getSession(sessionId);
    const isGroup = cachedType === 'group' || sessionRecord?.type === 'group';
    if (isGroup) {
      log.debug({ sessionId, messageId }, 'GroupSession 撤回事件仅记录 Raw Store，立即结束');
      return;
    }

    // 5. 【PrivateSession 显式 Memory 移出与 OM Scope Reset】
    if (this.mastraMemory) {
      try {
        const userMsgId = deriveUserMessageId(sessionId, messageId);
        await removeMastraMessage(this.mastraMemory, userMsgId);

        // 5.1 重置受影响的 Observational Memory Scope (Fail-Closed)
        if (this.mastraStorage) {
          const resourceId =
            (await this.resolveSessionResourceId(sessionId, {
              senderId: undefined,
            } as ConsolidatedMessage)) || sessionId;
          await resetObservationalMemoryScope({
            memory: this.mastraMemory,
            threadId: sessionId,
            resourceId,
            storage: this.mastraStorage,
          });
        }
      } catch (memErr) {
        log.error({ memErr, sessionId, messageId }, '撤回消息清理 Mastra Memory / OM Scope 异常');
      }
    }

    // 4.5 将处于 generated 的未发送 Delivery 安全置为 aborted
    try {
      const deliveries = await this.store.deliveries.getDeliveriesBySession(sessionId);
      for (const d of deliveries) {
        if (d.status === 'generated') {
          await this.store.deliveries.updateStatus(d.id, 'aborted', {
            errorCode: 'ABORTED_MESSAGE_RECALLED: 关联消息已撤回',
          });
          await this.hooks?.afterAbortedPersist?.(d.id);
        }
      }
    } catch (delivErr) {
      log.debug({ delivErr, sessionId }, '更新未发送 Delivery 状态告警');
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
    this.admissionGate?.assertOpen();
    const memMode = this.sessionModeMap.get(sessionId);
    const sessionRecord = await this.store.sessions.getSession(sessionId);
    const effectiveMode = options.mode ?? memMode ?? sessionRecord?.mode ?? 'auto';

    // 1. 人机退避守护：退避期内拦截自动发送并坚决保留红点
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

    // 2. 禁用模式守护
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
      this.recordBotSentMessageId(sessionId, sendResult.messageId);
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
        origin: 'bot_echo',
        processingState: 'raw_only',
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
    await this.startFlush(sessionId, true);
  }

  /**
   * 显式触发所有会话的防抖聚合（用于关闭前排空）
   */
  public async flushAll(): Promise<void> {
    const sessionIds = Array.from(this.buckets.keys());
    for (const sessionId of sessionIds) {
      await this.startFlush(sessionId, true);
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
        this.startFlush(sessionId).catch(err => {
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
      this.startFlush(bucket.sessionId).catch(err => {
        log.error({ err, sessionId: bucket.sessionId }, errorContext);
      });
    }, this.config.debounceMs);
  }
  private startFlush(sessionId: string, allowBeforeStart = false): Promise<void> {
    if ((!this.isRunning && !allowBeforeStart) || this.stopping) {
      return Promise.resolve();
    }
    const task = this.flush(sessionId);
    this.activeFlushes.add(task);
    void task.then(
      () => this.activeFlushes.delete(task),
      () => this.activeFlushes.delete(task)
    );
    return task;
  }
  private trackInbound(task: Promise<void>, context: Record<string, unknown>): void {
    this.activeInboundHandlers.add(task);
    void task.then(
      () => this.activeInboundHandlers.delete(task),
      error => {
        this.activeInboundHandlers.delete(task);
        log.error({ ...context, err: error }, '入站 handler 执行异常');
      }
    );
  }
  private trackInboundTask(task: Promise<void>): Promise<void> {
    this.activeInboundHandlers.add(task);
    return task.then(
      () => {
        this.activeInboundHandlers.delete(task);
      },
      error => {
        this.activeInboundHandlers.delete(task);
        throw error;
      }
    );
  }
  private async releaseAgentClaimedMessages(
    inFlight: InFlightSession,
    runId: string,
    messageIds: string[]
  ): Promise<void> {
    try {
      await this.store.messages.releaseAgentClaims(inFlight.sessionId, messageIds, runId);
    } finally {
      if (this.inFlightSessions.get(inFlight.sessionId) === inFlight) {
        this.inFlightSessions.delete(inFlight.sessionId);
      }
    }
  }

  /**
   * 将新消息压入会话防抖队列
   */
  private enqueueMessage(
    msg: KK9Message,
    persistPromise: Promise<boolean> = Promise.resolve(true)
  ): void {
    if (this.stopping) {
      return;
    }
    const sessionId = msg.sessionId;
    const bucket = this.getOrCreatePendingBucket(sessionId, msg);
    bucket.messages.push(msg);
    if (!bucket.items) {
      bucket.items = [];
    }
    bucket.items.push({ message: msg, persistPromise });
    this.resetDebounceTimer(bucket, '执行滑动窗口防抖合并异常');
    this.emit('message_queued', sessionId, msg, bucket.messages.length);
  }

  /**
   * 将在途任务消息与新消息自动归并入防抖桶
   */
  private regroupInFlightMessage(
    sessionId: string,
    inFlightMessage: ConsolidatedMessage,
    newMsg: KK9Message,
    newPersistPromise: Promise<boolean> = Promise.resolve(true)
  ): void {
    if (this.stopping) {
      return;
    }
    const bucket = this.getOrCreatePendingBucket(
      sessionId,
      newMsg,
      inFlightMessage.firstReceivedAt || Date.now()
    );

    if (!bucket.items) {
      bucket.items = [];
    }

    // 归并在途任务消息 (指纹去重)
    const existingIds = new Set(bucket.messages.map(m => m.id));
    for (const m of inFlightMessage.messages) {
      if (!existingIds.has(m.id)) {
        bucket.messages.push(m);
        bucket.items.push({
          message: m,
          persistPromise: Promise.resolve(true),
        });
        existingIds.add(m.id);
      }
    }

    // 追加新消息
    if (!existingIds.has(newMsg.id)) {
      bucket.messages.push(newMsg);
      bucket.items.push({ message: newMsg, persistPromise: newPersistPromise });
    }

    // 重置防抖计时器
    this.resetDebounceTimer(bucket, '执行重聚防抖合并异常');
    this.emit('in_flight_regrouped', sessionId, bucket.messages.length);
  }

  /**
   * 触发防抖合并并将聚合消息传递给处理流水线
   */
  private async prepareAgentRun(
    sessionId: string,
    consolidated: ConsolidatedMessage
  ): Promise<InFlightSession | null> {
    const runId = randomUUID();
    const abortController = new AbortController();
    const inFlight: InFlightSession = {
      sessionId,
      runId,
      inputMessageIds: consolidated.messages.map(message => message.messageId || message.id),
      abortController,
      startedAt: Date.now(),
      message: consolidated,
    };
    this.inFlightSessions.set(sessionId, inFlight);

    if (this.stopping || abortController.signal.aborted) {
      if (this.inFlightSessions.get(sessionId) === inFlight) {
        this.inFlightSessions.delete(sessionId);
      }
      return null;
    }

    let claimedMessageIds: string[];
    try {
      claimedMessageIds = await this.store.messages.claimMessagesForAgent(
        sessionId,
        inFlight.inputMessageIds ?? [],
        runId
      );
    } catch (error) {
      if (this.inFlightSessions.get(sessionId) === inFlight) {
        this.inFlightSessions.delete(sessionId);
      }
      throw error;
    }

    if (this.stopping || abortController.signal.aborted) {
      await this.releaseAgentClaimedMessages(inFlight, runId, claimedMessageIds);
      return null;
    }
    if (claimedMessageIds.length === 0) {
      if (this.inFlightSessions.get(sessionId) === inFlight) {
        this.inFlightSessions.delete(sessionId);
      }
      log.info({ sessionId, runId }, '本轮输入均已被既有 Agent claim，跳过重复 Agent Run');
      return null;
    }

    const claimedConsolidated = restrictConsolidatedToClaimedMessages(
      consolidated,
      claimedMessageIds
    );
    if (!claimedConsolidated) {
      await this.releaseAgentClaimedMessages(inFlight, runId, claimedMessageIds);
      log.warn(
        { sessionId, runId, claimedMessageIds },
        'Agent claim 未匹配到当前消息快照，跳过执行'
      );
      return null;
    }

    inFlight.message = claimedConsolidated;
    inFlight.inputMessageIds = claimedConsolidated.messageIds;
    return inFlight;
  }

  private async flush(sessionId: string): Promise<void> {
    const bucket = this.buckets.get(sessionId);
    if (!bucket || bucket.messages.length === 0) {
      this.clearPendingBucket(sessionId);
      return;
    }

    // 从活跃桶移除并清理定时器
    this.clearPendingBucket(sessionId);

    // 1. 【核心门禁】：等待桶内所有消息的 Raw Store 持久化 Promise 完成
    if (bucket.items && bucket.items.length > 0) {
      const persistResults = await Promise.all(bucket.items.map(item => item.persistPromise));
      const validMessages: KK9Message[] = [];
      for (let i = 0; i < bucket.items.length; i++) {
        const item = bucket.items[i];
        const persisted = persistResults[i];
        if (item && persisted) {
          const nativeId = item.message.messageId || item.message.id;
          const isRecalled = this.recalledMessageIds.has(`${sessionId}:${nativeId}`);
          if (!isRecalled) {
            validMessages.push(item.message);
          }
        }
      }
      bucket.messages = validMessages;
    }

    // 若经 Raw Store 持久化判定与撤回过滤后无有效消息，静默结束本次 flush
    if (bucket.messages.length === 0) {
      log.info({ sessionId }, '防抖桶内无成功持久化或全部被撤回的有效消息，静默结束本次 flush');
      return;
    }
    if (this.stopping) {
      log.info({ sessionId }, 'Shutdown 已开始，Raw Store 完成后保留 pending 消息并跳过下游');
      return;
    }

    // 再次确认退避状态
    if (await this.isTakeoverActive(sessionId)) {
      log.info({ sessionId }, '防抖到期时会话处于人工退避状态，静默放弃合并处理');
      this.emit('suppressed', sessionId, 'human_takeover');
      return;
    }
    if (this.stopping) {
      log.info({ sessionId }, 'Shutdown 在退避检查期间开始，跳过下游处理');
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
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      }
    }
    if (this.stopping) {
      log.info({ sessionId }, 'Shutdown 在 Consolidated 回调期间开始，跳过 Agent');
      return;
    }

    if (this.agent) {
      const inFlight = await this.prepareAgentRun(sessionId, consolidated);
      if (!inFlight) {
        return;
      }

      this.emit('agent_started', sessionId, inFlight.message);
      const execPromise = this.executeMastraAgentPipeline(
        sessionId,
        inFlight.message,
        inFlight.abortController.signal,
        inFlight.runId
      );
      inFlight.promise = execPromise;
      try {
        await execPromise;
      } catch (err) {
        log.error({ sessionId, err }, 'Mastra Agent 流水线执行发生异常');
        this.emitError(err instanceof Error ? err : new Error(String(err)));
      } finally {
        if (this.inFlightSessions.get(sessionId) === inFlight) {
          this.inFlightSessions.delete(sessionId);
        }
      }
      return;
    }

    await this.store.messages.markMessagesRawOnly(
      sessionId,
      consolidated.messages.map(message => message.messageId || message.id)
    );
  }
  /**
   * 执行 Mastra-native Agent 闭环流水线 (Issue #176)
   * 严格顺序：
   * 1. 显式保存 user message 到 Mastra Memory (保存失败则立即终止，严禁调用 Agent)
   * 2. 调用 KKBotAgent 以 readOnly=true 生成最终回复 (不自动保存本轮任何 message 或 tool)
   * 3. 立即创建 Delivery 状态为 generated (唯一未发送业务身份)
   * 4. 在调用 KK 发送前将 Delivery 更新为 sending
   * 5. 执行 KK 专属可靠发送 (单次调用)
   * 6. 发送明确成功后将 Delivery 更新为 sent
   * 7. Delivery=sent 持久化成功后，显式保存最终实际发送内容的 assistant Memory
   * 8. assistant Memory 保存成功后标记 Delivery 的 memory_committed_at
   */
  private async executeMastraAgentPipeline(
    sessionId: string,
    consolidated: ConsolidatedMessage,
    signal: AbortSignal,
    runId: string = randomUUID()
  ): Promise<void> {
    if (signal.aborted) {
      this.emit('agent_aborted', sessionId);
      return;
    }

    // 1. 解析真实 resourceId 身份 (优先 senderId -> session.employeeId -> sender 名称)
    const resourceId = await this.resolveSessionResourceId(sessionId, consolidated);
    if (!resourceId) {
      const error = new Error(`会话 [${sessionId}] 缺失有效人员身份，严禁调用 Agent`);
      this.emitError(error);
      return;
    }

    // 2. 【User Memory 前置提交】：在 Agent 运行前，通过 Mastra Memory 显式提交本轮各条原始 user message
    const precommitSuccess = await this.precommitUserMessages(
      sessionId,
      resourceId,
      consolidated.messages,
      signal
    );
    if (!precommitSuccess || signal.aborted) {
      if (signal.aborted) {
        this.emit('agent_aborted', sessionId);
      }
      return;
    }

    // 3. 【调用 Mastra-native Agent】：注入确定性 RequestContext，以 readOnly=true 执行
    const traceId = randomUUID();
    const agentRes = await this.executeMastraModel(
      sessionId,
      resourceId,
      consolidated,
      signal,
      traceId,
      runId
    );
    if (!agentRes || signal.aborted) {
      if (signal.aborted) {
        this.emit('agent_aborted', sessionId);
      }
      return;
    }

    const replyText = agentRes.text;
    if (!replyText || replyText.trim() === '') {
      this.emit('agent_completed', sessionId, agentRes);
      return;
    }

    // 4. 【创建 Delivery (generated) 并更新为 sending】
    const deliveryId = `deliv_${runId}`;
    const mastraMessageId = deriveAssistantMessageId(deliveryId);
    const inputMessageIds = consolidated.messages.map(m => m.messageId || m.id);
    const delivery = await this.createSendingDelivery(
      deliveryId,
      runId,
      sessionId,
      mastraMessageId,
      replyText,
      inputMessageIds
    );
    if (!delivery || signal.aborted) {
      if (signal.aborted && delivery) {
        await this.store.deliveries.updateStatus(delivery.id, 'aborted', {
          errorCode: 'ABORTED_BEFORE_SENDING_PIPELINE: 生成后发送前检测到取消信号',
        });
        await this.hooks?.afterAbortedPersist?.(delivery.id);
        this.emit('agent_aborted', sessionId);
      }
      return;
    }

    // 检查人工接管或中断状态（不可逆发送边界前的最后一道安全门）
    if (await this.isTakeoverActive(sessionId)) {
      await this.store.deliveries.updateStatus(delivery.id, 'aborted', {
        errorCode: 'ABORTED_HUMAN_TAKEOVER: 会话已被人工接管',
      });
      await this.hooks?.afterAbortedPersist?.(delivery.id);
      this.emit('agent_aborted', sessionId);
      return;
    }
    // 5. 【执行底层 KK 发送与有界自动重试】
    const maxRetries = this.config.maxRetries ?? 2;
    let currentSendResult: {
      success: boolean;
      messageId?: string;
      error?: string;
      isPreTrigger?: boolean;
    } | null = null;
    let retriesCount = 0;

    while (true) {
      if (signal.aborted || (await this.isTakeoverActive(sessionId))) {
        log.info(
          { sessionId, deliveryId: delivery.id },
          '发送前检测到中止信号或人工接管，取消发送并安全中止 Delivery'
        );
        try {
          await this.store.deliveries.updateStatus(delivery.id, 'aborted', {
            errorCode: 'ABORTED_BEFORE_SEND_TRIGGER: 发送前检测到中止信号或人工接管',
          });
          await this.hooks?.afterAbortedPersist?.(delivery.id);
        } catch (abortErr) {
          log.warn({ abortErr, deliveryId: delivery.id }, '更新 Delivery 为 aborted 失败');
        }
        this.emit('agent_aborted', sessionId);
        return;
      }

      await this.hooks?.afterSendingBeforeDriver?.(delivery.id, retriesCount);

      currentSendResult = await this.executeDriverOutbound(sessionId, replyText);

      await this.hooks?.afterDriverSendBeforeResultPersist?.(
        delivery.id,
        currentSendResult,
        retriesCount
      );

      // 6. 【处理明确发送成功分支】
      if (currentSendResult.success) {
        await this.handleSendSuccess(
          sessionId,
          resourceId,
          delivery.id,
          mastraMessageId,
          replyText,
          currentSendResult.messageId,
          agentRes
        );
        return;
      }

      // 仅当明确属于 pre-trigger failure 且重试次数未超限时允许自动重试
      if (currentSendResult.isPreTrigger && retriesCount < maxRetries) {
        try {
          await this.store.deliveries.updateStatus(delivery.id, 'failed', {
            errorCode: currentSendResult.error,
          });
          await this.hooks?.afterFailedPersistBeforeRetry?.(
            delivery.id,
            currentSendResult.error,
            retriesCount
          );

          if (signal.aborted || (await this.isTakeoverActive(sessionId))) {
            log.info(
              { sessionId, deliveryId: delivery.id },
              '重试前检测到中止信号或人工接管，放弃重试并安全中止'
            );
            await this.store.deliveries.updateStatus(delivery.id, 'aborted', {
              errorCode: 'ABORTED_DURING_RETRY: 重试期间检测到中止信号或人工接管',
            });
            await this.hooks?.afterAbortedPersist?.(delivery.id);
            this.emit('agent_aborted', sessionId);
            return;
          }

          await this.hooks?.beforeRetrySendingPersist?.(delivery.id, retriesCount + 1);

          await this.store.deliveries.updateStatus(delivery.id, 'sending', {
            isRetry: true,
            maxRetries,
          });
          retriesCount++;
          log.info(
            { sessionId, deliveryId: delivery.id, retryCount: retriesCount, maxRetries },
            '检测到 pre-trigger 发送前失败，正在执行有界自动重试'
          );
          continue;
        } catch (retryTransitionErr) {
          log.error({ retryTransitionErr, deliveryId: delivery.id }, '重试状态流转失败，终止重试');
          break;
        }
      }

      // 非 pre-trigger (如 post-trigger 超时/断线) 或重试次数已耗尽
      break;
    }

    // 7. 【处理发送失败分支 (区分 pre-trigger failed 与 post-trigger unknown)】
    if (currentSendResult) {
      await this.handleSendFailure(sessionId, delivery.id, currentSendResult, agentRes);
    }
  }

  /**
   * 解析会话外部员工人员身份标识 (resourceId)
   * 严格顺序：
   * 1. 优先复用既有 Mastra Thread 的 resourceId (若已存在且不为 'operator'，保证身份稳定不篡改)
   * 2. 其次使用 session.employeeId
   * 3. 再次使用 sampleMsg.senderId (当且仅当非 operator / 非 isMe 外部消息时)
   * 4. 再次查询 Raw Store 中该会话最近一条 external 消息的 senderId
   */
  private async resolveSessionResourceId(
    sessionId: string,
    sampleMsg?: { senderId?: string; isFromSelf?: boolean; origin?: string }
  ): Promise<string | undefined> {
    // 1. 检查既有 Thread 的 resourceId
    if (this.mastraMemory) {
      try {
        const thread = await this.mastraMemory.getThreadById({ threadId: sessionId });
        if (
          thread?.resourceId &&
          thread.resourceId.trim() !== '' &&
          thread.resourceId !== 'operator'
        ) {
          return thread.resourceId.trim();
        }
      } catch (err) {
        log.debug({ err, sessionId }, '查询既有 Thread resourceId 告警');
      }
    }

    // 2. 检查会话档案的 employeeId
    try {
      const sessionRecord = await this.store.sessions.getSession(sessionId);
      if (sessionRecord?.employeeId && sessionRecord.employeeId.trim() !== '') {
        return sessionRecord.employeeId.trim();
      }
    } catch (err) {
      log.debug({ err, sessionId }, '查询会话档案异常');
    }

    // 3. 检查传入的外部消息 senderId (严禁使用 operator / isMe 作为 resourceId)
    const isFromSelfOrOp =
      sampleMsg?.isFromSelf || sampleMsg?.origin === 'operator' || sampleMsg?.origin === 'bot_echo';
    if (!isFromSelfOrOp && sampleMsg?.senderId && sampleMsg.senderId.trim() !== '') {
      return sampleMsg.senderId.trim();
    }

    // 4. 查询 Raw Store 中该会话最近一条 external 消息的 senderId
    try {
      const history = await this.store.messages.getSessionHistory(sessionId, { limit: 20 });
      const lastExternal = history.find(
        m => !m.isFromSelf && m.origin !== 'operator' && m.origin !== 'bot_echo' && m.senderId
      );
      if (lastExternal?.senderId && lastExternal.senderId.trim() !== '') {
        return lastExternal.senderId.trim();
      }
    } catch (err) {
      log.debug({ err, sessionId }, '查询历史 external 消息 resourceId 告警');
    }

    return undefined;
  }
  /**
   * 前置显式提交 user messages 至 Mastra Memory
   */
  private async precommitUserMessages(
    sessionId: string,
    resourceId: string,
    messages: KK9Message[],
    signal?: AbortSignal
  ): Promise<boolean> {
    if (!this.mastraMemory) {
      return true;
    }
    try {
      if (signal?.aborted) {
        return false;
      }
      // 1. 过滤已被墓碑化的消息（阻止复活进入 Memory）
      const tombstoneSet = await this.store.tombstones.getTombstoneSet(sessionId);
      const validMessages = messages.filter(m => {
        const nativeMsgId = m.messageId || m.id;
        return !tombstoneSet.has(nativeMsgId);
      });

      if (validMessages.length === 0 || signal?.aborted) {
        log.info(
          { sessionId },
          '本批次所有 user messages 均已被墓碑化或流程已中止，终止 Agent 流程'
        );
        return false;
      }

      await ensureMastraThread(this.mastraMemory, sessionId, resourceId);
      if (signal?.aborted) {
        return false;
      }

      // 2. 二次门禁：写入前复核墓碑，避免在 ensureMastraThread 间隙被并发撤回/删除
      const freshTombstones = await this.store.tombstones.getTombstoneSet(sessionId);
      const strictlyValidMessages = validMessages.filter(m => {
        const nativeMsgId = m.messageId || m.id;
        return !freshTombstones.has(nativeMsgId);
      });

      if (strictlyValidMessages.length === 0 || signal?.aborted) {
        log.info({ sessionId }, '写入 Memory 前检测到消息已被墓碑化或流程已中止');
        return false;
      }

      const userMessages = strictlyValidMessages.map(m => {
        const nativeMsgId = m.messageId || m.id;
        const stableId = deriveUserMessageId(sessionId, nativeMsgId);
        return createMastraTextMessage({
          id: stableId,
          role: 'user',
          content: m.content,
          threadId: sessionId,
          resourceId,
          createdAt: new Date(m.timestamp || Date.now()),
        });
      });

      await this.mastraMemory.saveMessages({ messages: userMessages });
      if (typeof this.mastraMemory.settled === 'function') {
        await this.mastraMemory.settled();
      }
      log.debug({ sessionId, count: userMessages.length }, 'Mastra user messages 显式提交成功');
      return true;
    } catch (memErr) {
      const error = memErr instanceof Error ? memErr : new Error(String(memErr));
      log.error(
        { err: error, sessionId, resourceId },
        '保存 user Memory 失败，前置条件不满足，严禁调用 Agent'
      );
      this.emitError(error);
      return false;
    }
  }

  /**
   * 执行 Mastra-native Agent 推理
   */
  private async executeMastraModel(
    sessionId: string,
    resourceId: string,
    consolidated: ConsolidatedMessage,
    signal: AbortSignal,
    traceId: string,
    runId: string
  ): Promise<KKBotAgentRunResult | null> {
    const reqCtx = new RequestContext<KKBotRequestContextValues>();
    reqCtx.set('traceId', traceId);
    reqCtx.set('runId', runId);
    reqCtx.set('sessionId', sessionId);
    reqCtx.set('senderId', resourceId);
    reqCtx.set('threadId', sessionId);
    reqCtx.set('resourceId', resourceId);

    try {
      const agentInput = await createMastraAgentInput(consolidated, this.store.media);
      return await this.agent!.execute({
        input: agentInput,
        sessionId,
        senderId: resourceId,
        abortSignal: signal,
        requestContext: reqCtx,
      });
    } catch (agentErr) {
      if (signal.aborted) {
        return null;
      }
      const error = agentErr instanceof Error ? agentErr : new Error(String(agentErr));
      log.error({ err: error, sessionId, runId }, 'Agent 执行发生异常');
      this.emitError(error);
      return null;
    }
  }

  /**
   * 创建 Delivery 并持久化为 sending 状态
   */
  private async createSendingDelivery(
    deliveryId: string,
    runId: string,
    sessionId: string,
    mastraMessageId: string,
    replyText: string,
    inputMessageIds?: string[]
  ): Promise<Delivery | null> {
    const contentHash = createHash('sha256').update(replyText).digest('hex');
    try {
      await this.hooks?.afterAgentBeforeDeliveryCreate?.(sessionId, replyText);
      await this.store.deliveries.createDelivery({
        id: deliveryId,
        runId,
        sessionId,
        mastraMessageId,
        content: replyText,
        contentHash,
        inputMessageIds,
        status: 'generated',
      });
      await this.hooks?.afterDeliveryGeneratedBeforeSending?.(deliveryId);
      return await this.store.deliveries.updateStatus(deliveryId, 'sending');
    } catch (delivErr) {
      const error = delivErr instanceof Error ? delivErr : new Error(String(delivErr));
      log.error(
        { err: error, sessionId, deliveryId },
        '创建或更新 Delivery 为 sending 失败，严禁调用 KK 发送'
      );
      this.emitError(error);
      return null;
    }
  }

  /**
   * 执行底层 Driver 消息发送
   */
  private async executeDriverOutbound(
    sessionId: string,
    text: string
  ): Promise<{ success: boolean; messageId?: string; error?: string; isPreTrigger?: boolean }> {
    return this.executeWithSendLock(async () => {
      if (typeof this.driver.selectSession === 'function') {
        try {
          const current = await this.driver.getCurrentSession?.();
          if (!current || current.id !== sessionId) {
            const switched = await this.driver.selectSession(sessionId);
            if (!switched) {
              return {
                success: false,
                isPreTrigger: true,
                error: `切换目标会话失败: selectSession [${sessionId}] 返回 false`,
              };
            }
          }
        } catch (selErr) {
          const errMsg = selErr instanceof Error ? selErr.message : String(selErr);
          return {
            success: false,
            isPreTrigger: true,
            error: `切换目标会话异常: ${errMsg}`,
          };
        }
      }

      try {
        const res = await this.driver.sendText(text, { targetSessionId: sessionId });
        return {
          success: res.success,
          messageId: res.messageId,
          error: res.error,
          isPreTrigger: res.isPreTrigger ?? false,
        };
      } catch (err) {
        return {
          success: false,
          isPreTrigger: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });
  }

  /**
   * 处理发送明确成功分支
   */
  private async handleSendSuccess(
    sessionId: string,
    resourceId: string,
    deliveryId: string,
    mastraMessageId: string,
    replyText: string,
    sendMsgId: string | undefined,
    agentRes: KKBotAgentRunResult
  ): Promise<void> {
    const now = Date.now();
    if (sendMsgId) {
      this.recordBotSentMessageId(sessionId, sendMsgId);
    }

    try {
      await this.store.deliveries.updateStatus(deliveryId, 'sent', {
        kkMessageId: sendMsgId,
        updatedAt: now,
      });
      log.info(
        { sessionId, deliveryId, kkMessageId: sendMsgId },
        'KK 发送明确成功，Delivery 已进入 sent'
      );
    } catch (sentStatusErr) {
      const error =
        sentStatusErr instanceof Error ? sentStatusErr : new Error(String(sentStatusErr));
      log.error({ err: error, deliveryId }, '更新 Delivery 为 sent 失败，阻断后续 Memory 提交');
      this.emitError(error);
      return;
    }
    // 1. 检查 Delivery 是否在发送期间被合规删除或中止 (阻止复活)
    const currentDelivery = await this.store.deliveries.getDeliveryById(deliveryId);
    if (
      !currentDelivery ||
      currentDelivery.content === '[COMPLIANCE_DELETED]' ||
      currentDelivery.status === 'aborted'
    ) {
      log.info(
        { sessionId, deliveryId },
        'Delivery 已被合规删除或中止，拒绝回写明文至 Raw Store 与 Mastra Memory'
      );
      return;
    }
    const finalContent = currentDelivery.content || replyText;

    // 2. 同步到 KK Raw Store 记录
    await this.store.sessions.upsertSession({ id: sessionId });
    await this.store.sessions.touchReplyTime(sessionId, now);
    const savedBotMsg = await this.store.messages.saveMessage({
      sessionId,
      messageId: sendMsgId,
      origin: 'bot_echo',
      sender: '自己',
      content: finalContent,
      messageType: 'text',
      isFromSelf: true,
      isRecalled: false,
      createdAt: now,
      processingState: 'raw_only',
    });
    if (savedBotMsg.isTombstoned || finalContent === '[COMPLIANCE_DELETED]') {
      log.info(
        { sessionId, deliveryId },
        'Bot 回显消息已命中墓碑或内容已被合规擦除，跳过 Mastra Memory 写入'
      );
      return;
    }

    await this.hooks?.afterSentPersistBeforeMemorySave?.(deliveryId);
    if (this.mastraMemory) {
      try {
        const freshTombstones = await this.store.tombstones.getTombstoneSet(sessionId);
        if (sendMsgId && freshTombstones.has(sendMsgId)) {
          log.info(
            { sessionId, deliveryId, sendMsgId },
            '回复消息已被墓碑化，放弃写入 Mastra assistant Memory'
          );
          return;
        }
        await this.mastraMemory.saveMessages({
          messages: [
            createMastraTextMessage({
              id: mastraMessageId,
              role: 'assistant',
              content: finalContent,
              threadId: sessionId,
              resourceId,
              createdAt: new Date(now),
            }),
          ],
        });
        await this.hooks?.afterMemorySaveBeforeMarkCommitted?.(deliveryId);
        await this.store.deliveries.markMemoryCommitted(deliveryId, Date.now());
        await this.hooks?.afterMarkMemoryCommitted?.(deliveryId);
        log.debug(
          { sessionId, deliveryId, mastraMessageId },
          'assistant Memory 显式提交成功并标记 memory_committed_at'
        );
      } catch (asstMemErr) {
        log.error(
          { asstMemErr, sessionId, deliveryId },
          'assistant Memory 保存失败，保持 Delivery=sent 状态，严禁再次发送 KK'
        );
        this.emit('assistant_memory_save_failed', sessionId, deliveryId, asstMemErr);
      }
    }

    let redDotCleared = false;
    if (this.config.autoMarkRead) {
      try {
        redDotCleared = await this.driver.markSessionRead(sessionId);
      } catch (rdErr) {
        log.warn({ sessionId, rdErr }, '消除会话红点调用失败');
      }
    }

    const dispatchResult: CoordinatorDispatchResult = {
      action: 'message_sent',
      success: true,
      sessionId,
      messageId: sendMsgId,
      redDotCleared,
    };

    this.emit('reply_dispatched', sessionId, dispatchResult);
    this.emit('agent_completed', sessionId, agentRes);
  }

  /**
   * 处理发送失败分支 (区分 pre-trigger failed 与 post-trigger unknown)
   */
  private async handleSendFailure(
    sessionId: string,
    deliveryId: string,
    sendResult: { success: boolean; error?: string; isPreTrigger?: boolean },
    agentRes: KKBotAgentRunResult
  ): Promise<void> {
    const finalStatus: DeliveryStatus = sendResult.isPreTrigger ? 'failed' : 'unknown';
    log.error(
      { sessionId, deliveryId, status: finalStatus, error: sendResult.error },
      'KK 发送未获明确成功，更新 Delivery 终态并坚决保留红点'
    );
    try {
      await this.store.deliveries.updateStatus(deliveryId, finalStatus, {
        errorCode: sendResult.error,
      });
      if (finalStatus === 'failed') {
        await this.hooks?.afterFailedPersistBeforeRetry?.(deliveryId, sendResult.error, undefined);
      }
    } catch (failStatusErr) {
      log.error({ failStatusErr, deliveryId }, '更新 Delivery 状态失败');
    }
    const failResult: CoordinatorDispatchResult = {
      action: 'send_failed',
      success: false,
      sessionId,
      error: sendResult.error,
      redDotCleared: false,
    };
    this.emit('reply_dispatched', sessionId, failResult);
    this.emit('agent_completed', sessionId, agentRes);
  }

  /**
   * 人工裁定 Delivery (仅限对处于 unknown 状态的交付执行人工决议)
   * 裁定为 sent 且尚未提交 Memory 时，先持久化 sent，再补交 assistant Memory
   */
  public async adjudicateDelivery(options: {
    deliveryId: string;
    operator: string;
    decision: DeliveryAdjudicationDecision;
    evidenceSummary: string;
  }): Promise<{ success: boolean; delivery: Delivery; memoryCommitted?: boolean }> {
    const updated = await this.store.deliveries.adjudicateDelivery(options.deliveryId, {
      operator: options.operator,
      decision: options.decision,
      evidenceSummary: options.evidenceSummary,
    });

    let memoryCommitted = false;
    if (
      options.decision === 'sent' &&
      updated.status === 'sent' &&
      !updated.memoryCommittedAt &&
      this.mastraMemory
    ) {
      await this.hooks?.afterAdjudicationPersistBeforeMemorySave?.(options.deliveryId);
      try {
        const thread = await this.mastraMemory.getThreadById({ threadId: updated.sessionId });
        const resourceId = thread?.resourceId;
        if (!resourceId) {
          log.error(
            { deliveryId: options.deliveryId, sessionId: updated.sessionId },
            '会话在 Mastra Memory 中不存在有效 Thread 或 resourceId，保留 sent-but-uncommitted 状态'
          );
          return { success: true, delivery: updated, memoryCommitted: false };
        }

        const mastraMessageId = updated.mastraMessageId;
        const asstMsg = createMastraTextMessage({
          id: mastraMessageId,
          role: 'assistant',
          content: updated.content,
          threadId: updated.sessionId,
          resourceId,
          createdAt: new Date(updated.updatedAt || updated.createdAt),
        });

        await this.mastraMemory.saveMessages({ messages: [asstMsg] });
        await this.store.deliveries.markMemoryCommitted(updated.id, Date.now());
        memoryCommitted = true;
        log.info(
          { deliveryId: updated.id, mastraMessageId, resourceId },
          '人工裁定为 sent 后已成功补交 assistant Memory 并标记 memory_committed_at'
        );
      } catch (err) {
        log.error({ err, deliveryId: options.deliveryId }, '人工裁定后补交 assistant Memory 异常');
      }
    }

    return { success: true, delivery: updated, memoryCommitted };
  }

  /**
   * 执行 Delivery 检查点恢复扫描
   */
  public async runDeliveryRecoveryScan(): Promise<DeliveryRecoveryReport> {
    const scanner = new DeliveryRecoveryScanner({
      store: this.store,
      mastraMemory: this.mastraMemory,
    });
    return await scanner.runRecoveryScan();
  }
  /**
   * 执行正式合规删除命令 (ComplianceDeletion)
   * 1. 幂等性检查：若该 commandId 已执行过，直接返回既有审计记录
   * 2. 0ms 终止范围内仍在使用内容的在途 Run
   * 3. 擦除 Raw Store 内的消息正文与载荷文件
   * 4. 擦除显式 Mastra Thread Memory 正文 (removeMastraMessage / deleteThread)
   * 5. 擦除 Delivery 正文与哈希 (保持真实交付状态如 sent/unknown/aborted 与审计身份)
   * 6. 重置受影响的 Observational Memory Scope (clearObservationalMemory，Fail-Closed)
   * 7. 写入持久合规删除墓碑 (type: compliance_deletion)
   * 8. 记录 compliance_deletions 审计表
   */
  /**
   * 执行针对单条消息的合规删除
   */
  private async executeMessageComplianceDeletion(
    sessionId: string,
    messageId: string,
    operator: string,
    reason: string,
    scopeObj: ComplianceDeletionScope
  ): Promise<{ erasedMessagesCount: number; erasedDeliveriesCount: number }> {
    let erasedMessagesCount = 0;
    let erasedDeliveriesCount = 0;

    // 1. 0ms 中断正在使用该会话的在途 Run 并等待完成
    const inFlight = this.inFlightSessions.get(sessionId);
    if (inFlight) {
      inFlight.abortController.abort();
      this.inFlightSessions.delete(sessionId);
      this.emit(
        'in_flight_aborted',
        sessionId,
        Date.now() - inFlight.startedAt,
        'compliance_deletion'
      );
      if (inFlight.promise) {
        try {
          await inFlight.promise;
        } catch {
          // 忽略中断产生的异常
        }
      }
    }

    // 2. 清理防抖桶中的该消息
    const bucket = this.buckets.get(sessionId);
    if (bucket) {
      bucket.messages = bucket.messages.filter(m => (m.messageId || m.id) !== messageId);
      if (bucket.items) {
        bucket.items = bucket.items.filter(
          item => (item.message.messageId || item.message.id) !== messageId
        );
      }
      if (bucket.messages.length === 0) {
        this.clearPendingBucket(sessionId);
      }
    }

    this.recordTombstoneMemory(sessionId, messageId);
    await this.store.tombstones.recordTombstone({
      sessionId,
      messageId,
      type: 'compliance_deletion',
      operator,
      reason,
    });

    // 4. 按 scope 擦除 Raw Store 正文与载荷
    if (scopeObj.rawStore !== false) {
      erasedMessagesCount = await this.store.messages.eraseMessageContent(sessionId, messageId);
    }

    // 5. 按 scope 擦除由该输入消息产生的 Delivery (精准追踪与合规删除，非级联)
    if (scopeObj.deliveries !== false) {
      erasedDeliveriesCount = await this.store.deliveries.eraseDeliveriesByMessageId(
        sessionId,
        messageId
      );
    }

    // 6. 按 scope 移出 Mastra Thread Memory 并重置 OM Scope
    if (scopeObj.explicitMemory !== false && this.mastraMemory) {
      const userMsgId = deriveUserMessageId(sessionId, messageId);
      await removeMastraMessage(this.mastraMemory, userMsgId);

      if (this.mastraStorage) {
        const resourceId =
          (await this.resolveSessionResourceId(sessionId, {
            senderId: undefined,
          } as ConsolidatedMessage)) || sessionId;
        await resetObservationalMemoryScope({
          memory: this.mastraMemory,
          threadId: sessionId,
          resourceId,
          storage: this.mastraStorage,
        });
      }
    }

    return { erasedMessagesCount, erasedDeliveriesCount };
  }

  /**
   * 执行针对整个会话的合规删除
   */
  private async executeSessionComplianceDeletion(
    sessionId: string,
    operator: string,
    reason: string,
    scopeObj: ComplianceDeletionScope
  ): Promise<{ erasedMessagesCount: number; erasedDeliveriesCount: number }> {
    let erasedMessagesCount = 0;
    let erasedDeliveriesCount = 0;

    // 1. 0ms 中断在途 Run 并等待完成
    const inFlight = this.inFlightSessions.get(sessionId);
    if (inFlight) {
      inFlight.abortController.abort();
      this.inFlightSessions.delete(sessionId);
      this.emit(
        'in_flight_aborted',
        sessionId,
        Date.now() - inFlight.startedAt,
        'compliance_deletion'
      );
      if (inFlight.promise) {
        try {
          await inFlight.promise;
        } catch {
          // 忽略中断产生的异常
        }
      }
    }

    // 2. 清空防抖桶
    this.clearPendingBucket(sessionId);

    // 3. 获取会话内所有 messageId 并建立合规删除墓碑
    const allMsgs = await this.store.messages.getSessionHistory(sessionId, { limit: 10000 });
    for (const m of allMsgs) {
      if (m.messageId) {
        this.recordTombstoneMemory(sessionId, m.messageId);
        await this.store.tombstones.recordTombstone({
          sessionId,
          messageId: m.messageId,
          type: 'compliance_deletion',
          operator,
          reason,
        });
      }
    }

    // 4. 按 scope 擦除 Raw Store 与 Deliveries 正文
    if (scopeObj.rawStore !== false) {
      erasedMessagesCount = await this.store.messages.eraseSessionMessagesContent(sessionId);
    }
    if (scopeObj.deliveries !== false) {
      erasedDeliveriesCount = await this.store.deliveries.eraseDeliveriesBySession(sessionId);
    }

    // 5. 按 scope 清理 Mastra Memory Thread 与 OM Scope (Fail-Closed: 失败必须向外传播)
    if (scopeObj.explicitMemory !== false && this.mastraMemory) {
      try {
        await (
          this.mastraMemory as unknown as { deleteThread: (threadId: string) => Promise<void> }
        ).deleteThread(sessionId);
      } catch (delThreadErr) {
        const errorMsg =
          delThreadErr instanceof Error ? delThreadErr.message : String(delThreadErr);
        throw new Error(`Mastra Thread 删除失败 (sessionId=${sessionId}): ${errorMsg}`, {
          cause: delThreadErr,
        });
      }

      if (this.mastraStorage) {
        const resourceId =
          (await this.resolveSessionResourceId(sessionId, {
            senderId: undefined,
          } as ConsolidatedMessage)) || sessionId;
        await resetObservationalMemoryScope({
          memory: this.mastraMemory,
          threadId: sessionId,
          resourceId,
          storage: this.mastraStorage,
        });
      }
    }

    return { erasedMessagesCount, erasedDeliveriesCount };
  }

  /**
   * 执行正式合规删除命令 (ComplianceDeletion)
   * 1. 幂等性检查：若该 commandId 已执行过，直接返回既有审计记录
   * 2. 0ms 终止范围内仍在使用内容的在途 Run 并等待完成
   * 3. 擦除 Raw Store 内的消息正文与载荷文件
   * 4. 擦除显式 Mastra Thread Memory 正文 (removeMastraMessage / deleteThread)
   * 5. 擦除 Delivery 正文与哈希 (保持真实交付状态如 sent/unknown/aborted 与审计身份)
   * 6. 重置受影响的 Observational Memory Scope (clearObservationalMemory，Fail-Closed)
   * 7. 写入持久合规删除墓碑 (type: compliance_deletion)
   * 8. 记录 compliance_deletions 审计表
   */
  public async executeComplianceDeletion(
    command: ComplianceDeletionCommand
  ): Promise<ComplianceDeletionRecord> {
    // 1. 鉴权与参数完整性校验门禁 (Fail-Closed: 默认拒绝未授权命令)
    if (!command.commandId || !command.operator || !command.reason || !command.targetId) {
      throw new Error(
        '执行合规删除失败: 必须提供完整的 commandId、operator、reason 与 targetId 明确授权'
      );
    }

    let authResult: ComplianceAuthorizationResult = {
      authorized: false,
      reason: '未配置合规授权验证器 (默认拒绝)',
    };
    if (this.complianceAuthorizer) {
      authResult = await this.complianceAuthorizer(command);
    }

    if (!authResult.authorized) {
      const denyReason = authResult.reason || '合规删除命令未通过授权校验';
      log.warn(
        { commandId: command.commandId, operator: command.operator, denyReason },
        '合规删除命令被授权门禁拦截拒绝'
      );
      throw new Error(`合规删除命令授权拒绝: ${denyReason}`);
    }
    // 2. 幂等性检查：已完成的命令直接返回既有审计记录
    const existing = await this.store.tombstones.getComplianceDeletion(command.commandId);
    if (existing && existing.status === 'completed') {
      log.info({ commandId: command.commandId }, '合规删除命令已完成，幂等返回既有记录');
      return existing;
    }

    const scopeStr =
      typeof command.scope === 'string' ? command.scope : JSON.stringify(command.scope ?? {});

    try {
      // 3. 规范化结构化 scope (严格校验，Fail-Closed 禁止非法 JSON 默认开启全部删除)
      let scopeObj: ComplianceDeletionScope = {};
      if (typeof command.scope === 'object' && command.scope !== null) {
        scopeObj = command.scope;
      } else if (typeof command.scope === 'string') {
        const trimmed = command.scope.trim();
        if (trimmed.length > 0) {
          try {
            const parsed: unknown = JSON.parse(trimmed);
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
              throw new Error('合规删除 scope JSON 必须为结构化对象');
            }
            scopeObj = parsed as ComplianceDeletionScope;
          } catch (parseErr) {
            const errMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
            throw new Error(`合规删除 scope 参数不是合法的 JSON 对象字符串: ${errMsg}`, {
              cause: parseErr,
            });
          }
        }
      } else if (command.scope !== undefined && command.scope !== null) {
        throw new Error('合规删除 scope 参数类型无效，必须为对象或有效 JSON 字符串');
      }

      log.info(
        {
          commandId: command.commandId,
          targetType: command.targetType,
          targetId: command.targetId,
          operator: command.operator,
        },
        '开始执行正式合规删除命令'
      );
      await this.store.tombstones.recordComplianceDeletion({
        commandId: command.commandId,
        targetType: command.targetType,
        targetId: command.targetId,
        sessionId: command.sessionId ?? null,
        scope: scopeStr,
        reason: command.reason,
        operator: command.operator,
        status: 'pending',
      });

      let erasedMessagesCount = 0;
      let erasedDeliveriesCount = 0;

      if (command.targetType === 'message') {
        const sessionId = command.sessionId;
        const messageId = command.targetId;
        if (!sessionId) {
          throw new Error('删除 targetType=message 必须提供 sessionId');
        }
        const counts = await this.executeMessageComplianceDeletion(
          sessionId,
          messageId,
          command.operator,
          command.reason,
          scopeObj
        );
        erasedMessagesCount = counts.erasedMessagesCount;
        erasedDeliveriesCount = counts.erasedDeliveriesCount;
      } else if (command.targetType === 'session') {
        const sessionId = command.targetId;
        const counts = await this.executeSessionComplianceDeletion(
          sessionId,
          command.operator,
          command.reason,
          scopeObj
        );
        erasedMessagesCount = counts.erasedMessagesCount;
        erasedDeliveriesCount = counts.erasedDeliveriesCount;
      } else {
        throw new Error(`不支持的合规删除目标类型: ${String(command.targetType)}`);
      }

      // 6. 更新审计记录为 completed
      const completedRecord = await this.store.tombstones.recordComplianceDeletion({
        commandId: command.commandId,
        targetType: command.targetType,
        targetId: command.targetId,
        sessionId: command.sessionId ?? null,
        scope: scopeStr,
        reason: command.reason,
        operator: command.operator,
        status: 'completed',
        erasedMessagesCount,
        erasedDeliveriesCount,
      });

      return completedRecord;
    } catch (delErr) {
      const errorMsg = delErr instanceof Error ? delErr.message : String(delErr);
      await this.store.tombstones.recordComplianceDeletion({
        commandId: command.commandId,
        targetType: command.targetType,
        targetId: command.targetId,
        sessionId: command.sessionId ?? null,
        scope: scopeStr,
        reason: command.reason,
        operator: command.operator,
        status: 'failed',
        error: errorMsg,
      });
      throw delErr;
    }
  }
  /**
   * 记录 Bot 发送的消息身份并执行有限集合驱逐。
   */
  private recordBotSentMessageId(sessionId: string, messageId?: string | null): void {
    const normalizedSessionId = sessionId.trim();
    const normalizedMessageId = messageId?.trim();
    if (!normalizedSessionId || !normalizedMessageId) {
      return;
    }
    this.botSentMessageKeys.add(createMessageIdentityKey(normalizedSessionId, normalizedMessageId));
    if (this.botSentMessageKeys.size > MAX_BOT_SENT_KEYS) {
      const firstKey = this.botSentMessageKeys.values().next().value;
      if (firstKey) {
        this.botSentMessageKeys.delete(firstKey);
      }
    }
  }

  /**
   * 安全派发 error 事件（若未绑定监听器则仅记日志，避免 Node EventEmitter 抛出未捕获异常）
   */
  private emitError(error: Error): void {
    if (this.listenerCount('error') > 0) {
      this.emit('error', error);
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
export function createSessionCoordinator(options: SessionCoordinatorOptions): SessionCoordinator {
  return new SessionCoordinator(options);
}
