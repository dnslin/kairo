import { getConfig } from './config/index.js';
import { CdpConnector } from './cdp/index.js';
import { DomLocator } from './dom/index.js';
import { MessageExtractor } from './extract/index.js';
import { MessageWatcher } from './watch/index.js';
import { PolicyEngine } from './policy/index.js';
import { LlmClient } from './llm/index.js';
import { Sender } from './send/index.js';
import { Store } from './store/index.js';
import { OpsServer } from './ops/index.js';
import type { Message } from './extract/index.js';
import type { MessageInfo } from './dom/index.js';
import { createChildLogger } from './utils/logger.js';

const log = createChildLogger('main');

/** 全局暂停状态 */
let paused = false;

async function main(): Promise<void> {
  log.info('KKBot 启动中...');

  // 1. 加载配置
  const config = getConfig();

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

    // 标记已处理
    store.markProcessed(msg.fingerprint);

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

    // 保存接收到的消息
    store.saveMessage(
      msg.sessionId,
      {
        sender: msg.sender,
        content: msg.content,
        isFromSelf: false,
      },
      currentSession.name
    );

    // 获取会话历史用于 LLM 上下文
    const history = store.getSessionHistory(msg.sessionId, config.llm.contextMessages);
    const historyAsMessageInfo: MessageInfo[] = history.map(h => ({
      id: '',
      sender: h.sender,
      content: h.content,
      time: '',
      isMe: h.isFromSelf,
    }));

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
      reply = await llmClient.generateReply(currentMsgInfo, historyAsMessageInfo);
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
    if (config.mode === 'draft_only') {
      // 草稿模式：保存草稿等待人工确认
      const draftId = store.saveDraft({
        sessionId: msg.sessionId,
        sessionName: currentSession.name,
        originalMessage: msg.content,
        originalSender: msg.sender,
        draftContent: reply,
      });
      store.logEvent('draft_created', {
        draftId,
        sessionId: msg.sessionId,
        sessionName: currentSession.name,
      });
      log.info(
        { draftId, sessionId: msg.sessionId, sessionName: currentSession.name },
        '草稿已生成，等待确认'
      );
    } else {
      // 自动发送模式
      const result = await sender.send(reply);
      if (result.success) {
        store.saveMessage(
          msg.sessionId,
          {
            sender: '自己',
            content: reply,
            isFromSelf: true,
          },
          currentSession.name
        );
        store.logEvent('message_sent', {
          sessionId: msg.sessionId,
          sessionName: currentSession.name,
        });
        log.info({ sessionId: msg.sessionId }, '消息已自动发送');
      } else {
        store.logEvent('send_failed', {
          sessionId: msg.sessionId,
          error: result.error,
        });
        log.error({ sessionId: msg.sessionId, error: result.error }, '自动发送失败');
      }
    }
  };

  // 11. 初始化 Web 控制台
  const opsServer = new OpsServer(config.ops, {
    store,
    connector,
    sender,
    locator,
    mode: config.mode,
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
  });

  // 优雅关闭
  const shutdown = async (): Promise<void> => {
    log.info('正在关闭...');
    watcher.stop();
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
      { mode: config.mode, port: config.ops.port },
      'KKBot 已启动，运行模式: ' + config.mode
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
