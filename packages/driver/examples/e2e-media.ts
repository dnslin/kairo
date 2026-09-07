import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { KK9Driver, type SendOptions, type SendResult } from '../src/index.js';
import { CdpClient } from '../src/cdp/client.js';
import { callIpcToData } from '../src/bridge/rpc.js';

// 本脚本会真实发送；确认值必须与当前登录用户、目标 ID、目标名称完全一致。
const targetId = process.env['KK9_MEDIA_TARGET_ID'] || '0-3585';
const targetName = process.env['KK9_MEDIA_TARGET_NAME'] || 'int2024';
const cdpConfig = {
  url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
  pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
};
const driver = new KK9Driver({ cdp: cdpConfig });
const probe = new CdpClient(cdpConfig);
const sent: string[] = [];
const marker = `Kairo媒体验收-${Date.now()}`;
const keep = process.env['KK9_MEDIA_KEEP'] === '1';
const verifyKeyCases = process.env['KK9_MEDIA_KEY_CASES'] === '1';

type Case = {
  name: string;
  contentType: number;
  messageType: string;
  send: (options: SendOptions) => Promise<SendResult>;
};
const cases: Case[] = [
  {
    name: 'UrlCard',
    contentType: 10,
    messageType: 'url-card',
    send: options =>
      driver.sendUrlCard(
        {
          title: marker,
          summary: '链接图文卡片验收',
          linkUrl: 'https://example.com',
          picUrl: 'https://www.microsoft.com/favicon.ico',
        },
        options
      ),
  },
  {
    name: 'BizMsg',
    contentType: 17,
    messageType: 'biz-message',
    send: options =>
      driver.sendBizMessage(
        {
          title: marker,
          content: '任务完成通知验收',
          summary: ['状态: 已完成', '来源: Kairo Driver'],
          bizUrl: 'https://example.com',
          bizType: 1,
        },
        options
      ),
  },
  {
    name: 'AppMsg',
    contentType: 8,
    messageType: 'app-message',
    send: options =>
      driver.sendAppMessage(
        {
          title: marker,
          content: '<p>这是一条<b>微应用</b>通知</p>',
          linkUrl: 'https://example.com',
        },
        options
      ),
  },
  {
    name: 'ChatRecord',
    contentType: 15,
    messageType: 'chat-record',
    send: options =>
      driver.sendChatRecord(
        {
          title: marker,
          msgArray: [
            { senderName: '验收甲', contentType: 0, content: '请检查合并转发详情' },
            { senderName: '验收乙', contentType: 0, content: '收到，这是第二条消息' },
          ],
        },
        options
      ),
  },
  {
    name: 'Voice',
    contentType: 2,
    messageType: 'voice',
    send: options =>
      driver.sendVoice(
        {
          text: '这是开罗原生语音消息验收，请确认声音可以正常播放。',
          voice: 'zh-CN-XiaoxiaoNeural',
        },
        options
      ),
  },
];
if (process.env['KK9_MEDIA_AUDIO_FILE']) {
  cases.push({
    name: 'VoiceFile',
    contentType: 2,
    messageType: 'voice',
    send: options => driver.sendVoice({ filePath: process.env['KK9_MEDIA_AUDIO_FILE']! }, options),
  });
}

