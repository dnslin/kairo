import { setTimeout as sleep } from 'node:timers/promises';
import { InMemorySendOperationStore, KK9Driver, SendError } from '../src/index.js';
import type { KK9EventBridge } from '../src/bridge/event-bridge.js';
import type { CdpClient } from '../src/cdp/client.js';
import type {
  DriverConfig,
  KK9Employee,
  KK9Message,
  KK9Session,
  SendOptions,
  SendResult,
} from '../src/types/index.js';

const INBOUND_TIMEOUT_MS = 120_000;
const OBSERVATION_TIMEOUT_MS = 15_000;

interface TestConfig {
  driver: DriverConfig;
  botUid: string;
  employeeUid: string;
  sessionId: string;
  sessionName: string;
}

interface StepResult {
  name: string;
  ok: boolean;
  error?: string;
}

interface RecallTarget {
  label: string;
  messageId: string;
  sessionId: string;
}

interface ObservedMessage {
  driverName: string;
  sequence: number;
  message: KK9Message;
}

interface ManagedDriver {
  name: string;
  driver: KK9Driver;
  authorized: boolean;
}
interface PendingSend {
  label: string;
  sessionId: string;
  marker: string;
  operationId?: string;
}

interface DriverInternals {
  cdp: CdpClient;
  eventBridge: KK9EventBridge;
}

