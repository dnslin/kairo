import { CdpConnectionError, CdpConnector } from '../src/cdp/connector.js';
import { loadConfig } from '../src/config/loader.js';

interface CliOptions {
  sessionId?: number;
  sesUUID?: string;
  name?: string;
  count: number;
  all: boolean;
}

interface SessionInfo {
  id: number;
  sesUUID: string;
  type: number;
  displayName: string;
  typeName: string;
  createrName: string;
  typeID: number;
  maxMessageIndex: number | string;
  userReadIndex: number | string;
  lastMsgTime?: number;
  activeTime?: number;
}

interface MessageInfo {
  id: number;
  msgIdx: number | string;
  sender: number;
  senderName?: string;
  sendTime: number;
  notifyMsg?: string;
  contentType?: number;
  content?: unknown;
  sessionID: number;
}

function printUsage(): void {
  console.log(
    '用法: pnpm exec tsx scripts/query-session-history.ts (--session-id ID | --ses-uuid UUID | --name 名称) [--count 20] [--all]'
  );
  console.log('示例:');
  console.log('  pnpm exec tsx scripts/query-session-history.ts --session-id 539277 --count 20');
  console.log('  pnpm exec tsx scripts/query-session-history.ts --ses-uuid 0-7783 --all');
  console.log('  pnpm exec tsx scripts/query-session-history.ts --name "陈鹏" --count 50');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    count: 20,
    all: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--all') {
      options.all = true;
      continue;
    }

    if (arg === '--count') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --count 参数值');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--count 必须是正整数');
      }
      options.count = parsed;
      index += 1;
      continue;
    }

    if (arg === '--session-id') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --session-id 参数值');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--session-id 必须是正整数');
      }
      options.sessionId = parsed;
      index += 1;
      continue;
    }

    if (arg === '--ses-uuid') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --ses-uuid 参数值');
      }
      options.sesUUID = value;
      index += 1;
      continue;
    }

    if (arg === '--name') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --name 参数值');
      }
      options.name = value;
      index += 1;
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
  }

  const selectors = [options.sessionId, options.sesUUID, options.name].filter(Boolean);
  if (selectors.length !== 1) {
    throw new Error('必须且只能提供一个会话选择条件：--session-id 或 --ses-uuid 或 --name');
  }

  return options;
}

async function evaluateValue<T>(
  connector: CdpConnector,
  expression: string,
  awaitPromise = false
): Promise<T> {
  const response = await connector.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });

  if (response.error) {
    throw new CdpConnectionError(`执行页面脚本失败: ${response.error.message}`);
  }

  const payload = response.result as {
    exceptionDetails?: { text?: string };
    result?: { value?: T };
  };

  if (payload.exceptionDetails) {
    throw new CdpConnectionError(payload.exceptionDetails.text || '页面脚本执行异常');
  }

  return payload.result?.value as T;
}

function getBridgePrelude(): string {
  return `
    function nextRequestId() {
      const key = '__kkbotHistoryQueryReqId';
      const current = typeof window[key] === 'number' ? window[key] : 1000000;
      const next = current + 1;
      window[key] = next;
      return next;
    }

    function toData() {
      const args = Array.from(arguments);
      return new Promise(resolve => {
        if (!window.ipcRenderer || typeof window.ipcRenderer.send !== 'function') {
          resolve({ code: -1, message: 'ipcRenderer 不可用' });
          return;
        }
        const requestId = nextRequestId();
        const replyChannel = 'data-' + requestId;
        window.ipcRenderer.once(replyChannel, (_event, payload) => resolve(payload));
        window.ipcRenderer.send('data', { id: requestId, args, progress: false });
      });
    }

    function getMainPageVm() {
      return document.querySelector('#main-page')?.__vue__ || null;
    }

    function normalizeDisplayName(item, currentUserId) {
      if (item.type === 0 && currentUserId !== null && item.typeID === currentUserId) {
        return item.createrName || item.typeName || '';
      }
      return item.typeName || item.createrName || '';
    }
  `;
}

async function fetchSessions(connector: CdpConnector): Promise<SessionInfo[]> {
  return await evaluateValue<SessionInfo[]>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const currentUserId = getMainPageVm()?.userID || null;
      const editorVm = document.querySelector('.chat-editor')?.__vue__ || null;
      const sortedSessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];
      const sortedById = new Map(sortedSessions.map(item => [item.id, item]));
      return toData('getConversations').then(result => {
        const sessions = Array.isArray(result?.data?.sessionsInfo) ? result.data.sessionsInfo : [];
        return sessions.map(item => ({
          id: item.id,
          sesUUID: item.sesUUID || sortedById.get(item.id)?.sesUUID || '',
          type: item.type,
          displayName: normalizeDisplayName(item, currentUserId),
          typeName: item.typeName || '',
          createrName: item.createrName || '',
          typeID: item.typeID,
          maxMessageIndex: item.maxMessageIndex,
          userReadIndex: item.userReadIndex,
          lastMsgTime: item.lastMsgTime,
          activeTime: item.activeTime,
        }));
      });
    })()`,
    true
  );
}

async function fetchMessagesWindow(
  connector: CdpConnector,
  session: SessionInfo,
  count: number,
  endIdx: number,
  sendTime: number
): Promise<MessageInfo[]> {
  return await evaluateValue<MessageInfo[]>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const request = {
        sessionID: ${session.id},
        count: ${count},
        endIdx: ${endIdx},
        sendTime: ${sendTime},
      };
      return toData('getMessages', request).then(result => {
        if (result?.code !== 0 || !Array.isArray(result?.data)) {
          return [];
        }
        return result.data;
      });
    })()`,
    true
  );
}

