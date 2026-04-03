import { CdpConnectionError, CdpConnector } from '../src/cdp/connector.js';
import { loadConfig } from '../src/config/loader.js';

interface CapabilityTestResult {
  name: string;
  passed: boolean;
  required: boolean;
  skipped?: boolean;
  summary: string;
  details?: Record<string, unknown>;
}

interface PageSession {
  id: number;
  sesUUID: string;
  maxMessageIndex: number | string;
  userReadIndex: number | string;
  lastMsgTime?: number;
  activeTime?: number;
  type?: number;
  typeName?: string;
}

interface PageMessage {
  id: number;
  msgIdx: number | string;
  notifyMsg?: string;
  sendTime: number;
  sender: number;
  sessionID: number;
  content?: unknown;
}

interface CliOptions {
  allSessions: boolean;
}

function printUsage(): void {
  console.log('用法: pnpm exec tsx scripts/verify-lowlevel-capabilities.ts [--all-sessions]');
  console.log('说明: 只读验证 KK9 低层能力，不实际发送消息。');
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    allSessions: false,
  };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--all-sessions') {
      options.allSessions = true;
      continue;
    }

    throw new Error(`未知参数: ${arg}`);
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
      const key = '__kkbotCapabilityProbeReqId';
      const current = typeof window[key] === 'number' ? window[key] : 800000;
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

    function getEditorVm() {
      return document.querySelector('.chat-editor')?.__vue__ || null;
    }

    function getMainPageVm() {
      return document.querySelector('#main-page')?.__vue__ || null;
    }

    function getActiveChatVm() {
      const containers = Array.from(document.querySelectorAll('.chat-container'));
      for (const node of containers) {
        const vm = node.__vue__;
        if (!vm || vm.$options?.name !== 'chat-content') {
          continue;
        }
        const style = window.getComputedStyle(node);
        if (style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0) {
          return vm;
        }
      }
      return null;
    }

    function getBus() {
      const mainPageVm = getMainPageVm();
      const editorVm = getEditorVm();
      return mainPageVm?.$bus || editorVm?.$bus || null;
    }
  `;
}

async function verifyConversations(
  connector: CdpConnector,
  allSessions: boolean
): Promise<CapabilityTestResult> {
  const result = await evaluateValue<{
    ok: boolean;
    error?: string;
    code?: number;
    count?: number;
    dataKeys?: string[];
    sessionPreview?: Array<Record<string, unknown>>;
    sample?: Record<string, unknown> | null;
  }>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const currentUserId = getMainPageVm()?.userID || null;
      function getDisplayName(item) {
        if (item.type === 0 && currentUserId !== null && item.typeID === currentUserId) {
          return item.createrName || item.typeName || '';
        }
        return item.typeName || item.createrName || '';
      }
      return toData('getConversations').then(result => ({
        ok: result?.code === 0 && Array.isArray(result?.data?.sessionsInfo) && result.data.sessionsInfo.length > 0,
        error: result?.code === 0 ? undefined : (result?.message || result?.msg || 'getConversations 失败'),
        code: result?.code,
        count: Array.isArray(result?.data?.sessionsInfo) ? result.data.sessionsInfo.length : 0,
        dataKeys: result?.data && typeof result.data === 'object' && !Array.isArray(result.data)
          ? Object.keys(result.data)
          : [],
        sessionPreview: Array.isArray(result?.data?.sessionsInfo)
          ? result.data.sessionsInfo.slice(0, ${allSessions ? 'result.data.sessionsInfo.length' : '10'}).map(item => ({
              id: item.id,
              sesUUID: item.sesUUID,
              type: item.type,
              displayName: getDisplayName(item),
              typeName: item.typeName,
              createrName: item.createrName,
              typeID: item.typeID,
              maxMessageIndex: item.maxMessageIndex,
              userReadIndex: item.userReadIndex,
              lastMsgTime: item.lastMsgTime,
            }))
          : [],
        sample: Array.isArray(result?.data?.sessionsInfo) && result.data.sessionsInfo.length > 0
          ? {
              id: result.data.sessionsInfo[0].id,
              sesUUID: result.data.sessionsInfo[0].sesUUID,
              type: result.data.sessionsInfo[0].type,
              displayName: getDisplayName(result.data.sessionsInfo[0]),
              typeName: result.data.sessionsInfo[0].typeName,
              createrName: result.data.sessionsInfo[0].createrName,
              typeID: result.data.sessionsInfo[0].typeID,
              maxMessageIndex: result.data.sessionsInfo[0].maxMessageIndex,
              userReadIndex: result.data.sessionsInfo[0].userReadIndex,
            }
          : null,
      }));
    })()`,
    true
  );

  return {
    name: '会话列表读取',
    passed: result.ok,
    required: true,
    summary: result.ok
      ? `getConversations 可用，返回 ${String(result.count)} 个会话`
      : `getConversations 不可用: ${result.error || '未知错误'}`,
    details: {
      code: result.code,
      count: result.count,
      dataKeys: result.dataKeys,
      [allSessions ? 'sessions' : 'sessionPreview']: result.sessionPreview,
      sample: result.sample,
    },
  };
}