const steps: StepResult[] = [];
const recallTargets = new Map<string, RecallTarget>();
const recalledKeys = new Set<string>();
const eventMessages: ObservedMessage[] = [];
const pendingSends = new Map<string, PendingSend>();
let observationSequence = 0;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function requiredStep<T>(name: string, run: () => Promise<T> | T): Promise<T> {
  try {
    const value = await run();
    steps.push({ name, ok: true });
    console.log(`通过 ${name}`);
    return value;
  } catch (error) {
    const message = errorText(error);
    steps.push({ name, ok: false, error: message });
    console.error(`失败 ${name}: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

async function cleanupStep(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    steps.push({ name, ok: true });
    console.log(`通过 ${name}`);
  } catch (error) {
    const message = errorText(error);
    steps.push({ name, ok: false, error: message });
    console.error(`失败 ${name}: ${message}`);
  }
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`必须设置 ${name}`);
  return value;
}

function readTestConfig(): TestConfig {
  const botUid = requiredEnv('KK9_STAGE1_BOT_UID');
  const employeeUid = requiredEnv('KK9_STAGE1_EMPLOYEE_UID');
  const sessionId = requiredEnv('KK9_STAGE1_SESSION_ID');
  const sessionName = requiredEnv('KK9_STAGE1_SESSION_NAME');
  const expectedSessionId = `0-${employeeUid}`;
  if (sessionId !== expectedSessionId) {
    throw new Error(`KK9_STAGE1_SESSION_ID 必须等于 ${expectedSessionId}`);
  }

  const expectedConfirmation = `${botUid}:${employeeUid}:${sessionId}`;
  const confirmation = process.env['KK9_STAGE1_CONFIRM'];
  if (confirmation !== expectedConfirmation) {
    throw new Error(
      `必须设置 KK9_STAGE1_CONFIRM=${expectedConfirmation}，当前=${confirmation || '<未设置>'}`
    );
  }

  const cdpUrl = process.env['CDP_URL']?.trim() || 'http://127.0.0.1:9222';
  let parsedCdpUrl: URL;
  try {
    parsedCdpUrl = new URL(cdpUrl);
  } catch (error) {
    throw new Error(`CDP_URL 无效: ${errorText(error)}`);
  }
  if (parsedCdpUrl.hostname !== '127.0.0.1') {
    throw new Error(`CDP_URL 必须绑定 127.0.0.1，当前=${parsedCdpUrl.hostname}`);
  }

  return {
    botUid,
    employeeUid,
    sessionId,
    sessionName,
    driver: {
      currentUserId: botUid,
      cdp: {
        url: cdpUrl,
        pageMatch: process.env['PAGE_MATCH']?.trim() || 'renderer.html',
      },
    },
  };
}

function getCdp(driver: KK9Driver): CdpClient {
  const driverInternals = driver as unknown as DriverInternals;
  return driverInternals.cdp;
}

function getEventBridge(driver: KK9Driver): KK9EventBridge {
  const driverInternals = driver as unknown as DriverInternals;
  return driverInternals.eventBridge;
}

function createManagedDriver(
  name: string,
  config: TestConfig,
  store: InMemorySendOperationStore
): ManagedDriver {
  const managed: ManagedDriver = {
    name,
    driver: new KK9Driver(config.driver, store),
    authorized: false,
  };
  getEventBridge(managed.driver).on('message', message => {
    eventMessages.push({
      driverName: name,
      sequence: ++observationSequence,
      message,
    });
  });
  managed.driver.on('health', event => {
    console.error(`健康 ${name} ${event.kind}`);
  });
  managed.driver.on('error', error => {
    console.error(`错误 ${name} ${errorText(error)}`);
  });
  return managed;
}

function messageId(message: KK9Message): string {
  return (message.messageId || message.id).trim();
}

function messageKey(message: KK9Message): string {
  return `${message.sessionId.trim()}:${messageId(message)}`;
}

function isPositiveNativeId(value: string | undefined): value is string {
  if (!value) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function rememberRecall(label: string, id: string | undefined, sessionId: string): void {
  if (!isPositiveNativeId(id)) return;
  const key = `${sessionId}:${id}`;
  if (!recallTargets.has(key)) {
    recallTargets.set(key, { label, messageId: id, sessionId });
  }
}

async function pollMessages(
  managed: ManagedDriver,
  session: KK9Session,
  limit = 100
): Promise<KK9Message[]> {
  const messages = await managed.driver.getRecentMessages(limit, session);
  return messages;
}

function rememberTestMessageById(
  messages: KK9Message[],
  sessionId: string,
  expectedMessageId: string,
  marker: string,
  label: string
): boolean {
  const matched = messages.find(
    message =>
      message.sessionId === sessionId &&
      messageId(message) === expectedMessageId &&
      message.content.includes(marker)
  );
  if (!matched) return false;
  rememberRecall(label, messageId(matched), sessionId);
  return true;
}

function rememberTestMarkerMessages(
  messages: KK9Message[],
  sessionId: string,
  marker: string,
  label: string
): void {
  for (const message of messages) {
    if (message.sessionId === sessionId && message.content.includes(marker)) {
      rememberRecall(label, messageId(message), sessionId);
    }
  }
}

async function rememberTestSendResult(
  managed: ManagedDriver,
  session: KK9Session,
  label: string,
  text: string,
  result: SendResult
): Promise<void> {
  if (managed.driver.getStatus() === 'disconnected') return;
  try {
    const messages = await pollMessages(managed, session);
    if (isPositiveNativeId(result.messageId)) {
      rememberTestMessageById(messages, session.id, result.messageId, text, label);
    } else {
      rememberTestMarkerMessages(messages, session.id, text, `${label}（回查）`);
    }
  } catch (error) {
    console.error(`警告 ${label} 回查失败: ${errorText(error)}`);
  }
}

function rememberPendingSend(
  sessionId: string,
  label: string,
  text: string,
  options: SendOptions
): void {
  const operationId = options.operationId?.trim();
  const key = `${sessionId}:${operationId || ''}:${text}`;
  pendingSends.set(key, { label, sessionId, marker: text, operationId });
}

async function sendTextAndTrack(
  managed: ManagedDriver,
  session: KK9Session,
  label: string,
  text: string,
  options: SendOptions
): Promise<SendResult> {
  rememberPendingSend(session.id, label, text, options);
  try {
    const result = await managed.driver.sendText(text, options);
    await rememberTestSendResult(managed, session, label, text, result);
    return result;
  } catch (error) {
    if (managed.driver.getStatus() !== 'disconnected') {
      try {
        const messages = await pollMessages(managed, session);
        rememberTestMarkerMessages(messages, session.id, text, `${label}（异常回查）`);
      } catch (lookupError) {
        console.error(`警告 ${label} 异常回查失败: ${errorText(lookupError)}`);
      }
    }
    throw error;
  }
}

function messageMetadata(message: KK9Message): Record<string, unknown> {
  return {
    messageId: messageId(message),
    sessionId: message.sessionId,
    direction: message.direction,
    origin: message.origin,
    senderId: message.senderId,
  };
}

const DIRECTION_EVIDENCE_KEYS = [
  'isFromSelf',
  'fromMe',
  'isMe',
  'origin',
  'source',
  'senderId',
  'senderID',
  'fromUID',
  'sender',
  'senderName',
  'sendName',
  'fromUserName',
] as const;

function rawRecords(message: KK9Message): Record<string, unknown>[] {
  const raw = message.raw || {};
  const nestedRawValue = raw['raw'];
  if (
    nestedRawValue !== null &&
    typeof nestedRawValue === 'object' &&
    !Array.isArray(nestedRawValue)
  ) {
    const nestedRaw = nestedRawValue as Record<string, unknown>;
    return [raw, nestedRaw];
  }
  return [raw];
}

function hasMeaningfulRawValue(raw: Record<string, unknown>, key: string): boolean {
  const value = raw[key];
  return value !== undefined && value !== null && value !== '';
}

function hasDirectionEvidence(message: KK9Message): boolean {
  if (message.senderId) return true;
  return rawRecords(message).some(raw =>
    DIRECTION_EVIDENCE_KEYS.some(key => hasMeaningfulRawValue(raw, key))
  );
}

function hasSystemEvidence(message: KK9Message): boolean {
  if (message.messageType === 'system' || message.origin === 'system') return true;
  return rawRecords(message).some(
    raw =>
      raw['isSystem'] === true ||
      raw['system'] === true ||
      raw['systemMsg'] === true ||
      raw['sysType'] !== undefined ||
      raw['type'] === 'system' ||
      raw['messageType'] === 'system' ||
      raw['origin'] === 'system' ||
      raw['source'] === 'system' ||
      raw['msgType'] === 99 ||
      raw['contentType'] === 99
  );
}

function createControlledUnknownSample(
  managed: ManagedDriver,
  config: TestConfig,
  source: KK9Message
): KK9Message {
  const raw: Record<string, unknown> = {
    ...(source.raw || {}),
    id: messageId(source),
    sessionId: config.sessionId,
    content: source.content,
    contentType: 1,
    type: 0,
  };
  for (const key of [
    ...DIRECTION_EVIDENCE_KEYS,
    'isSystem',
    'system',
    'systemMsg',
    'sysType',
    'messageType',
    'msgType',
    'raw',
    'event',
    'msgFlag',
  ]) {
    delete raw[key];
  }
  const samples = getEventBridge(managed.driver).parseRawMessage(raw, {
    id: config.sessionId,
    name: config.sessionName,
    type: 'private',
  });
  ensure(samples.length === 1, '受控证据不足样本未能标准化');
  const sample = samples[0]!;
  ensure(sample.messageType !== 'system', '受控 unknown 样本不得是 system 消息');
  ensure(sample.origin === 'unknown', '受控证据不足样本 origin 不是 unknown');
  ensure(sample.direction === 'unknown', '受控证据不足样本 direction 不是 unknown');
  ensure(!hasDirectionEvidence(sample), '受控样本仍包含 self/source/sender 身份证据');
  ensure(!hasSystemEvidence(sample), '受控样本仍包含 system 身份证据');
  return sample;
}

function isExpectedInbound(message: KK9Message, config: TestConfig): boolean {
  if (message.sessionId !== config.sessionId || message.direction !== 'inbound' || message.isMe) {
    return false;
  }
  return !message.senderId || message.senderId === config.employeeUid;
}

async function waitForExpectedInbound(
  managed: ManagedDriver,
  config: TestConfig,
  session: KK9Session,
  baselineKeys: Set<string>
): Promise<ObservedMessage> {
  console.log(
    `操作 请目标员工在会话 ${config.sessionId} 发送一条真实消息，等待 ${INBOUND_TIMEOUT_MS}ms`
  );
  const deadline = Date.now() + INBOUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const eventMatch = eventMessages.find(
      observed =>
        observed.driverName === managed.name &&
        !baselineKeys.has(messageKey(observed.message)) &&
        isExpectedInbound(observed.message, config)
    );
    if (eventMatch) return eventMatch;

    const messages = await pollMessages(managed, session);
    const pollingMatch = messages.find(
      message => !baselineKeys.has(messageKey(message)) && isExpectedInbound(message, config)
    );
    if (pollingMatch) {
      return { driverName: managed.name, sequence: ++observationSequence, message: pollingMatch };
    }
    await sleep(500);
  }
  throw new Error('未在限定时间内观察到目标员工的真实 inbound 消息');
}

async function waitForEventMessage(
  driverName: string,
  predicate: (message: KK9Message) => boolean,
  timeoutMs = OBSERVATION_TIMEOUT_MS
): Promise<ObservedMessage> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = eventMessages.find(
      observed => observed.driverName === driverName && predicate(observed.message)
    );
    if (match) return match;
    await sleep(200);
  }
  throw new Error('未观察到预期的实时消息回显');
}

async function readLoggedInUid(cdp: CdpClient): Promise<string> {
  const value = await cdp.evaluate<string>(`
    (() => {
      const main = document.querySelector('.main-page')?.__vue__;
      const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
      return String(main?.userID || editor?.userID || '');
    })()
  `);
  return String(value || '').trim();
}

async function assertExactTarget(managed: ManagedDriver, config: TestConfig): Promise<KK9Session> {
  const actualUserId = await readLoggedInUid(getCdp(managed.driver));
  ensure(
    actualUserId === config.botUid,
    `登录 Bot UID 不匹配: expected=${config.botUid}, actual=${actualUserId}`
  );

  const sessions = await managed.driver.getSessions();
  const matches = sessions.filter(
    session =>
      session.id === config.sessionId &&
      session.name === config.sessionName &&
      session.type === 'private'
  );
  ensure(matches.length === 1, `目标会话必须精确唯一，匹配数量=${matches.length}`);
  return matches[0]!;
}

async function assertEmployeeBySessionId(
  managed: ManagedDriver,
  config: TestConfig,
  sessionId: string
): Promise<KK9Employee> {
  const employee = await managed.driver.getEmployeeBySession(sessionId);
  ensure(employee !== null, 'getEmployeeBySession 未返回员工档案');
  ensure(String(employee.id) === config.employeeUid, '员工 UID 与 sessionId 后缀不一致');
  ensure(sessionId === `0-${String(employee.id)}`, 'sessionId 不是 0-<uid> 格式');
  return employee;
}

async function recoverPendingSendTargets(
  managed: ManagedDriver,
  config: TestConfig,
  session: KK9Session
): Promise<void> {
  const pending = [...pendingSends.values()].filter(
    send => send.sessionId === config.sessionId && send.sessionId === session.id
  );
  if (pending.length === 0) return;

  const messages = await pollMessages(managed, session);
  for (const send of pending) {
    let expectedMessageId: string | undefined;
    if (send.operationId) {
      try {
        const result = await managed.driver.getSendStatus(send.operationId);
        if (isPositiveNativeId(result.messageId)) expectedMessageId = result.messageId;
      } catch (error) {
        console.error(`警告 ${send.label} operation 回查失败: ${errorText(error)}`);
      }
    }
    if (expectedMessageId) {
      rememberTestMessageById(
        messages,
        send.sessionId,
        expectedMessageId,
        send.marker,
        `${send.label}（清理回查）`
      );
    }
    rememberTestMarkerMessages(messages, send.sessionId, send.marker, `${send.label}（清理回查）`);
  }
}

function countContentMatches(messages: KK9Message[], marker: string): number {
  return messages.filter(message => message.content.includes(marker)).length;
}

function assertNoNewOutboundMessages(
  before: KK9Message[],
  after: KK9Message[],
  sessionId: string
): void {
  const beforeKeys = new Set(
    before
      .filter(message => message.sessionId === sessionId && message.direction === 'outbound')
      .map(messageKey)
  );
  const newOutbound = after.filter(
    message =>
      message.sessionId === sessionId &&
      message.direction === 'outbound' &&
      !beforeKeys.has(messageKey(message))
  );
  ensure(
    newOutbound.length === 0,
    `检测到未预期的 outbound 消息: ${newOutbound.map(messageKey).join(',')}`
  );
}

function assertDelivered(label: string, result: SendResult): string {
  ensure(result.success, `${label} 未成功`);
  ensure(result.status === 'delivered', `${label} 状态不是 delivered`);
  ensure(isPositiveNativeId(result.messageId), `${label} 未返回正 native messageId`);
  return result.messageId;
}

async function main(): Promise<void> {
  const sendStore = new InMemorySendOperationStore();
  const managedDrivers: ManagedDriver[] = [];
  let config: TestConfig | undefined;
  let fatalError: Error | undefined;

  const createManaged = (name: string): ManagedDriver => {
    ensure(config, '测试配置尚未初始化');
    const managed = createManagedDriver(name, config, sendStore);
    managedDrivers.push(managed);
    return managed;
  };

  try {
    config = await requiredStep('确认 T09 真实测试授权', readTestConfig);
    const primary = createManaged('primary');

    await requiredStep('连接真实 KK9 EventBridge', async () => {
      await primary.driver.connect();
    });

    const targetSession = await requiredStep('核对登录 Bot 与唯一目标会话', () =>
      assertExactTarget(primary, config!)
    );
    ensure(targetSession.id === config.sessionId, '目标会话 ID 与授权值不一致');

    const baselineMessages = await requiredStep('建立员工入站消息基线', () =>
      pollMessages(primary, targetSession)
    );
    const baselineKeys = new Set(baselineMessages.map(messageKey));

    ensure(
      await primary.driver.selectSession(config.sessionId),
      `无法切换到目标会话 ${config.sessionId}`
    );
    primary.driver.startPolling({
      autoSwitchSession: false,
      intervalMs: 500,
      switchDelayMs: 0,
      maxSessionsPerCycle: 1,
      maxMessagesPerSession: 100,
    });

    const inboundObservation = await requiredStep('观察真实员工 inbound 消息', () =>
      waitForExpectedInbound(primary, config!, targetSession, baselineKeys)
    );
    const inbound = inboundObservation.message;
    await requiredStep('核对入站消息员工档案与 sessionId', async () => {
      ensure(inbound.sessionId === config!.sessionId, '入站消息 sessionId 不匹配');
      ensure(inbound.direction === 'inbound', '真实员工消息未分类为 inbound');
      await assertEmployeeBySessionId(primary, config!, inbound.sessionId);
      console.log(`入站 ${JSON.stringify(messageMetadata(inbound))}`);
      primary.authorized = true;
    });

    await requiredStep('确认证据不足样本为 unknown', async () => {
      const messages = await pollMessages(primary, targetSession);
      const realUnknown = [
        ...eventMessages
          .filter(observed => observed.driverName === primary.name)
          .map(observed => observed.message),
        ...messages,
      ].find(
        message =>
          message.sessionId === config!.sessionId &&
          message.direction === 'unknown' &&
          !hasSystemEvidence(message) &&
          !hasDirectionEvidence(message)
      );
      if (realUnknown) {
        console.log(
          `未知方向 ${JSON.stringify({ source: 'real', ...messageMetadata(realUnknown) })}`
        );
        return;
      }
      const controlledUnknown = createControlledUnknownSample(primary, config!, inbound);
      console.log(
        `未知方向 ${JSON.stringify({ source: 'controlled-real-payload-shape', ...messageMetadata(controlledUnknown) })}`
      );
    });

    const deliveredText = `T09-${new Date().toISOString()}-delivered`;
    const deliveredOperationId = `t09-delivered-${Date.now()}`;
    const deliveredResult = await requiredStep('发送真实 Bot 文本并取得 delivered', () =>
      sendTextAndTrack(primary, targetSession, '真实 delivered Bot 文本', deliveredText, {
        targetSessionId: config!.sessionId,
        operationId: deliveredOperationId,
      })
    );
    const deliveredMessageId = assertDelivered('Bot 文本发送', deliveredResult);

    const deliveredEcho = await requiredStep('确认 Bot echo 为 outbound 且晚于员工入站', () =>
      waitForEventMessage(
        primary.name,
        message =>
          message.sessionId === config!.sessionId &&
          messageId(message) === deliveredMessageId &&
          message.content.includes(deliveredText)
      )
    );
    ensure(deliveredEcho.message.direction === 'outbound', 'Bot echo 未分类为 outbound');
    ensure(
      deliveredEcho.sequence > inboundObservation.sequence,
      'Bot echo 观察顺序早于员工 inbound 消息'
    );
    console.log(`出站 ${JSON.stringify(messageMetadata(deliveredEcho.message))}`);

    await requiredStep('确认 EventBridge 与轮询可用同一消息键去重', async () => {
      const messages = await pollMessages(primary, targetSession);
      const pollingEcho = messages.find(
        message => messageKey(message) === messageKey(deliveredEcho.message)
      );
      ensure(pollingEcho, '轮询未观察到与 EventBridge 相同的消息键');
      ensure(
        messageKey(pollingEcho) === `${config!.sessionId}:${deliveredMessageId}`,
        '业务消息键不是 (sessionId,messageId)'
      );
    });

    await requiredStep('确认 getSendStatus 只读且不发送', async () => {
      const before = await pollMessages(primary, targetSession);
      const status = await primary.driver.getSendStatus(deliveredOperationId);
      const after = await pollMessages(primary, targetSession);
      rememberTestMarkerMessages(
        after,
        config!.sessionId,
        deliveredText,
        'getSendStatus 异常 Bot 文本'
      );
      assertNoNewOutboundMessages(before, after, config!.sessionId);
      ensure(status.status === 'delivered', 'getSendStatus 未返回 delivered');
      ensure(status.messageId === deliveredMessageId, 'getSendStatus 返回的 messageId 不一致');
    });

    await requiredStep('确认同 operationId 同内容安全重试不双发', async () => {
      const replay = await sendTextAndTrack(
        primary,
        targetSession,
        '同 operationId 重试 Bot 文本',
        deliveredText,
        {
          targetSessionId: config!.sessionId,
          operationId: deliveredOperationId,
        }
      );
      ensure(replay.operationId === deliveredOperationId, '安全重试返回的 operationId 不一致');
      ensure(replay.status === 'delivered', '安全重试未复用 delivered 状态');
      ensure(replay.messageId === deliveredMessageId, '安全重试返回了不同 native messageId');
      const messages = await pollMessages(primary, targetSession);
      ensure(countContentMatches(messages, deliveredText) === 1, '同 operationId 重试产生了双发');
    });

    await requiredStep('确认不同内容复用 operationId 被拒绝', async () => {
      const differentText = `${deliveredText}-different`;
      let rejectionError: unknown;
      let rejectionResult: SendResult | undefined;
      try {
        rejectionResult = await sendTextAndTrack(
          primary,
          targetSession,
          '不同内容复用异常 Bot 文本',
          differentText,
          {
            targetSessionId: config!.sessionId,
            operationId: deliveredOperationId,
          }
        );
      } catch (error) {
        rejectionError = error;
      }
      const messages = await pollMessages(primary, targetSession);
      ensure(rejectionError instanceof SendError, '不同内容复用未返回 fingerprint 冲突错误');
      ensure(errorText(rejectionError).includes('fingerprint'), '拒绝原因不是 fingerprint 冲突');
      if (rejectionResult) {
        ensure(rejectionResult.success === false, '不同内容复用意外返回成功');
      }
      ensure(countContentMatches(messages, differentText) === 0, '被拒绝的不同内容仍然发送');
    });

    await requiredStep('使用无效目标确认 pre-trigger failed', async () => {
      const invalidTarget = `0-invalid-${Date.now()}`;
      const invalidText = `T09-${Date.now()}-pre-trigger`;
      const before = await pollMessages(primary, targetSession);
      const result = await sendTextAndTrack(
        primary,
        targetSession,
        '无效目标异常 Bot 文本',
        invalidText,
        {
          targetSessionId: invalidTarget,
          operationId: `t09-pre-trigger-${Date.now()}`,
        }
      );
      ensure(result.success === false, '无效目标意外发送成功');
      ensure(result.status === 'failed', '无效目标状态不是 failed');
      ensure(result.isPreTrigger === true, '无效目标未标记为确定 pre-trigger failed');
      const after = await pollMessages(primary, targetSession);
      ensure(
        countContentMatches(after, invalidText) === countContentMatches(before, invalidText),
        '无效目标产生了消息'
      );
    });

    primary.driver.stopPolling();
    await requiredStep('断开首个 Driver 连接以准备中断场景', async () => {
      await primary.driver.disconnect();
    });

    const unknown = createManaged('unknown');
    await requiredStep('连接发送后 unknown 测试 Driver', async () => {
      await unknown.driver.connect();
    });
    const unknownSession = await requiredStep('核对 unknown 场景目标会话', async () => {
      const session = await assertExactTarget(unknown, config!);
      await assertEmployeeBySessionId(unknown, config!, session.id);
      unknown.authorized = true;
      return session;
    });
    const unknownText = `T09-${new Date().toISOString()}-unknown`;
    const unknownOperationId = `t09-unknown-${Date.now()}`;
    let interruption: Promise<void> | undefined;
    let interruptionError: Error | undefined;
    let interruptionObservation: KK9Message | undefined;
    const interruptConnection = (): void => {
      if (interruption) return;
      interruption = unknown.driver.disconnect().catch(error => {
        interruptionError = error instanceof Error ? error : new Error(String(error));
      });
    };
    getEventBridge(unknown.driver).on('message', message => {
      if (
        message.sessionId === config!.sessionId &&
        message.content.includes(unknownText) &&
        isPositiveNativeId(messageId(message))
      ) {
        interruptionObservation = message;
        rememberRecall('post-trigger 原生回显 Bot 文本', messageId(message), config!.sessionId);
        interruptConnection();
      }
    });

    await requiredStep('制造并确认 post-trigger unknown', async () => {
      const result = await sendTextAndTrack(
        unknown,
        unknownSession,
        'post-trigger 中断 Bot 文本',
        unknownText,
        {
          targetSessionId: config!.sessionId,
          operationId: unknownOperationId,
        }
      );
      ensure(interruptionObservation, '未观察到原生 outbound 回显，不能证明发送已触发');
      if (interruption) await interruption;
      if (interruptionError) {
        throw new Error(`中断连接失败: ${errorText(interruptionError)}`);
      }
      ensure(result.operationId === unknownOperationId, 'unknown 结果缺少 operationId');
      ensure(result.status === 'unknown', '发送后中断未产生 unknown 状态');
      ensure(result.success === false, 'post-trigger unknown 不应标记 success');
      ensure(result.isPreTrigger === false, 'post-trigger unknown 错误标记为 pre-trigger');
      return result;
    });

    const recovery = createManaged('recovery');
    await requiredStep('重连 Driver 并核对 Bot 与员工 session', async () => {
      await recovery.driver.connect();
      const recoveredSession = await assertExactTarget(recovery, config!);
      await assertEmployeeBySessionId(recovery, config!, recoveredSession.id);
      recovery.authorized = true;
    });

    const finalUnknownStatus = await requiredStep('重连后查询 post-trigger 最终状态', () =>
      recovery.driver.getSendStatus(unknownOperationId)
    );
    await rememberTestSendResult(
      recovery,
      unknownSession,
      'post-trigger unknown 最终 Bot 文本',
      unknownText,
      finalUnknownStatus
    );
    const finalUnknownMessageId = assertDelivered('post-trigger 最终状态', finalUnknownStatus);
    await requiredStep('核对 unknown 原生消息关联', () => {
      ensure(interruptionObservation, '缺少发送后中断前的原生回显');
      ensure(
        finalUnknownMessageId === messageId(interruptionObservation),
        '重连后最终状态未指向中断前同一 native messageId'
      );
    });

    await requiredStep('确认 unknown operation 安全重试不双发', async () => {
      const replay = await sendTextAndTrack(
        recovery,
        unknownSession,
        'unknown operation 重试 Bot 文本',
        unknownText,
        {
          targetSessionId: config!.sessionId,
          operationId: unknownOperationId,
        }
      );
      ensure(replay.operationId === unknownOperationId, 'unknown 重试返回的 operationId 不一致');
      ensure(replay.status === 'delivered', 'unknown operation 重试未复用最终 delivered');
      ensure(
        replay.messageId === finalUnknownMessageId,
        'unknown operation 重试返回不同 native messageId'
      );
      const messages = await recovery.driver.getRecentMessages(100, unknownSession);
      ensure(countContentMatches(messages, unknownText) === 1, 'unknown operation 重试产生了双发');
    });
  } catch (error) {
    fatalError = error instanceof Error ? error : new Error(String(error));
  } finally {
    const cleanupConfig = config;
    let cleanupDriver = [...managedDrivers]
      .reverse()
      .find(managed => managed.driver.getStatus() !== 'disconnected');
    let cleanupSession: KK9Session | undefined;

    if (cleanupDriver && cleanupConfig) {
      const candidate = cleanupDriver;
      candidate.authorized = false;
      await cleanupStep(`清理前重新核对 ${candidate.name} 目标`, async () => {
        const session = await assertExactTarget(candidate, cleanupConfig);
        await assertEmployeeBySessionId(candidate, cleanupConfig, session.id);
        candidate.authorized = true;
        cleanupSession = session;
      });
      if (!candidate.authorized) {
        await cleanupStep(`断开未授权 ${candidate.name} Driver`, async () => {
          await candidate.driver.disconnect();
        });
        cleanupDriver = undefined;
      }
    }

    if (
      !cleanupDriver &&
      cleanupConfig &&
      pendingSends.size > 0 &&
      !managedDrivers.some(managed => managed.driver.getStatus() !== 'disconnected')
    ) {
      const dedicated = createManaged('cleanup');
      await cleanupStep('建立并核对专用清理连接', async () => {
        await dedicated.driver.connect();
        const session = await assertExactTarget(dedicated, cleanupConfig);
        await assertEmployeeBySessionId(dedicated, cleanupConfig, session.id);
        dedicated.authorized = true;
        cleanupSession = session;
      });
      if (dedicated.authorized) cleanupDriver = dedicated;
    }

    if (cleanupDriver?.authorized && cleanupConfig && cleanupSession) {
      const authorizedCleanupDriver = cleanupDriver;
      if (pendingSends.size > 0) {
        await cleanupStep('回查待清理发送消息', () =>
          recoverPendingSendTargets(authorizedCleanupDriver, cleanupConfig, cleanupSession!)
        );
      }
      for (const target of [...recallTargets.values()].reverse()) {
        await cleanupStep(`撤回清理 ${target.label}`, async () => {
          let recalled = await authorizedCleanupDriver.driver.recallMessage(
            target.messageId,
            target.sessionId
          );
          if (!recalled) {
            await sleep(500);
            recalled = await authorizedCleanupDriver.driver.recallMessage(
              target.messageId,
              target.sessionId
            );
          }
          ensure(recalled, `撤回失败 messageId=${target.messageId}`);
          recalledKeys.add(`${target.sessionId}:${target.messageId}`);
        });
      }
    }

    for (const managed of [...managedDrivers].reverse()) {
      if (managed.driver.getStatus() === 'disconnected') continue;
      await cleanupStep(`断开 ${managed.name} Driver`, async () => {
        await managed.driver.disconnect();
      });
    }
  }

  const failures = steps.filter(step => !step.ok);
  const cleanupMissing = [...recallTargets.values()]
    .filter(target => !recalledKeys.has(`${target.sessionId}:${target.messageId}`))
    .map(target => ({
      label: target.label,
      messageId: target.messageId,
      sessionId: target.sessionId,
    }));
  console.log(
    `阶段一合同测试汇总 ${JSON.stringify({
      total: steps.length,
      passed: steps.length - failures.length,
      failed: failures.length,
      fatalError: fatalError?.message,
      cleanupMissing,
      failures,
    })}`
  );
  if (fatalError || failures.length > 0 || cleanupMissing.length > 0) process.exitCode = 1;
}

await main();
