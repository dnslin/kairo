import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { callIpcToData } from '../src/bridge/rpc.js';
import type { CdpClient } from '../src/cdp/client.js';
import { KK9Driver } from '../src/index.js';
import type { KK9Message, SendResult } from '../src/types/index.js';

const PRIVATE_NAME = process.env['KK9_TEST_PRIVATE_NAME'] || 'int2024';
const PRIVATE_ID = process.env['KK9_TEST_PRIVATE_ID'] || '0-3585';
const GROUP_NAME = process.env['KK9_TEST_GROUP_NAME'] || '测试123';
const GROUP_ID = process.env['KK9_TEST_GROUP_ID'] || '1-29467';
const EXPECTED_USER_ID = process.env['KK9_TEST_USER_ID'] || '5761';
const EXPECTED_CONFIRMATION = `${EXPECTED_USER_ID}:${PRIVATE_ID}:${GROUP_ID}`;
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const prefix = `[Kairo真实回归测试 ${runId}]`;
const tempFile = path.join(os.tmpdir(), `kairo-real-${runId}.txt`);
const tempImage = path.join(os.tmpdir(), `kairo-real-${runId}.png`);

interface StepResult {
  name: string;
  ok: boolean;
  detail?: unknown;
  error?: string;
}

interface RecallTarget {
  label: string;
  messageId: string;
  sessionId: string;
}

interface RawMessage extends Record<string, unknown> {
  id?: string | number;
  msgID?: string | number;
  msgIdx?: string | number;
  sender?: string | number;
  sendTime?: string | number;
  content?: unknown;
}

interface NativeSession {
  id: string | number;
}

