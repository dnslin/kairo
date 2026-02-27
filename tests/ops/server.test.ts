import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Store } from '../../src/store/index.js';
import { OpsServer } from '../../src/ops/server.js';
import type { OpsContext } from '../../src/ops/server.js';
import type { OpsConfig, StoreConfig } from '../../src/config/schema.js';
import type { CdpConnector } from '../../src/cdp/index.js';
import type { Sender } from '../../src/send/index.js';
import type { DomLocator } from '../../src/dom/index.js';

const TEST_DIR = join(process.cwd(), 'tmp', 'test-ops-server');

const createStoreConfig = (): StoreConfig => ({
  dbPath: join(TEST_DIR, `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`),
  storeMessageContent: true,
});

/** 获取 OpsServer 内部 HTTP Server 实例（绕过 private 访问） */
function getServerAddress(ops: OpsServer): AddressInfo {
  const internal = ops as unknown as { server: Server };
  return internal.server.address() as AddressInfo;
}

/** 构建最小化 OpsContext mock */
function createMockContext(store: Store): OpsContext {
  const connector = {
    getStatus: () => 'connected',
    getUptime: () => 12345,
  } as unknown as CdpConnector;

  const sender = {} as unknown as Sender;
  const locator = {} as unknown as DomLocator;

  return {
    store,
    connector,
    sender,
    locator,
    mode: 'draft_only',
    isPaused: () => false,
    setPaused: () => {},
    isWithinWorkingHours: () => true,
  };
}

describe('OpsServer API', () => {
  let store: Store;
  let storeConfig: StoreConfig;
  let opsServer: OpsServer;
  let baseUrl: string;

  beforeEach(async () => {
    if (!existsSync(TEST_DIR)) {
      mkdirSync(TEST_DIR, { recursive: true });
    }
    storeConfig = createStoreConfig();
    store = new Store(storeConfig);

    const opsConfig: OpsConfig = { port: 0, host: '127.0.0.1' };
    const ctx = createMockContext(store);
    opsServer = new OpsServer(opsConfig, ctx);
    await opsServer.start();

    const addr = getServerAddress(opsServer);
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  afterEach(async () => {
    await opsServer.stop();
    try {
      store.close();
    } catch {
      /* 忽略 */
    }
    try {
      rmSync(storeConfig.dbPath, { force: true });
      rmSync(`${storeConfig.dbPath}-wal`, { force: true });
      rmSync(`${storeConfig.dbPath}-shm`, { force: true });
    } catch {
      /* 忽略 */
    }
  });

  // ── GET /api/sessions ──────────────────────────────────────────────

  describe('GET /api/sessions', () => {
    it('无草稿时返回空数组', async () => {
      const res = await fetch(`${baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it('返回各会话的待处理草稿计数', async () => {
      store.saveDraft({
        sessionId: 's1',
        sessionName: '会话一',
        originalMessage: 'msg1',
        originalSender: 'user1',
        draftContent: 'draft1',
      });
      store.saveDraft({
        sessionId: 's1',
        sessionName: '会话一',
        originalMessage: 'msg2',
        originalSender: 'user1',
        draftContent: 'draft2',
      });
      store.saveDraft({
        sessionId: 's2',
        sessionName: '会话二',
        originalMessage: 'msg3',
        originalSender: 'user2',
        draftContent: 'draft3',
      });

      const res = await fetch(`${baseUrl}/api/sessions`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Array<{
        sessionId: string;
        sessionName: string;
        count: number;
      }>;
      expect(body).toHaveLength(2);

      const s1 = body.find(s => s.sessionId === 's1');
      expect(s1).toBeDefined();
      expect(s1!.count).toBe(2);
      expect(s1!.sessionName).toBe('会话一');

      const s2 = body.find(s => s.sessionId === 's2');
      expect(s2).toBeDefined();
      expect(s2!.count).toBe(1);
    });
  });

  // ── GET /api/drafts ────────────────────────────────────────────────

  describe('GET /api/drafts', () => {
    it('无草稿时返回空数组', async () => {
      const res = await fetch(`${baseUrl}/api/drafts`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it('无 sessionId 时返回所有待确认草稿', async () => {
      store.saveDraft({
        sessionId: 's1',
        sessionName: '会话一',
        originalMessage: 'msg1',
        originalSender: 'user1',
        draftContent: 'draft1',
      });
      store.saveDraft({
        sessionId: 's2',
        sessionName: '会话二',
        originalMessage: 'msg2',
        originalSender: 'user2',
        draftContent: 'draft2',
      });

      const res = await fetch(`${baseUrl}/api/drafts`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Array<{ sessionId: string }>;
      expect(body).toHaveLength(2);
    });

    it('有 sessionId 时仅返回该会话草稿', async () => {
      store.saveDraft({
        sessionId: 's1',
        sessionName: '会话一',
        originalMessage: 'msg1',
        originalSender: 'user1',
        draftContent: 'draft1',
      });
      store.saveDraft({
        sessionId: 's2',
        sessionName: '会话二',
        originalMessage: 'msg2',
        originalSender: 'user2',
        draftContent: 'draft2',
      });

      const res = await fetch(`${baseUrl}/api/drafts?sessionId=s1`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Array<{ sessionId: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]!.sessionId).toBe('s1');
    });

    it('sessionId 无匹配时返回空数组', async () => {
      store.saveDraft({
        sessionId: 's1',
        sessionName: '会话一',
        originalMessage: 'msg1',
        originalSender: 'user1',
        draftContent: 'draft1',
      });

      const res = await fetch(`${baseUrl}/api/drafts?sessionId=nonexistent`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });
  });

  // ── GET /api/logs ──────────────────────────────────────────────────

  describe('GET /api/logs', () => {
    it('无日志时返回空数组', async () => {
      const res = await fetch(`${baseUrl}/api/logs`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as unknown[];
      expect(body).toEqual([]);
    });

    it('无 sessionId 时返回所有日志', async () => {
      store.logEvent('draft_sent', { sessionId: 's1', draftId: 1 });
      store.logEvent('system_paused');
      store.logEvent('draft_sent', { sessionId: 's2', draftId: 2 });

      const res = await fetch(`${baseUrl}/api/logs`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Array<{ type: string }>;
      expect(body).toHaveLength(3);
    });

    it('有 sessionId 时仅返回该会话日志', async () => {
      store.logEvent('draft_sent', { sessionId: 's1', draftId: 1 });
      store.logEvent('system_paused');
      store.logEvent('draft_sent', { sessionId: 's2', draftId: 2 });

      const res = await fetch(`${baseUrl}/api/logs?sessionId=s1`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as Array<{ type: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]!.type).toBe('draft_sent');
    });

    it('支持 limit 和 type 与 sessionId 组合', async () => {
      store.logEvent('draft_sent', { sessionId: 's1', draftId: 1 });
      store.logEvent('draft_sent', { sessionId: 's1', draftId: 2 });
      store.logEvent('draft_sent', { sessionId: 's1', draftId: 3 });

      const res = await fetch(`${baseUrl}/api/logs?sessionId=s1&limit=2`);
      expect(res.status).toBe(200);

      const body = (await res.json()) as unknown[];
      expect(body).toHaveLength(2);
    });
  });
});