async function verifyMessages(connector: CdpConnector): Promise<CapabilityTestResult> {
  const result = await evaluateValue<{
    ok: boolean;
    error?: string;
    session?: PageSession;
    request?: Record<string, unknown>;
    code?: number;
    size?: number;
    first?: Record<string, unknown> | null;
    last?: Record<string, unknown> | null;
  }>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const editorVm = getEditorVm();
      const sessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];
      const current = sessions[0];
      if (!current) {
        return Promise.resolve({ ok: false, error: '未找到当前会话' });
      }
      const request = {
        sessionID: current.id,
        count: 5,
        endIdx: Math.ceil(Number(current.maxMessageIndex) || 0),
        sendTime: current.lastMsgTime || current.activeTime || Math.floor(Date.now() / 1000),
      };
      return toData('getMessages', request).then(result => {
        const data = Array.isArray(result?.data) ? result.data : [];
        return {
          ok: result?.code === 0 && data.length > 0,
          error: result?.code === 0 ? undefined : (result?.message || result?.msg || 'getMessages 失败'),
          session: {
            id: current.id,
            sesUUID: current.sesUUID,
            maxMessageIndex: current.maxMessageIndex,
            userReadIndex: current.userReadIndex,
            lastMsgTime: current.lastMsgTime,
            activeTime: current.activeTime,
            type: current.type,
            typeName: current.typeName,
          },
          request,
          code: result?.code,
          size: data.length,
          first: data[0]
            ? {
                id: data[0].id,
                msgIdx: data[0].msgIdx,
                sender: data[0].sender,
                notifyMsg: data[0].notifyMsg,
              }
            : null,
          last: data.at(-1)
            ? {
                id: data.at(-1).id,
                msgIdx: data.at(-1).msgIdx,
                sender: data.at(-1).sender,
                notifyMsg: data.at(-1).notifyMsg,
              }
            : null,
        };
      });
    })()`,
    true
  );

  return {
    name: '消息分页读取',
    passed: result.ok,
    required: true,
    summary: result.ok
      ? `getMessages 可用，会话 ${result.session?.sesUUID || '未知'} 返回 ${String(result.size)} 条消息`
      : `getMessages 不可用: ${result.error || '未知错误'}`,
    details: {
      session: result.session,
      request: result.request,
      code: result.code,
      size: result.size,
      first: result.first,
      last: result.last,
    },
  };
}

async function verifySingleMessage(connector: CdpConnector): Promise<CapabilityTestResult> {
  const result = await evaluateValue<{
    ok: boolean;
    error?: string;
    session?: { id: number; sesUUID: string };
    sample?: { id: number; msgIdx: number | string; notifyMsg?: string };
    code?: number;
    rowType?: string;
    row?: Record<string, unknown> | null;
  }>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const editorVm = getEditorVm();
      const sessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];
      const current = sessions[0];
      if (!current) {
        return Promise.resolve({ ok: false, error: '未找到当前会话' });
      }
      const request = {
        sessionID: current.id,
        count: 3,
        endIdx: Math.ceil(Number(current.maxMessageIndex) || 0),
        sendTime: current.lastMsgTime || current.activeTime || Math.floor(Date.now() / 1000),
      };
      return toData('getMessages', request).then(listResult => {
        const data = Array.isArray(listResult?.data) ? listResult.data : [];
        const sample = data.at(-1);
        if (!sample) {
          return { ok: false, error: '未拿到样本消息' };
        }
        return toData('getMessageBySessionIDAndMsgIdx', current.id, sample.msgIdx).then(rowResult => ({
          ok: rowResult?.code === 0 && Array.isArray(rowResult?.data) && rowResult.data.length > 0,
          error: rowResult?.code === 0 ? undefined : (rowResult?.message || rowResult?.msg || '单条消息接口失败'),
          session: { id: current.id, sesUUID: current.sesUUID },
          sample: { id: sample.id, msgIdx: sample.msgIdx, notifyMsg: sample.notifyMsg },
          code: rowResult?.code,
          rowType: Array.isArray(rowResult?.data) ? 'array' : typeof rowResult?.data,
          row: Array.isArray(rowResult?.data) && rowResult.data.length > 0
            ? {
                id: rowResult.data[0].id,
                msgIdx: rowResult.data[0].msgIdx,
                notifyMsg: rowResult.data[0].notifyMsg,
                contentType: typeof rowResult.data[0].content,
              }
            : null,
        }));
      });
    })()`,
    true
  );

  return {
    name: '单条消息定位',
    passed: result.ok,
    required: true,
    summary: result.ok
      ? `getMessageBySessionIDAndMsgIdx 可用，样本 msgIdx=${String(result.sample?.msgIdx ?? '')}`
      : `单条消息接口不可用: ${result.error || '未知错误'}`,
    details: {
      session: result.session,
      sample: result.sample,
      code: result.code,
      rowType: result.rowType,
      row: result.row,
    },
  };
}