function formatMessageContent(message: MessageInfo): string {
  if (typeof message.notifyMsg === 'string' && message.notifyMsg.length > 0) {
    return message.notifyMsg;
  }

  let contentValue: unknown = message.content;
  if (typeof contentValue === 'string') {
    try {
      contentValue = JSON.parse(contentValue);
    } catch {
      return contentValue as string;
    }
  }

  const contentItems =
    typeof contentValue === 'object' &&
    contentValue !== null &&
    'content' in contentValue &&
    Array.isArray((contentValue as { content?: unknown[] }).content)
      ? (contentValue as { content: Array<Record<string, unknown>> }).content
      : [];

  const parts = contentItems.map(item => {
    if (item.type === 0 && typeof item.text === 'string') {
      return item.text;
    }
    if (item.type === 1) {
      return '[图片]';
    }
    if (item.type === 2 && typeof item.replyMemberName === 'string') {
      return `@${item.replyMemberName}`;
    }
    return '[复杂消息]';
  });

  return parts.join('').trim() || '[空消息]';
}

function formatTimestamp(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('zh-CN');
}

function resolveSession(sessions: SessionInfo[], options: CliOptions): SessionInfo {
  if (typeof options.sessionId === 'number') {
    const session = sessions.find(item => item.id === options.sessionId);
    if (!session) {
      throw new Error(`未找到 sessionID=${String(options.sessionId)} 对应的会话`);
    }
    return session;
  }

  if (typeof options.sesUUID === 'string') {
    const session = sessions.find(item => item.sesUUID === options.sesUUID);
    if (!session) {
      throw new Error(`未找到 sesUUID=${options.sesUUID} 对应的会话`);
    }
    return session;
  }

  const matches = sessions.filter(item => item.displayName === options.name);
  if (matches.length === 0) {
    throw new Error(`未找到名称为 ${options.name} 的会话`);
  }
  if (matches.length > 1) {
    const lines = matches
      .slice(0, 10)
      .map(
        item => `id=${String(item.id)}, sesUUID=${item.sesUUID}, displayName=${item.displayName}`
      )
      .join('；');
    throw new Error(
      `名称 ${options.name} 存在多个会话，请改用 --session-id 或 --ses-uuid。候选：${lines}`
    );
  }
  return matches[0];
}

async function fetchHistory(
  connector: CdpConnector,
  session: SessionInfo,
  pageSize: number,
  all: boolean
): Promise<MessageInfo[]> {
  const sendTime = session.lastMsgTime || session.activeTime || Math.floor(Date.now() / 1000);
  let endIdx = Math.ceil(Number(session.maxMessageIndex) || 0);

  if (endIdx <= 0) {
    return [];
  }

  const seenIds = new Set<number>();
  const messages: MessageInfo[] = [];
  const maxRounds = all ? 500 : 1;

  for (let round = 0; round < maxRounds; round += 1) {
    const page = await fetchMessagesWindow(connector, session, pageSize, endIdx, sendTime);
    if (page.length === 0) {
      break;
    }

    const uniquePage = page.filter(item => {
      if (seenIds.has(item.id)) {
        return false;
      }
      seenIds.add(item.id);
      return true;
    });

    if (all) {
      messages.unshift(...uniquePage);
    } else {
      messages.push(...uniquePage);
    }

    if (!all) {
      break;
    }

    const firstMsgIdx = Number(page[0]?.msgIdx);
    const nextEndIdx = Math.ceil(firstMsgIdx - 1);
    if (
      page.length < pageSize ||
      !Number.isFinite(nextEndIdx) ||
      nextEndIdx < 1 ||
      nextEndIdx >= endIdx
    ) {
      break;
    }

    endIdx = nextEndIdx;
  }

  return messages;
}

function printSession(session: SessionInfo): void {
  console.log('会话信息:');
  console.log(`  displayName: ${session.displayName}`);
  console.log(`  sessionID: ${String(session.id)}`);
  console.log(`  sesUUID: ${session.sesUUID}`);
  console.log(`  type: ${String(session.type)}`);
  console.log(`  typeName: ${session.typeName}`);
  console.log(`  createrName: ${session.createrName}`);
  console.log(`  maxMessageIndex: ${String(session.maxMessageIndex)}`);
  console.log(`  userReadIndex: ${String(session.userReadIndex)}`);
  console.log(
    `  lastMsgTime: ${session.lastMsgTime ? formatTimestamp(session.lastMsgTime) : '未知'}`
  );
}

function printMessages(messages: MessageInfo[]): void {
  console.log('');
  console.log(`历史消息数: ${String(messages.length)}`);
  console.log('----------------------------------------');
  for (const message of messages) {
    console.log(
      `[${String(message.msgIdx)}] ${formatTimestamp(message.sendTime)} ${message.senderName || message.sender}`
    );
    console.log(`  ${formatMessageContent(message)}`);
  }
  console.log('----------------------------------------');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  try {
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接到 KK9 渲染页面。');

    const sessions = await fetchSessions(connector);
    const session = resolveSession(sessions, options);
    const messages = await fetchHistory(connector, session, options.count, options.all);

    printSession(session);
    printMessages(messages);
  } finally {
    connector.disconnect();
  }
}

main().catch(error => {
  console.error('查询失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
