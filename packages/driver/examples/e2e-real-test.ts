import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { KK9Driver } from '../src/index.js';
import type { KK9Message, KK9Session, SendResult } from '../src/types/index.js';

const PRIVATE_NAME = 'int2024';
const GROUP_NAME = '测试123';
const GROUP_ID = process.env['KK9_TEST_GROUP_ID'] || '1-29467';
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const prefix = `[KKBot真实回归测试 ${runId}]`;
const tempFile = path.join(os.tmpdir(), `kkbot-real-${runId}.txt`);
const tempImage = path.join(os.tmpdir(), `kkbot-real-${runId}.png`);

fs.writeFileSync(tempFile, `${prefix}\n文件发送真实测试\n`, 'utf8');
fs.writeFileSync(
  tempImage,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64'
  )
);

const driver = new KK9Driver({
  currentUserId: 5761,
  cdp: {
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
  },
});

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

const steps: StepResult[] = [];
const recallTargets: RecallTarget[] = [];
let connected = false;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function step<T>(name: string, run: () => Promise<T> | T): Promise<T | undefined> {
  try {
    const value = await run();
    steps.push({ name, ok: true });
    console.log(`PASS ${name}`);
    return value;
  } catch (error) {
    const message = errorText(error);
    steps.push({ name, ok: false, error: message });
    console.error(`FAIL ${name}: ${message}`);
    return undefined;
  }
}

function requireSend(label: string, result: SendResult): SendResult {
  console.log(`${label}: ${JSON.stringify(result)}`);
  if (!result.success) {
    throw new Error(result.error || `${label} 未返回 success`);
  }
  return result;
}

function rememberRecall(label: string, result: SendResult, session: KK9Session): void {
  if (result.messageId) {
    recallTargets.push({ label, messageId: result.messageId, sessionId: session.id });
  }
}

function findMessage(messages: KK9Message[], messageId?: string): KK9Message | undefined {
  if (!messageId) return undefined;
  return messages.find(message => message.id === messageId || message.messageId === messageId);
}

