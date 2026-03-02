import { getConfig, watchConfig } from './config/index.js';
import type { OperationMode } from './config/index.js';
import { resolve } from 'node:path';
import { CdpConnector } from './cdp/index.js';
import { DomLocator } from './dom/index.js';
import { MessageExtractor } from './extract/index.js';
import { MessageWatcher } from './watch/index.js';
import { PolicyEngine, checkThrottle } from './policy/index.js';
import { LlmClient } from './llm/index.js';
import { Sender } from './send/index.js';
import { Store } from './store/index.js';
import { OpsServer } from './ops/index.js';
import { dispatchReply } from './dispatch/index.js';
import type { Message } from './extract/index.js';
import type { MessageInfo } from './dom/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('main');

/**
 * 尝试异步生成会话摘要（失败只记录日志，不影响主流程）
 */
async function tryGenerateSummary(
  sessionId: string,
  store: Store,
  llmClient: LlmClient,
  summaryIntervalMessages: number
): Promise<void> {
  // 同一会话已有摘要生成任务在执行，跳过避免竞态
  if (summaryInProgress.has(sessionId)) {
    return;
  }
  summaryInProgress.add(sessionId);
  try {
    if (summaryIntervalMessages <= 0) {
      return;
    }

    const latestSummary = store.getLatestSummary(sessionId);
    const lastCoveredId = latestSummary?.coveredUpToId ?? 0;
    const newMessageCount = store.getMessageCountSince(sessionId, lastCoveredId);
    if (newMessageCount < summaryIntervalMessages) {
      return;
    }

    const history = store.getSessionHistory(sessionId, newMessageCount);
    if (history.length === 0) {
      return;
    }

    const historyAsMessageInfo: MessageInfo[] = history.map(h => ({
      id: '',
      sender: h.sender,
      content: h.content,
      time: '',
      isMe: h.isFromSelf,
    }));

    const summary = await llmClient.generateSummary(historyAsMessageInfo, latestSummary?.summaryText);
    if (!summary) {
      log.debug({ sessionId }, '会话摘要为空，跳过保存');
      return;
    }

    const coveredUpToId = store.getMaxMessageId(sessionId);
    const estimatedTokenCount = Math.ceil(summary.length / 4);
    const summaryId = store.saveSummary(sessionId, summary, coveredUpToId, estimatedTokenCount);
    log.info({ sessionId, summaryId, coveredUpToId }, '会话摘要已更新');
  } catch (error) {
    log.warn({ err: error, sessionId }, '会话摘要生成失败，已忽略');
  } finally {
    summaryInProgress.delete(sessionId);
  }
}

/** 全局暂停状态 */
let paused = false;

/** 正在生成摘要的会话集合，防止同一会话并发生成 */
const summaryInProgress = new Set<string>();

