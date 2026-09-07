import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CdpClient } from '../src/cdp/client.js';
import { BridgeMessageOps } from '../src/bridge/message-ops.js';
import { normalizeNativeMessage } from '../src/bridge/converter.js';
import { createNativeMessageKey } from '../src/bridge/send-status.js';
import { prepareVoice } from '../src/bridge/voice-ops.js';
import { KK9Driver } from '../src/driver.js';
import { InMemorySendOperationStore } from '../src/send-operation.js';
import type { SendResult } from '../src/types/index.js';
import { getDriverTestInternals } from './helpers/driver-internals.js';
import {
  createRendererRuntime,
  FakeIpcRenderer,
  NO_IPC_RESPONSE,
  runRendererScript,
  type RendererMessage,
  type RendererRuntime,
} from './helpers/renderer-runtime.js';

vi.mock('../src/bridge/voice-ops.js', () => ({
  prepareVoice: vi.fn(),
}));

const session = {
  id: 602475,
  sesUUID: '0-3585',
  typeName: 'int2024',
  name: 'int2024',
  type: 0,
  typeID: 3585,
};

interface SuccessfulNativeRuntime {
  cdp: CdpClient;
  ipc: FakeIpcRenderer;
  runtime: RendererRuntime;
  inserted: Array<Record<string, unknown>>;
  sent: Array<Record<string, unknown>>;
  confirmed: RendererMessage[];
}

function createSuccessfulNativeRuntime(): SuccessfulNativeRuntime {
  const inserted: Array<Record<string, unknown>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const confirmed: RendererMessage[] = [];
  let nextMessageId = 135_700_000;
  const ipc = new FakeIpcRenderer(request => {
    const method = request.args[0];
    if (method === 'insertSendBefoeMsg') {
      const message = request.args[1] as Record<string, unknown>;
      inserted.push(message);
      const persisted = {
        ...message,
        id: nextMessageId,
        msgIdx: nextMessageId - 135_699_900,
        sessionID: session.id,
      };
      nextMessageId += 1;
      confirmed.push(persisted);
      return { code: 0, data: { ...message, id: -22, msgIdx: persisted.msgIdx } };
    }
    if (method === 'sendMessageNew') {
      sent.push(request.args[1] as Record<string, unknown>);
      return { code: 0 };
    }
    if (method === 'getMessages') return { code: 0, data: confirmed };
    return { code: 1 };
  });
  const runtime = createRendererRuntime({ ipc, sessions: [session] });
  const cdp = {
    evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
  } as unknown as CdpClient;
  return { cdp, ipc, runtime, inserted, sent, confirmed };
}

afterEach(() => {
  vi.useRealTimers();
  vi.mocked(prepareVoice).mockReset();
});

