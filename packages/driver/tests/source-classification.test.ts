import { describe, expect, it } from 'vitest';
import { createMessageIdentityKey, normalizeNativeMessage } from '../src/bridge/converter.js';

describe('InboundMessage 来源分类合同', () => {
  it('缺少 self/source 事实时保留 unknown，不伪装 external', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-unknown',
      messages: [{ id: 'native-unknown', sender: '未知', content: '无法判断来源' }],
    });

    expect(message?.origin).toBe('unknown');
  });
  it('仅有 isMe=true 且缺少来源关联时保留 unknown，避免误触发人工接管', () => {
    const [message] = normalizeNativeMessage(
      {
        sessionId: 'session-self-unknown',
        messages: [
          { id: 'native-self-unknown', senderId: 'bot-01', isMe: true, content: '来源未明' },
        ],
      },
      {
        currentUserId: 'bot-01',
        knownBotSentMessageKeys: new Set<string>(),
      }
    );

    expect(message?.origin).toBe('unknown');
  });

  it('明确 origin=operator 时识别为 operator', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-self-operator',
      messages: [
        { id: 'native-self-operator', origin: 'operator', isMe: true, content: '人工发言' },
      ],
    });

    expect(message?.origin).toBe('operator');
  });

  it('明确 isMe=false 时识别为 external', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-external',
      messages: [{ id: 'native-external', sender: '员工', isMe: false, content: '外部消息' }],
    });

    expect(message?.origin).toBe('external');
  });

  it('当前账号消息按 Bot ID 区分 bot_echo 与 operator', () => {
    const [botEcho, operator] = normalizeNativeMessage(
      {
        sessionId: 'session-self',
        messages: [
          { id: 'native-bot', senderId: 'bot-01', content: '自动回复' },
          { id: 'native-operator', senderId: 'bot-01', origin: 'operator', content: '人工发言' },
        ],
      },
      {
        currentUserId: 'bot-01',
        knownBotSentMessageKeys: new Set([createMessageIdentityKey('session-self', 'native-bot')]),
      }
    );
    expect(botEcho?.origin).toBe('bot_echo');
    expect(operator?.origin).toBe('operator');
  });

  it('系统消息优先识别为 system', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-system',
      messages: [{ id: 'native-system', type: 'system', content: '系统提示' }],
    });

    expect(message?.origin).toBe('system');
  });
});
