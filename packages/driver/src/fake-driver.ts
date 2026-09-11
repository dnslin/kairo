import EventEmitter from 'node:events';
import type {
  CompensationScanOptions,
  ConnectionStatus,
  DriverEvents,
  DriverHealthSnapshot,
  FormattedText,
  IKK9Driver,
  KK9AppMsgOptions,
  KK9BizMsgOptions,
  KK9ChatRecordOptions,
  KK9Employee,
  KK9Message,
  KK9RecalledEvent,
  KK9ReplyTarget,
  KK9Session,
  KK9UrlCardOptions,
  KK9VoiceOptions,
  PollingConfig,
  PreSendCheckResult,
  SendFileOptions,
  SendOptions,
  SendResult,
} from './types/index.js';
import {
  InMemorySendOperationStore,
  createSendOperationFingerprint,
  type SendOperationMessageType,
  type SendOperationRecord,
  type SendOperationStore,
} from './send-operation.js';
import { sendOperationRecordToResult, sendResultToOperationUpdate } from './bridge/send-status.js';

export type FakeSendPayload =
  | FormattedText
  | KK9UrlCardOptions
  | KK9BizMsgOptions
  | KK9AppMsgOptions
  | KK9ChatRecordOptions
  | KK9VoiceOptions;

export type FakeSendBehavior =
  | { mode: 'success'; messageId?: string }
  | { mode: 'pre_trigger_failure'; error: string }
  | { mode: 'post_trigger_timeout'; error?: string }
  | { mode: 'post_trigger_disconnect'; error?: string }
  | { mode: 'post_trigger_lost_response'; error?: string }
  | {
      mode: 'custom';
      handler(
        payload: FakeSendPayload,
        options?: SendOptions | SendFileOptions
      ): Promise<SendResult> | SendResult;
    }
  | { mode: 'sequence'; behaviors: FakeSendBehavior[] };