const steps: StepResult[] = [];
const recallTargets: RecallTarget[] = [];
const recalledKeys = new Set<string>();
let connected = false;
let fatalError: Error | undefined;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requiredStep<T>(name: string, run: () => Promise<T> | T): Promise<T> {
  try {
    const value = await run();
    steps.push({ name, ok: true });
    console.log(`PASS ${name}`);
    return value;
  } catch (error) {
    const message = errorText(error);
    steps.push({ name, ok: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
    throw error instanceof Error ? error : new Error(message);
  }
}

async function cleanupStep(name: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
    steps.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (error) {
    const message = errorText(error);
    steps.push({ name, ok: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
  }
}

function rawId(message: RawMessage): string {
  return String(message.id ?? message.msgID ?? '');
}

function isPositiveNativeId(value: string | undefined): value is string {
  if (!value) return false;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric > 0;
}

function rememberRecall(label: string, messageId: string | undefined, sessionId: string): void {
  if (!isPositiveNativeId(messageId)) return;
  const key = `${sessionId}:${messageId}`;
  if (recallTargets.some(target => `${target.sessionId}:${target.messageId}` === key)) return;
  recallTargets.push({ label, messageId, sessionId });
}

function containsTestImage(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsTestImage);
  const object = value as Record<string, unknown>;
  if (Number(object['width']) === 7 && Number(object['height']) === 11) {
    return true;
  }
  return Object.values(object).some(containsTestImage);
}

function findMessage(messages: KK9Message[], messageId?: string): KK9Message | undefined {
  if (!messageId) return undefined;
  return messages.find(message => message.id === messageId || message.messageId === messageId);
}

const driver = new KK9Driver({
  currentUserId: Number(EXPECTED_USER_ID),
  cdp: {
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
  },
});
const cdp = (driver as unknown as { cdp: CdpClient }).cdp;

async function exactNativeSession(sessionId: string): Promise<NativeSession> {
  const session = await cdp.evaluate<NativeSession | null>(`
    (() => {
      const target = ${JSON.stringify(sessionId)};
      const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
      const sessions = Array.isArray(editor?.sortedSessions) ? editor.sortedSessions : [];
      const found = sessions.find(item => item.sesUUID === target || String(item.id) === target);
      return found ? { id: found.id } : null;
    })()
  `);
  if (!session) throw new Error(`未找到精确 native 会话 ${sessionId}`);
  return session;
}

async function readRawMessages(sessionId: string, count = 100): Promise<RawMessage[]> {
  const session = await exactNativeSession(sessionId);
  const response = await callIpcToData<RawMessage[]>(
    cdp,
    'getMessages',
    [{ sessionID: session.id, count, endIdx: 2147483647, sendTime: 0 }],
    5000
  );
  if (response.code !== 0 || !Array.isArray(response.data)) {
    throw new Error(`getMessages(${sessionId}) 失败: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function findRawByContent(
  sessionId: string,
  contentMarker: string,
  timeoutMs = 8000
): Promise<RawMessage | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const messages = await readRawMessages(sessionId, 120);
    const found = messages.find(message => JSON.stringify(message.content).includes(contentMarker));
    if (found) return found;
    await sleep(400);
  }
  return undefined;
}

async function trackSendResult(
  label: string,
  result: SendResult,
  sessionId: string,
  contentMarker: string
): Promise<SendResult> {
  console.log(`${label}: ${JSON.stringify(result)}`);
  if (isPositiveNativeId(result.messageId)) {
    rememberRecall(label, result.messageId, sessionId);
  } else if (!result.isPreTrigger) {
    const persisted = await findRawByContent(sessionId, contentMarker);
    rememberRecall(`${label}（未知结果恢复）`, persisted ? rawId(persisted) : undefined, sessionId);
  }
  if (!result.success || !isPositiveNativeId(result.messageId)) {
    throw new Error(result.error || `${label} 未返回真实正 native ID`);
  }
  return result;
}

async function pollImageCandidates(
  privateBeforeIds: Set<string>,
  groupBeforeIds: Set<string>
): Promise<{ privateImages: RawMessage[]; groupImages: RawMessage[] }> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const [privateMessages, groupMessages] = await Promise.all([
      readRawMessages(PRIVATE_ID, 120),
      readRawMessages(GROUP_ID, 120),
    ]);
    const isCurrentImage = (message: RawMessage, beforeIds: Set<string>): boolean =>
      isPositiveNativeId(rawId(message)) &&
      !beforeIds.has(rawId(message)) &&
      String(message.sender ?? '') === EXPECTED_USER_ID &&
      containsTestImage(message);
    const privateImages = privateMessages.filter(message =>
      isCurrentImage(message, privateBeforeIds)
    );
    const groupImages = groupMessages.filter(message => isCurrentImage(message, groupBeforeIds));
    if (privateImages.length > 0 || groupImages.length > 0) {
      return { privateImages, groupImages };
    }
    await sleep(500);
  }
  return { privateImages: [], groupImages: [] };
}

try {
  await requiredStep('确认真实测试授权', () => {
    const confirmation = process.env['KK9_REAL_TEST_CONFIRM'];
    if (confirmation !== EXPECTED_CONFIRMATION) {
      throw new Error(
        `必须设置 KK9_REAL_TEST_CONFIRM=${EXPECTED_CONFIRMATION}，当前=${confirmation || '<未设置>'}`
      );
    }
  });

  fs.writeFileSync(tempFile, `${prefix}\n文件发送真实测试\n`, 'utf8');
  fs.writeFileSync(
    tempImage,
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAcAAAALCAYAAACzkJeoAAAAAXNSR0IArs4c6QAAABdJREFUKFNjvK1V+58BB2AclWRgwBsIAHlLG5fbQNpJAAAAAElFTkSuQmCC',
      'base64'
    )
  );

  await requiredStep('连接真实 KK9 renderer', async () => {
    await driver.connect();
    connected = true;
  });

  const sessions = await requiredStep('读取并锁定真实测试目标', async () => {
    const actualUserId = await cdp.evaluate<string>(`
      (() => {
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        return String(main?.userID || editor?.userID || '');
      })()
    `);
    if (actualUserId !== EXPECTED_USER_ID) {
      throw new Error(`登录用户不匹配: expected=${EXPECTED_USER_ID}, actual=${actualUserId}`);
    }

    const allSessions = await driver.getSessions();
    const privateMatches = allSessions.filter(
      session =>
        session.id === PRIVATE_ID &&
        session.name === PRIVATE_NAME &&
        session.type === 'private'
    );
    const groupMatches = allSessions.filter(
      session =>
        session.id === GROUP_ID && session.name === GROUP_NAME && session.type === 'group'
    );
    if (privateMatches.length !== 1 || groupMatches.length !== 1) {
      throw new Error(
        `目标必须精确唯一: ${JSON.stringify({ privateMatches, groupMatches })}`
      );
    }
    console.log(
      `TARGETS ${JSON.stringify({
        actualUserId,
        private: privateMatches[0],
        group: groupMatches[0],
        sameNameGroups: allSessions
          .filter(session => session.name === GROUP_NAME)
          .map(session => ({ id: session.id, type: session.type })),
      })}`
    );
    return { privateSession: privateMatches[0]!, groupSession: groupMatches[0]! };
  });
  const { privateSession, groupSession } = sessions;

  const privateText = `${prefix} 私聊文本`;
  const privateTextResult = await requiredStep('真实发送私聊文本', async () =>
    trackSendResult(
      'privateText',
      await driver.sendText(privateText, { targetSessionId: PRIVATE_ID }),
      PRIVATE_ID,
      privateText
    )
  );

  const richText = `**${prefix} 富文本**\n字面路径 C:\\new\\notes`;
  const privateRichResult = await requiredStep('真实发送私聊富文本与字面反斜杠', async () =>
    trackSendResult(
      'privateRich',
      await driver.sendRichText(richText, { targetSessionId: PRIVATE_ID }),
      PRIVATE_ID,
      `${prefix} 富文本`
    )
  );

  const privateFileResult = await requiredStep('真实发送私聊文件', async () =>
    trackSendResult(
      'privateFile',
      await driver.sendFile(tempFile, { targetSessionId: PRIVATE_ID }),
      PRIVATE_ID,
      path.basename(tempFile)
    )
  );

  const imageBaselines = await requiredStep('读取图片发送前双会话基线', async () => {
    const [privateBefore, groupBefore] = await Promise.all([
      readRawMessages(PRIVATE_ID, 120),
      readRawMessages(GROUP_ID, 120),
    ]);
    return {
      privateBeforeIds: new Set(privateBefore.map(rawId)),
      groupBeforeIds: new Set(groupBefore.map(rawId)),
    };
  });

  await requiredStep('真实发送并精确关联私聊图片', async () => {
    if (!(await driver.selectSession(GROUP_ID))) {
      throw new Error('无法在图片测试前切换至授权群聊');
    }
    await sleep(500);
    const result = await driver.sendImage(tempImage, { targetSessionId: PRIVATE_ID });
    const candidates = await pollImageCandidates(
      imageBaselines.privateBeforeIds,
      imageBaselines.groupBeforeIds
    );
    for (const message of candidates.privateImages) {
      rememberRecall('私聊图片', rawId(message), PRIVATE_ID);
    }
    for (const message of candidates.groupImages) {
      rememberRecall('误投群聊图片', rawId(message), GROUP_ID);
    }
    if (
      !result.success ||
      candidates.privateImages.length !== 1 ||
      candidates.groupImages.length !== 0
    ) {
      throw new Error(
        `图片目标或落库异常: ${JSON.stringify({ result, candidates })}`
      );
    }
  });

  const groupText = `${prefix} 群聊普通消息（无群体提醒）`;
  const groupTextResult = await requiredStep('真实发送群聊普通消息', async () =>
    trackSendResult(
      'groupText',
      await driver.sendText(groupText, { targetSessionId: GROUP_ID }),
      GROUP_ID,
      groupText
    )
  );
  const groupTextRaw = await requiredStep('读取群聊原消息 native 元数据', async () => {
    const messages = await readRawMessages(GROUP_ID, 120);
    const found = messages.find(message => rawId(message) === groupTextResult.messageId);
    if (!found) throw new Error('未读取到群聊原消息 raw 数据');
    return found;
  });

  const replyText = `${prefix} 引用回复`;
  const groupReplyResult = await requiredStep('真实发送群聊引用回复', async () =>
    trackSendResult(
      'groupReply',
      await driver.sendReply(
        {
          messageId: groupTextResult.messageId,
          msgIdx: Number(groupTextRaw.msgIdx || 0),
          sender: 'Kairo真实回归测试',
          content: groupText,
        },
        replyText,
        { targetSessionId: GROUP_ID }
      ),
      GROUP_ID,
      replyText
    )
  );

  await sleep(1000);
  const privateMessages = await requiredStep('真实回读私聊历史', () =>
    driver.getRecentMessages(100, privateSession)
  );
  await requiredStep('确认私聊文本落库', () => {
    if (!findMessage(privateMessages, privateTextResult.messageId)) {
      throw new Error('未按 native messageId 回读到私聊文本');
    }
  });
  await requiredStep('确认私聊富文本及字面路径无损', () => {
    const message = findMessage(privateMessages, privateRichResult.messageId);
    if (!message) throw new Error('未按 native messageId 回读到私聊富文本');
    if (!message.content.includes(String.raw`C:\new\notes`)) {
      throw new Error(`字面路径被改写: ${JSON.stringify(message.content)}`);
    }
  });
  await requiredStep('确认私聊文件落库', () => {
    const message = findMessage(privateMessages, privateFileResult.messageId);
    if (!message) throw new Error('未按 native messageId 回读到私聊文件');
    if (!message.fileInfo && !message.content.includes(path.basename(tempFile))) {
      throw new Error('回读消息缺少文件信息');
    }
  });

  const groupMessages = await requiredStep('真实回读群聊历史', () =>
    driver.getRecentMessages(100, groupSession)
  );
  await requiredStep('确认群聊文本落库且无群体提醒', () => {
    const message = findMessage(groupMessages, groupTextResult.messageId);
    if (!message || !message.content.includes(groupText)) {
      throw new Error('群聊文本正文不匹配');
    }
    if (message.atAll || message.mentions?.isAtAll) {
      throw new Error('群聊普通消息被错误标记为 @全体');
    }
  });
  await requiredStep('确认群聊回复原生引用关系与正文', async () => {
    const rawMessages = await readRawMessages(GROUP_ID, 120);
    const reply = rawMessages.find(message => rawId(message) === groupReplyResult.messageId);
    const content = reply?.content as Record<string, unknown> | undefined;
    if (
      Number(reply?.['contentType']) !== 13 ||
      String(content?.['replyedMsgId']) !== groupTextResult.messageId ||
      !JSON.stringify(content?.['replyContent']).includes(replyText)
    ) {
      throw new Error(`引用回复 raw 结构不匹配: ${JSON.stringify(reply)}`);
    }
  });

  await requiredStep('真实标记私聊已读', async () => {
    if (!(await driver.markSessionRead(PRIVATE_ID))) {
      throw new Error('私聊 readMessage 未获成功 ack');
    }
  });
  await requiredStep('真实标记群聊已读', async () => {
    if (!(await driver.markSessionRead(GROUP_ID))) {
      throw new Error('群聊 readMessage 未获成功 ack');
    }
  });
  await requiredStep('真实读取组织架构', async () => {
    const employees = await driver.getOrgEmployees(15000);
    if (employees.length === 0) throw new Error('组织架构返回 0 人');
    console.log(`ORG_EMPLOYEES ${employees.length}`);
  });
} catch (error) {
  fatalError = error instanceof Error ? error : new Error(String(error));
} finally {
  if (connected) {
    for (const target of [...recallTargets].reverse()) {
      await cleanupStep(`真实撤回清理：${target.label}`, async () => {
        let recalled = await driver.recallMessage(target.messageId, target.sessionId);
        if (!recalled) {
          await sleep(500);
          recalled = await driver.recallMessage(target.messageId, target.sessionId);
        }
        if (!recalled) throw new Error(`撤回失败 messageId=${target.messageId}`);
        recalledKeys.add(`${target.sessionId}:${target.messageId}`);
      });
    }
    await cleanupStep('断开真实 KK9', () => driver.disconnect());
  }
  for (const file of [tempFile, tempImage]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 临时文件可能尚未创建或已被系统清理。
    }
  }
}

const failures = steps.filter(result => !result.ok);
const cleanupMissing = recallTargets.filter(
  target => !recalledKeys.has(`${target.sessionId}:${target.messageId}`)
);
console.log(
  `REAL_TEST_SUMMARY ${JSON.stringify({
    runId,
    total: steps.length,
    passed: steps.length - failures.length,
    failed: failures.length,
    fatalError: fatalError?.message,
    cleanupTargets: recallTargets.length,
    cleanupMissing,
    failures,
  })}`
);
if (fatalError || failures.length > 0 || cleanupMissing.length > 0) process.exitCode = 1;