async function main(): Promise<void> {
  log.info('KKBot 启动中...');

  // 1. 加载配置
  const config = getConfig();
  let currentMode: OperationMode = config.mode;

  // 2. 初始化数据存储
  const store = new Store(config.store);
  store.logEvent('system_start');

  // 3. 初始化 CDP 连接器
  const connector = new CdpConnector(config.cdp, config.page);

  connector.on('connected', () => {
    log.info('CDP 连接已建立');
    store.logEvent('cdp_connected');
  });

  connector.on('disconnected', reason => {
    log.warn({ reason }, 'CDP 连接断开');
    store.logEvent('cdp_disconnected', { reason });
  });

  connector.on('heartbeat', uptimeMs => {
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    log.debug({ uptimeMin, uptimeSec: uptimeSec % 60 }, '连接心跳');
  });

  connector.on('error', error => {
    log.error({ err: error }, 'CDP 连接错误');
    store.logEvent('cdp_error', { message: error.message });
  });

  // 4. 初始化 DOM 定位器
  const locator = new DomLocator(connector, config.selectors);

  // 5. 初始化消息提取器
  const extractor = new MessageExtractor(locator);

  // 6. 初始化策略引擎
  const policy = new PolicyEngine(config.policy);

  // 7. 初始化 LLM 客户端
  const llmClient = new LlmClient(config.llm, config.validation);

  // 8. 初始化发送器
  const sender = new Sender(locator, config.sender);

  // 9. 初始化消息监听器
  const watcher = new MessageWatcher(extractor, config.watcher);

  // 10. 消息处理回调
  const processMessage = async (msg: Message): Promise<void> => {
    if (paused) {
      log.debug({ fingerprint: msg.fingerprint }, '系统已暂停，跳过消息');
      return;
    }

    // 检查是否已处理（持久化去重）
    if (store.isProcessed(msg.fingerprint)) {
      return;
    }

    // 获取当前会话信息用于策略检查
    const currentSession = await locator.getCurrentSession();
    if (!currentSession) {
      log.debug('无当前会话，跳过');
      return;
    }

    // 策略检查
    const decision = policy.shouldProcess(currentSession);
    if (!decision.allowed) {
      log.debug({ sessionId: msg.sessionId, reason: decision.reason }, '策略拒绝处理');
      store.logEvent('policy_rejected', {
        sessionId: msg.sessionId,
        reason: decision.reason,
      });
      return;
    }

    // 节流检查（在 markProcessed 之前，被节流的消息下次轮询可重新处理）
    const throttleResult = checkThrottle(msg.sessionId, store, config.policy.throttle);
    if (!throttleResult.allowed) {
      log.debug({ sessionId: msg.sessionId, reason: throttleResult.reason, detail: throttleResult.detail }, '节流拒绝处理');
      store.logEvent('throttle_rejected', {
        sessionId: msg.sessionId,
        reason: throttleResult.reason,
        detail: throttleResult.detail,
      });
      return;
    }

    // 所有前置检查通过后再标记已处理，避免检查失败时消息被静默丢弃
    store.markProcessed(msg.fingerprint);

    // 先读取历史，再保存当前消息，避免当前消息在 LLM 上下文中重复出现
    const history = store.getSessionHistory(msg.sessionId, config.llm.contextMessages);
    const latestSummary = store.getLatestSummary(msg.sessionId);
    const summaryContext = latestSummary?.summaryText;
    const historyAsMessageInfo: MessageInfo[] = history.map(h => ({
      id: '',
      sender: h.sender,
      content: h.content,
      time: '',
      isMe: h.isFromSelf,
    }));

    // 保存接收到的消息（在读取历史之后）
    store.saveMessage(
      msg.sessionId,
      {
        sender: msg.sender,
        content: msg.content,
        isFromSelf: false,
      },
      currentSession.name
    );

    // 将当前消息转为 MessageInfo 格式
    const currentMsgInfo: MessageInfo = {
      id: '',
      sender: msg.sender,
      content: msg.content,
      time: msg.time,
      isMe: false,
    };

    // 调用 LLM 生成回复
    let reply: string | null = null;
    try {
      reply = await llmClient.generateReply(currentMsgInfo, historyAsMessageInfo, summaryContext);
      store.logEvent('llm_call', {
        sessionId: msg.sessionId,
        hasReply: reply !== null,
      });
    } catch (error) {
      log.error({ err: error, sessionId: msg.sessionId }, 'LLM 调用失败');
      store.logEvent('llm_error', {
        sessionId: msg.sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    if (!reply) {
      log.debug({ sessionId: msg.sessionId }, 'LLM 未生成回复');
      return;
    }

    // 根据运行模式处理回复
    const dispatchResult = await dispatchReply(
      { store, sender },
      {
        mode: currentMode,
        reply,
        sessionId: msg.sessionId,
        sessionName: currentSession.name,
        originalMessage: msg.content,
        originalSender: msg.sender,
      }
    );

    if (dispatchResult.action !== 'send_failed') {
      // 更新节流计数
      store.incrementDailyReplyCount(msg.sessionId);

      if (config.store.storeMessageContent && config.llm.summaryIntervalMessages > 0) {
        void tryGenerateSummary(
          msg.sessionId,
          store,
          llmClient,
          config.llm.summaryIntervalMessages
        );
      }
    }
  };

  // 11. 初始化 Web 控制台
  const opsCtx = {
    store,
    connector,
    sender,
    locator,
    mode: currentMode,
    isPaused: (): boolean => paused,
    setPaused: (value: boolean): void => {
      paused = value;
      log.info({ paused: value }, value ? '系统已暂停' : '系统已恢复');
    },
    isWithinWorkingHours: (): boolean => {
      // 复用策略引擎的工作时间检查逻辑
      // 通过一个虚拟会话来检查（白名单会话始终通过，用非白名单名称）
      const testDecision = policy.shouldProcess({
        id: '__test__',
        name: '__working_hours_check__',
        type: 'private',
        lastMessage: '',
        time: '',
        unread: false,
        isSelected: false,
      });
      // 如果被拒绝且原因是工作时间，说明不在工作时间内
      return testDecision.reason !== 'outside_working_hours';
    },
  };
  const opsServer = new OpsServer(config.ops, opsCtx);

  // 12. 启动配置热重载（mode + selectors）
  const configPath = resolve(process.cwd(), 'config.yaml');
  const stopConfigWatch = watchConfig(configPath, currentMode, {
    onModeChange: (newMode: OperationMode) => {
      currentMode = newMode;
      opsCtx.mode = newMode;
      log.info({ mode: newMode }, '运行模式已热重载');
      store.logEvent('mode_changed', { mode: newMode });
    },
    onSelectorsChange: (selectors) => {
      locator.updateSelectors(selectors);
    },
  });

  // 优雅关闭
  const shutdown = async (): Promise<void> => {
    log.info('正在关闭...');
    watcher.stop();
    stopConfigWatch();
    await opsServer.stop();
    connector.disconnect();
    store.logEvent('system_stop');
    store.close();
    process.exit(0);
  };

  try {
    // 连接 CDP
    const { pageUrl } = await connector.connect();
    log.info({ url: pageUrl }, '已连接到渲染页面');

    // 启动 Web 控制台
    await opsServer.start();

    // 启动消息监听
    watcher.start((msg: Message) => {
      void processMessage(msg);
    });
    log.info('消息监听已启动');

    // 注册关闭信号
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    log.info(
      { mode: currentMode, port: config.ops.port },
      'KKBot 已启动，运行模式: ' + currentMode
    );
  } catch (error) {
    log.error({ err: error }, 'KKBot 启动失败');
    store.logEvent('system_error', {
      error: error instanceof Error ? error.message : String(error),
    });
    store.close();
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('未捕获的错误:', err);
  process.exit(1);
});
