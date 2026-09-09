import type { KK9Message } from '@kairo/driver';
import type { RawMessageInput } from '../private-chat-core/types.js';

/** id 是 Driver 必填的稳定原生编号；不从正文、raw 或可选字段推测身份。 */
export function toRawMessage(message: KK9Message, observedAt: number): RawMessageInput {
  return {
    sessionId: message.sessionId,
    messageId: message.id,
    direction: message.direction,
    observedAt,
    text: message.content,
    messageType: message.messageType ?? null,
    attachments: {
      ...(message.fileInfo ? { fileInfo: message.fileInfo } : {}),
      ...(message.images ? { images: message.images } : {}),
    },
  };
}
