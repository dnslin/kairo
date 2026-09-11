import EventEmitter from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { extractRecalledEventsFromPayload } from '../src/bridge/converter.js';
import { SUBMIT_NATIVE_MESSAGE_SCRIPT } from '../src/bridge/renderer-script.js';
import { CdpClient } from '../src/cdp/client.js';
import type {
  CdpConnectionIdentity,
  ConnectionStatus,
  KK9Message,
  KK9RecalledEvent,
} from '../src/types/index.js';
import { createRendererRuntime, runRendererScript } from './helpers/renderer-runtime.js';

const bindingName = '__kairo_native_bridge';
const cdpConfig = { url: 'http://127.0.0.1:1', pageMatch: '离线生命周期' };

function createPage(sessionId = '会话') {
  const bus = new EventEmitter();
  const rendererBus = { $on: bus.on.bind(bus), $off: bus.off.bind(bus) };
  const runtime = createRendererRuntime({
    main: { $bus: rendererBus },
    sessions: [{ id: sessionId, sesUUID: sessionId }],
  });
  const windowObject = runtime.context['window'] as Record<string, unknown>;
  const ipc = new EventEmitter();
  windowObject['ipcRenderer'] = ipc;
  const originalRevoke = vi.fn();
  const chat: {
    addRevokeMsg: (data: unknown) => void;
    sesInfo: { sesUUID?: string; id?: number; type?: number; typeID?: number };
    __kairo_revoke_active?: boolean;
  } = {
    addRevokeMsg: originalRevoke,
    sesInfo: { sesUUID: sessionId },
  };
  const observers = new Set<object>();
  runtime.context['MutationObserver'] = class {
    observe() {
      observers.add(this);
    }
    disconnect() {
      observers.delete(this);
    }
  };
  Object.assign(runtime.context['document'] as object, {
    body: {},
    querySelectorAll: () => [{ __vue__: chat }],
  });

  function createBridge(generationId: string, connectionId: string, currentUserId?: string) {
    const cdp = new CdpClient(cdpConfig, { startupGenerationId: generationId });
    let status: ConnectionStatus = 'disconnected';
    const identity: CdpConnectionIdentity = {
      startupGenerationId: generationId,
      connectionId,
      targetId: '页面',
      webSocketDebuggerUrl: 'ws://127.0.0.1:1/离线',
      connectedAt: 1,
    };
    vi.spyOn(cdp, 'getStatus').mockImplementation(() => status);
    vi.spyOn(cdp, 'getConnectionIdentity').mockImplementation(() =>
      status === 'connected' ? identity : null
    );
    vi.spyOn(cdp, 'connect').mockImplementation(() => {
      status = 'connected';
      cdp.emit('status', status);
      return Promise.resolve();
    });
    vi.spyOn(cdp, 'disconnect').mockImplementation(() => {
      status = 'disconnected';
      cdp.emit('status', status);
      return Promise.resolve();
    });
    vi.spyOn(cdp, 'sendCommand').mockImplementation(method => {
      if (method === 'Runtime.addBinding') {
        windowObject[bindingName] = (payload: string) =>
          cdp.emit('Runtime.bindingCalled', { name: bindingName, payload });
      }
      if (method === 'Runtime.removeBinding') delete windowObject[bindingName];
      return Promise.resolve({});
    });
    vi.spyOn(cdp, 'evaluate').mockImplementation(script =>
      runRendererScript(script, runtime.context)
    );
    const bridge = new KK9EventBridge(
      { cdp: cdpConfig, startupGenerationId: generationId, currentUserId },
      cdp
    );
    return { cdp, bridge };
  }
  return {
    bus,
    ipc,
    rendererBus,
    runtime,
    windowObject,
    originalRevoke,
    chat,
    observers,
    createBridge,
  };
}

const nativeSubmissionScript = `(async () => {
  ${SUBMIT_NATIVE_MESSAGE_SCRIPT}
  const callIpc = window.nativeSubmitIpc;
  const waitForPersistedMessage = window.confirmNativeSend;
  if (window.beforeNativeSubmit) await window.beforeNativeSubmit();
  return submitNativeMessage({ sessionID: 716791, sender: 5761, receiver: 3585,
    contentType: 4, content: '请求正文', msgFlag: '本次原生标识' },
    { id: 716791, sesUUID: '0-3585', type: 0, typeID: 3585 });
})()`;

