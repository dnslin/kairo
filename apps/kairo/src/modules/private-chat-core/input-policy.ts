import type { BatchingSettings, InputRejection } from './collector-types.js';
import type { RawMessage } from './types.js';

export const INPUT_NOTICES: Record<InputRejection, string> = {
  attachment: '当前暂不支持文件处理，请先使用文字描述需求',
  too_long: '内容过长，请缩短问题；文件处理功能将在后续阶段提供',
};

/** 只用 Driver 已给出的类别和元数据，不读取、解析或下载附件。 */
export function hasAttachments(message: RawMessage): boolean {
  return (
    message.messageType === 'file' ||
    message.messageType === 'image' ||
    message.messageType === 'voice' ||
    message.attachments.fileInfo !== undefined ||
    Boolean(message.attachments.images?.length)
  );
}

export function isEmptyInput(message: RawMessage): boolean {
  return !hasAttachments(message) && message.text.trim().length === 0;
}

export function evaluateInput(
  messages: readonly RawMessage[],
  settings: Pick<BatchingSettings, 'maxMessages' | 'maxChars'>
): InputRejection | null {
  // 先检查整批附件，不能让前面的超长文字覆盖后面的附件原因。
  if (messages.some(hasAttachments)) return 'attachment';
  let count = 0;
  let chars = 0;
  for (const message of messages) {
    if (message.text.trim().length === 0) continue;
    if (++count > settings.maxMessages) return 'too_long';
    for (let index = 0; index < message.text.length; ) {
      index += message.text.codePointAt(index)! > 0xffff ? 2 : 1;
      if (++chars > settings.maxChars) return 'too_long';
    }
  }
  return null;
}