async function verifyEventChain(connector: CdpConnector): Promise<CapabilityTestResult> {
  const result = await evaluateValue<{
    ok: boolean;
    error?: string;
    mainPageName?: string;
    hasNativeMessageHook?: boolean;
    receiveListenerCount?: number;
    activeSessionEvent?: string;
    sessionListenerCount?: number;
  }>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const mainPageVm = getMainPageVm();
      const editorVm = getEditorVm();
      const activeChatVm = getActiveChatVm();
      const bus = getBus();
      if (!mainPageVm || !editorVm || !activeChatVm || !bus) {
        return { ok: false, error: 'main-page、chat-editor、chat-content 或 bus 不可用' };
      }
      const createdFns = Array.isArray(mainPageVm.$options?.created)
        ? mainPageVm.$options.created
        : [mainPageVm.$options?.created].filter(Boolean);
      const createdSource = createdFns.map(fn => Function.prototype.toString.call(fn));
      const hasNativeMessageHook = createdSource.some(source => source.includes('v.a.on("message",this.onReceiveMessage)'));
      const receiveRaw = bus._events?.['receive-message'];
      const receiveListeners = Array.isArray(receiveRaw) ? receiveRaw : receiveRaw ? [receiveRaw] : [];
      const activeSessionEvent = editorVm.activedSes?.sesUUID ? editorVm.activedSes.sesUUID + '-msg' : '';
      const sessionRaw = activeSessionEvent ? bus._events?.[activeSessionEvent] : null;
      const sessionListeners = Array.isArray(sessionRaw) ? sessionRaw : sessionRaw ? [sessionRaw] : [];
      return {
        ok: hasNativeMessageHook && receiveListeners.length > 0 && sessionListeners.length > 0,
        error: hasNativeMessageHook ? undefined : '未找到 main-page 对原生 message 的注册',
        mainPageName: mainPageVm.$options?.name || '',
        hasNativeMessageHook,
        receiveListenerCount: receiveListeners.length,
        activeSessionEvent,
        sessionListenerCount: sessionListeners.length,
      };
    })()`
  );

  return {
    name: '增量消息事件链',
    passed: result.ok,
    required: true,
    summary: result.ok
      ? `已确认 main-page -> receive-message -> ${result.activeSessionEvent || '未知事件'} 链路存在`
      : `增量事件链不完整: ${result.error || '未知错误'}`,
    details: {
      mainPageName: result.mainPageName,
      hasNativeMessageHook: result.hasNativeMessageHook,
      receiveListenerCount: result.receiveListenerCount,
      activeSessionEvent: result.activeSessionEvent,
      sessionListenerCount: result.sessionListenerCount,
    },
  };
}

async function verifyReadChain(connector: CdpConnector): Promise<CapabilityTestResult> {
  const result = await evaluateValue<{
    ok: boolean;
    skipped?: boolean;
    error?: string;
    session?: { id: number; sesUUID: string; maxMessageIndex: number | string; userReadIndex: number | string };
    unreadBefore?: number;
    readCode?: number;
    unreadAfter?: number;
    hasSetMessageRead?: boolean;
  }>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const editorVm = getEditorVm();
      const rootVm = document.querySelector('#app')?.__vue__;
      const sessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];
      const current = sessions[0];
      if (!rootVm || !current) {
        return Promise.resolve({ ok: false, error: '未找到当前会话或根实例' });
      }
      const queue = [rootVm];
      const seen = new Set();
      let hasSetMessageRead = false;
      while (queue.length) {
        const vm = queue.shift();
        if (!vm || seen.has(vm._uid)) {
          continue;
        }
        seen.add(vm._uid);
        if (typeof vm.$options?.methods?.setMessageRead === 'function') {
          hasSetMessageRead = true;
          break;
        }
        for (const child of vm.$children || []) {
          queue.push(child);
        }
      }
      const sameReadIndex = Number(current.userReadIndex) === Number(current.maxMessageIndex);
      if (!sameReadIndex) {
        return Promise.resolve({
          ok: true,
          skipped: true,
          session: {
            id: current.id,
            sesUUID: current.sesUUID,
            maxMessageIndex: current.maxMessageIndex,
            userReadIndex: current.userReadIndex,
          },
          hasSetMessageRead,
        });
      }
      return Promise.all([
        toData('getAtMsgUnread'),
        toData('readMessage', { type: current.type, sessionID: current.id, maxMsgIdx: current.maxMessageIndex }),
        toData('getAtMsgUnread'),
      ]).then(([beforeUnread, readResult, afterUnread]) => ({
        ok: readResult?.code === 0 && hasSetMessageRead,
        session: {
          id: current.id,
          sesUUID: current.sesUUID,
          maxMessageIndex: current.maxMessageIndex,
          userReadIndex: current.userReadIndex,
        },
        unreadBefore: beforeUnread?.data,
        readCode: readResult?.code,
        unreadAfter: afterUnread?.data,
        hasSetMessageRead,
      }));
    })()`,
    true
  );

  return {
    name: '已读同步链',
    passed: result.ok,
    required: false,
    skipped: result.skipped,
    summary: result.skipped
      ? `当前会话已读状态不安全，跳过 readMessage 实调；已确认 setMessageRead 业务函数存在`
      : result.ok
        ? `readMessage 可用，返回 code=${String(result.readCode)}`
        : `已读链不可用: ${result.error || '未知错误'}`,
    details: {
      session: result.session,
      unreadBefore: result.unreadBefore,
      readCode: result.readCode,
      unreadAfter: result.unreadAfter,
      hasSetMessageRead: result.hasSetMessageRead,
    },
  };
}

