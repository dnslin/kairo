import EventEmitter from 'node:events';
import type {
  FormattedText,
  KK9Message,
  KK9RecalledEvent,
  KK9Session,
  PreSendCheckResult,
  SendFileOptions,
  SendOptions,
  SendResult,
} from './types/index.js';

export type FakeSendBehavior =
  | { mode: 'success'; messageId?: string }
  | { mode: 'pre_trigger_failure'; error: string }
  | { mode: 'post_trigger_timeout'; error?: string }
  | { mode: 'post_trigger_disconnect'; error?: string }
  | { mode: 'post_trigger_lost_response'; error?: string }
  | {
      mode: 'custom';
      handler: (text: FormattedText, options?: SendOptions) => Promise<SendResult> | SendResult;
    }
  | { mode: 'sequence'; behaviors: FakeSendBehavior[] };

export interface RecordedSendCall {
  type: 'text' | 'richText' | 'image' | 'file';
  payload: FormattedText | string;
  options?: SendOptions | SendFileOptions;
  timestamp: number;
}

/**
 * FakeKK9Driver
 * 具备精确发送不可逆边界与故障注入能力的 Driver 模拟实现
 *
 * 核心契约：
 * 1. 严格区分 pre-trigger failure (可以证明未触发发送) 与 post-trigger failure (可能已触发发送)。
 * 2. 模拟超时、断线、丢包、会话切换失败与前置检查失败。
 * 3. 记录完整的发送调用历史与调用次数。
 */
export class FakeKK9Driver extends EventEmitter {
  private currentSession: KK9Session | null = {
    id: 'session_init',
    name: '初始化会话',
    type: 'private',
    unread: false,
    unreadCount: 0,
  };
  private currentBehavior: FakeSendBehavior = { mode: 'success' };
  private behaviorSequence: FakeSendBehavior[] = [];
  private selectSessionHandler?: (sessionId: string) => Promise<boolean> | boolean;
  private preSendCheckHandler?: (sessionId: string) => Promise<PreSendCheckResult> | PreSendCheckResult;

  public readonly recordedCalls: RecordedSendCall[] = [];
  public selectSessionCallsCount = 0;
  public markSessionReadCallsCount = 0;

  constructor() {
    super();
  }

  /**
   * 配置发送行为模拟
   */
  public setSendBehavior(behavior: FakeSendBehavior): void {
    if (behavior.mode === 'sequence') {
      this.behaviorSequence = [...behavior.behaviors];
      this.currentBehavior = this.behaviorSequence.shift() ?? { mode: 'success' };
    } else {
      this.currentBehavior = behavior;
      this.behaviorSequence = [];
    }
  }

  /**
   * 配置会话切换行为模拟
   */
  public setSelectSessionBehavior(
    handler: (sessionId: string) => Promise<boolean> | boolean
  ): void {
    this.selectSessionHandler = handler;
  }

  /**
   * 配置发送前检查行为模拟
   */
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

  public async getCurrentSession(): Promise<KK9Session | null> {
    return this.currentSession;
  }

  public async markSessionRead(_sessionId: string): Promise<boolean> {
    this.markSessionReadCallsCount++;
    return true;
  }

  public async preSendCheck(sessionId: string): Promise<PreSendCheckResult> {
    if (this.preSendCheckHandler) {
      return await this.preSendCheckHandler(sessionId);
    }
    return { canSend: true };
  }

  public async sendText(text: FormattedText, options?: SendOptions): Promise<SendResult> {
    this.recordedCalls.push({
      type: 'text',
      payload: text,
      options,
      timestamp: Date.now(),
    });

    return this.executeSendAction(text, options);
  }

  public async sendRichText(text: FormattedText, options?: SendOptions): Promise<SendResult> {
    this.recordedCalls.push({
      type: 'richText',
      payload: text,
      options,
      timestamp: Date.now(),
    });

    return this.executeSendAction(text, options);
  }

  public async sendImage(imagePath: string, options?: SendOptions): Promise<SendResult> {
    this.recordedCalls.push({
      type: 'image',
      payload: imagePath,
      options,
      timestamp: Date.now(),
    });

    return this.executeSendAction(imagePath, options);
  }

  public async sendFile(filePath: string, options?: SendFileOptions): Promise<SendResult> {
    this.recordedCalls.push({
      type: 'file',
      payload: filePath,
      options,
      timestamp: Date.now(),
    });

    return this.executeSendAction(filePath, options);
  }

  private async executeSendAction(
    payload: FormattedText | string,
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
          messageId: active.messageId ?? `kk_msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
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
