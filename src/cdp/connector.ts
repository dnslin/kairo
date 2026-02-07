import WebSocket from 'ws';
import { EventEmitter } from 'node:events';
import type { CdpConfig, PageConfig } from '../config/schema.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('cdp');

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

interface CdpTargetInfo {
  description: string;
  devtoolsFrontendUrl: string;
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpResponse {
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

export interface CdpConnection {
  ws: WebSocket;
  pageUrl: string;
  targetId: string;
}

export type CdpConnectorEvents = {
  connected: [];
  disconnected: [reason: string];
  reconnecting: [attempt: number, maxRetries: number];
  heartbeat: [uptimeMs: number];
  error: [error: Error];
  status_change: [status: ConnectionStatus, previousStatus: ConnectionStatus];
};

export class CdpConnectionError extends Error {
  public readonly originalCause: Error | undefined;

  constructor(message: string, originalCause?: Error) {
    super(message);
    this.name = 'CdpConnectionError';
    this.originalCause = originalCause;
  }
}

export class CdpConnector extends EventEmitter<CdpConnectorEvents> {
  private ws: WebSocket | null = null;
  private pageUrl = '';
  private targetId = '';
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private connectedAt: number | null = null;
  private isConnected = false;
  private messageId = 0;
  private status: ConnectionStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingCallbacks = new Map<
    number,
    {
      resolve: (value: CdpResponse) => void;
      reject: (reason: Error) => void;
    }
  >();

  constructor(
    private readonly cdpConfig: CdpConfig,
    private readonly pageConfig: PageConfig
  ) {
    super();
  }

  private setStatus(newStatus: ConnectionStatus): void {
    const previousStatus = this.status;
    if (previousStatus === newStatus) return;
    this.status = newStatus;
    log.info({ status: newStatus, previousStatus }, 'Connection status changed');
    this.emit('status_change', newStatus, previousStatus);
  }

  getStatus(): ConnectionStatus {
    return this.status;
  }

  async connect(): Promise<CdpConnection> {
    this.setStatus('connecting');
    log.info({ url: this.cdpConfig.url }, 'Connecting to CDP endpoint');

    try {
      const target = await this.discoverTarget();
      this.pageUrl = target.url;
      this.targetId = target.id;
      log.info(
        { wsUrl: target.webSocketDebuggerUrl, pageUrl: target.url },
        'Discovered renderer page'
      );

      await this.connectWebSocket(target.webSocketDebuggerUrl);

      this.connectedAt = Date.now();
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.setStatus('connected');

      log.info({ url: this.pageUrl }, 'Connected to renderer page');
      this.emit('connected');
      this.startHeartbeat();

      return {
        ws: this.ws!,
        pageUrl: this.pageUrl,
        targetId: this.targetId,
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ err }, 'Failed to connect to CDP');
      this.setStatus('disconnected');
      throw new CdpConnectionError('Failed to connect to CDP', err);
    }
  }

  private async discoverTarget(): Promise<CdpTargetInfo> {
    const targetListUrl = `${this.cdpConfig.url}/json`;
    const response = await fetch(targetListUrl);
    if (!response.ok) {
      throw new CdpConnectionError(`Failed to fetch ${targetListUrl}: ${String(response.status)}`);
    }
    const targetList = (await response.json()) as CdpTargetInfo[];
    log.info(
      {
        targetCount: targetList.length,
        targets: targetList.map(t => ({ url: t.url, title: t.title, type: t.type })),
      },
      'Available CDP targets'
    );

    const matchingTarget = targetList.find(t => t.url.includes(this.pageConfig.match));
    if (!matchingTarget) {
      throw new CdpConnectionError(
        `No target matching "${this.pageConfig.match}" found among ${String(targetList.length)} targets`
      );
    }

    return matchingTarget;
  }

  private connectWebSocket(wsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('error', err => {
        reject(new CdpConnectionError('WebSocket connection failed', err));
      });

      this.ws.on('close', () => {
        this.handleDisconnect('WebSocket closed');
      });

      this.ws.on('message', (data: WebSocket.RawData) => {
        const raw = Buffer.isBuffer(data)
          ? data.toString('utf-8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf-8')
            : Buffer.from(data).toString('utf-8');
        const message = JSON.parse(raw) as CdpResponse;
        const callback = this.pendingCallbacks.get(message.id);
        if (callback) {
          this.pendingCallbacks.delete(message.id);
          callback.resolve(message);
        }
      });
    });
  }

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<CdpResponse> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new CdpConnectionError('WebSocket not connected');
    }

    const id = ++this.messageId;
    const message = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(id);
        reject(new CdpConnectionError(`CDP command "${method}" timed out`));
      }, 5000);

      this.pendingCallbacks.set(id, {
        resolve: response => {
          clearTimeout(timeout);
          resolve(response);
        },
        reject: err => {
          clearTimeout(timeout);
          reject(err);
        },
      });

      this.ws!.send(message);
    });
  }

  async evaluate(expression: string): Promise<unknown> {
    const response = await this.sendCommand('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });

    if (response.error) {
      throw new CdpConnectionError(`Evaluate failed: ${response.error.message}`);
    }

    return response.result;
  }

  private startHeartbeat(): void {
    const intervalMs = 10000;
    this.heartbeatInterval = setInterval(() => {
      void this.checkConnection();
    }, intervalMs);
    log.debug({ intervalMs }, 'Heartbeat started');
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      log.debug('Heartbeat stopped');
    }
  }

  private async checkConnection(): Promise<void> {
    if (!this.isConnected || !this.ws) {
      return;
    }

    try {
      await this.sendCommand('Runtime.evaluate', { expression: '1', returnByValue: true });
      const uptimeMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
      log.debug({ uptimeMs }, 'Heartbeat OK');
      this.emit('heartbeat', uptimeMs);
    } catch (error) {
      log.warn({ err: error }, 'Heartbeat failed');
      this.handleDisconnect('Heartbeat check failed');
    }
  }

  private handleDisconnect(reason: string): void {
    if (!this.isConnected && this.status !== 'connected') {
      return;
    }

    this.isConnected = false;
    this.stopHeartbeat();
    log.warn({ reason }, 'Connection lost');
    this.emit('disconnected', reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const maxRetries = this.cdpConfig.reconnect.maxRetries;
    const baseDelay = this.cdpConfig.reconnect.baseDelayMs;
    const maxDelay = this.cdpConfig.reconnect.maxDelayMs;

    if (this.reconnectAttempts >= maxRetries) {
      log.error(
        { attempts: this.reconnectAttempts, maxRetries },
        'CDP connection failed after max retries - manual intervention required'
      );
      this.setStatus('disconnected');
      this.emit('error', new CdpConnectionError(`Reconnect failed after ${maxRetries} attempts`));
      return;
    }

    const delay = Math.min(baseDelay * Math.pow(2, this.reconnectAttempts), maxDelay);
    this.reconnectAttempts++;
    this.setStatus('reconnecting');

    log.info(
      { attempt: this.reconnectAttempts, maxRetries, delayMs: delay },
      'Scheduling reconnect'
    );
    this.emit('reconnecting', this.reconnectAttempts, maxRetries);

    if (this.reconnectAttempts >= 5) {
      log.error(
        { attempts: this.reconnectAttempts },
        'CDP reconnect attempts reached 5 - alerting'
      );
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(err => {
        log.warn({ err }, 'Reconnect attempt failed');
      });
    }, delay);
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.isConnected = false;
    this.reconnectAttempts = 0;

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* cleanup */
      }
      this.ws = null;
    }

    for (const [id, callback] of this.pendingCallbacks) {
      callback.reject(new CdpConnectionError('Disconnected'));
      this.pendingCallbacks.delete(id);
    }

    this.connectedAt = null;
    this.setStatus('disconnected');
    log.info('Disconnected from CDP');
  }

  getConnection(): CdpConnection | null {
    if (!this.isConnected || !this.ws) {
      return null;
    }
    return {
      ws: this.ws,
      pageUrl: this.pageUrl,
      targetId: this.targetId,
    };
  }

  getUptime(): number {
    return this.connectedAt ? Date.now() - this.connectedAt : 0;
  }

  isActive(): boolean {
    return this.isConnected;
  }
}
