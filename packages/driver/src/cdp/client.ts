import { randomUUID } from 'node:crypto';
import EventEmitter from 'node:events';
import WebSocket from 'ws';
import type {
  CdpConfig,
  CdpConnectionIdentity,
  CdpConnectionLostEvent,
  ConnectionStatus,
} from '../types/index.js';
import { CdpError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('cdp-client');

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

interface CdpResponse<T = unknown> {
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: string };
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CdpClientOptions {
  startupGenerationId?: string;
}

export class CdpClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private status: ConnectionStatus = 'disconnected';
  private messageId = 0;
  private pending = new Map<number, PendingCommand>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectedAt = 0;
  private connectionIdentity: CdpConnectionIdentity | null = null;
  private isIntentionallyClosed = false;
  private readonly startupGenerationId: string;

  constructor(
    private readonly config: CdpConfig,
    options: CdpClientOptions = {}
  ) {
    super();
    this.startupGenerationId = options.startupGenerationId ?? randomUUID();
  }

  public getStatus(): ConnectionStatus {
    return this.status;
  }

  public getStartupGenerationId(): string {
    return this.startupGenerationId;
  }

  public getConnectionIdentity(): CdpConnectionIdentity | null {
    return this.connectionIdentity;
  }

  public getUptimeMs(): number {
    return this.status === 'connected' ? Date.now() - this.connectedAt : 0;
  }

  public async connect(): Promise<void> {
    if (this.status === 'connected') return;

    this.isIntentionallyClosed = false;
    this.setStatus('connecting');

    try {
      const target = await this.discoverTarget();
      if (!target.webSocketDebuggerUrl) {
        throw new CdpError(`目标页面缺少 webSocketDebuggerUrl: ${target.title}`);
      }

      await this.connectWebSocket(target.webSocketDebuggerUrl);
      this.connectedAt = Date.now();
      this.connectionIdentity = {
        startupGenerationId: this.startupGenerationId,
        connectionId: randomUUID(),
        targetId: target.id,
        webSocketDebuggerUrl: target.webSocketDebuggerUrl,
        connectedAt: this.connectedAt,
      };
      this.setStatus('connected');
      this.startHeartbeat();
      log.info(
        { title: target.title, url: target.url, startupGenerationId: this.startupGenerationId },
        'CDP 客户端连接成功'
      );
    } catch (err) {
      this.connectionIdentity = null;
      this.connectedAt = 0;
      this.setStatus('disconnected');
      const error = err instanceof Error ? err : new Error(String(err));
      log.error(
        { err: error.message, startupGenerationId: this.startupGenerationId },
        'CDP 连接失败'
      );
      throw new CdpError(`CDP 连接失败: ${error.message}`, error);
    }
  }

  public async disconnect(): Promise<void> {
    this.isIntentionallyClosed = true;
    this.stopHeartbeat();

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new CdpError('CDP 连接主动断开'));
      this.pending.delete(id);
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close();
      }
      this.ws = null;
    }

    this.connectionIdentity = null;
    this.connectedAt = 0;
    this.setStatus('disconnected');
    log.info({ startupGenerationId: this.startupGenerationId }, 'CDP 客户端已主动断开');
    await Promise.resolve();
  }

  public async sendCommand<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    customTimeoutMs?: number
  ): Promise<T> {
    if (this.status !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new CdpError(`CDP 未连接 (当前状态: ${this.status})`);
    }

    const id = ++this.messageId;
    const payload = JSON.stringify({ id, method, params });

    return new Promise<T>((resolve, reject) => {
      const timeoutMs = customTimeoutMs ?? this.config.timeoutMs ?? 5000;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError(`CDP 指令执行超时 (${method}, id=${id}, 超时=${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      this.ws!.send(payload, err => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new CdpError(`发送 CDP 指令失败: ${err.message}`, err));
        }
      });
    });
  }

  public async evaluate<T = unknown>(expression: string, timeoutMs?: number): Promise<T> {
    const res = await this.sendCommand<{
      result?: { type: string; value?: T; description?: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      timeoutMs
    );

    if (res.exceptionDetails) {
      const msg = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new CdpError(`DOM 脚本执行异常: ${msg}`);
    }

    return res.result?.value as T;
  }

  public async bringToFront(): Promise<void> {
    await this.sendCommand('Page.bringToFront');
  }

  public async dispatchKeyEvent(params: {
    type: 'keyDown' | 'keyUp' | 'rawKeyDown' | 'char';
    modifiers?: number;
    windowsVirtualKeyCode?: number;
    key?: string;
    code?: string;
    text?: string;
  }): Promise<void> {
    await this.sendCommand('Input.dispatchKeyEvent', params);
  }

  private async discoverTarget(): Promise<CdpTarget> {
    const url = `${this.config.url.replace(/\/+$/, '')}/json`;
    log.debug({ url }, '正在探测 CDP 渲染目标');

    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (!response.ok) {
        throw new Error(`HTTP 状态码异常: ${response.status}`);
      }
      const targets = (await response.json()) as CdpTarget[];
      const matched = targets.find(
        t =>
          (t.type === 'page' || t.type === 'webview' || t.type === 'app') &&
          t.url.includes(this.config.pageMatch)
      );

      if (!matched) {
        const available = targets.map(t => `[${t.type}] ${t.title} (${t.url})`).join(', ');
        throw new Error(
          `未找到匹配 "${this.config.pageMatch}" 的目标页面。当前可用页面: ${available}`
        );
      }

      return matched;
    } catch (err) {
      throw new CdpError(
        `探测 CDP 目标失败: ${err instanceof Error ? err.message : String(err)}`,
        err instanceof Error ? err : undefined
      );
    }
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let settled = false;

      ws.on('open', () => {
        if (!settled) {
          settled = true;
          this.ws = ws;
          this.setupWsHandlers(ws);
          resolve();
        }
      });

      ws.on('error', err => {
        if (!settled) {
          settled = true;
          reject(err);
        } else {
          log.warn({ err: err.message }, 'WebSocket 运行中报错');
          this.emit('error', err);
        }
      });
    });
  }

  private setupWsHandlers(ws: WebSocket): void {
    ws.on('message', (data: WebSocket.RawData) => {
      try {
        const text =
          typeof data === 'string'
            ? data
            : Buffer.isBuffer(data)
              ? data.toString('utf-8')
              : Array.isArray(data)
                ? Buffer.concat(data).toString('utf-8')
                : Buffer.from(data).toString('utf-8');
        const res = JSON.parse(text) as CdpResponse & {
          method?: string;
          params?: Record<string, unknown>;
        };
        if (res.id && this.pending.has(res.id)) {
          const { resolve, reject, timer } = this.pending.get(res.id)!;
          clearTimeout(timer);
          this.pending.delete(res.id);

          if (res.error) {
            reject(new CdpError(`CDP 远程返回错误: ${res.error.message} (code=${res.error.code})`));
          } else {
            resolve(res.result);
          }
        } else if (!res.id && res.method) {
          this.emit('event', res.method, res.params);
          this.emit(res.method, res.params);
        }
      } catch (err) {
        log.warn({ err: String(err) }, '解析 CDP 消息失败');
      }
    });

    ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'CDP WebSocket 连接断开');
      this.handleDisconnect('WebSocket closed', ws);
    });
  }

  private handleDisconnect(reason: string, disconnectedSocket: WebSocket | null = this.ws): void {
    if (this.status === 'disconnected') return;
    if (this.ws && disconnectedSocket && this.ws !== disconnectedSocket) return;

    this.stopHeartbeat();
    const cause = new CdpError(`连接已断开: ${reason}`);
    const identity = this.connectionIdentity;
    const socket = this.ws;

    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(cause);
      this.pending.delete(id);
    }

    if (
      socket &&
      (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)
    ) {
      socket.removeAllListeners();
      socket.terminate();
    }
    this.ws = null;
    this.connectionIdentity = null;
    this.connectedAt = 0;
    this.setStatus('disconnected');

    if (!this.isIntentionallyClosed) {
      const event: CdpConnectionLostEvent = {
        startupGenerationId: this.startupGenerationId,
        connectionIdentity: identity,
        observedAt: Date.now(),
        cause,
      };
      this.emit('connection_lost', event);
      if (this.listenerCount('error') > 0) {
        this.emit('error', cause);
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.config.heartbeatIntervalMs ?? 10000;

    this.heartbeatTimer = setInterval(() => {
      void (async (): Promise<void> => {
        try {
          await this.evaluate('1');
          const uptime = this.getUptimeMs();
          this.emit('heartbeat', uptime);
        } catch (err) {
          log.warn({ err: String(err) }, '心跳检测失败');
          this.handleDisconnect('Heartbeat check failed');
        }
      })();
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private setStatus(newStatus: ConnectionStatus): void {
    if (this.status !== newStatus) {
      this.status = newStatus;
      this.emit('status', newStatus);
    }
  }
}
