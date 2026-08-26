import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import { LibSQLStore } from '@mastra/libsql';
import {
  KKBotAgent,
  MastraModelFactory,
  createFakeModel,
  Memory,
} from '@kkbot/agent';
import { FakeKK9Driver, type KK9Driver } from '@kkbot/driver';
import { SessionCoordinator } from '../src/coordinator.js';

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (
    content &&
    typeof content === 'object' &&
    'content' in content &&
    typeof content.content === 'string'
  ) {
    return content.content;
  }
  return '';
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Delivery 跨独立进程强杀与重启恢复 Oracle 测试 (CONCURRENCY-01 / DELIVERY-01)', () => {
  let tempDir: string;
  let dbPath: string;
  let fileUrl: string;
  let store: KKBotStore;
  let libSqlStore: LibSQLStore;
  let mastraMemory: Memory;
  let fakeDriver: FakeKK9Driver;
  let coordinator: SessionCoordinator;

  const workerScript = path.resolve(__dirname, 'helpers/crash-injection-worker.ts');

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kkbot-proc-crash-'));
    dbPath = path.join(tempDir, 'test.db');
    fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;

    // 父进程首次初始化数据库并执行迁移
    store = await createKKBotStore({ url: fileUrl });
    store.close();
  });

  afterEach(async () => {
    if (coordinator) {
      await coordinator.stop();
    }
    if (store) {
      store.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // 忽略清理异常
    }
  });

  /**
   * 启动子进程执行场景并在指定检查点触发 process.kill(SIGKILL)
   */
  function runChildWorkerToCrash(scenario: string, sessionId: string, deliveryId: string, resourceId: string) {
    const isWin = process.platform === 'win32';
    const pnpmCmd = isWin ? 'pnpm.cmd' : 'pnpm';

    const res = spawnSync(
      pnpmCmd,
      [
        'tsx',
        workerScript,
        '--scenario',
        scenario,
        '--db-url',
        fileUrl,
        '--session-id',
        sessionId,
        '--delivery-id',
        deliveryId,
        '--resource-id',
        resourceId,
      ],
      {
        encoding: 'utf-8',
        shell: true,
        timeout: 15000,
      }
    );

    if (!res.stdout?.includes(`CRASH_POINT_REACHED:${scenario}`)) {
      console.error(`WORKER FAILED for ${scenario}:\nSTDOUT: ${res.stdout}\nSTDERR: ${res.stderr}\nSTATUS: ${res.status}\nSIGNAL: ${res.signal}`);
    }
    expect(res.stdout).toContain(`CRASH_POINT_REACHED:${scenario}`);
    // 子进程必须以 SIGKILL 或非零退出码终止 (证明发生强杀崩溃)
    expect(res.signal === 'SIGKILL' || (res.status !== null && res.status !== 0)).toBe(true);
  }

  it('强杀点 1: 创建 Delivery 前强杀 -> 重启后数据库无该 Delivery，Memory 无 assistant 记录', async () => {
    const sessionId = 'ses_crash_pt1';
    const deliveryId = 'deliv_crash_pt1';
    const resourceId = 'emp_pt1';

    // 1. 子进程在创建 Delivery 前触发 SIGKILL 崩溃
    runChildWorkerToCrash('crash_before_create_delivery', sessionId, deliveryId, resourceId);

    // 2. 父进程重新打开同一数据库文件并启动 Coordinator (执行启动恢复扫描)
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt1', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：Delivery 实体不存在，Memory 0 写入，Driver 0 发送
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(0);

    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(0);
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('强杀点 2: Delivery=generated 提交后、sending 提交前强杀 -> 启动恢复扫描安全收敛为 aborted，无 Memory 写入', async () => {
    const sessionId = 'ses_crash_pt2';
    const deliveryId = 'deliv_crash_pt2';
    const resourceId = 'emp_pt2';

    // 1. 子进程创建 Delivery=generated 后被 SIGKILL
    runChildWorkerToCrash('crash_after_generated_before_sending', sessionId, deliveryId, resourceId);

    // 2. 重启 Coordinator
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt2', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：启动恢复扫描自动将未进入发送流程的 generated 收敛为 aborted
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('aborted');
    expect(deliv.errorCode).toContain('RECOVERY_GENERATED_INTERRUPTED_ABORTED');
    expect(deliv.memoryCommittedAt).toBeNull();

    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(0);
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('强杀点 3: Delivery=sending 提交后、调用 Driver 发送前强杀 -> 启动恢复扫描安全收敛为 unknown', async () => {
    const sessionId = 'ses_crash_pt3';
    const deliveryId = 'deliv_crash_pt3';
    const resourceId = 'emp_pt3';

    // 1. 子进程更新为 sending 后被 SIGKILL
    runChildWorkerToCrash('crash_after_sending_before_driver', sessionId, deliveryId, resourceId);

    // 2. 重启 Coordinator (启动期必须执行恢复扫描)
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt3', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：因跨进程崩溃无法证明是否已发送，Delivery 必须被自动收敛为 unknown
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('unknown');
    expect(deliv.errorCode).toContain('RECOVERY_IN_FLIGHT_SENDING_INTERRUPTED');
    expect(deliv.memoryCommittedAt).toBeNull();

    // 验证 Memory 0 写入，Driver 0 发送
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(0);
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('强杀点 4: Driver 发送成功但 sent 落库前强杀 -> 启动恢复扫描安全收敛为 unknown，人工裁定后补交 Memory', async () => {
    const sessionId = 'ses_crash_pt4';
    const deliveryId = 'deliv_crash_pt4';
    const resourceId = 'emp_pt4';

    // 1. 子进程在 Driver 发送成功后、sent 持久化前被 SIGKILL
    runChildWorkerToCrash('crash_after_driver_send_before_sent', sessionId, deliveryId, resourceId);

    // 2. 重启 Coordinator
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt4', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：数据库中仍保留 sending，启动扫描后安全转换为 unknown
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('unknown');
    expect(deliv.memoryCommittedAt).toBeNull();

    // 4. 后续人工取得真机送达证据，正式裁定为 sent
    const adjResult = await coordinator.adjudicateDelivery({
      deliveryId: deliv.id,
      operator: 'op_recovery_oracle',
      decision: 'sent',
      evidenceSummary: '真机网络日志与抓包确认已成功发出',
    });
    expect(adjResult.success).toBe(true);
    expect(adjResult.delivery.status).toBe('sent');
    expect(adjResult.memoryCommitted).toBe(true);

    // 5. 验证 Memory 已通过人工裁定安全补交且仅有 1 条
    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(1);
    expect(extractMessageText(asstMsgs[0].content)).toContain('crash_after_driver_send_before_sent');
  });

  it('强杀点 5: Delivery=sent 持久化成功但 Memory 保存前强杀 -> 启动恢复扫描仅补交 Memory 不二次发送', async () => {
    const sessionId = 'ses_crash_pt5';
    const deliveryId = 'deliv_crash_pt5';
    const resourceId = 'emp_pt5';

    // 1. 子进程在 sent 持久化后、Memory.saveMessages 前被 SIGKILL
    runChildWorkerToCrash('crash_after_sent_before_memory', sessionId, deliveryId, resourceId);

    // 2. 重启 Coordinator
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt5', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：Driver 0 次调用，Memory 已由启动扫描自动补交，memory_committed_at 已标记
    expect(fakeDriver.recordedCalls.length).toBe(0);

    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('sent');
    expect(deliv.memoryCommittedAt).toBeGreaterThan(0);

    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.role === 'assistant');
    expect(asstMsgs.length).toBe(1);
    expect(extractMessageText(asstMsgs[0].content)).toContain('crash_after_sent_before_memory');
  });

  it('强杀点 6: Memory 保存成功但 markMemoryCommitted 前强杀 -> 启动恢复扫描重放后保持 exactly-once', async () => {
    const sessionId = 'ses_crash_pt6';
    const deliveryId = 'deliv_crash_pt6';
    const resourceId = 'emp_pt6';

    // 1. 子进程在 Memory 保存成功后、markMemoryCommitted 前被 SIGKILL
    runChildWorkerToCrash('crash_after_memory_before_mark_committed', sessionId, deliveryId, resourceId);

    // 2. 重启 Coordinator
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt6', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：稳定 ID 重放后 Memory 依然仅有 1 条逻辑 assistant 消息，commit 标记完成
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('sent');
    expect(deliv.memoryCommittedAt).toBeGreaterThan(0);

    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.id === deliv.mastraMessageId);
    expect(asstMsgs.length).toBe(1);
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });

  it('强杀点 7: 人工裁定为 sent 持久化后、Memory 补交前强杀 -> 启动恢复扫描自动补交 Memory', async () => {
    const sessionId = 'ses_crash_pt7';
    const deliveryId = 'deliv_crash_pt7';
    const resourceId = 'emp_pt7';

    // 1. 子进程在人工裁定 sent 事务提交后、Memory 补交前被 SIGKILL
    runChildWorkerToCrash('crash_after_adjudication_before_memory', sessionId, deliveryId, resourceId);

    // 2. 重启 Coordinator
    store = await createKKBotStore({ url: fileUrl });
    libSqlStore = new LibSQLStore({ id: 'mastra-recovery-pt7', url: fileUrl });
    await libSqlStore.init();
    mastraMemory = new Memory({ storage: libSqlStore });
    fakeDriver = new FakeKK9Driver();

    const fakeModel = createFakeModel({ responses: [] });
    const factory = new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model: fakeModel }] },
        DEEP: { models: [{ model: fakeModel }] },
        VISION: { models: [{ model: fakeModel }] },
      },
    });
    const agent = new KKBotAgent({ modelFactory: factory, memory: mastraMemory });

    coordinator = new SessionCoordinator({
      driver: fakeDriver as unknown as KK9Driver,
      store,
      agent,
      mastraMemory,
    });
    await coordinator.start();

    // 3. Oracle 校验：sent-but-uncommitted 已被自动补交，审计记录完好
    const deliveries = await store.deliveries.getDeliveriesBySession(sessionId);
    expect(deliveries.length).toBe(1);
    const deliv = deliveries[0];
    expect(deliv.status).toBe('sent');
    expect(deliv.memoryCommittedAt).toBeGreaterThan(0);

    const audits = await store.deliveries.getAdjudicationsByDeliveryId(deliv.id);
    expect(audits.length).toBe(1);
    expect(audits[0].decision).toBe('sent');

    const recalled = await mastraMemory.recall({ threadId: sessionId, resourceId });
    const asstMsgs = recalled.messages.filter((m) => m.id === deliv.mastraMessageId);
    expect(asstMsgs.length).toBe(1);
    expect(fakeDriver.recordedCalls.length).toBe(0);
  });
});
