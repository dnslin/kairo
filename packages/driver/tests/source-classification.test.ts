import { describe, expect, it } from 'vitest';
import { createMessageIdentityKey, normalizeNativeMessage } from '../src/bridge/converter.js';

describe('InboundMessage 来源分类合同', () => {
  it('缺少 self/source 事实时保留 unknown，不伪装 external', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-unknown',
      messages: [{ id: 'native-unknown', sender: '未知', content: '无法判断来源' }],
    });

    expect(message?.origin).toBe('unknown');
    expect(message?.direction).toBe('unknown');
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
    expect(message?.direction).toBe('outbound');
  });

  it('明确 origin=operator 时识别为 operator', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-self-operator',
      messages: [
        { id: 'native-self-operator', origin: 'operator', isMe: true, content: '人工发言' },
      ],
    });

    expect(message?.origin).toBe('operator');
    expect(message?.direction).toBe('outbound');
  });

  it('明确 isMe=false 时识别为 external', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-external',
      messages: [{ id: 'native-external', sender: '员工', isMe: false, content: '外部消息' }],
    });

    expect(message?.origin).toBe('external');
    expect(message?.direction).toBe('inbound');
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
    expect(botEcho?.direction).toBe('outbound');
    expect(operator?.origin).toBe('operator');
    expect(operator?.direction).toBe('outbound');
  });

  it('系统消息优先识别为 system', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-system',
      messages: [{ id: 'native-system', type: 'system', content: '系统提示' }],
    });

    expect(message?.origin).toBe('system');
    expect(message?.direction).toBe('unknown');
  });
  it('isFromSelf=true 或 fromMe=true 优先于 raw origin/source 并判定为 outbound', () => {
    const [isFromSelf, fromMe] = normalizeNativeMessage({
      sessionId: 'session-self-flags',
      messages: [
        {
          id: 'native-is-from-self',
          isFromSelf: true,
          origin: 'external',
          content: '自身消息',
        },
        {
          id: 'native-from-me',
          fromMe: true,
          source: 'external',
          content: '自身历史消息',
        },
      ],
    });

    expect(isFromSelf?.direction).toBe('outbound');
    expect(fromMe?.direction).toBe('outbound');
  });

  it('明确 external 来源且没有自身事实时判定为 inbound', () => {
    const [message] = normalizeNativeMessage({
      sessionId: 'session-explicit-external',
      messages: [
        { id: 'native-explicit-external', origin: 'external', content: '员工消息' },
      ],
    });

    expect(message?.direction).toBe('inbound');
  });
  it('轮询 raw 中的 isFromSelf=true 或 fromMe=true 也判定为 outbound', () => {
    const [isFromSelf, fromMe] = normalizeNativeMessage({
      sessionId: 'session-nested-self-flags',
      messages: [
        {
          id: 'native-nested-is-from-self',
          origin: 'external',
          raw: { isFromSelf: true },
          content: '嵌套自身消息',
        },
        {
          id: 'native-nested-from-me',
          source: 'external',
          raw: { fromMe: true },
          content: '嵌套历史消息',
        },
      ],
    });

    expect(isFromSelf?.direction).toBe('outbound');
    expect(fromMe?.direction).toBe('outbound');
  });
  it('已登记的 Bot 历史消息即使缺少 self 字段仍判定为 outbound', () => {
    const messageId = 'native-history-bot';
    const [message] = normalizeNativeMessage(
      {
        sessionId: 'session-history-bot',
        messages: [
          {
            id: messageId,
            senderId: 'history-bot',
            isMe: false,
            content: '历史 Bot 消息',
          },
        ],
      },
      {
        currentUserId: 'bot-01',
        knownBotSentMessageKeys: new Set([
          createMessageIdentityKey('session-history-bot', messageId),
        ]),
      }
    );

    expect(message?.direction).toBe('outbound');
  });

  it('明确非 self 与 raw operator 来源冲突时返回 unknown', () => {
    const [message] = normalizeNativeMessage(
      {
        sessionId: 'session-conflicting-origin',
        messages: [
          {
            id: 'native-conflicting-origin',
            senderId: 'employee-01',
            isMe: false,
            origin: 'operator',
            content: '来源冲突消息',
          },
        ],
      },
      { currentUserId: 'bot-01' }
    );

    expect(message?.direction).toBe('unknown');
  });
});