try {
  await step('连接真实 KK9 renderer', async () => {
    await driver.connect();
    connected = true;
  });
  if (!connected) throw new Error('无法连接真实 KK9，停止所有发送');

  const sessions = await step('读取真实会话列表', () => driver.getSessions());
  if (!sessions) throw new Error('无法读取真实会话列表，停止所有发送');

  const privateMatches = sessions.filter(session => session.name === PRIVATE_NAME);
  const sameNameGroups = sessions.filter(session => session.name === GROUP_NAME);
  const groupMatches = sameNameGroups.filter(session => session.id === GROUP_ID);
  console.log(
    `TARGETS ${JSON.stringify({
      private: privateMatches.map(session => ({ id: session.id, name: session.name, type: session.type })),
      groupCandidates: sameNameGroups.map(session => ({ id: session.id, name: session.name, type: session.type })),
      selectedGroupId: GROUP_ID,
    })}`
  );
  if (privateMatches.length !== 1 || groupMatches.length !== 1) {
    throw new Error(
      `目标必须唯一：${PRIVATE_NAME}=${privateMatches.length}, ${GROUP_NAME}/${GROUP_ID}=${groupMatches.length}`
    );
  }

  const privateSession = privateMatches[0];
  const groupSession = groupMatches[0];
  if (!privateSession || !groupSession) throw new Error('目标会话解析失败');

  const privateBeforeImage = await step('读取私聊发送前历史', () =>
    driver.getRecentMessages(30, privateSession)
  );
  const beforeImageIds = new Set((privateBeforeImage ?? []).map(message => message.id));

  const privateText = `${prefix} 私聊文本`;
  const privateTextResult = await step('真实发送私聊文本', async () => {
    const result = requireSend(
      'privateText',
      await driver.sendText(privateText, { targetSessionId: privateSession.id })
    );
    rememberRecall('私聊文本', result, privateSession);
    return result;
  });

  const richText = `**${prefix} 富文本**\n字面路径 C:\\new\\notes`;
  const privateRichResult = await step('真实发送私聊富文本与字面反斜杠', async () => {
    const result = requireSend(
      'privateRich',
      await driver.sendRichText(richText, { targetSessionId: privateSession.id })
    );
    rememberRecall('私聊富文本', result, privateSession);
    return result;
  });

  const privateFileResult = await step('真实发送私聊文件', async () => {
    const result = requireSend(
      'privateFile',
      await driver.sendFile(tempFile, { targetSessionId: privateSession.id })
    );
    rememberRecall('私聊文件', result, privateSession);
    return result;
  });

  await step('真实发送私聊图片', async () => {
    requireSend(
      'privateImage',
      await driver.sendImage(tempImage, { targetSessionId: privateSession.id })
    );
  });

  const groupText = `${prefix} 群聊普通消息（无群体提醒）`;
  const groupTextResult = await step('真实发送群聊普通消息', async () => {
    const result = requireSend(
      'groupText',
      await driver.sendText(groupText, { targetSessionId: groupSession.id })
    );
    rememberRecall('群聊文本', result, groupSession);
    return result;
  });

  const groupReplyResult = await step('真实发送群聊引用回复', async () => {
    if (!groupTextResult?.messageId) throw new Error('群聊原消息缺少 native messageId');
    const result = requireSend(
      'groupReply',
      await driver.sendReply(
        {
          messageId: groupTextResult.messageId,
          sender: 'KKBot真实回归测试',
          content: groupText,
        },
        `${prefix} 引用回复`,
        { targetSessionId: groupSession.id }
      )
    );
    rememberRecall('群聊回复', result, groupSession);
    return result;
  });

  await sleep(1500);

  const privateMessages = await step('真实回读私聊历史', () =>
    driver.getRecentMessages(50, privateSession)
  );
  if (privateMessages) {
    await step('确认私聊文本落库', () => {
      if (!findMessage(privateMessages, privateTextResult?.messageId)) {
        throw new Error('未按 native messageId 回读到私聊文本');
      }
    });
    await step('确认私聊富文本及字面路径无损', () => {
      const message = findMessage(privateMessages, privateRichResult?.messageId);
      if (!message) throw new Error('未按 native messageId 回读到私聊富文本');
      if (!message.content.includes(String.raw`C:\new\notes`)) {
        throw new Error(`字面路径被改写: ${JSON.stringify(message.content)}`);
      }
    });
    await step('确认私聊文件落库', () => {
      const message = findMessage(privateMessages, privateFileResult?.messageId);
      if (!message) throw new Error('未按 native messageId 回读到私聊文件');
      if (!message.fileInfo && !message.content.includes(path.basename(tempFile))) {
        throw new Error('回读消息缺少文件信息');
      }
    });

    const imageMessage = privateMessages.find(
      message => !beforeImageIds.has(message.id) && (message.images?.length ?? 0) > 0
    );
    if (imageMessage) {
      recallTargets.push({
        label: '私聊图片',
        messageId: imageMessage.id,
        sessionId: privateSession.id,
      });
      steps.push({ name: '确认私聊图片落库', ok: true, detail: imageMessage.id });
      console.log(`PASS 确认私聊图片落库: ${imageMessage.id}`);
    } else {
      steps.push({ name: '确认私聊图片落库', ok: false, error: '未识别到新增自发图片消息' });
      console.error('FAIL 确认私聊图片落库: 未识别到新增自发图片消息');
    }
  }

  const groupMessages = await step('真实回读群聊历史', () =>
    driver.getRecentMessages(50, groupSession)
  );
  if (groupMessages) {
    await step('确认群聊文本落库', () => {
      if (!findMessage(groupMessages, groupTextResult?.messageId)) {
        throw new Error('未按 native messageId 回读到群聊文本');
      }
    });
    await step('确认群聊回复落库', () => {
      if (!findMessage(groupMessages, groupReplyResult?.messageId)) {
        throw new Error('未按 native messageId 回读到群聊回复');
      }
    });
  }

  await step('真实标记私聊已读', async () => {
    if (!(await driver.markSessionRead(privateSession.id))) {
      throw new Error('私聊 readMessage 未获成功 ack');
    }
  });
  await step('真实标记群聊已读', async () => {
    if (!(await driver.markSessionRead(groupSession.id))) {
      throw new Error('群聊 readMessage 未获成功 ack');
    }
  });

  await step('真实读取组织架构', async () => {
    const employees = await driver.getOrgEmployees(15000);
    if (employees.length === 0) throw new Error('组织架构返回 0 人');
    console.log(`ORG_EMPLOYEES ${employees.length}`);
  });
} finally {
  if (connected) {
    for (const target of [...recallTargets].reverse()) {
      await step(`真实撤回清理：${target.label}`, async () => {
        const recalled = await driver.recallMessage(target.messageId, target.sessionId);
        if (!recalled) throw new Error(`撤回失败 messageId=${target.messageId}`);
      });
    }
    await step('断开真实 KK9', () => driver.disconnect());
  }
  for (const file of [tempFile, tempImage]) {
    try {
      fs.unlinkSync(file);
    } catch {
      // 临时文件可能已被外部清理。
    }
  }
}

const failures = steps.filter(result => !result.ok);
console.log(`REAL_TEST_SUMMARY ${JSON.stringify({ runId, total: steps.length, passed: steps.length - failures.length, failed: failures.length, failures })}`);
if (failures.length > 0) process.exitCode = 1;
