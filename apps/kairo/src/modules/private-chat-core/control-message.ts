import type { SendService } from '../im-transport/send-service.js';
import type { ContextService } from './context-service.js';
import type { IngressResult } from './ingress.js';
import type { ChatContext, RawMessage } from './types.js';

export function isNewCommand(message: RawMessage): boolean {
  return (
    message.messageType === 'text' &&
    message.text.trim() === '/new' &&
    message.attachments.fileInfo === undefined &&
    !message.attachments.images?.length
  );
}

export type ContextMessageResult =
  | Exclude<IngressResult, { status: 'accepted' }>
  | { status: 'new_context'; context: ChatContext }
  | {
      status: 'message';
      botId: string;
      message: RawMessage & { employeeId: string };
      context: ChatContext;
    };

/** 只消费 T22 的可信返回值，不订阅 Driver、不重复去重、不创建聚合或 Agent。 */
export function createControlMessageHandler(options: {
  contexts: ContextService;
  sender: Pick<SendService, 'send'>;
}): (input: IngressResult) => Promise<ContextMessageResult> {
  return async input => {
    if (input.status !== 'accepted') return input;
    const { botId, message } = input;
    const reset = isNewCommand(message);
    const result = await options.contexts.resolve(
      {
        botId,
        employeeId: message.employeeId,
        sessionId: message.sessionId,
      },
      reset
    );
    if (!reset) return { status: 'message', botId, message, context: result.context };
    await options.sender.send({
      subject: {
        kind: 'event',
        botId,
        sessionId: message.sessionId,
        messageId: message.messageId,
        threadId: result.context.threadId,
      },
      purpose: 'notice:new_context',
      text: result.hadUnfinishedWork ? '已开始新对话，之前未完成的任务已取消。' : '已开始新对话。',
    });
    return { status: 'new_context', context: result.context };
  };
}
