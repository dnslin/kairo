import { loadConfig } from '../src/config/loader.js';
import { CdpConnectionError, CdpConnector } from '../src/cdp/connector.js';

interface CliOptions {
  send: boolean;
  parallel: boolean;
  text: string;
  sessionIds: string[];
  verifyTimeoutMs: number;
}

interface SessionTarget {
  id: number;
  sesUUID: string;
  sesTypeID: number;
  type: number;
  typeName?: string;
  showName?: string;
  userConfig?: string;
}

interface BatchProbeResult {
  ok: boolean;
  error?: string;
  currentSessionId?: string;
  currentSessionName?: string;
  currentUserId?: number;
  availableSessions?: SessionTarget[];
  targets?: SessionTarget[];
  previewPayloads?: Array<{
    target: string;
    sessionID: number;
    receiver: number;
    sessionType: number;
    msgFlag: string;
    contentType: number;
  }>;
}

interface BatchSendResult {
  ok: boolean;
  error?: string;
  currentUserId?: number;
  targets?: Array<{
    target: string;
    sessionID: number;
    receiver: number;
    sessionType: number;
    msgFlag: string;
    sent: boolean;
    error?: string;
  }>;
}

interface BatchVerifyResult {
  ok: boolean;
  pending: string[];
  matched: Array<{
    target: string;
    lastSender: number | null;
    lastText: string;
  }>;
}

function parseArgs(argv: string[]): CliOptions {
  let send = false;
  let parallel = false;
  let text = `[批量会话直发Demo] ${new Date().toLocaleString('zh-CN')}`;
  let sessionIds: string[] = [];
  let verifyTimeoutMs = 8000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--send') {
      send = true;
      continue;
    }

    if (arg === '--parallel') {
      parallel = true;
      continue;
    }

    if (arg === '--text') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --text 参数值');
      }
      text = value;
      index += 1;
      continue;
    }

    if (arg === '--session-ids') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --session-ids 参数值');
      }
      sessionIds = value
        .split(',')
        .map(item => item.trim())
        .filter(Boolean);
      index += 1;
      continue;
    }

    if (arg === '--verify-timeout-ms') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --verify-timeout-ms 参数值');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--verify-timeout-ms 必须是正整数');
      }
      verifyTimeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`未知参数: ${arg}`);
  }

  return { send, parallel, text, sessionIds, verifyTimeoutMs };
}

