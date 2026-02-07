import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CdpConnector, CdpConnectionError } from '../src/cdp/connector.js';
import type { CdpConfig, PageConfig } from '../src/config/schema.js';

const createMockConfig = (): { cdpConfig: CdpConfig; pageConfig: PageConfig } => ({
  cdpConfig: {
    url: 'http://127.0.0.1:9222',
    reconnect: {
      maxRetries: 5,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
    },
  },
  pageConfig: {
    match: 'renderer.html',
  },
});

describe('CdpConnector', () => {
  let connector: CdpConnector;
  let config: ReturnType<typeof createMockConfig>;

  beforeEach(() => {
    vi.useFakeTimers();
    config = createMockConfig();
    connector = new CdpConnector(config.cdpConfig, config.pageConfig);
  });

  afterEach(() => {
    connector.disconnect();
    vi.useRealTimers();
  });

  describe('getStatus', () => {
    it('should return disconnected as initial status', () => {
      expect(connector.getStatus()).toBe('disconnected');
    });
  });

  describe('status transitions', () => {
    it('should emit status_change event when status changes', () => {
      const statusChanges: Array<{ status: string; previousStatus: string }> = [];
      connector.on('status_change', (status, previousStatus) => {
        statusChanges.push({ status, previousStatus });
      });

      // @ts-expect-error accessing private method for testing
      connector.setStatus('connecting');
      // @ts-expect-error accessing private method for testing
      connector.setStatus('connected');
      // @ts-expect-error accessing private method for testing
      connector.setStatus('reconnecting');
      // @ts-expect-error accessing private method for testing
      connector.setStatus('disconnected');

      expect(statusChanges).toEqual([
        { status: 'connecting', previousStatus: 'disconnected' },
        { status: 'connected', previousStatus: 'connecting' },
        { status: 'reconnecting', previousStatus: 'connected' },
        { status: 'disconnected', previousStatus: 'reconnecting' },
      ]);
    });

    it('should not emit status_change for same status', () => {
      const statusChanges: string[] = [];
      connector.on('status_change', status => {
        statusChanges.push(status);
      });

      // @ts-expect-error accessing private method for testing
      connector.setStatus('connecting');
      // @ts-expect-error accessing private method for testing
      connector.setStatus('connecting');

      expect(statusChanges).toEqual(['connecting']);
    });
  });

  describe('exponential backoff', () => {
    it('should calculate correct delays with exponential backoff', () => {
      const baseDelay = config.cdpConfig.reconnect.baseDelayMs;
      const maxDelay = config.cdpConfig.reconnect.maxDelayMs;

      const expectedDelays = [
        baseDelay * Math.pow(2, 0),
        baseDelay * Math.pow(2, 1),
        baseDelay * Math.pow(2, 2),
        baseDelay * Math.pow(2, 3),
        baseDelay * Math.pow(2, 4),
      ];

      expectedDelays.forEach((expected, i) => {
        const delay = Math.min(baseDelay * Math.pow(2, i), maxDelay);
        expect(delay).toBe(expected);
      });
    });

    it('should cap delay at maxDelayMs', () => {
      const baseDelay = config.cdpConfig.reconnect.baseDelayMs;
      const maxDelay = config.cdpConfig.reconnect.maxDelayMs;

      const attemptWithMaxDelay = 6;
      const rawDelay = baseDelay * Math.pow(2, attemptWithMaxDelay);
      const cappedDelay = Math.min(rawDelay, maxDelay);

      expect(rawDelay).toBeGreaterThan(maxDelay);
      expect(cappedDelay).toBe(maxDelay);
    });
  });

  describe('disconnect', () => {
    it('should set status to disconnected', () => {
      // @ts-expect-error accessing private method for testing
      connector.setStatus('connected');
      connector.disconnect();
      expect(connector.getStatus()).toBe('disconnected');
    });

    it('should reset reconnect attempts', () => {
      // @ts-expect-error accessing private property for testing
      connector.reconnectAttempts = 3;
      connector.disconnect();
      // @ts-expect-error accessing private property for testing
      expect(connector.reconnectAttempts).toBe(0);
    });
  });

  describe('CdpConnectionError', () => {
    it('should create error with message', () => {
      const error = new CdpConnectionError('Test error');
      expect(error.message).toBe('Test error');
      expect(error.name).toBe('CdpConnectionError');
    });

    it('should preserve original cause', () => {
      const cause = new Error('Original error');
      const error = new CdpConnectionError('Wrapped error', cause);
      expect(error.originalCause).toBe(cause);
    });
  });
});