async function main(): Promise<void> {
  try {
    const requested = process.argv.slice(2);
    for (const name of requested)
      assert.ok(
        cases.some(item => item.name === name),
        `未知或未配置的验收类型: ${name}`
      );
    const selected = requested.length ? cases.filter(item => requested.includes(item.name)) : cases;
    await probe.connect();
    const uid = await probe.evaluate<string>(`(() => {
      const main = document.querySelector('.main-page')?.__vue__;
      const editor = document.querySelector('.chat-editor, .message-editor')?.__vue__;
      return String(main?.userID || editor?.userID || '');
    })()`);
    assert.ok(uid, '无法识别当前登录用户');
    assert.equal(
      process.env['KK9_MEDIA_CONFIRM'],
      `${uid}:${targetId}:${targetName}`,
      '请设置 KK9_MEDIA_CONFIRM=当前UID:目标ID:目标名称 后运行'
    );
    await driver.connect();
    const session = (await driver.getSessions()).find(
      item => item.id === targetId && item.name === targetName
    );
    assert.ok(session, '目标会话 ID 与名称不匹配，停止发送');
    console.log(`已核对用户 ${uid} 与会话 ${session.name} (${session.id})；标记 ${marker}`);

    for (const item of selected) {
      const operationIds: Array<string | undefined> = verifyKeyCases
        ? [
            undefined,
            selected.length === 1 ? 'task-complete-001' : `task-complete-001-${item.name}`,
          ]
        : [`media-${item.name}-${randomUUID()}`];
      for (const operationId of operationIds) {
        const options: SendOptions = {
          targetSessionId: targetId,
          ...(operationId !== undefined ? { operationId } : {}),
        };
        const result = await item.send(options);
        if (result.messageId) sent.push(result.messageId);
        console.log(JSON.stringify({ name: item.name, ...result }));
        assert.equal(
          result.status,
          'delivered',
          `${item.name}: ${result.error || '未确认送达，禁止自动重发'}`
        );
        assert.match(result.messageId || '', /^[1-9]\d*$/, '必须返回服务端正式消息 ID');
        if (operationId !== undefined) {
          const repeated = await item.send(options);
          assert.equal(repeated.messageId, result.messageId, '相同 operationId 不应产生新消息');
          assert.equal(repeated.status, 'delivered');
          const queried = await driver.getSendStatus(operationId);
          assert.equal(queried.messageId, result.messageId, '状态回查应返回同一消息');
        }
        const history = await driver.getRecentMessages(100, session);
        const message = history.find(row => (row.messageId || row.id) === result.messageId);
        assert.ok(message, `${item.name} 必须能从真实历史读取`);
        assert.equal(
          message.raw?.['contentType'],
          item.contentType,
          '历史中的原生类型必须与发送类型一致'
        );
        assert.equal(
          message.messageType,
          item.messageType,
          '公开消息类型不能被音频缓存路径误判为文件'
        );
        const msgFlag = message.raw?.['msgFlag'];
        assert.equal(typeof msgFlag, 'string', '必须读到真实落库的关联键');
        assert.doesNotMatch(String(msgFlag), /[Cc]/, '新媒体关联键不得触发原生历史过滤');
        const nativeSessionId = message.raw?.['sessionID'];
        assert.ok(typeof nativeSessionId === 'number' || typeof nativeSessionId === 'string');
        for (const method of ['queryChatMessage', 'searchMessages'] as const) {
          const response = await callIpcToData<{ messages: Array<{ id: number | string }> }>(
            probe,
            method,
            [
              {
                sessionID: nativeSessionId,
                type: 'all',
                pageSize: 100,
                pageNo: method === 'searchMessages' ? -1 : 1,
                ...(method === 'searchMessages' ? { kwd: '' } : {}),
              },
            ]
          );
          assert.equal(response.code, 0, `${method} 原生调用失败`);
          assert.ok(
            response.data?.messages?.some(row => String(row.id) === result.messageId),
            `${item.name} 未出现在 ${method} 原生历史中`
          );
          console.log(
            JSON.stringify({
              name: item.name,
              operationId: operationId ?? null,
              messageId: result.messageId,
              msgFlag,
              nativeHistory: method,
              visible: true,
            })
          );
        }
        console.log(
          JSON.stringify({
            name: item.name,
            historyType: message.messageType,
            messageId: message.id,
            content: message.content,
          })
        );
      }
    }
    console.log(
      '原生发送、正式 ID、queryChatMessage/searchMessages 历史可见性、操作防重与状态回查通过。界面与语音播放另行检查，不能由落库替代。'
    );
  } finally {
    if (!keep) {
      for (const id of sent) {
        try {
          if (await driver.recallMessage(id, targetId)) {
            console.log(`已撤回验收消息 ${id}`);
          } else {
            process.exitCode = 1;
            console.error(`未撤回消息 ${id}: 原生撤回返回失败`);
          }
        } catch (error) {
          process.exitCode = 1;
          console.error(`未撤回消息 ${id}:`, error);
        }
      }
    } else {
      console.log(`保留供界面验收的消息: ${sent.join(', ')}`);
    }
    await driver.disconnect();
    await probe.disconnect();
  }
}

void main().catch(error => {
  console.error('富媒体真机验收失败:', error);
  process.exitCode = 1;
});
