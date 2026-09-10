import type { BotConfig } from '../../config/schema.js';
import type { ContextMessageResult } from './control-message.js';
import type { MessageBatch, PrivateChatStore } from './types.js';

export type BatchingSettings = BotConfig['batching'];
export type InputRejection = 'attachment' | 'too_long';
export type CollectibleMessage = Extract<ContextMessageResult, { status: 'message' }>;

export interface CollectedBatch extends MessageBatch {
  finishedAt: number | null;
  rejection: InputRejection | 'queue_full' | null;
  settledAt: number | null;
}

/** context 行锁是追加、结束及 /new 的共同顺序边界，不持锁等待发送。 */
export interface CollectorStore extends Pick<PrivateChatStore, 'getBatchMessages'> {
  /** 返回本次结束的旧批及接入后的当前批；空白无附件消息返回空数组。 */
  collectMessage(
    input: CollectibleMessage,
    settings: BatchingSettings,
    clock: () => number
  ): Promise<CollectedBatch[]>;
  /** 未到截止返回当前 collecting；失效或废弃返回 null，结束时刻不被重放刷新。 */
  finishBatch(batchId: string, clock: () => number): Promise<CollectedBatch | null>;
  /** 仅扫描指定 Bot 的有效 collecting 及未收尾 ready/rejected。 */
  listPendingBatches(botId: string): Promise<CollectedBatch[]>;
  settleBatch(batchId: string, settledAt: number): Promise<void>;
}