describe('原生卡片与语音发送集成', () => {
  it('真实执行 renderer 脚本并序列化五类 payload，确认后推送同一 confirmedMessage', async () => {
    const native = createSuccessfulNativeRuntime();
    vi.mocked(prepareVoice).mockResolvedValue({
      duration: 3,
      data: 'IyFBTVIK',
      filepath: 'C:\\tmp\\voice.amr',
    });
    const operations = new BridgeMessageOps(native.cdp, new InMemorySendOperationStore());

    const results = [
      await operations.sendUrlCard(
        { title: '部署报告', summary: '构建成功', linkUrl: 'https://example.com/report' },
        { targetSessionId: session.sesUUID, operationId: 'op-url-card' }
      ),
      await operations.sendBizMessage(
        { title: '任务完成', content: '审批已完成', summary: ['状态: 完成'] },
        { targetSessionId: session.sesUUID, operationId: 'op-biz-message' }
      ),
      await operations.sendAppMessage(
        { title: '应用通知', content: '<p>正文</p>', linkUrl: 'https://example.com/app' },
        { targetSessionId: session.sesUUID, operationId: 'op-app-message' }
      ),
      await operations.sendChatRecord(
        {
          title: '甲与乙的聊天记录',
          msgArray: [{ senderName: '甲', contentType: 0, content: '请确认方案' }],
        },
        { targetSessionId: session.sesUUID, operationId: 'op-chat-record' }
      ),
      await operations.sendVoice(
        { text: '请确认语音' },
        { targetSessionId: session.sesUUID, operationId: 'op-voice' }
      ),
    ];
    const queried = await Promise.all(
      ['op-url-card', 'op-biz-message', 'op-app-message', 'op-chat-record', 'op-voice'].map(
        operationId => operations.getSendStatus(operationId)
      )
    );

    expect(results.map(result => result.status)).toEqual([
      'delivered',
      'delivered',
      'delivered',
      'delivered',
      'delivered',
    ]);
    expect(queried.map(result => result.messageId)).toEqual(
      results.map(result => result.messageId)
    );
    expect(queried.every(result => result.status === 'delivered')).toBe(true);
    expect(native.inserted.map(message => message['contentType'])).toEqual([10, 17, 8, 15, 2]);
    expect(native.inserted.map(message => message['msgFlag'])).toEqual([
      createNativeMessageKey('url-card', 'op-url-card'),
      createNativeMessageKey('biz-message', 'op-biz-message'),
      createNativeMessageKey('app-message', 'op-app-message'),
      createNativeMessageKey('chat-record', 'op-chat-record'),
      createNativeMessageKey('voice', 'op-voice'),
    ]);
    expect(native.sent.map(message => message['contentType'])).toEqual([10, 17, 8, 15, 2]);
    expect(native.sent.map(message => message['content'])).toEqual(
      native.inserted.map(message => message['content'])
    );
    expect(native.inserted[0]?.['content']).toEqual({
      title: '部署报告',
      summary: '构建成功',
      linkUrl: 'https://example.com/report',
      picUrl: '',
      isValid: true,
      filepath: '',
    });
    expect(native.inserted[1]?.['content']).toEqual({
      title: '任务完成',
      content: '审批已完成',
      summary: ['状态: 完成'],
      bizUrl: '',
      bizType: 1,
    });
    expect(native.inserted[2]?.['content']).toEqual({
      title: '应用通知',
      content: '<p>正文</p>',
      linkUrl: 'https://example.com/app',
      pcAppCode: '',
    });
    expect(native.inserted[3]?.['content']).toMatchObject({
      title: '甲与乙的聊天记录',
      sessionType: 0,
      sessionID: session.id,
      senderID: 5761,
      senderName: '我',
      typeID: session.typeID,
      typeName: '甲与乙的聊天记录',
      msgArray: [
        {
          id: 1,
          msgIdx: 1,
          senderID: 0,
          senderName: '甲',
          contentType: 4,
          content: { content: [{ type: 0, text: '请确认方案' }] },
          sessionType: 0,
          sessionID: session.id,
        },
      ],
    });
    expect(native.inserted[4]?.['content']).toEqual({
      duration: 3,
      data: 'IyFBTVIK',
      filepath: 'C:\\tmp\\voice.amr',
    });
    expect(prepareVoice).toHaveBeenCalledOnce();

    expect(native.runtime.commits).toHaveLength(5);
    expect(native.runtime.events).toHaveLength(5);
    native.confirmed.forEach((confirmedMessage, index) => {
      expect(native.runtime.commits[index]).toEqual({
        type: 'updateSesLastMsg',
        payload: { sesUUID: session.sesUUID, message: confirmedMessage },
      });
      expect(native.runtime.events[index]).toEqual({
        event: `${session.sesUUID}-msg`,
        args: [[confirmedMessage]],
      });
    });
  });

  it('卡片显式传入 replyTo 或 mentions 时触发前失败并写入操作状态', async () => {
    const native = createSuccessfulNativeRuntime();
    const store = new InMemorySendOperationStore();
    const operations = new BridgeMessageOps(native.cdp, store);

    const mentionsResult = await operations.sendUrlCard(
      { title: '链接', summary: '摘要', linkUrl: 'https://example.com' },
      {
        targetSessionId: session.sesUUID,
        operationId: 'op-card-mentions',
        mentions: ['all'],
      }
    );
    const replyResult = await operations.sendAppMessage(
      { title: '应用', content: '<p>正文</p>' },
      {
        targetSessionId: session.sesUUID,
        operationId: 'op-card-reply',
        replyTo: 'native-message-1',
      }
    );

    expect(mentionsResult).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(mentionsResult.error).toContain('mentions');
    expect(replyResult).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(replyResult.error).toContain('replyTo');
    expect(await store.get('op-card-mentions')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(await store.get('op-card-reply')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(native.ipc.sent).toHaveLength(0);
  });

  it('卡片触发后响应丢失保持 unknown，重放不再次触发 native 发送', async () => {
    vi.useFakeTimers();
    const store = new InMemorySendOperationStore();
    const ipc = new FakeIpcRenderer(request => {
      if (request.args[0] === 'insertSendBefoeMsg') {
        return { code: 0, data: { id: -22, msgIdx: 12 } };
      }
      if (request.args[0] === 'sendMessageNew') return NO_IPC_RESPONSE;
      if (request.args[0] === 'getMessages') return { code: 0, data: [] };
      return { code: 1 };
    });
    const runtime = createRendererRuntime({ ipc, sessions: [session] });
    const cdp = {
      evaluate: vi.fn((script: string) => runRendererScript(script, runtime.context)),
    } as unknown as CdpClient;
    const operations = new BridgeMessageOps(cdp, store);
    const input = { title: '未知结果', content: '发送动作已触发' };
    const options = {
      targetSessionId: session.sesUUID,
      operationId: 'op-card-unknown',
    };

    const pending = operations.sendBizMessage(input, options);
    await Promise.resolve();
    await vi.runAllTimersAsync();
    const first = await pending;
    const replay = await operations.sendBizMessage(input, options);

    expect(first).toMatchObject({
      success: false,
      status: 'unknown',
      isPreTrigger: false,
    });
    expect(replay).toMatchObject({
      success: false,
      status: 'unknown',
      isPreTrigger: false,
    });
    expect(await store.get(options.operationId)).toMatchObject({ status: 'unknown' });
    expect(ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')).toHaveLength(1);
    expect(ipc.sent.filter(request => request.args[0] === 'sendMessageNew')).toHaveLength(1);
  });

  it('语音准备失败属于 claim 后的 pre-trigger failed，且不会访问 native IPC', async () => {
    const native = createSuccessfulNativeRuntime();
    const store = new InMemorySendOperationStore();
    vi.mocked(prepareVoice).mockRejectedValue(new Error('TTS 服务不可用'));

    const result = await new BridgeMessageOps(native.cdp, store).sendVoice(
      { text: '合成失败' },
      { targetSessionId: session.sesUUID, operationId: 'op-voice-prepare-failed' }
    );

    expect(result).toMatchObject({
      success: false,
      operationId: 'op-voice-prepare-failed',
      status: 'failed',
      isPreTrigger: true,
      error: expect.stringContaining('TTS 服务不可用'),
    });
    expect(await store.get('op-voice-prepare-failed')).toMatchObject({
      status: 'failed',
      isPreTrigger: true,
    });
    expect(native.ipc.sent).toHaveLength(0);
  });

  it('同一语音 operationId 重放直接复用 delivered，不重复准备音频', async () => {
    const native = createSuccessfulNativeRuntime();
    vi.mocked(prepareVoice).mockResolvedValue({ duration: 2, data: 'IyFBTVIK' });
    const operations = new BridgeMessageOps(native.cdp, new InMemorySendOperationStore());
    const input = { text: '只合成一次' } as const;
    const options = { targetSessionId: session.sesUUID, operationId: 'op-voice-deduplicate' };

    const first = await operations.sendVoice(input, options);
    const replay = await operations.sendVoice(input, options);

    expect(first).toMatchObject({ status: 'delivered', messageId: '135700000' });
    expect(replay).toEqual(first);
    expect(prepareVoice).toHaveBeenCalledOnce();
    expect(
      native.ipc.sent.filter(request => request.args[0] === 'insertSendBefoeMsg')
    ).toHaveLength(1);
  });

  it('跳过缺失或无效的消息 ID，只确认正式正整数 ID', async () => {
    const native = createSuccessfulNativeRuntime();
    const operationId = 'op-invalid-native-id';
    const msgFlag = createNativeMessageKey('url-card', operationId);
    native.confirmed.push({ msgFlag }, { msgFlag, id: 'invalid' }, { msgFlag, id: -22 });
    const result = await new BridgeMessageOps(native.cdp).sendUrlCard(
      { title: '正式 ID', summary: '等待服务端确认', linkUrl: 'https://example.com' },
      { targetSessionId: session.sesUUID, operationId }
    );
    expect(result).toMatchObject({ status: 'delivered', messageId: '135700000' });
    expect(native.runtime.events[0]?.args).toEqual([[native.confirmed[3]]]);
  });

  it('会话摘要更新异常不阻断已送达消息的聊天窗口推送', async () => {
    const native = createSuccessfulNativeRuntime();
    await runRendererScript(
      `(() => {
      document.querySelector('#app').__vue__.$store.commit = () => { throw new Error('摘要更新失败'); };
    })()`,
      native.runtime.context
    );
    const result = await new BridgeMessageOps(native.cdp).sendAppMessage(
      { title: '应用通知', content: '<p>已送达</p>' },
      { targetSessionId: session.sesUUID }
    );
    expect(result).toMatchObject({ status: 'delivered', messageId: '135700000' });
    expect(native.runtime.events[0]?.args).toEqual([[native.confirmed[0]]]);
  });

  it('不支持的语音选项在调用 TTS 前失败', async () => {
    const native = createSuccessfulNativeRuntime();
    const result = await new BridgeMessageOps(native.cdp).sendVoice(
      { text: '不应上传到语音服务' },
      { targetSessionId: session.sesUUID, mentions: ['all'] }
    );
    expect(result).toMatchObject({ status: 'failed', isPreTrigger: true });
    expect(prepareVoice).not.toHaveBeenCalled();
    expect(native.ipc.sent).toHaveLength(0);
  });
});

describe('原生媒体历史规范化', () => {
  it('按 KK9 contentType 映射五类公开 messageType 与可读摘要', () => {
    const cases = [
      {
        contentType: 10,
        content: { title: '链接标题', summary: '链接摘要' },
        messageType: 'url-card',
        summary: '链接标题\n链接摘要',
      },
      {
        contentType: 17,
        content: { title: '业务标题', content: '业务正文' },
        messageType: 'biz-message',
        summary: '业务标题\n业务正文',
      },
      {
        contentType: 8,
        content: { title: '应用标题', content: '<p>应用正文</p>' },
        messageType: 'app-message',
        summary: '应用标题\n<p>应用正文</p>',
      },
      {
        contentType: 15,
        content: { title: '聊天记录', msgArray: [] },
        messageType: 'chat-record',
        summary: '聊天记录',
      },
      {
        contentType: 2,
        content: { duration: 3, data: 'IyFBTVIK', filepath: 'C:\\KK9\\voice.wav' },
        messageType: 'voice',
        summary: '[语音: 3秒]',
      },
    ] as const;

    const messages = cases.map(
      (testCase, index) =>
        normalizeNativeMessage({
          id: `native-media-${index}`,
          sessionId: session.sesUUID,
          sessionName: session.name,
          sessionType: 'private',
          sender: '我',
          isFromSelf: true,
          contentType: testCase.contentType,
          content: testCase.content,
        })[0]
    );

    expect(messages.map(message => message?.messageType)).toEqual(
      cases.map(testCase => testCase.messageType)
    );
    expect(messages.map(message => message?.content)).toEqual(
      cases.map(testCase => testCase.summary)
    );
    expect(messages[4]?.fileInfo).toBeUndefined();
  });
});

describe('KK9Driver 五类原生媒体门面', () => {
  it('解析目标后转发五类调用，并为确认结果提供快捷撤回', async () => {
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    internals.bridgeSessionOps.getSessions = vi
      .fn()
      .mockResolvedValue([
        { id: session.sesUUID, name: session.name, type: 'private', unread: false },
      ]);
    const delivered = (messageId: string): SendResult => ({
      success: true,
      status: 'delivered',
      messageId,
      isPreTrigger: false,
    });
    internals.bridgeMessageOps.sendUrlCard = vi.fn().mockResolvedValue(delivered('media-1'));
    internals.bridgeMessageOps.sendBizMessage = vi.fn().mockResolvedValue(delivered('media-2'));
    internals.bridgeMessageOps.sendAppMessage = vi.fn().mockResolvedValue(delivered('media-3'));
    internals.bridgeMessageOps.sendChatRecord = vi.fn().mockResolvedValue(delivered('media-4'));
    internals.bridgeMessageOps.sendVoice = vi.fn().mockResolvedValue(delivered('media-5'));
    internals.bridgeMessageOps.recallMessage = vi.fn().mockResolvedValue(true);

    const options = { targetSessionId: session.name };
    const results = await Promise.all([
      driver.sendUrlCard(
        { title: '链接', summary: '摘要', linkUrl: 'https://example.com' },
        options
      ),
      driver.sendBizMessage({ title: '业务', content: '正文' }, options),
      driver.sendAppMessage({ title: '应用', content: '<p>正文</p>' }, options),
      driver.sendChatRecord(
        { title: '聊天记录', msgArray: [{ senderName: '甲', contentType: 0, content: '内容' }] },
        options
      ),
      driver.sendVoice({ filePath: 'C:\\tmp\\voice.wav' }, options),
    ]);

    expect(internals.bridgeMessageOps.sendUrlCard).toHaveBeenCalledWith(expect.any(Object), {
      targetSessionId: session.sesUUID,
    });
    expect(internals.bridgeMessageOps.sendBizMessage).toHaveBeenCalledWith(expect.any(Object), {
      targetSessionId: session.sesUUID,
    });
    expect(internals.bridgeMessageOps.sendAppMessage).toHaveBeenCalledWith(expect.any(Object), {
      targetSessionId: session.sesUUID,
    });
    expect(internals.bridgeMessageOps.sendChatRecord).toHaveBeenCalledWith(expect.any(Object), {
      targetSessionId: session.sesUUID,
    });
    expect(internals.bridgeMessageOps.sendVoice).toHaveBeenCalledWith(expect.any(Object), {
      targetSessionId: session.sesUUID,
    });

    for (const result of results) {
      const recall = result.recall;
      expect(recall).toBeTypeOf('function');
      if (!recall) throw new Error('确认发送结果缺少快捷撤回方法');
      await expect(recall()).resolves.toBe(true);
    }
    expect(internals.bridgeMessageOps.recallMessage).toHaveBeenCalledTimes(5);
    results.forEach(result => {
      expect(internals.bridgeMessageOps.recallMessage).toHaveBeenCalledWith(
        result.messageId,
        session.sesUUID
      );
    });
  });

  it('默认目标在语音合成前绑定，切换窗口不会把消息发给另一会话', async () => {
    const native = createSuccessfulNativeRuntime();
    const other = {
      ...session,
      id: 700001,
      sesUUID: '0-9999',
      typeID: 9999,
      name: '另一会话',
      typeName: '另一会话',
    };
    native.runtime.editor.sortedSessions.push(other);
    const driver = new KK9Driver({
      cdp: { url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' },
    });
    const internals = getDriverTestInternals(driver);
    internals.cdp = native.cdp;
    internals.bridgeMessageOps = new BridgeMessageOps(native.cdp);
    internals.bridgeSessionOps.getSessions = vi.fn().mockResolvedValue([
      { id: session.sesUUID, name: session.name, type: 'private', unread: false },
      { id: other.sesUUID, name: other.name, type: 'private', unread: false },
    ]);
    vi.mocked(prepareVoice).mockImplementation(() => {
      native.runtime.editor.activedSes = other;
      return Promise.resolve({ duration: 1, data: 'IyFBTVIK' });
    });
    const result = await driver.sendVoice({ text: '只发给开始时的当前会话' });
    expect(result.status).toBe('delivered');
    expect(native.sent[0]?.['sessionID']).toBe(session.id);
    expect(driver.isBotSentMessageId(session.sesUUID, result.messageId!)).toBe(true);
    expect(driver.isBotSentMessageId(other.sesUUID, result.messageId!)).toBe(false);
  });
});
