import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import type { DriverHealthEvent, KK9Message } from '@kairo/driver';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDriverSupervisor,
  type DriverSupervisor,
} from '../../src/modules/im-transport/driver-supervisor.js';
import { ApplicationTestDriver } from '../helpers/application-driver.js';
import { deferredSignal } from '../helpers/collector-runtime.js';

const supervisors: DriverSupervisor[] = [];
const input: KK9Message = {
  id: '原生消息一',
  sessionId: '0-1001',
  sessionName: '测试员工',
  sessionType: 'private',
  direction: 'inbound',
  sender: '测试员工',
  content: '新问题',
  time: '现在',
  isMe: false,
  timestamp: 0,
};

function fixture(createDriver: () => ApplicationTestDriver = () => new ApplicationTestDriver()) {
  const logger = { error: vi.fn() };
  const factory = vi.fn(createDriver);
  const supervisor = createDriverSupervisor({
    createDriver: factory,
    logger,
    reconnectIntervalMs: 20,
  });
  supervisors.push(supervisor);
  return { supervisor, factory, logger };
}

function failureEvent(driver: ApplicationTestDriver): DriverHealthEvent {
  return {
    kind: 'cdp_invalidated',
    startupGenerationId: driver.getStartupGenerationId(),
    connectionIdentity: driver.getHealthSnapshot().cdpConnectionIdentity,
    observedAt: Date.now(),
    cause: new Error('连接失效'),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  await Promise.allSettled(supervisors.splice(0).map(supervisor => supervisor.close()));
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('应用自有 Driver 监督器', () => {
  it('初次连接失败保留原始原因和日志，固定间隔以新实例恢复', async () => {
    const first = new ApplicationTestDriver();
    const next = new ApplicationTestDriver();
    const failure = new Error('连接拒绝');
    const connect = vi.spyOn(first, 'connect').mockRejectedValue(failure);
    let created = 0;
    const { supervisor, factory, logger } = fixture(() => (created++ === 0 ? first : next));
    await expect(supervisor.connect()).rejects.toBe(failure);
    await supervisor.settled();
    expect(supervisor.lastError).toBe(failure);
    expect(supervisor.readStatus()).toBe('down');
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ errorType: 'driver' }));
    await vi.advanceTimersByTimeAsync(19);
    expect(factory).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await supervisor.settled();
    expect(supervisor.current).toBe(next);
    expect(supervisor.readStatus()).toBe('up');
    expect(first.getStatus()).toBe('disconnected');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('重连工厂失败也继续定间隔重试，不复用已失效实例', async () => {
    const first = new ApplicationTestDriver();
    const next = new ApplicationTestDriver();
    const failure = new Error('临时创建失败');
    let created = 0;
    const { supervisor } = fixture(() => {
      created += 1;
      if (created === 2) throw failure;
      return created === 1 ? first : next;
    });
    await supervisor.connect();
    first.emit('health', failureEvent(first));
    await supervisor.settled();
    await vi.advanceTimersByTimeAsync(20);
    expect(supervisor.lastError).toBe(failure);
    expect(supervisor.readStatus()).toBe('down');
    await vi.advanceTimersByTimeAsync(20);
    expect(supervisor.current).toBe(next);
    expect(supervisor.readStatus()).toBe('up');
  });

  it('断线同步失效门禁，迟到旧message/error/health不污染新代，新消息仅处理一次', async () => {
    const first = new ApplicationTestDriver();
    const next = new ApplicationTestDriver();
    let created = 0;
    const { supervisor, logger } = fixture(() => (created++ === 0 ? first : next));
    const received = vi.fn();
    supervisor.onMessage(received);
    await supervisor.connect();
    const oldGeneration = supervisor.generation!;
    const lateMessage = first.listeners('message')[0]!;
    const lateHealth = first.listeners('health')[0]!;
    const lost = failureEvent(first);
    first.emit('health', lost);
    expect(oldGeneration.signal.aborted).toBe(true);
    expect(oldGeneration.isCurrent()).toBe(false);
    expect(supervisor.generation).toBeNull();
    first.emit('message', input);
    await supervisor.settled();
    await vi.advanceTimersByTimeAsync(20);
    const current = supervisor.generation;
    lateMessage(input);
    lateHealth(lost);
    first.emit('message', input);
    first.emit('health', lost);
    first.emit('error', new Error('迟到的旧错误'));
    expect(supervisor.generation).toBe(current);
    expect(supervisor.lastError).toBe(lost.cause);
    expect(supervisor.readStatus()).toBe('up');
    expect(logger.error).toHaveBeenLastCalledWith(
      expect.objectContaining({ runId: oldGeneration.id })
    );
    next.emit('message', input);
    await supervisor.settled();
    expect(received).toHaveBeenCalledExactlyOnceWith(input, current);
  });

  it('健康读取异常保留原始诊断并使本代次永久失效', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor } = fixture(() => driver);
    await supervisor.connect();
    const generation = supervisor.generation!;
    const failure = new Error('健康读取失败');
    const probe = vi.spyOn(driver, 'getHealthSnapshot').mockImplementation(() => {
      throw failure;
    });
    expect(supervisor.readStatus()).toBe('down');
    expect(supervisor.lastError).toBe(failure);
    probe.mockRestore();
    expect(generation.signal.aborted).toBe(true);
    expect(supervisor.readStatus()).toBe('down');
  });

  it('新连接装配完成后才投递消息，解除订阅后不再投递', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor } = fixture(() => driver);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    supervisor.onConnected(async () => {
      entered();
      await gate;
    });
    const received = vi.fn();
    const unsubscribe = supervisor.onMessage(received);
    const connecting = supervisor.connect();
    await started;
    driver.emit('message', input);
    release();
    await connecting;
    driver.emit('message', input);
    unsubscribe();
    driver.emit('message', input);
    await supervisor.settled();
    expect(received).toHaveBeenCalledExactlyOnceWith(input, supervisor.generation);
    expect(supervisor.readStatus()).toBe('up');
  });

  it('连接装配失败传播并关闭本代次，不继续开放消息', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor, factory } = fixture(() => driver);
    const failure = new Error('业务装配失败');
    supervisor.onConnected(() => Promise.reject(failure));
    const received = vi.fn();
    supervisor.onMessage(received);
    await expect(supervisor.connect()).rejects.toBe(failure);
    await expect(supervisor.settled()).rejects.toBe(failure);
    driver.emit('message', input);
    await vi.advanceTimersByTimeAsync(100);
    expect(received).not.toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);
    expect(driver.getStatus()).toBe('disconnected');
  });

  it('等待onConnected完成才开放新消息，期间关闭不能重新开放入口', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor } = fixture(() => driver);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    supervisor.onConnected(async (_driver, generation) => {
      expect(generation.isCurrent()).toBe(true);
      entered();
      await gate;
    });
    const received = vi.fn();
    supervisor.onMessage(received);
    const connecting = supervisor.connect();
    const rejected = expect(connecting).rejects.toThrow();
    await started;
    driver.emit('message', input);
    expect(supervisor.readStatus()).toBe('unknown');
    const closing = supervisor.close();
    release();
    await rejected;
    await closing;
    driver.emit('message', input);
    expect(received).not.toHaveBeenCalled();
    expect(driver.getStatus()).toBe('disconnected');
    expect(supervisor.current).toBeNull();
  });

  it('连接与close竞争主动取消正在连接的实例，不再创建下一实例', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor, factory } = fixture(() => driver);
    const started = deferredSignal();
    const stopped = deferredSignal();
    const disconnect = driver.disconnect.bind(driver);
    vi.spyOn(driver, 'connect').mockImplementation(async () => {
      started.resolve();
      await stopped.promise;
      throw new Error('握手已主动取消');
    });
    vi.spyOn(driver, 'disconnect').mockImplementation(async () => {
      stopped.resolve();
      await disconnect();
    });
    const connecting = supervisor.connect();
    const rejected = expect(connecting).rejects.toThrow();
    await started.promise;
    const closing = supervisor.close();
    expect(supervisor.close()).toBe(closing);
    await closing;
    await rejected;
    await vi.advanceTimersByTimeAsync(100);
    expect(driver.getStatus()).toBe('disconnected');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('abort监听者同步调用close仍等待正在启动的旧连接收尾', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor } = fixture(() => driver);
    let release!: () => void;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const disconnect = driver.disconnect.bind(driver);
    vi.spyOn(driver, 'disconnect').mockImplementation(async () => {
      await gate;
      await disconnect();
    });
    await supervisor.connect();
    await supervisor.settled();
    let closing!: Promise<void>;
    let finished = false;
    supervisor.generation!.signal.addEventListener('abort', () => {
      closing = supervisor.close();
      void closing.then(() => {
        finished = true;
      });
    });
    driver.emit('health', failureEvent(driver));
    await vi.advanceTimersByTimeAsync(100);
    expect(finished).toBe(false);
    release();
    await closing;
    expect(driver.getStatus()).toBe('disconnected');
    expect(supervisor.current).toBeNull();
  });

  it('换代先同步启动取消，再等旧消息与异步取消全部收尾', async () => {
    const first = new ApplicationTestDriver();
    const next = new ApplicationTestDriver();
    let created = 0;
    const { supervisor, factory } = fixture(() => (created++ === 0 ? first : next));
    let releaseMessage!: () => void;
    let releaseCancel!: () => void;
    const messageGate = new Promise<void>(resolve => {
      releaseMessage = resolve;
    });
    const cancelGate = new Promise<void>(resolve => {
      releaseCancel = resolve;
    });
    let cancellationStarted = false;
    supervisor.onMessage(async (_message, generation) => {
      await messageGate;
      expect(generation.isCurrent()).toBe(false);
    });
    supervisor.onInvalidate(async generation => {
      expect(generation.signal.aborted).toBe(true);
      cancellationStarted = true;
      await cancelGate;
    });
    await supervisor.connect();
    first.emit('message', input);
    first.emit('health', failureEvent(first));
    expect(cancellationStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(1);
    releaseCancel();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(1);
    releaseMessage();
    await supervisor.settled();
    await vi.advanceTimersByTimeAsync(20);
    expect(supervisor.current).toBe(next);
    expect(supervisor.readStatus()).toBe('up');
  });

  it('消息消费按代次signal取消后仍自动重连，只接收新代消息', async () => {
    const first = new ApplicationTestDriver();
    const next = new ApplicationTestDriver();
    let created = 0;
    const { supervisor } = fixture(() => (created++ === 0 ? first : next));
    const received = vi.fn();
    supervisor.onMessage(async (message, generation) => {
      if (generation.id === first.getStartupGenerationId()) {
        await delay(60000, undefined, { signal: generation.signal });
      }
      received(message, generation);
    });
    await supervisor.connect();
    first.emit('message', input);
    first.emit('health', failureEvent(first));
    await supervisor.settled();
    await vi.advanceTimersByTimeAsync(20);
    expect(supervisor.current).toBe(next);
    expect(supervisor.readStatus()).toBe('up');
    expect(received).not.toHaveBeenCalled();
    first.emit('message', input);
    next.emit('message', input);
    await supervisor.settled();
    expect(received).toHaveBeenCalledExactlyOnceWith(input, supervisor.generation);
  });

  it('装配按代次reason取消后旧connect拒绝，新连接仍能装配并接收消息', async () => {
    const first = new ApplicationTestDriver();
    const next = new ApplicationTestDriver();
    let created = 0;
    const { supervisor } = fixture(() => (created++ === 0 ? first : next));
    const started = deferredSignal();
    supervisor.onConnected(async (driver, generation) => {
      if (driver !== first) return;
      const cancelled = once(generation.signal, 'abort');
      started.resolve();
      await cancelled;
      generation.signal.throwIfAborted();
    });
    const received = vi.fn();
    supervisor.onMessage(received);
    const lost = failureEvent(first);
    const rejected = expect(supervisor.connect()).rejects.toBe(lost.cause);
    await started.promise;
    first.emit('health', lost);
    await rejected;
    await supervisor.settled();
    await vi.advanceTimersByTimeAsync(20);
    expect(supervisor.current).toBe(next);
    next.emit('message', input);
    await supervisor.settled();
    expect(received).toHaveBeenCalledExactlyOnceWith(input, supervisor.generation);
  });

  it('代次取消后的无关入站错误仍传播并阻止重连', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor, factory } = fixture(() => driver);
    const gate = deferredSignal();
    const failure = new Error('入站存储失败');
    supervisor.onMessage(async () => {
      await gate.promise;
      throw failure;
    });
    await supervisor.connect();
    driver.emit('message', input);
    driver.emit('health', failureEvent(driver));
    gate.resolve();
    await expect(supervisor.settled()).rejects.toBe(failure);
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(supervisor.close()).rejects.toBe(failure);
  });

  it('主动关闭可取消消息消费且不创建新连接', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor, factory } = fixture(() => driver);
    supervisor.onMessage(async (_message, generation) => {
      await delay(60000, undefined, { signal: generation.signal });
    });
    await supervisor.connect();
    driver.emit('message', input);
    await supervisor.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(supervisor.current).toBeNull();
    expect(driver.getStatus()).toBe('disconnected');
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('异步onInvalidate错误不被吞掉，settled和close传播且禁止带病换代', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor, factory } = fixture(() => driver);
    const failure = new Error('业务取消事务失败');
    supervisor.onInvalidate(async () => {
      await Promise.resolve();
      throw failure;
    });
    await supervisor.connect();
    driver.emit('health', failureEvent(driver));
    await expect(supervisor.settled()).rejects.toBe(failure);
    expect(supervisor.lastError).toBe(failure);
    expect(driver.getStatus()).toBe('disconnected');
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(1);
    await expect(supervisor.close()).rejects.toBe(failure);
  });

  it('同步与异步取消错误均保留，其他取消回调与自有连接回收仍完成', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor } = fixture(() => driver);
    const first = new Error('同步取消失败');
    const second = new Error('异步取消失败');
    supervisor.onInvalidate(() => {
      throw first;
    });
    supervisor.onInvalidate(() => Promise.reject(second));
    await supervisor.connect();
    await expect(supervisor.close()).rejects.toMatchObject({ errors: [first, second] });
    expect(driver.getStatus()).toBe('disconnected');
  });

  it('异步message失败传播并失效，不将consumer异常视作连接成功', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor } = fixture(() => driver);
    const failure = new Error('入站事务失败');
    supervisor.onMessage(() => Promise.reject(failure));
    await supervisor.connect();
    const generation = supervisor.generation!;
    driver.emit('message', input);
    await expect(supervisor.settled()).rejects.toBe(failure);
    expect(generation.signal.aborted).toBe(true);
    expect(supervisor.readStatus()).toBe('down');
  });

  it('同一失效实例被工厂返回时拒绝原地连接，close取消后续重试', async () => {
    const driver = new ApplicationTestDriver();
    const { supervisor, factory } = fixture(() => driver);
    const connect = vi.spyOn(driver, 'connect');
    await supervisor.connect();
    driver.emit('health', failureEvent(driver));
    await supervisor.settled();
    await vi.advanceTimersByTimeAsync(20);
    expect(supervisor.readStatus()).toBe('down');
    expect(connect).toHaveBeenCalledTimes(1);
    await supervisor.close();
    await vi.advanceTimersByTimeAsync(100);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('主动close触发的同步abort重入也共享同一关闭Promise', async () => {
    const { supervisor } = fixture();
    await supervisor.connect();
    let nested: Promise<void> | undefined;
    supervisor.generation!.signal.addEventListener('abort', () => {
      nested = supervisor.close();
    });
    const closing = supervisor.close();
    await Promise.all([closing, nested]);
    expect(nested).toBe(closing);
  });

  it('一个装配回调失败立即取消另一项等待signal的装配，不形成循环等待', async () => {
    const { supervisor } = fixture();
    const failure = new Error('首项装配失败');
    const started = deferredSignal();
    const released = deferredSignal();
    let signal: AbortSignal | undefined;
    supervisor.onConnected(() => Promise.reject(failure));
    supervisor.onConnected((_driver, generation) => {
      signal = generation.signal;
      signal.addEventListener('abort', () => released.resolve(), { once: true });
      started.resolve();
      return released.promise;
    });
    const connecting = supervisor.connect().catch(error => error as unknown);
    await started.promise;
    await vi.advanceTimersByTimeAsync(0);
    const cancelledBeforeRelease = signal?.aborted;
    released.resolve();
    await connecting;
    await expect(supervisor.settled()).rejects.toBe(failure);
    expect(cancelledBeforeRelease).toBe(true);
  });
});
