import type { DriverHealthEvent, IKK9Driver, KK9Message } from '@kairo/driver';
import type { AppLogger } from '../operability/logger.js';

export interface DriverGeneration {
  readonly id: string;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
}

type MessageConsumer = (message: KK9Message, generation: DriverGeneration) => void | Promise<void>;
type InvalidationConsumer = (generation: DriverGeneration) => void | Promise<void>;
type ConnectedConsumer = (driver: IKK9Driver, generation: DriverGeneration) => void | Promise<void>;

export interface DriverSupervisor {
  readonly current: IKK9Driver | null;
  readonly generation: DriverGeneration | null;
  /** 原始异常只供程序内诊断，不能直接写日志或健康响应。 */
  readonly lastError: unknown;
  readStatus(): 'up' | 'down' | 'unknown';
  connect(): Promise<void>;
  close(): Promise<void>;
  /** 等待当前工作，不等待未来的固定间隔重连；业务与资源收尾错误向调用方传播。 */
  settled(): Promise<void>;
  onMessage(consumer: MessageConsumer): () => void;
  onInvalidate(consumer: InvalidationConsumer): () => void;
  onConnected(consumer: ConnectedConsumer): () => void;
}

interface OwnedDriver {
  driver: IKK9Driver;
  controller: AbortController;
  generation: DriverGeneration;
  valid: boolean;
  ready: boolean;
  accepting: boolean;
  setup: Promise<void> | null;
  connection: Promise<void> | null;
  attempt: Promise<void> | null;
  messages: Set<Promise<void>>;
  message: (message: KK9Message) => void;
  health: (event: DriverHealthEvent) => void;
}

function isGenerationCancellation(error: unknown, signal: AbortSignal): boolean {
  return (
    signal.aborted &&
    (error === signal.reason ||
      ((error instanceof Error || error instanceof DOMException) && error.name === 'AbortError'))
  );
}

