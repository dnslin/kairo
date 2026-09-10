import { describe, expect, it } from 'vitest';
import {
  evaluateInput,
  hasAttachments,
  isEmptyInput,
} from '../../src/modules/private-chat-core/input-policy.js';
import type { RawMessage } from '../../src/modules/private-chat-core/types.js';

const limits = { maxMessages: 10, maxChars: 30000 };
function message(text: string, extra: Partial<RawMessage> = {}): RawMessage {
  return {
    sessionId: '0-3585',
    messageId: '消息',
    direction: 'inbound',
    observedAt: 0,
    employeeId: '3585',
    processingResult: 'accepted',
    messageType: 'text',
    attachments: {},
    text,
    ...extra,
  };
}

describe('阶段一输入策略', () => {
  it('空文本和纯空白忽略，实际正文首尾空白原样计数', () => {
    expect(isEmptyInput(message(''))).toBe(true);
    expect(isEmptyInput(message(' \r\n\t\u3000'))).toBe(true);
    const original = message(' 中 ');
    expect(isEmptyInput(original)).toBe(false);
    expect(evaluateInput([original], { maxMessages: 10, maxChars: 3 })).toBeNull();
    expect(evaluateInput([original], { maxMessages: 10, maxChars: 2 })).toBe('too_long');
    expect(original.text).toBe(' 中 ');
  });
  it('第十条允许，第十一条整批拒绝', () => {
    const ten = Array.from({ length: 10 }, () => message('中'));
    expect(evaluateInput(ten, limits)).toBeNull();
    expect(evaluateInput([...ten, message('文')], limits)).toBe('too_long');
  });
  it('中文三万码点允许，多一码点拒绝，不按UTF8字节计数', () => {
    expect(evaluateInput([message('中'.repeat(30000))], limits)).toBeNull();
    expect(evaluateInput([message('中'.repeat(30001))], limits)).toBe('too_long');
  });
  it('普通表情为一码点，组合表情按基础码点累计', () => {
    expect(evaluateInput([message('😀'.repeat(30000))], limits)).toBeNull();
    expect(evaluateInput([message('😀'.repeat(30001))], limits)).toBe('too_long');
    expect(evaluateInput([message('👨‍👩‍👧‍👦')], { maxMessages: 10, maxChars: 7 })).toBeNull();
    expect(evaluateInput([message('👨‍👩‍👧‍👦')], { maxMessages: 10, maxChars: 6 })).toBe('too_long');
  });
  it('累加每条原文，不把系统分隔符加入额度', () => {
    const messages = [message('中'.repeat(15000)), message('文'.repeat(15000))];
    expect(evaluateInput(messages, limits)).toBeNull();
    messages[1]!.text += '\n';
    expect(evaluateInput(messages, limits)).toBe('too_long');
  });
  it('纯空白不占条数和字数，非空消息中的空白正常计数', () => {
    expect(
      evaluateInput(
        Array.from({ length: 20 }, () => message(' '.repeat(2000))),
        limits
      )
    ).toBeNull();
    expect(evaluateInput([message('文' + ' '.repeat(30000))], limits)).toBe('too_long');
  });
  it.each(['file', 'image', 'voice'] as const)(
    '没有元数据的%s仍拒绝，空正文不能绕过',
    messageType => {
      const media = message('', { messageType });
      expect(hasAttachments(media)).toBe(true);
      expect(isEmptyInput(media)).toBe(false);
      expect(evaluateInput([media], limits)).toBe('attachment');
    }
  );
  it('文字中的文件或图片元数据也使整批拒绝，空图片列表不是附件', () => {
    expect(hasAttachments(message('文字', { attachments: { images: [] } }))).toBe(false);
    expect(
      evaluateInput(
        [
          message('文字'),
          message('', { attachments: { fileInfo: { fileName: '文件', fileSize: '1' } } }),
        ],
        limits
      )
    ).toBe('attachment');
    expect(
      evaluateInput(
        [message('文字', { attachments: { images: [{ url: '不得访问的图片' }] } })],
        limits
      )
    ).toBe('attachment');
  });
  it('同一条消息既超限又有附件时只采用附件原因，原文不截断', () => {
    const file = message('中'.repeat(30001), { messageType: 'file' });
    expect(evaluateInput([file], limits)).toBe('attachment');
    const ten = Array.from({ length: 10 }, () => message('文字'));
    expect(evaluateInput([...ten, file], limits)).toBe('attachment');
    expect(file.text).toBe('中'.repeat(30001));
  });
});
