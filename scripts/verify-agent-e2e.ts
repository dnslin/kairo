import EventEmitter from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LibSQLStore } from '@mastra/libsql';
import { KK9Driver, type FormattedText, type KK9Message, type SendResult } from '@kkbot/driver';
import { createKKBotStore, type KKBotStore } from '@kkbot/store';
import { KKBotAgent, MastraModelFactory, Memory, createFakeModel } from '@kkbot/agent';
import { SessionCoordinator, type CoordinatorDispatchResult } from '@kkbot/gateway';

function waitForEvent<T = unknown[]>(
  emitter: EventEmitter,
  event: string,
  timeoutMs: number,
  stepName: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${stepName} 在 ${timeoutMs}ms 内未收到 ${event} 事件`));
    }, timeoutMs);

    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as T);
    });
  });
}
async function removeTemporaryDatabase(dbPath: string): Promise<void> {
  await Promise.all(
    [dbPath, `${dbPath}-wal`, `${dbPath}-shm`].map(filePath =>
      fs.promises.rm(filePath, { force: true, maxRetries: 20, retryDelay: 100 })
    )
  );
}

/**
 * 离线仿真 Driver；开启 E2E_LIVE=1 时由真实 KK9Driver 替换。
 */
class SimulationDriver extends EventEmitter {
  public readonly sentMessages: Array<{
    targetSessionId: string;
    content: string | FormattedText;
  }> = [];
  public readonly readSessionIds = new Set<string>();

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async markSessionRead(sessionId: string): Promise<boolean> {
    this.readSessionIds.add(sessionId);
    return true;
  }

  async sendText(text: string, options?: { targetSessionId?: string }): Promise<SendResult> {
    const targetSessionId = options?.targetSessionId ?? 'default_session';
    this.sentMessages.push({ targetSessionId, content: text });
    return {
      success: true,
      messageId: `sim_text_${randomUUID()}`,
    };
  }

  async sendRichText(
    richText: FormattedText,
    options?: { targetSessionId?: string }
  ): Promise<SendResult> {
    const targetSessionId = options?.targetSessionId ?? 'default_session';
    this.sentMessages.push({ targetSessionId, content: richText });
    return {
      success: true,
      messageId: `sim_rich_${randomUUID()}`,
    };
  }
}
function emitDriverMessage(driver: KK9Driver | SimulationDriver, message: KK9Message): void {
  (driver as unknown as EventEmitter).emit('message', message);
}

function createModelFactory() {
  const model = createFakeModel({
    modelId: 'verify-agent-model',
    responses: [
      {
        text: '已收到您的私聊请求，KKBot 将按照当前业务规则继续协助。',
        finishReason: 'stop',
      },
      {
        text: 'KKBot 没有执行外部操作。涉及权限、删除、资金或敏感数据的事项请由您在目标系统中手动处理。',
        finishReason: 'stop',
      },
    ],
  });

  return {
    model,
    factory: new MastraModelFactory({
      tiers: {
        FAST: { models: [{ model }] },
        DEEP: { models: [{ model }] },
        VISION: { models: [{ model }] },
      },
    }),
  };
}

async function runAgentE2eVerification(): Promise<void> {
  const isLiveRequested = process.env['E2E_LIVE'] === '1';
  const targetSessionId = process.env['E2E_TARGET_SESSION_ID'] ?? 'session_verify_private';
  const liveDbName = `kkbot_agent_e2e_${Date.now()}_${randomUUID().slice(0, 8)}.db`;
  const dbPath = path.resolve(os.tmpdir(), liveDbName);
  let driver: KK9Driver | SimulationDriver | undefined;
  let liveDriver: KK9Driver | undefined;
  let store: KKBotStore | undefined;
  let mastraStorage: LibSQLStore | undefined;
  let mastraMemory: Memory | undefined;
  let coordinator: SessionCoordinator | undefined;
  let verificationError: unknown;

  try {
    if (isLiveRequested) {
      if (!process.env['E2E_TARGET_SESSION_ID']) {
        throw new Error('E2E_LIVE=1 时必须提供 E2E_TARGET_SESSION_ID');
      }
      liveDriver = new KK9Driver({
        cdp: {
          url: process.env['CDP_URL'] ?? 'http://127.0.0.1:9222',
          pageMatch: process.env['PAGE_MATCH'] ?? 'renderer.html',
        },
        polling: { intervalMs: 1500 },
      });
      driver = liveDriver;
      await liveDriver.connect();
    } else {
      driver = new SimulationDriver();
      await driver.connect();
    }

    const kkbotStore = await createKKBotStore({ path: dbPath });
    store = kkbotStore;
    const fileUrl = `file:${dbPath.replace(/\\/g, '/')}`;
    const storage = new LibSQLStore({ id: 'verify-agent-storage', url: fileUrl });
    mastraStorage = storage;
    await storage.init();
    const memory = new Memory({ storage });
    mastraMemory = memory;
    const { model, factory } = createModelFactory();
    const agent = new KKBotAgent({ modelFactory: factory, memory });
    const activeDriver = driver;
    if (!activeDriver) {
      throw new Error('E2E 验证 Driver 尚未取得');
    }
    const activeCoordinator = new SessionCoordinator({
      driver: activeDriver as KK9Driver,
      store: kkbotStore,
      agent,
      mastraMemory: memory,
      mastraStorage: storage,
      config: { debounceMs: 50, maxWaitMs: 200 },
    });
    coordinator = activeCoordinator;

    await activeCoordinator.start();

    const privateReply = waitForEvent<[string, CoordinatorDispatchResult]>(
      activeCoordinator,
      'reply_dispatched',
      8000,
      'PrivateSession Agent 闭环'
    );
    emitDriverMessage(activeDriver, {
      id: 'verify_private_message',
      messageId: 'verify_private_message',
      sessionId: targetSessionId,
      sessionName: '验证员工',
      time: new Date().toISOString(),
      sessionType: 'private',
      sender: '验证员工',
      senderId: 'emp_verify_001',
      content: '请介绍当前助手能力',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now(),
    } satisfies KK9Message);
    const [, privateResult] = await privateReply;
    if (!privateResult.success || privateResult.action !== 'message_sent') {
      throw new Error(`PrivateSession 闭环失败: ${privateResult.error ?? privateResult.action}`);
    }

    const deliveries = await kkbotStore.deliveries.getDeliveriesBySession(targetSessionId);
    if (deliveries.length !== 1 || deliveries[0]?.status !== 'sent') {
      throw new Error('PrivateSession 未形成唯一 sent Delivery');
    }
    const memoryResult = await memory.recall({
      threadId: targetSessionId,
      resourceId: 'emp_verify_001',
    });
    if (memoryResult.messages.length !== 2) {
      throw new Error('PrivateSession Memory 未保留一条 user 与一条 sent assistant 消息');
    }

    const modelCallsBeforeGroup = model.callCount;
    const groupSessionId = `${targetSessionId}_group`;
    const groupSaved = waitForEvent<[string, unknown, KK9Message]>(
      activeCoordinator,
      'group_message_saved',
      8000,
      'GroupSession Raw Store-only 短路'
    );
    emitDriverMessage(activeDriver, {
      id: 'verify_group_message',
      messageId: 'verify_group_message',
      sessionId: groupSessionId,
      sessionName: '验证群聊',
      time: new Date().toISOString(),
      sessionType: 'group',
      sender: '群成员',
      senderId: 'emp_group_001',
      content: '@机器人 请查询群内信息',
      messageType: 'text',
      atMe: true,
      isMe: false,
      timestamp: Date.now(),
    } satisfies KK9Message);
    await groupSaved;
    if (model.callCount !== modelCallsBeforeGroup) {
      throw new Error('GroupSession 错误进入 Mastra Agent');
    }
    if ((await kkbotStore.deliveries.getDeliveriesBySession(groupSessionId)).length !== 0) {
      throw new Error('GroupSession 错误创建 Delivery');
    }

    const highRiskReply = waitForEvent<[string, CoordinatorDispatchResult]>(
      activeCoordinator,
      'reply_dispatched',
      8000,
      '高风险意图无副作用建议'
    );
    emitDriverMessage(activeDriver, {
      id: 'verify_high_risk_message',
      messageId: 'verify_high_risk_message',
      sessionId: targetSessionId,
      sessionName: '验证员工',
      time: new Date().toISOString(),
      sessionType: 'private',
      sender: '验证员工',
      senderId: 'emp_verify_001',
      content: '请删除员工账号并修改全员权限',
      messageType: 'text',
      isMe: false,
      timestamp: Date.now() + 1,
    } satisfies KK9Message);
    const [, highRiskResult] = await highRiskReply;
    if (!highRiskResult.success || highRiskResult.action !== 'message_sent') {
      throw new Error(
        `高风险意图普通 assistant 回复失败: ${highRiskResult.error ?? highRiskResult.action}`
      );
    }

    process.stdout.write(
      'Mastra-native Agent E2E 仿真验证通过：PrivateSession、GroupSession 与高风险无副作用合同。\n'
    );
  } catch (error) {
    verificationError = error;
    throw error;
  } finally {
    const cleanupErrors: Error[] = [];
    const cleanup = async (
      resourceId: string,
      action: () => Promise<void> | void
    ): Promise<void> => {
      try {
        await action();
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        cleanupErrors.push(new Error(`${resourceId} 清理失败: ${cause.message}`, { cause }));
      }
    };

    await cleanup('Coordinator', () => coordinator?.stop());
    await cleanup('Memory', () => mastraMemory?.settled());
    await cleanup('MastraStorage', () => mastraStorage?.close());
    await cleanup('KKBotStore', () => store?.close());
    await cleanup('Driver', () => driver?.disconnect());
    try {
      await removeTemporaryDatabase(dbPath);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      cleanupErrors.push(new Error(`临时验证数据库清理失败: ${cause.message}`, { cause }));
    }

    if (cleanupErrors.length > 0) {
      const causes =
        verificationError === undefined ? cleanupErrors : [verificationError, ...cleanupErrors];
      throw new AggregateError(causes, 'E2E 验证资源清理失败');
    }
  }
}

runAgentE2eVerification().catch(error => {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    error instanceof AggregateError
      ? `；明细: ${error.errors.map(item => (item instanceof Error ? item.message : String(item))).join(' | ')}`
      : '';
  process.stderr.write(`Mastra-native Agent E2E 验证失败: ${message}${details}\n`);
  process.exitCode = 1;
});