export function createDriverSupervisor(options: {
  createDriver: () => IKK9Driver;
  logger: Pick<AppLogger, 'error'>;
  reconnectIntervalMs?: number;
}): DriverSupervisor {
  const retryMs = options.reconnectIntervalMs ?? 1000;
  if (!Number.isFinite(retryMs) || retryMs <= 0) throw new RangeError('重连间隔必须为正数');
  const seen = new WeakSet<IKK9Driver>();
  const messages = new Set<MessageConsumer>();
  const invalidations = new Set<InvalidationConsumer>();
  const connected = new Set<ConnectedConsumer>();
  const pending = new Set<Promise<void>>();
  const failures: unknown[] = [];
  let lastError: unknown = null;
  let closed = false;
  let closing: Promise<void> | null = null;
  let retry: NodeJS.Timeout | undefined;
  let owned: OwnedDriver | null = null;

  function report(error: unknown, id?: string): void {
    lastError = error;
    options.logger.error({
      event: 'Driver运行异常',
      status: 'down',
      errorType: 'driver',
      ...(id ? { runId: id } : {}),
    });
  }

  function track(work: Promise<void>): Promise<void> {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work)
    );
    return work;
  }

  function scheduleReconnect(): void {
    if (closed || failures.length > 0 || retry) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (closed) return;
      try {
        owned = createOwned();
        // connect 已保存原始原因并安排下一次重试；此处接住后台 Promise。
        void connect().catch(() => undefined);
      } catch (error) {
        report(error);
        scheduleReconnect();
      }
    }, retryMs);
    retry.unref?.();
  }

  function invalidate(record: OwnedDriver, error?: unknown): void {
    if (!record.valid) return;
    record.valid = false;
    record.ready = false;
    record.driver.off('message', record.message);
    record.driver.off('health', record.health);
    let callbacksDone: Promise<PromiseSettledResult<void>[]>;
    // 先登记收尾，再同步 abort；abort 监听者重入 close 也必须等待自有资源。
    void track(
      Promise.resolve().then(async () => {
        // 真实 Driver.disconnect 会取消挂起握手；先发起关闭，再等待全部旧工作退出。
        const results = await Promise.allSettled([
          Promise.resolve().then(() => record.driver.disconnect()),
          record.connection?.catch(() => undefined),
          record.setup?.catch(() => undefined),
          ...record.messages,
        ]);
        const callbacksResult = await callbacksDone;
        for (const result of [...results, ...callbacksResult]) {
          if (result.status === 'rejected') {
            failures.push(result.reason);
            report(result.reason, record.generation.id);
          }
        }
        scheduleReconnect();
      })
    );
    record.controller.abort();
    if (error !== undefined) report(error, record.generation.id);
    // 回调在当前栈启动；数据库取消不能先于关闭代次门禁，也不能假释放业务执行槽。
    callbacksDone = Promise.allSettled(
      [...invalidations].map(consumer => {
        try {
          return Promise.resolve(consumer(record.generation));
        } catch (cause) {
          return Promise.reject(
            cause instanceof Error ? cause : new Error('Driver 失效处理失败', { cause })
          );
        }
      })
    );
  }

  function readStatus(): 'up' | 'down' | 'unknown' {
    const record = owned;
    if (closed || !record?.valid) return 'down';
    if (!record.ready) return 'unknown';
    try {
      const snapshot = record.driver.getHealthSnapshot();
      const cdp = snapshot.cdpConnectionIdentity;
      const bridge = snapshot.eventBridgeConnectionIdentity;
      const id = record.generation.id;
      if (
        snapshot.cdpStatus === 'connected' &&
        snapshot.eventBridgeAttached &&
        snapshot.startupGenerationId === id &&
        cdp !== null &&
        bridge !== null &&
        cdp.startupGenerationId === id &&
        bridge.startupGenerationId === id &&
        cdp.connectionId === bridge.connectionId
      )
        return record.accepting ? 'up' : 'unknown';
      invalidate(record, new Error('Driver 健康身份不一致'));
    } catch (error) {
      invalidate(record, error);
    }
    return 'down';
  }

  function createOwned(): OwnedDriver {
    const driver = options.createDriver();
    if (seen.has(driver)) throw new Error('失效的 Driver 实例不能再次使用');
    seen.add(driver);
    const controller = new AbortController();
    const record: OwnedDriver = {
      driver,
      controller,
      generation: {
        id: driver.getStartupGenerationId(),
        signal: controller.signal,
        isCurrent: () => !closed && owned === record && record.valid && record.ready,
      },
      valid: true,
      ready: false,
      accepting: false,
      setup: null,
      connection: null,
      attempt: null,
      messages: new Set(),
      message(message) {
        if (!record.accepting || !record.generation.isCurrent() || readStatus() !== 'up') return;
        for (const consumer of messages) {
          if (!record.generation.isCurrent()) break;
          let result: void | Promise<void>;
          try {
            result = consumer(message, record.generation);
          } catch (error) {
            if (isGenerationCancellation(error, controller.signal)) break;
            failures.push(error);
            invalidate(record, error);
            break;
          }
          if (result) {
            const work = track(
              Promise.resolve(result).catch(error => {
                if (isGenerationCancellation(error, controller.signal)) return;
                failures.push(error);
                if (record.valid) invalidate(record, error);
                else report(error, record.generation.id);
              })
            );
            record.messages.add(work);
            void work.then(() => record.messages.delete(work));
          }
        }
      },
      health(event) {
        if (owned === record && record.valid) invalidate(record, event.cause);
      },
    };
    // 只读新实例的事件，不启动轮询或补偿；新 Hook 总线旧载荷仍须真机验证。
    driver.on('message', record.message);
    driver.on('health', record.health);
    driver.on('error', (error: Error) => {
      if (owned === record && record.valid) invalidate(record, error);
      else {
        // EventEmitter 的迟到 error 仍必须有诊断接收者，但不得污染当前代次。
        options.logger.error({
          event: 'Driver运行异常',
          status: 'down',
          errorType: 'driver',
          runId: record.generation.id,
        });
      }
    });
    return record;
  }

  function connect(): Promise<void> {
    if (closed) return Promise.reject(new Error('Driver 监督器已关闭'));
    const record = owned;
    if (!record?.valid) return Promise.reject(new Error('Driver 代次已失效，等待换实例'));
    if (record.attempt) return record.attempt;
    // 延至微任务，保证 connect 同步发出的事件也能等待已登记的连接 Promise。
    record.connection = Promise.resolve().then(() => {
      if (closed || !record.valid) return;
      return record.driver.connect();
    });
    record.attempt = track(
      (async (): Promise<void> => {
        try {
          await record.connection;
          if (closed || !record.valid)
            throw lastError instanceof Error
              ? lastError
              : new Error('Driver 连接期间已失效', { cause: lastError });
          record.ready = true;
          if (readStatus() === 'down') throw lastError;
          record.setup = Promise.resolve().then(async () => {
            const results = await Promise.allSettled(
              [...connected].map(consumer =>
                Promise.resolve()
                  .then(() => consumer(record.driver, record.generation))
                  .catch(error => {
                    if (isGenerationCancellation(error, record.controller.signal)) return;
                    failures.push(error);
                    report(error, record.generation.id);
                    invalidate(record, error);
                    throw error;
                  })
              )
            );
            const failed = results.find(result => result.status === 'rejected');
            if (failed) throw failed.reason;
          });
          await record.setup;
          if (closed || !record.valid)
            throw lastError instanceof Error
              ? lastError
              : new Error('Driver 装配期间已失效', { cause: lastError });
          if (readStatus() === 'down') throw lastError;
          record.accepting = true;
        } catch (error) {
          if (record.valid) invalidate(record, error);
          throw error;
        }
      })()
    );
    return record.attempt;
  }

  async function settled(): Promise<void> {
    while (pending.size > 0) await Promise.allSettled([...pending]);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, 'Driver 业务与连接收尾失败');
  }

  // 构造错误仍属于初次启动错误，不改为隐藏在无限重试里的配置问题。
  owned = createOwned();
  return {
    get current(): IKK9Driver | null {
      return owned?.driver ?? null;
    },
    get generation(): DriverGeneration | null {
      return owned?.valid ? owned.generation : null;
    },
    get lastError(): unknown {
      return lastError;
    },
    readStatus,
    connect,
    settled,
    close(): Promise<void> {
      if (closing) return closing;
      closing = Promise.resolve()
        .then(settled)
        .finally(() => {
          owned = null;
        });
      closed = true;
      clearTimeout(retry);
      retry = undefined;
      if (owned) invalidate(owned);
      return closing;
    },
    onMessage(consumer) {
      messages.add(consumer);
      return () => {
        messages.delete(consumer);
      };
    },
    onInvalidate(consumer) {
      invalidations.add(consumer);
      return () => {
        invalidations.delete(consumer);
      };
    },
    onConnected(consumer) {
      connected.add(consumer);
      return () => {
        connected.delete(consumer);
      };
    },
  };
}
