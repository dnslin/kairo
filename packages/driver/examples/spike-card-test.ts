import { setTimeout as sleep } from 'node:timers/promises';
import { CdpClient } from '../src/cdp/client.js';
import {
  RENDERER_IPC_HELPERS_SCRIPT,
  RENDERER_SESSION_RESOLVER_SCRIPT,
  encodeRendererPayload,
} from '../src/bridge/renderer-script.js';

interface CustomSendResult {
  contentType: number;
  typeName: string;
  success: boolean;
  code?: number;
  error?: string;
  nativeId?: number;
  persistedId?: number | string;
  response?: unknown;
}

const TARGET_NAME = 'int2024';
const TARGET_ID = '0-3585';

async function main() {
  console.log('=== KK9 非文本/卡片消息服务端可行性 Spike 测试 ===\n');

  const cdp = new CdpClient({
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
  });

  try {
    console.log('1. 连接 KK9 CDP...');
    await cdp.connect();
    console.log('   ✅ CDP 已连接\n');

    // 验证当前用户信息与目标会话
    const sessionInfo = await cdp.evaluate<{
      myUid: number;
      myName: string;
      targetSes: {
        id: number | string;
        type: number;
        sesUUID: string;
        typeID: number | string;
        sesTypeID?: number | string;
        name: string;
      } | null;
    }>(`
      (() => {
        const main = document.querySelector('.main-page')?.__vue__;
        const editor = document.querySelector('.chat-editor, .message-editor, .chat-sendArea')?.__vue__;
        ${RENDERER_SESSION_RESOLVER_SCRIPT}
        const matched = resolveRendererSession(editor?.sortedSessions, '${TARGET_NAME}')
          || resolveRendererSession(editor?.sortedSessions, '${TARGET_ID}');
        return {
          myUid: main?.userID || editor?.userID,
          myName: main?.userName || editor?.userName || '测试员',
          targetSes: matched ? {
            id: matched.id,
            type: matched.type,
            sesUUID: matched.sesUUID,
            typeID: matched.typeID,
            sesTypeID: matched.sesTypeID,
            name: matched.typeName || matched.name
          } : null
        };
      })()
    `);

    if (!sessionInfo?.targetSes) {
      throw new Error(`未找到目标测试会话: ${TARGET_NAME} (${TARGET_ID})`);
    }

    console.log(`2. 目标会话确认: [${sessionInfo.targetSes.name}] (id: ${sessionInfo.targetSes.id}, type: ${sessionInfo.targetSes.type})`);
    console.log(`   当前操作者 UID: ${sessionInfo.myUid} (${sessionInfo.myName})\n`);

    // 通用发送函数
    async function sendCustomMessage(
      typeName: string,
      contentType: number,
      content: unknown
    ): Promise<CustomSendResult> {
      console.log(`--------------------------------------------------`);
      console.log(`▶ 测试发送类型: ${typeName} (contentType: ${contentType})`);
      console.log(`  Payload:`, JSON.stringify(content, null, 2));

      const payload = {
        targetSes: sessionInfo.targetSes,
        myUid: sessionInfo.myUid,
        myName: sessionInfo.myName,
        contentType,
        content,
        msgFlag: `KAIRO_SPIKE_${contentType}_${Date.now()}`
      };

      const encoded = encodeRendererPayload(payload);

      const res = await cdp.evaluate<{
        step: string;
        success: boolean;
        code?: number;
        error?: string;
        nativeId?: number;
        persistedId?: number | string;
        sendRes?: unknown;
      }>(`
        (async () => {
          const electron = window.require ? window.require('electron') : null;
          const ipc = window.ipcRenderer || electron?.ipcRenderer;
          ${RENDERER_IPC_HELPERS_SCRIPT}
          const callIpc = callKairoIpcWithTimeout;

          const data = JSON.parse(decodeURIComponent(${encoded}));
          const targetSes = data.targetSes;
          const myUid = data.myUid;
          const myName = data.myName;

          const msgObj = {
            contentType: data.contentType,
            content: data.content,
            sender: myUid,
            senderName: myName,
            senderNameEN: myName,
            senderNameTC: myName,
            receiver: targetSes.typeID || targetSes.sesTypeID,
            sendTime: Math.floor(Date.now() / 1000),
            sessionType: targetSes.type,
            sessionID: targetSes.id,
            atState: 1,
            atMemberIDList: [],
            status: 1,
            type: 0,
            msgFlag: data.msgFlag,
            deviceID: ''
          };

          // 1. insertSendBefoeMsg
          const insertRes = await callIpc(5000, 'insertSendBefoeMsg', msgObj);
          if (!insertRes || insertRes.code !== 0 || !insertRes.data) {
            return {
              step: 'insertSendBefoeMsg',
              success: false,
              code: insertRes?.code,
              error: insertRes?.error || 'insertSendBefoeMsg 失败'
            };
          }

          const nativeId = insertRes.data.id;
          msgObj.id = nativeId;
          msgObj.msgIdx = insertRes.data.msgIdx;

          // 2. sendMessageNew
          const sendRes = await callIpc(8000, 'sendMessageNew', {
            id: nativeId,
            content: msgObj.content,
            contentType: msgObj.contentType,
            sender: msgObj.sender,
            senderName: msgObj.senderName,
            senderNameEN: msgObj.senderNameEN,
            senderNameTC: msgObj.senderNameTC,
            receiver: msgObj.receiver,
            sessionType: msgObj.sessionType,
            sessionID: msgObj.sessionID,
            atState: msgObj.atState,
            msgFlag: msgObj.msgFlag,
            atMemberIDList: msgObj.atMemberIDList,
            type: msgObj.type
          });

          if (!sendRes || sendRes.code !== 0) {
            return {
              step: 'sendMessageNew',
              success: false,
              code: sendRes?.code,
              error: sendRes?.error || sendRes?.message || '服务端拒绝或返回错误',
              sendRes
            };
          }

          // 3. 验证是否成功落库确认
          let persistedId;
          for (let i = 0; i < 8; i++) {
            const query = await callIpc(3000, 'getMessages', {
              sessionID: targetSes.id,
              count: 10,
              endIdx: 2147483647,
              sendTime: 0
            });
            if (query?.code === 0 && Array.isArray(query.data)) {
              const match = query.data.find(m => m && m.msgFlag === data.msgFlag && Number(m.id) > 0);
              if (match) {
                persistedId = match.id;
                break;
              }
            }
            await new Promise(r => setTimeout(r, 250));
          }

          return {
            step: 'done',
            success: true,
            code: 0,
            nativeId,
            persistedId,
            sendRes
          };
        })()
      `, 15000);

      const result: CustomSendResult = {
        contentType,
        typeName,
        success: res?.success ?? false,
        code: res?.code,
        error: res?.error,
        nativeId: res?.nativeId,
        persistedId: res?.persistedId,
        response: res?.sendRes
      };

      if (result.success && result.persistedId) {
        console.log(`  ✅ 发送成功！服务端未拦截。落库消息 ID: ${result.persistedId}`);
      } else {
        console.log(`  ❌ 发送受阻/被拦截！步骤: ${res?.step}, Code: ${res?.code}, 错误: ${res?.error}`);
      }

      return result;
    }

    const testResults: CustomSendResult[] = [];

    // 测试用例 1: UrlCard (10) - 网页分享卡片
    const urlCardResult = await sendCustomMessage('UrlCard (链接卡片)', 10, {
      title: '[Spike测试] Kairo 系统部署报告',
      summary: '自动化构建成功，这是一条免模板的 UrlCard 原生卡片消息测试。',
      linkUrl: 'https://example.com/build/1024',
      picUrl: 'https://www.google.com/favicon.ico'
    });
    testResults.push(urlCardResult);
    await sleep(1500);

    // 测试用例 2: BizMsg (17) - 业务工作通知卡片
    const bizMsgResult = await sendCustomMessage('BizMsg (业务任务卡片)', 17, {
      title: '[Spike测试] 任务催办通知',
      content: '您的数字化需求单已进入待审批状态，请及时处理。',
      summary: [
        '单据编号: REQ-20260906-01',
        '提交人员: 董仕林',
        '单据状态: 待审批'
      ],
      bizUrl: 'https://example.com/oa/flow/123',
      bizType: 1
    });
    testResults.push(bizMsgResult);
    await sleep(1500);

    // 测试用例 3: AppMsg (8) - 工作台微应用图文通知
    const appMsgResult = await sendCustomMessage('AppMsg (微应用通知)', 8, {
      title: '[Spike测试] 微应用系统提醒',
      content: '<p>这是一条<b>微应用</b>风格的富文本通知消息测试。</p>',
      linkUrl: 'https://example.com/app/dashboard',
      pcAppCode: 'test_app'
    });
    testResults.push(appMsgResult);
    await sleep(1500);

    // 测试用例 4: GroupInfoShare (14) - 群名片推荐
    const groupShareResult = await sendCustomMessage('GroupInfoShare (群名片推荐)', 14, {
      groupId: 29467,
      groupName: '测试123',
      ownerName: '管理员'
    });
    testResults.push(groupShareResult);

    console.log('\n==================================================');
    console.log('📊 Spike 测试汇总:');
    for (const r of testResults) {
      console.log(` - ${r.typeName} (type=${r.contentType}): ${r.success ? '✅ 服务端放行 (ID=' + r.persistedId + ')' : '❌ 服务端拦截 (' + (r.error || 'code=' + r.code) + ')'}`);
    }
    console.log('==================================================\n');

  } catch (err) {
    console.error('Spike 测试执行异常:', err);
    process.exitCode = 1;
  } finally {
    await cdp.disconnect();
  }
}

void main();