export interface RecordedSendCall {
  type:
    | 'text'
    | 'richText'
    | 'reply'
    | 'image'
    | 'file'
    | 'urlCard'
    | 'bizMessage'
    | 'appMessage'
    | 'chatRecord'
    | 'voice';
  payload: FakeSendPayload;
  options?: SendOptions | SendFileOptions;
  timestamp: number;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export declare interface FakeKK9Driver {
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
  emit<U extends keyof DriverEvents>(event: U, ...args: Parameters<DriverEvents[U]>): boolean;
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging, no-redeclare
export class FakeKK9Driver extends EventEmitter implements IKK9Driver {
  private currentUserId: string | null = null;
  private currentSession: KK9Session | null = {
    id: 'session_init',
    name: '初始化会话',
    type: 'private',
    unread: false,
    unreadCount: 0,
  };
  private sessions: KK9Session[] = [];
  private employees: KK9Employee[] = [];
  private currentBehavior: FakeSendBehavior = { mode: 'success' };
  private behaviorSequence: FakeSendBehavior[] = [];
  private selectSessionHandler?: (sessionId: string) => Promise<boolean> | boolean;
  private preSendCheckHandler?: (
    sessionId: string
  ) => Promise<PreSendCheckResult> | PreSendCheckResult;
  private readonly botSentKeys = new Set<string>();
  private readonly sendOperationStore: SendOperationStore;

  public readonly recordedCalls: RecordedSendCall[] = [];
  public selectSessionCallsCount = 0;
  public markSessionReadCallsCount = 0;

  constructor(sendOperationStore: SendOperationStore = new InMemorySendOperationStore()) {
    super();
    this.sendOperationStore = sendOperationStore;
  }

  public connect(): Promise<void> {
    return Promise.resolve();
  }

  public disconnect(): Promise<void> {
    return Promise.resolve();
  }

  public getStatus(): ConnectionStatus {
    return 'connected';
  }

  public getStartupGenerationId(): string {
    return 'fake-startup-gen';
  }

  public getHealthSnapshot(): DriverHealthSnapshot {
    return {
      startupGenerationId: 'fake-startup-gen',
      cdpStatus: 'connected',
      cdpConnectionIdentity: null,
      eventBridgeAttached: true,
      eventBridgeConnectionIdentity: null,
    };
  }

  public setCurrentUserId(userId: string | null): void {
    this.currentUserId = userId;
  }

  public getCurrentUserId(): Promise<string | null> {
    return Promise.resolve(this.currentUserId);
  }

  public setSessions(sessions: KK9Session[]): void {
    this.sessions = sessions;
  }

  public setEmployees(employees: KK9Employee[]): void {
    this.employees = employees;
  }

  public getSessions(): Promise<KK9Session[]> {
    return Promise.resolve(this.sessions);
  }

  public getRecentMessages(_limit?: number, _session?: KK9Session): Promise<KK9Message[]> {
    return Promise.resolve([]);
  }

  public scanCompensationWindow(_options: CompensationScanOptions): Promise<KK9Message[]> {
    return Promise.resolve([]);
  }

  public setSendBehavior(behavior: FakeSendBehavior): void {
    if (behavior.mode === 'sequence') {
      this.behaviorSequence = [...behavior.behaviors];
      this.currentBehavior = this.behaviorSequence.shift() ?? { mode: 'success' };
    } else {
      this.currentBehavior = behavior;
      this.behaviorSequence = [];
    }
  }

  public setSelectSessionBehavior(
    handler: (sessionId: string) => Promise<boolean> | boolean
  ): void {
    this.selectSessionHandler = handler;
  }

  public setPreSendCheckBehavior(
    handler: (sessionId: string) => Promise<PreSendCheckResult> | PreSendCheckResult
  ): void {
    this.preSendCheckHandler = handler;
  }

  public async selectSession(sessionId: string): Promise<boolean> {
    this.selectSessionCallsCount++;
    if (this.selectSessionHandler) {
      const ok = await this.selectSessionHandler(sessionId);
      if (ok) {
        this.currentSession = {
          id: sessionId,
          name: `会话_${sessionId}`,
          type: 'private',
          unread: false,
          unreadCount: 0,
        };
      }
      return ok;
    }
    this.currentSession = {
      id: sessionId,
      name: `会话_${sessionId}`,
      type: 'private',
      unread: false,
      unreadCount: 0,
    };
    return true;
  }

  public getCurrentSession(): Promise<KK9Session | null> {
    return Promise.resolve(this.currentSession);
  }

  public markSessionRead(_sessionId: string): Promise<boolean> {
    this.markSessionReadCallsCount++;
    return Promise.resolve(true);
  }

  public async preSendCheck(sessionId: string): Promise<PreSendCheckResult> {
    if (this.preSendCheckHandler) {
      return await this.preSendCheckHandler(sessionId);
    }
    return { canSend: true };
  }

  public async sendText(text: string, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('text', 'text', text, options);
  }

  public async sendRichText(content: FormattedText, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('rich-text', 'richText', content, options);
  }

  public async sendReply(
    replyTo: string | KK9ReplyTarget,
    content: FormattedText,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('reply', 'reply', content, { ...options, replyTo });
  }

  public async sendImage(imagePath: string, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('image', 'image', imagePath, options);
  }

  public async sendFile(filePath: string, options?: SendFileOptions): Promise<SendResult> {
    return this.executeSendAction('file', 'file', filePath, options);
  }

  public async sendUrlCard(card: KK9UrlCardOptions, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('url-card', 'urlCard', card, options, false);
  }

  public async sendBizMessage(
    message: KK9BizMsgOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('biz-message', 'bizMessage', message, options, false);
  }

  public async sendAppMessage(
    message: KK9AppMsgOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('app-message', 'appMessage', message, options, false);
  }

  public async sendChatRecord(
    record: KK9ChatRecordOptions,
    options?: SendOptions
  ): Promise<SendResult> {
    return this.executeSendAction('chat-record', 'chatRecord', record, options, false);
  }

  public async sendVoice(voice: KK9VoiceOptions, options?: SendOptions): Promise<SendResult> {
    return this.executeSendAction('voice', 'voice', voice, options, false);
  }
  public async getSendStatus(operationId: string): Promise<SendResult> {
    const operation = await this.sendOperationStore.get(operationId);
    return operation
      ? sendOperationRecordToResult(operation)
      : {
          success: false,
          operationId: operationId.trim(),
          status: 'unknown',
          isPreTrigger: false,
        };
  }

  public recallMessage(_messageId: string, _session?: KK9Session | string): Promise<boolean> {
    return Promise.resolve(true);
  }

  public getOrgEmployees(_timeoutMs?: number): Promise<KK9Employee[]> {
    return Promise.resolve(this.employees);
  }

  public getUserProfile(userId: number | string): Promise<KK9Employee | null> {
    const found = this.employees.find(e => String(e.id) === String(userId));
    return Promise.resolve(found || null);
  }

  public async getEmployeeBySession(session: string | KK9Session): Promise<KK9Employee | null> {
    if (!session) return null;

    let targetSessionId = '';
    if (typeof session === 'object') {
      if (session.type !== 'private') {
        return null;
      }
      targetSessionId = session.id?.trim() || '';
    } else if (typeof session === 'string') {
      targetSessionId = session.trim();
    }

    if (!targetSessionId) return null;

    if (targetSessionId.startsWith('0-')) {
      const uid = targetSessionId.slice(2).trim();
      return this.getUserProfile(uid);
    }

    if (/^[123]-/.test(targetSessionId)) {
      return null;
    }

    const matched = this.sessions.find(s => s.id === targetSessionId || s.name === targetSessionId);
    if (matched && matched.type === 'private' && matched.id.startsWith('0-')) {
      return this.getUserProfile(matched.id.slice(2).trim());
    }

    if (/^\d+$/.test(targetSessionId)) {
      return this.getUserProfile(targetSessionId);
    }

    return null;
  }

  public startPolling(_customPolling?: Partial<PollingConfig>): void {}
  public stopPolling(): void {}

  public recordBotSentMessageId(sessionId: string, messageId: string): void {
    this.botSentKeys.add(`${sessionId}:${messageId}`);
  }

  public isBotSentMessageId(sessionId: string, messageId: string): boolean {
    return this.botSentKeys.has(`${sessionId}:${messageId}`);
  }

  private async executeSendAction(
    operationType: SendOperationMessageType,
    callType: RecordedSendCall['type'],
    payload: FakeSendPayload,
    options?: SendOptions | SendFileOptions,
    supportsReplyAndMentions = true
  ): Promise<SendResult> {
    const requestedOperationId = options?.operationId;
    let claimedOperation: SendOperationRecord | undefined;
    if (requestedOperationId !== undefined) {
      const replyTo = options && 'replyTo' in options ? options.replyTo : undefined;
      const mentions = options && 'mentions' in options ? options.mentions : undefined;
      const fingerprint = createSendOperationFingerprint({
        targetSessionId: options?.targetSessionId,
        messageType: operationType,
        content: { payload, replyTo, mentions },
      });
      const claim = await this.sendOperationStore.claim({
        operationId: requestedOperationId,
        fingerprint,
      });
      if (!claim.claimed) return sendOperationRecordToResult(claim.operation);
      claimedOperation = claim.operation;
    }

    this.recordedCalls.push({
      type: callType,
      payload,
      options,
      timestamp: Date.now(),
    });

    const unsupportedOptions =
      !supportsReplyAndMentions &&
      options &&
      (('replyTo' in options && options.replyTo !== undefined) ||
        ('mentions' in options && options.mentions !== undefined));
    const result: SendResult = unsupportedOptions
      ? {
          success: false,
          status: 'failed',
          error: '原生卡片与语音消息不支持 replyTo 或 mentions 参数',
          isPreTrigger: true,
        }
      : await this.executeSendBehavior(payload, options);
    if (!claimedOperation) return this.normalizeLegacyResult(result);

    const normalized = sendResultToOperationUpdate(result);
    const operation = await this.sendOperationStore.update(
      claimedOperation.operationId,
      normalized
    );
    return sendOperationRecordToResult(operation);
  }

  private async executeSendBehavior(
    payload: FakeSendPayload,
    options?: SendOptions | SendFileOptions
  ): Promise<SendResult> {
    const active = this.currentBehavior;
    if (this.behaviorSequence.length > 0) {
      this.currentBehavior = this.behaviorSequence.shift()!;
    }

    switch (active.mode) {
      case 'success':
        return {
          success: true,
          messageId:
            active.messageId ?? `kk_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          isPreTrigger: false,
          verifyLatencyMs: 15,
        };

      case 'pre_trigger_failure':
        return {
          success: false,
          error: active.error,
          isPreTrigger: true,
        };

      case 'post_trigger_timeout':
        return {
          success: false,
          error: active.error ?? 'CDP send timeout after trigger',
          isPreTrigger: false,
        };

      case 'post_trigger_disconnect':
        return {
          success: false,
          error: active.error ?? 'CDP disconnected during send verification',
          isPreTrigger: false,
        };

      case 'post_trigger_lost_response':
        return {
          success: false,
          error: active.error ?? 'Driver response lost after send action dispatched',
          isPreTrigger: false,
        };

      case 'custom':
        return await active.handler(payload, options);

      default:
        return {
          success: true,
          messageId: `kk_msg_def_${Date.now()}`,
          isPreTrigger: false,
        };
    }
  }

  private normalizeLegacyResult(result: SendResult): SendResult {
    const status = result.status ?? sendResultToOperationUpdate(result).status;
    return {
      ...result,
      status,
    };
  }

  public emitMessage(msg: KK9Message): void {
    this.emit('message', msg);
  }

  public emitRecalled(evt: KK9RecalledEvent): void {
    this.emit('recalled', evt);
  }

  public reset(): void {
    this.recordedCalls.length = 0;
    this.selectSessionCallsCount = 0;
    this.markSessionReadCallsCount = 0;
    this.currentBehavior = { mode: 'success' };
    this.behaviorSequence = [];
    this.selectSessionHandler = undefined;
    this.preSendCheckHandler = undefined;
  }
}