function printUsage(): void {
  console.log('用法: pnpm exec tsx scripts/demo-batch-send.ts --session-ids "0-3585,716791" [--send] [--parallel] [--text 文本] [--verify-timeout-ms 毫秒]');
  console.log('说明: 默认只解析目标会话并预览 payload，带 --send 才实际批量发送，且不切 DOM。');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

async function probeBatchTargets(
  connector: CdpConnector,
  sessionIds: string[],
  text: string
): Promise<BatchProbeResult> {
  return await evaluateValue<BatchProbeResult>(
    connector,
    `(() => {
      const requestedIds = ${JSON.stringify(sessionIds)};
      const contentText = ${JSON.stringify(text)};

      function getBridgeVm() {
        const containers = Array.from(document.querySelectorAll('.chat-container'));
        const element = containers.find(node => {
          const vm = node.__vue__;
          if (!vm || vm.$options?.name !== 'chat-content') {
            return false;
          }

          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
        });

        return element?.__vue__ || null;
      }

      function simplifySession(item) {
        return {
          id: item.id,
          sesUUID: item.sesUUID,
          sesTypeID: item.sesTypeID,
          type: item.type,
          typeName: item.typeName,
          showName: item.showName,
          userConfig: item.userConfig,
        };
      }

      const bridgeVm = getBridgeVm();
      const editorVm = document.querySelector('.chat-editor')?.__vue__;
      const sessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];

      if (!bridgeVm) {
        return { ok: false, error: '未找到当前可见 chat-content 组件' };
      }

      if (!editorVm) {
        return { ok: false, error: '未找到 MessageEditor 组件' };
      }

      if (typeof bridgeVm.buildMessageObj !== 'function' || typeof bridgeVm.sendMessage !== 'function') {
        return { ok: false, error: '低层发送方法不可用' };
      }

      const availableSessions = sessions.slice(0, 20).map(simplifySession);
      if (!requestedIds.length) {
        return {
          ok: false,
          error: '缺少目标会话 ID',
          currentSessionId: bridgeVm.sesInfo?.sesUUID || '',
          currentSessionName: bridgeVm.sesInfo?.showName || bridgeVm.sesInfo?.typeName || '',
          currentUserId: bridgeVm.userInfo?.id,
          availableSessions,
        };
      }

      const targets = requestedIds
        .map(requestId => sessions.find(item => item.sesUUID === requestId || String(item.id) === requestId))
        .filter(Boolean);

      if (targets.length !== requestedIds.length) {
        const missing = requestedIds.filter(requestId => !targets.some(item => item.sesUUID === requestId || String(item.id) === requestId));
        return {
          ok: false,
          error: '部分目标会话不存在: ' + missing.join(', '),
          currentSessionId: bridgeVm.sesInfo?.sesUUID || '',
          currentSessionName: bridgeVm.sesInfo?.showName || bridgeVm.sesInfo?.typeName || '',
          currentUserId: bridgeVm.userInfo?.id,
          availableSessions,
        };
      }

      return bridgeVm.buildMessageObj({ content: [{ type: 0, text: contentText }], type: 'PicText' }, false)
        .then(template => {
          const previewPayloads = targets.map(target => {
            const userConfig = typeof target.userConfig === 'string' ? target.userConfig : '';
            const needReport = userConfig[1] === '1';
            const msgFlag = needReport ? 'A1' : '';
            return {
              target: target.sesUUID,
              sessionID: target.id,
              receiver: target.sesTypeID,
              sessionType: target.type,
              msgFlag,
              contentType: template.contentType,
            };
          });

          return {
            ok: true,
            currentSessionId: bridgeVm.sesInfo?.sesUUID || '',
            currentSessionName: bridgeVm.sesInfo?.showName || bridgeVm.sesInfo?.typeName || '',
            currentUserId: bridgeVm.userInfo?.id,
            availableSessions,
            targets: targets.map(simplifySession),
            previewPayloads,
          };
        })
        .catch(error => ({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
          currentSessionId: bridgeVm.sesInfo?.sesUUID || '',
          currentSessionName: bridgeVm.sesInfo?.showName || bridgeVm.sesInfo?.typeName || '',
          currentUserId: bridgeVm.userInfo?.id,
          availableSessions,
        }));
    })()`,
    true
  );
}

async function sendBatchBySessionIds(
  connector: CdpConnector,
  sessionIds: string[],
  text: string,
  parallel: boolean
): Promise<BatchSendResult> {
  return await evaluateValue<BatchSendResult>(
    connector,
    `(async () => {
      const requestedIds = ${JSON.stringify(sessionIds)};
      const contentText = ${JSON.stringify(text)};
      const runParallel = ${parallel ? 'true' : 'false'};

      function nextRequestId() {
        const key = '__kkbotBatchReqId';
        const current = typeof window[key] === 'number' ? window[key] : 100000;
        const next = current + 1;
        window[key] = next;
        return next;
      }

      function toData(...args) {
        return new Promise(resolve => {
          if (!window.ipcRenderer || typeof window.ipcRenderer.send !== 'function') {
            resolve({ code: -1, message: 'ipcRenderer 不可用' });
            return;
          }

          const requestId = nextRequestId();
          const replyChannel = 'data-' + requestId;
          window.ipcRenderer.once(replyChannel, (_event, payload) => {
            resolve(payload);
          });
          window.ipcRenderer.send('data', {
            id: requestId,
            args,
            progress: false,
          });
        });
      }

      function getBridgeVm() {
        const containers = Array.from(document.querySelectorAll('.chat-container'));
        const element = containers.find(node => {
          const vm = node.__vue__;
          if (!vm || vm.$options?.name !== 'chat-content') {
            return false;
          }

          const style = window.getComputedStyle(node);
          return style.display !== 'none' && style.visibility !== 'hidden' && node.getClientRects().length > 0;
        });

        return element?.__vue__ || null;
      }

      const bridgeVm = getBridgeVm();
      const editorVm = document.querySelector('.chat-editor')?.__vue__;
      const sessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];

      if (!bridgeVm) {
        return { ok: false, error: '未找到当前可见 chat-content 组件' };
      }

      if (!editorVm) {
        return { ok: false, error: '未找到 MessageEditor 组件' };
      }

      if (typeof bridgeVm.buildMessageObj !== 'function' || typeof bridgeVm.sendMessage !== 'function') {
        return { ok: false, error: '低层发送方法不可用' };
      }

      const targets = requestedIds
        .map(requestId => sessions.find(item => item.sesUUID === requestId || String(item.id) === requestId))
        .filter(Boolean);

      if (targets.length !== requestedIds.length) {
        const missing = requestedIds.filter(requestId => !targets.some(item => item.sesUUID === requestId || String(item.id) === requestId));
        return { ok: false, error: '部分目标会话不存在: ' + missing.join(', ') };
      }

      const template = await bridgeVm.buildMessageObj({ content: [{ type: 0, text: contentText }], type: 'PicText' }, false);

      const jobs = targets.map(target => {
        const userConfig = typeof target.userConfig === 'string' ? target.userConfig : '';
        const needReport = userConfig[1] === '1';
        const message = {
          ...JSON.parse(JSON.stringify(template)),
          sendTime: Math.floor(Date.now() / 1000),
          receiver: target.sesTypeID,
          sessionType: target.type,
          sessionID: target.id,
          msgFlag: needReport ? 'A1' : '',
          reportSummary: needReport ? { state: 0 } : undefined,
        };

        return {
          target: target.sesUUID,
          sessionID: target.id,
          receiver: target.sesTypeID,
          sessionType: target.type,
          msgFlag: message.msgFlag,
          async execute() {
            try {
              if (typeof bridgeVm.checkMuted === 'function' && await bridgeVm.checkMuted(message.sessionID)) {
                return {
                  target: target.sesUUID,
                  sessionID: target.id,
                  receiver: target.sesTypeID,
                  sessionType: target.type,
                  msgFlag: message.msgFlag,
                  sent: false,
                  error: '目标会话当前不可发送',
                };
              }

              if (typeof bridgeVm.buildFont === 'function') {
                await bridgeVm.buildFont(message);
              }

              const inserted = await toData('insertSendBefoeMsg', message);
              if (!inserted || inserted.code) {
                return {
                  target: target.sesUUID,
                  sessionID: target.id,
                  receiver: target.sesTypeID,
                  sessionType: target.type,
                  msgFlag: message.msgFlag,
                  sent: false,
                  error: inserted?.message || inserted?.msg || JSON.stringify(inserted),
                };
              }

              message.id = inserted.data.id;
              message.msgIdx = inserted.data.msgIdx;

              bridgeVm.$store.commit('updateSesLastMsg', {
                sesUUID: target.sesUUID,
                message: inserted.data,
              });

              const payload = {
                content: message.content,
                contentType: message.contentType,
                sender: message.sender,
                senderName: message.senderName,
                senderNameEN: message.senderNameEN,
                senderNameTC: message.senderNameTC,
                receiver: message.receiver,
                sessionType: message.sessionType,
                sessionID: message.sessionID,
                atState: message.atState,
                msgFlag: message.msgFlag,
                atMemberIDList: message.atMemberIDList,
                type: message.type,
                id: message.id,
              };

              const sent = await toData('sendMessageNew', payload);
              if (sent && sent.code) {
                return {
                  target: target.sesUUID,
                  sessionID: target.id,
                  receiver: target.sesTypeID,
                  sessionType: target.type,
                  msgFlag: message.msgFlag,
                  sent: false,
                  error: sent.message || sent.msg || JSON.stringify(sent),
                };
              }

              return {
                target: target.sesUUID,
                sessionID: target.id,
                receiver: target.sesTypeID,
                sessionType: target.type,
                msgFlag: message.msgFlag,
                sent: true,
              };
            } catch (error) {
              return {
                target: target.sesUUID,
                sessionID: target.id,
                receiver: target.sesTypeID,
                sessionType: target.type,
                msgFlag: message.msgFlag,
                sent: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          },
        };
      });

      const targetsResult = runParallel
        ? await Promise.all(jobs.map(job => job.execute()))
        : await (async () => {
            const results = [];
            for (const job of jobs) {
              results.push(await job.execute());
            }
            return results;
          })();

      return {
        ok: targetsResult.every(item => item.sent),
        currentUserId: bridgeVm.userInfo?.id,
        targets: targetsResult,
      };
    })()`,
    true
  );
}

async function verifyBatchResult(
  connector: CdpConnector,
  sessionIds: string[],
  text: string,
  currentUserId: number | undefined,
  timeoutMs: number
): Promise<BatchVerifyResult> {
  const deadline = Date.now() + timeoutMs;
  const probeText = text.slice(0, 20);

  while (Date.now() < deadline) {
    const result = await evaluateValue<BatchVerifyResult>(
      connector,
      `(() => {
        const requestedIds = ${JSON.stringify(sessionIds)};
        const expectedUserId = ${currentUserId ?? 'undefined'};
        const editorVm = document.querySelector('.chat-editor')?.__vue__;
        const sessions = Array.isArray(editorVm?.sortedSessions) ? editorVm.sortedSessions : [];

        function extractText(lastMessage) {
          const value = typeof lastMessage === 'string'
            ? (() => {
                try {
                  return JSON.parse(lastMessage);
                } catch {
                  return { content: [{ type: 0, text: String(lastMessage) }] };
                }
              })()
            : lastMessage;

          const content = Array.isArray(value?.content) ? value.content : [];
          return content
            .filter(item => item && typeof item.text === 'string')
            .map(item => item.text)
            .join('');
        }

        const matched = [];
        const pending = [];

        for (const requestId of requestedIds) {
          const target = sessions.find(item => item.sesUUID === requestId || String(item.id) === requestId);
          if (!target) {
            pending.push(requestId);
            continue;
          }

          const lastText = extractText(target.lastMessage);
          const senderMatched = typeof expectedUserId === 'number' ? target.lastSender === expectedUserId : true;
          const textMatched = lastText.includes(${JSON.stringify(probeText)});
          if (senderMatched && textMatched) {
            matched.push({
              target: target.sesUUID,
              lastSender: typeof target.lastSender === 'number' ? target.lastSender : null,
              lastText,
            });
          } else {
            pending.push(requestId);
          }
        }

        return {
          ok: pending.length === 0,
          pending,
          matched,
        };
      })()`
    );

    if (result.ok) {
      return result;
    }

    await sleep(300);
  }

  return {
    ok: false,
    pending: sessionIds,
    matched: [],
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  try {
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接到 KK9 渲染页面。');

    const probe = await probeBatchTargets(connector, options.sessionIds, options.text);
    if (!probe.ok) {
      console.error(`目标探测失败: ${probe.error || '未知错误'}`);
      if (probe.availableSessions?.length) {
        console.log('可用会话示例:');
        for (const session of probe.availableSessions) {
          console.log(`- sesUUID=${session.sesUUID}, id=${String(session.id)}, 名称=${session.showName || session.typeName || '未知'}`);
        }
      }
      process.exit(1);
    }

    console.log(`当前桥接会话: ${probe.currentSessionId || '未知'} / ${probe.currentSessionName || '未知'}`);
    console.log(`目标会话数: ${probe.targets?.length || 0}`);
    for (const target of probe.targets || []) {
      console.log(`- 目标: sesUUID=${target.sesUUID}, id=${String(target.id)}, 名称=${target.showName || target.typeName || '未知'}, 类型=${String(target.type)}`);
    }

    console.log('Payload 预览:');
    for (const item of probe.previewPayloads || []) {
      console.log(`- target=${item.target}, sessionID=${String(item.sessionID)}, receiver=${String(item.receiver)}, sessionType=${String(item.sessionType)}, msgFlag=${item.msgFlag || '(空)'}, contentType=${String(item.contentType)}`);
    }

    if (!options.send) {
      console.log('当前为探测模式，未实际发送。');
      console.log(`如需发送，请执行: pnpm exec tsx scripts/demo-batch-send.ts --session-ids "${options.sessionIds.join(',')}" --send --text "${options.text}"${options.parallel ? ' --parallel' : ''}`);
      return;
    }

    console.log(`准备批量发送，模式: ${options.parallel ? '并行' : '顺序'}`);
    const sendResult = await sendBatchBySessionIds(connector, options.sessionIds, options.text, options.parallel);
    if (!sendResult.ok) {
      console.log('发送返回包含失败项:');
      for (const item of sendResult.targets || []) {
        console.log(`- target=${item.target}, sent=${item.sent ? 'true' : 'false'}, error=${item.error || '(空)'}`);
      }
      throw new Error(sendResult.error || '批量发送失败');
    }

    console.log('发送调用已完成，开始通过会话列表 lastMessage 验证结果。');
    const verifyResult = await verifyBatchResult(
      connector,
      options.sessionIds,
      options.text,
      sendResult.currentUserId,
      options.verifyTimeoutMs
    );

    if (!verifyResult.ok) {
      throw new Error(`验证超时，未确认以下会话已更新: ${verifyResult.pending.join(', ')}`);
    }

    console.log('批量发送成功，以下会话已确认更新 lastMessage:');
    for (const item of verifyResult.matched) {
      console.log(`- target=${item.target}, lastSender=${String(item.lastSender)}, lastText=${item.lastText}`);
    }
  } finally {
    connector.disconnect();
  }
}

main().catch(error => {
  console.error('Demo 执行失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