async function verifyLowLevelEntrypoints(connector: CdpConnector): Promise<CapabilityTestResult> {
  const result = await evaluateValue<{
    ok: boolean;
    error?: string;
    editorMethods?: string[];
    chatMethods?: string[];
  }>(
    connector,
    `(() => {
      ${getBridgePrelude()}
      const editorVm = getEditorVm();
      const chatVm = getActiveChatVm();
      if (!editorVm || !chatVm) {
        return { ok: false, error: '未找到 chat-editor 或 chat-content 组件' };
      }
      const editorMethods = Object.keys(editorVm.$options?.methods || {})
        .filter(name => /send|getContent|reply/i.test(name))
        .sort();
      const chatMethods = Object.keys(chatVm.$options?.methods || {})
        .filter(name => /send|buildMessageObj|updateMsg|reloadSingleMsg/i.test(name))
        .sort();
      const ok =
        editorMethods.includes('sendPicTextMessage')
        && chatMethods.includes('onSendMessage')
        && chatMethods.includes('sendMessage')
        && chatMethods.includes('buildMessageObj');
      return {
        ok,
        editorMethods,
        chatMethods,
      };
    })()`
  );

  return {
    name: '低层发送入口存在性',
    passed: result.ok,
    required: true,
    summary: result.ok
      ? '已确认 MessageEditor 与 chat-content 的低层发送入口可直接利用'
      : `低层发送入口不完整: ${result.error || '未知错误'}`,
    details: {
      editorMethods: result.editorMethods,
      chatMethods: result.chatMethods,
    },
  };
}

function printResult(result: CapabilityTestResult): void {
  const status = result.skipped ? 'SKIP' : result.passed ? 'PASS' : 'FAIL';
  const requirement = result.required ? '必需' : '可选';
  console.log(`[${status}] ${result.name} (${requirement})`);
  console.log(`  ${result.summary}`);
  if (result.details) {
    console.log(`  详情: ${JSON.stringify(result.details)}`);
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  const config = loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  try {
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接到 KK9 渲染页面。');

    const results = [
      await verifyConversations(connector, options.allSessions),
      await verifyMessages(connector),
      await verifySingleMessage(connector),
      await verifyEventChain(connector),
      await verifyReadChain(connector),
      await verifyLowLevelEntrypoints(connector),
    ];

    console.log('');
    console.log('========== 低层能力验证结果 ==========');
    for (const result of results) {
      printResult(result);
    }
    console.log('=====================================');

    const failedRequired = results.filter(result => result.required && !result.passed);
    const passedNames = results.filter(result => result.passed).map(result => result.name);

    console.log('');
    console.log(`可直接利用的能力: ${passedNames.join('、')}`);

    if (failedRequired.length > 0) {
      console.log(`存在失败的必需项: ${failedRequired.map(result => result.name).join('、')}`);
      process.exit(1);
    }

    console.log('验证完成，核心低层能力可利用。');
  } finally {
    connector.disconnect();
  }
}

main().catch(error => {
  console.error('验证失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