function configureNativeSubmission(windowObject: Record<string, unknown>) {
  const confirmed = {
    id: '136000001',
    sessionID: 716791,
    sender: 5761,
    contentType: 4,
    content: { content: [{ type: 0, text: '原生确认正文' }] },
    msgIdx: 10,
  };
  windowObject['nativeSubmitIpc'] = (channel: string) =>
    Promise.resolve(
      channel === 'insertSendBefoeMsg' ? { code: 0, data: { id: -1, msgIdx: 9 } } : { code: 0 }
    );
  windowObject['confirmNativeSend'] = () => Promise.resolve(confirmed);
  return confirmed;
}

afterEach(() => vi.restoreAllMocks());

describe('EventBridge 渲染资源所有权关闭', () => {
  it('只有原生确认后才在调用返回前回显真实记录，其他来源重复与Vue历史不再派发', async () => {
    const page = createPage('0-3585');
    const { bridge } = page.createBridge('发送代次', '连接', '5761');
    const confirmed = configureNativeSubmission(page.windowObject);
    let release!: (value: typeof confirmed) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<typeof confirmed>(resolve => {
      release = resolve;
    });
    page.windowObject['confirmNativeSend'] = () => {
      entered();
      return gate;
    };
    const messages: KK9Message[] = [];
    let returned = false;
    const beforeReturn: boolean[] = [];
    bridge.on('message', message => {
      beforeReturn.push(!returned);
      messages.push(message);
    });
    await bridge.connect();
    try {
      const work = runRendererScript(nativeSubmissionScript, page.runtime.context);
      await started;
      expect(messages).toEqual([]);
      release(confirmed);
      await work;
      returned = true;
      const envelope = { session: { id: 716791, type: 0, typeID: 3585 }, message: [confirmed] };
      page.ipc.emit('message', {}, { args: envelope });
      page.bus.emit('receive-message', envelope);
      page.bus.emit('0-3585-msg', [confirmed]);
      expect(
        messages.map(message => ({
          id: message.id,
          sessionId: message.sessionId,
          content: message.content,
          direction: message.direction,
        }))
      ).toEqual([
        { id: confirmed.id, sessionId: '0-3585', content: '原生确认正文', direction: 'outbound' },
      ]);
      expect(beforeReturn).toEqual([true]);
    } finally {
      release(confirmed);
      await bridge.disconnect();
    }
  });

  it.each(['发送ack失败', '没有确认记录'])('%s不得根据请求正文伪造成功回显', async failure => {
    const page = createPage('0-3585');
    const { bridge } = page.createBridge('发送失败', '连接', '5761');
    configureNativeSubmission(page.windowObject);
    if (failure === '发送ack失败')
      page.windowObject['nativeSubmitIpc'] = (channel: string) =>
        Promise.resolve(
          channel === 'insertSendBefoeMsg' ? { code: 0, data: { id: -1 } } : { code: 1 }
        );
    else page.windowObject['confirmNativeSend'] = () => Promise.resolve(null);
    const messages: KK9Message[] = [];
    bridge.on('message', message => messages.push(message));
    await bridge.connect();
    try {
      const result = await runRendererScript<{ failure: { success: boolean } }>(
        nativeSubmissionScript,
        page.runtime.context
      );
      expect(result.failure.success).toBe(false);
      expect(messages).toEqual([]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('发送脚本预处理跨越换代也只能持有旧回调，旧实例关闭不破坏新回显', async () => {
    const page = createPage('0-3585');
    configureNativeSubmission(page.windowObject);
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    page.windowObject['beforeNativeSubmit'] = () => {
      entered();
      return gate;
    };
    const older = page.createBridge('旧发送代次', '旧连接', '5761');
    await older.bridge.connect();
    const oldWork = runRendererScript(nativeSubmissionScript, page.runtime.context);
    await started;
    await older.cdp.disconnect();
    const newer = page.createBridge('新发送代次', '新连接', '5761');
    const messages: KK9Message[] = [];
    newer.bridge.on('message', message => messages.push(message));
    try {
      await newer.bridge.connect();
      await older.bridge.disconnect();
      delete page.windowObject['beforeNativeSubmit'];
      release();
      await oldWork;
      expect(messages).toEqual([]);
      await runRendererScript(nativeSubmissionScript, page.runtime.context);
      expect(messages.map(message => message.id)).toEqual(['136000001']);
    } finally {
      release();
      await oldWork;
      await newer.bridge.disconnect();
    }
  });

  it('关闭释放本实例订阅、撤回方法、观察器和binding，重复关闭不再清理', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('当前代', '当前连接');
    await bridge.connect();
    expect(page.chat.addRevokeMsg).not.toBe(page.originalRevoke);
    expect(page.bus.listenerCount('会话-msg')).toBe(1);
    expect(page.observers.size).toBe(1);

    const closing = bridge.disconnect();
    expect(bridge.disconnect()).toBe(closing);
    await closing;
    expect(page.bus.eventNames()).toEqual([]);
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.chat.__kairo_revoke_active).toBeUndefined();
    expect(page.observers.size).toBe(0);
    expect(page.windowObject[bindingName]).toBeUndefined();
    expect(page.windowObject['__kairo_bridge_cleanup']).toBeUndefined();
    expect(bridge.getStatus()).toBe('disconnected');
    expect(bridge.isAttached()).toBe(false);
    await bridge.disconnect();
  });

  it.each([
    ['新代', '新连接'],
    ['原代', '新连接'],
  ])('旧实例关闭不破坏已接管页面的%s/%s', async (generationId, connectionId) => {
    const page = createPage();
    const older = page.createBridge('原代', '原连接');
    const newer = page.createBridge(generationId, connectionId);
    await older.bridge.connect();
    await newer.bridge.connect();
    const newHook = page.chat.addRevokeMsg;
    const newCleanup = page.windowObject['__kairo_bridge_cleanup'];
    const received: KK9Message[] = [];
    newer.bridge.on('message', message => received.push(message));

    await older.bridge.disconnect();
    expect(page.chat.addRevokeMsg).toBe(newHook);
    expect(page.windowObject['__kairo_bridge_cleanup']).toBe(newCleanup);
    expect(page.observers.size).toBe(1);
    expect(page.bus.listenerCount('receive-message')).toBe(1);
    page.ipc.emit(
      'message',
      {},
      {
        args: {
          id: '消息',
          sessionID: '会话',
          sender: '员工',
          content: '接管后消息',
        },
      }
    );
    expect(received.map(message => message.id)).toEqual(['消息']);
    await newer.bridge.disconnect();
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.bus.eventNames()).toEqual([]);
  });

  it('渲染清理异常仍关闭本机CDP，并向调用方保留失败', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('清理异常代', '连接');
    await bridge.connect();
    const originalOff = page.bus.off.bind(page.bus);
    // 修改已注入清理调用的真实总线方法，而非模拟脚本结果。
    page.rendererBus.$off = (event, handler) => {
      originalOff(event, handler);
      if (event === 'receive-message') throw new Error('取消订阅失败');
      return page.bus;
    };

    await expect(bridge.disconnect()).rejects.toThrow('清理');
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.bus.eventNames()).toEqual([]);
    expect(page.chat.addRevokeMsg).toBe(page.originalRevoke);
    expect(page.observers.size).toBe(0);
    expect(page.windowObject[bindingName]).toBeUndefined();
  });

  it('失去连接后不伪造远端已清理，仍释放本机连接', async () => {
    const page = createPage();
    const { cdp, bridge } = page.createBridge('失联代', '连接');
    await bridge.connect();
    const cleanup = page.windowObject['__kairo_bridge_cleanup'];
    await cdp.disconnect();
    await bridge.disconnect();
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.windowObject['__kairo_bridge_cleanup']).toBe(cleanup);
    expect(page.bus.listenerCount('receive-message')).toBe(1);
    // 新实例仍能按既有接管语义清理不可达前代。
    const next = page.createBridge('恢复代', '新连接');
    await next.bridge.connect();
    await next.bridge.disconnect();
    expect(page.bus.eventNames()).toEqual([]);
  });

  it('清理脚本执行失败仍关闭本机CDP且不宣称远端释放成功', async () => {
    const page = createPage();
    const { cdp, bridge } = page.createBridge('脚本异常代', '连接');
    await bridge.connect();
    const cause = new Error('渲染执行失败');
    vi.mocked(cdp.evaluate).mockRejectedValueOnce(cause);
    await expect(bridge.disconnect()).rejects.toBe(cause);
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.bus.listenerCount('receive-message')).toBe(1);
    const next = page.createBridge('恢复代', '新连接');
    await next.bridge.connect();
    await next.bridge.disconnect();
    expect(page.bus.eventNames()).toEqual([]);
  });

  it('注入中途失败也清理已安装的订阅和binding并断开CDP', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('失败代', '连接');
    const originalOn = page.rendererBus.$on;
    page.rendererBus.$on = (event, handler) => {
      if (event === 'CancelMessage') throw new Error('订阅初始化失败');
      return originalOn(event, handler);
    };
    await expect(bridge.connect()).rejects.toThrow('注入失败');
    expect(bridge.getStatus()).toBe('disconnected');
    expect(page.bus.eventNames()).toEqual([]);
    expect(page.windowObject[bindingName]).toBeUndefined();
    expect(page.windowObject['__kairo_bridge_cleanup']).toBeUndefined();
    await bridge.disconnect();
  });

  it.each([0, 1])('原生IPC会话类型%d使用typeID而非数据库行ID，保留正文与入站身份', async type => {
    const page = createPage();
    const { bridge } = page.createBridge('原生载荷', '连接', '5761');
    const received: KK9Message[] = [];
    bridge.on('message', message => received.push(message));
    await bridge.connect();
    page.ipc.emit(
      'message',
      {},
      {
        args: {
          sessionID: 716791,
          session: { id: 716791, type, typeID: 3585, typeName: '测试员工' },
          message: [
            {
              id: 136018959,
              sessionID: 716791,
              sessionType: type,
              sender: 3585,
              senderName: '测试员工',
              contentType: 4,
              content: { content: [{ type: 0, text: 'T26-开始' }] },
            },
          ],
        },
      }
    );
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      id: '136018959',
      sessionId: `${type}-3585`,
      sessionType: type === 0 ? 'private' : 'group',
      content: 'T26-开始',
      senderId: '3585',
      direction: 'inbound',
    });
    await bridge.disconnect();
  });

  it.each([
    { name: '顶层事件', data: { event: 'CancelMessage', msgID: '待撤回' } },
    {
      name: '正文内事件',
      data: {
        message: [{ sessionID: 716791, content: { event: 'CancelMessage', msgID: '待撤回' } }],
      },
    },
    {
      name: '消息内事件',
      data: { message: [{ sessionID: 716791, event: 'CancelMessage', msgID: '待撤回' }] },
    },
  ])('原生撤回$name沿用普通消息会话，与Vue来源重复事件只派发一次', async ({ data }) => {
    const page = createPage();
    const { bridge } = page.createBridge('撤回载荷', '连接', '5761');
    const messages: KK9Message[] = [];
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('message', message => messages.push(message));
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const envelope = { sessionID: 716791, session: { id: 716791, type: 0, typeID: 3585 } };
      page.ipc.emit(
        'message',
        {},
        { args: { ...envelope, message: [{ id: '待撤回', sender: 3585, content: '测试问题' }] } }
      );
      expect(messages[0]?.sessionId).toBe('0-3585');
      page.ipc.emit('message', {}, { args: { ...envelope, ...data } });
      page.bus.emit('receive-message', { ...envelope, ...data });
      page.bus.emit('CancelMessage', { ...envelope, msgID: '待撤回' });
      page.bus.emit('CancelMessage', { msgID: '待撤回', sessionId: '0-3585' });
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([{ messageId: messages[0]?.id, sessionId: messages[0]?.sessionId }]);
    } finally {
      await bridge.disconnect();
    }
  });

  it.each(['msg', 'revokeMsg'])('会话%s通道的公开范围不被消息内数据库编号覆盖', async channel => {
    const page = createPage('0-3585');
    const { bridge } = page.createBridge('会话撤回', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const payload = { sessionID: 716791, event: 'CancelMessage', msgID: '待撤回' };
      page.bus.emit(`0-3585-${channel}`, channel === 'msg' ? [payload] : payload);
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([{ messageId: '待撤回', sessionId: '0-3585' }]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('聊天组件保留原生会话范围供统一解析，仍调用原撤回方法', async () => {
    const page = createPage();
    page.chat.sesInfo = { id: 716791, type: 0, typeID: 3585 };
    const { bridge } = page.createBridge('聊天撤回', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      page.chat.addRevokeMsg({ sessionID: 716791, msgID: '待撤回' });
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([{ messageId: '待撤回', sessionId: '0-3585' }]);
      expect(page.originalRevoke).toHaveBeenCalledOnce();
    } finally {
      await bridge.disconnect();
    }
  });

  it('携带msgID的普通Vue历史消息不会误派发为撤回或新入站', async () => {
    const page = createPage('0-3585');
    const { bridge } = page.createBridge('普通历史', '连接');
    const messages: KK9Message[] = [];
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('message', message => messages.push(message));
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      const payload = {
        sessionID: 716791,
        session: { id: 716791, type: 0, typeID: 3585 },
        msgID: '普通历史',
        sender: 3585,
        content: '普通问题',
      };
      page.bus.emit('receive-message', payload);
      page.bus.emit('0-3585-msg', [payload]);
      expect(messages).toEqual([]);
      expect(recalls).toEqual([]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('撤回消息内数据库编号不能覆盖外层显式公开编号', () => {
    const events = extractRecalledEventsFromPayload({
      sessionId: '0-3585',
      message: [{ sessionID: 716791, content: { event: 'CancelMessage', msgID: '待撤回' } }],
    });
    expect(events.map(event => event.sessionId)).toEqual(['0-3585']);
  });

  it('撤回消息内数据库编号不能覆盖调用方已提供的会话范围', () => {
    const events = extractRecalledEventsFromPayload(
      { message: [{ sessionID: 716791, event: 'CancelMessage', msgID: '待撤回' }] },
      { id: '0-3585' }
    );
    expect(events.map(event => event.sessionId)).toEqual(['0-3585']);
  });

  it('无外层范围的撤回数组保留各条会话，相同消息ID不跨会话误去重', async () => {
    const page = createPage();
    const { bridge } = page.createBridge('多会话撤回', '连接');
    const recalls: KK9RecalledEvent[] = [];
    bridge.on('recalled', event => recalls.push(event));
    await bridge.connect();
    try {
      page.ipc.emit(
        'message',
        {},
        {
          args: [
            { event: 'CancelMessage', msgID: '相同编号', sessionId: '0-3585', sessionID: 716791 },
            { event: 'CancelMessage', msgID: '相同编号', sessionID: '1-7783' },
          ],
        }
      );
      expect(
        recalls.map(event => ({ messageId: event.messageId, sessionId: event.sessionId }))
      ).toEqual([
        { messageId: '相同编号', sessionId: '0-3585' },
        { messageId: '相同编号', sessionId: '1-7783' },
      ]);
    } finally {
      await bridge.disconnect();
    }
  });

  it('新代只接收原生IPC新事件，断线旧消息的迟到总线转发不补做', async () => {
    const page = createPage();
    const older = page.createBridge('旧代', '旧连接');
    await older.bridge.connect();
    await older.cdp.disconnect();
    // KK9断线期间已收到该消息；随后UI异步工作完成才转发到总线。
    page.ipc.emit(
      'message',
      {},
      { args: { id: '断线旧消息', sessionID: '会话', sender: '员工', content: '旧问题' } }
    );
    const newer = page.createBridge('新代', '新连接');
    await newer.bridge.connect();
    const received: string[] = [];
    newer.bridge.on('message', message => received.push(message.id));
    page.bus.emit('receive-message', {
      id: '断线旧消息',
      sessionID: '会话',
      sender: '员工',
      content: '旧问题',
    });
    page.bus.emit('会话-msg', [
      { id: '历史消息', sessionID: '会话', sender: '员工', content: '历史' },
    ]);
    expect(received).toEqual([]);
    page.ipc.emit(
      'message',
      {},
      { args: { id: '新收到消息', sessionID: '会话', sender: '员工', content: '新问题' } }
    );
    expect(received).toEqual(['新收到消息']);
    await older.bridge.disconnect();
    await newer.bridge.disconnect();
    expect(page.ipc.listenerCount('message')).toBe(0);
  });
});
