import EventEmitter from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KK9EventBridge } from '../src/bridge/event-bridge.js';
import { CdpClient } from '../src/cdp/client.js';
import type { CdpConnectionIdentity, ConnectionStatus, KK9Message } from '../src/types/index.js';
import { createRendererRuntime, runRendererScript } from './helpers/renderer-runtime.js';

const bindingName = '__kairo_native_bridge';
const cdpConfig = { url: 'http://127.0.0.1:1', pageMatch: '离线生命周期' };

function createPage() {
  const bus = new EventEmitter();
  const rendererBus = { $on: bus.on.bind(bus), $off: bus.off.bind(bus) };
  const runtime = createRendererRuntime({
    main: { $bus: rendererBus },
    sessions: [{ id: '会话', sesUUID: '会话' }],
  });
  const windowObject = runtime.context['window'] as Record<string, unknown>;
  const originalRevoke = vi.fn();
  const chat: {
    addRevokeMsg: (data: unknown) => void;
    sesInfo: { sesUUID: string };
    __kairo_revoke_active?: boolean;
  } = {
    addRevokeMsg: originalRevoke,
    sesInfo: { sesUUID: '会话' },
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

  function createBridge(generationId: string, connectionId: string) {
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
    const bridge = new KK9EventBridge({ cdp: cdpConfig, startupGenerationId: generationId }, cdp);
    return { cdp, bridge };
  }
  return { bus, rendererBus, runtime, windowObject, originalRevoke, chat, observers, createBridge };
}

afterEach(() => vi.restoreAllMocks());

describe('EventBridge 渲染资源所有权关闭', () => {
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
    page.bus.emit('receive-message', {
      id: '消息',
      sessionID: '会话',
      sender: '员工',
      content: '接管后消息',
    });
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
});
