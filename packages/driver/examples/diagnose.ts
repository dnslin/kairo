#!/usr/bin/env tsx
/**
 * KK9 Driver 全功能实机诊断与测试套件 (Bridge 优先)
 *
 * 使用方式:
 *   pnpm --filter @kairo/driver run diagnose [command] [args...]
 *
 * 命令清单:
 *   status                      探测 CDP 端口与 Target 状态
 *   sessions                    读取全量会话列表 (Bridge IPC 驱动)
 *   messages [count=10] [target]读取指定会话最近消息列表 (默认: int2024)
 *   switch <target>             切换至指定会话 (私聊 "int2024" / 群聊 "测试123")
 *   send [target=int2024] <text>向目标后台发送纯文本 (不切换UI)
 *   rich [target=测试123] <md>  向目标后台发送富文本/Markdown (不切换UI)
 *   at [target=测试123] <text>  向群聊后台发送带 @全体成员 的消息 (不切换UI)
 *   reply <target> <msgId> <text>向指定消息发送引用回复
 *   image [target=int2024] <imgPath>向目标发送图片
 *   file [target=int2024] <filePath>向目标发送文件
 *   card <target> <url|biz|app|record> <JSON> 发送原生卡片
 *   voice <target> <text>       合成并发送语音
 *   voice-file <target> <path>  将本地音频转为原生语音发送
 *   recall <msgId> [sessionId]  通过原生 IPC 撤回消息
 *   user <uid>                  按 UID 单点查询员工档案
 *   org [timeoutMs=10000]       递归抽取企业组织架构全量员工
 *   listen                      启动实时事件监听 (message, at, recalled, 含图片与文件路径输出)
 */

import { KK9Driver } from '../src/index.js';
import type {
  KK9AppMsgOptions,
  KK9BizMsgOptions,
  KK9ChatRecordOptions,
  KK9UrlCardOptions,
  SendResult,
} from '../src/index.js';
import { decodeCliEscapedLineBreaks } from '../src/dom/rich-text.js';

const cdpUrl = process.env['CDP_URL'] || 'http://127.0.0.1:9222';
const pageMatch = process.env['PAGE_MATCH'] || 'renderer.html';
const DEFAULT_PRIVATE_TARGET = 'int2024';
const DEFAULT_GROUP_TARGET = '测试123';

const driver = new KK9Driver({
  cdp: {
    url: cdpUrl,
    pageMatch,
  },
  polling: {
    intervalMs: 2000,
  },
});

async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);

  switch (cmd) {
    case 'status': {
      console.log(`正在探测 CDP 服务: ${cdpUrl} ...`);
      try {
        const res = await fetch(`${cdpUrl.replace(/\/+$/, '')}/json`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const targets = (await res.json()) as Array<{
          title: string;
          type: string;
          url: string;
          webSocketDebuggerUrl?: string;
        }>;
        console.log(`✅ 成功连接到 CDP 服务，共发现 ${targets.length} 个 Target:\n`);
        targets.forEach((t, i) => {
          const isMatched = t.url.includes(pageMatch);
          console.log(`[${i + 1}] ${isMatched ? '👉 [MATCHED] ' : '   '}[${t.type}] ${t.title}`);
          console.log(`    URL: ${t.url}`);
          console.log(`    WS : ${t.webSocketDebuggerUrl || '无'}\n`);
        });
      } catch (err) {
        console.error(`❌ 连接 CDP 服务失败: ${err instanceof Error ? err.message : String(err)}`);
        console.error(`请确认 KK9 客户端是否已启动，且带启动参数: --remote-debugging-port=9222`);
      }
      break;
    }

    case 'sessions': {
      await driver.connect();
      console.log('✅ 已连接 CDP，正在通过 Bridge 获取全量会话...');
      const sessions = await driver.getSessions();
      console.log(`\n📋 共检索到 ${sessions.length} 个会话:`);
      sessions.forEach((s, i) => {
        const unreadTag = s.unread ? ` [未读${s.unreadCount ? ` (${s.unreadCount})` : ''}]` : '';
        const unreadAtTag = s.unreadAt ? ' [@提及未读]' : '';
        const activeTag = s.active ? ' [当前激活]' : '';
        console.log(
          `${(i + 1).toString().padStart(3)}. [${s.type.padEnd(7)}] ${s.name} (id: ${s.id})${unreadTag}${unreadAtTag}${activeTag}`
        );
        if (s.lastMessage) {
          console.log(`     └─ 最新消息: ${s.lastMessage} (${s.lastMessageTime || '无时间'})`);
        }
      });
      await driver.disconnect();
      break;
    }

    case 'messages': {
      const count = parseInt(args[0] || '10', 10);
      const target = args[1] || DEFAULT_PRIVATE_TARGET;
      await driver.connect();
      console.log(`正在后台读取会话 [${target}] 最近 ${count} 条消息 (无需切换UI)...\n`);
      const msgs = await driver.getRecentMessages(count, {
        id: target,
        name: target,
        type: 'private',
        unread: false,
      });
      msgs.forEach((m, i) => {
        const who = m.isMe ? '我 (发送)' : `${m.sender} (接收)`;
        console.log(`[${i + 1}] ${m.time} | ${who} [${m.origin || 'unknown'}]`);
        console.log(`    内容: ${m.content}`);
        if (m.images && m.images.length > 0) {
          console.log(
            `    图片附件 (${m.images.length}张): ${m.images.map(img => img.filePath || img.url).join(', ')}`
          );
        }
        if (m.fileInfo) {
          console.log(
            `    文件卡片: ${m.fileInfo.fileName} (${m.fileInfo.fileSize || ''}) -> ${m.fileInfo.filePath || '云端/未下载'}`
          );
        }
        console.log(`    NativeID: ${m.id}\n`);
      });
      await driver.disconnect();
      break;
    }

    case 'switch': {
      const sessionId = args[0] || DEFAULT_PRIVATE_TARGET;
      await driver.connect();
      console.log(`正在切换到会话: ${sessionId} ...`);
      const success = await driver.selectSession(sessionId);
      if (success) {
        const cur = await driver.getCurrentSession();
        console.log(`✅ 切换成功！当前激活: ${cur?.name} (${cur?.id})`);
      } else {
        console.error(`❌ 切换失败，未检索到目标会话`);
      }
      await driver.disconnect();
      break;
    }

    case 'send': {
      let target = DEFAULT_PRIVATE_TARGET;
      let text = '';
      if (args.length >= 2) {
        target = args[0] || DEFAULT_PRIVATE_TARGET;
        text = args.slice(1).join(' ');
      } else {
        text = args[0] || '';
      }

      text = decodeCliEscapedLineBreaks(text);
      if (!text) {
        console.error(`用法: pnpm diagnose send [目标会话=${DEFAULT_PRIVATE_TARGET}] <发送文本>`);
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在向 [${target}] 后台静默发送纯文本: "${text}" ...`);
      const res = await driver.sendText(text, { targetSessionId: target });
      if (res.success) {
        console.log(`✅ 发送成功！耗时: ${res.verifyLatencyMs || 0}ms (UI保持原状)`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'rich': {
      let target = DEFAULT_GROUP_TARGET;
      let md = '';
      if (args.length >= 2) {
        target = args[0] || DEFAULT_GROUP_TARGET;
        md = args.slice(1).join(' ');
      } else {
        md = args[0] || '**加粗富文本**\n- 状态: 正常';
      }

      md = decodeCliEscapedLineBreaks(md);
      await driver.connect();
      console.log(`正在向 [${target}] 后台静默发送富文本/Markdown...`);
      const res = await driver.sendRichText(md, { targetSessionId: target });
      if (res.success) {
        console.log(`✅ 富文本发送成功！耗时: ${res.verifyLatencyMs || 0}ms (UI保持原状)`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'at': {
      const target = args[0] || DEFAULT_GROUP_TARGET;
      const text = decodeCliEscapedLineBreaks(args[1] || '请各位关注当前工单进展');
      await driver.connect();
      console.log(`正在向群聊 [${target}] 后台发送 @全体成员 消息...`);
      const res = await driver.sendRichText(text, {
        targetSessionId: target,
        mentions: ['all'],
      });
      if (res.success) {
        console.log(`✅ @ 提及消息发送成功！(UI保持原状)`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'reply': {
      const target = args[0] || DEFAULT_GROUP_TARGET;
      const replyMsgId = args[1];
      const text = decodeCliEscapedLineBreaks(args[2] || '已收到，正在跟进中');
      if (!replyMsgId) {
        console.error(`用法: pnpm diagnose reply <目标会话> <被回复MsgID> [回复内容]`);
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在向 [${target}] 的消息 ${replyMsgId} 发送回复...`);
      const res = await driver.sendReply(replyMsgId, text, { targetSessionId: target });
      if (res.success) {
        console.log(`✅ 引用回复发送成功！`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'image': {
      const target = args[0] || DEFAULT_PRIVATE_TARGET;
      const imgPath = args[1];
      if (!imgPath) {
        console.error(
          `用法: pnpm diagnose image [目标会话=${DEFAULT_PRIVATE_TARGET}] <图片文件路径>`
        );
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在向 [${target}] 发送图片: ${imgPath} ...`);
      const res = await driver.sendImage(imgPath, { targetSessionId: target });
      if (res.success) {
        console.log(`✅ 图片发送成功！耗时: ${res.verifyLatencyMs || 0}ms`);
      } else {
        console.error(`❌ 发送图片失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'file': {
      const target = args[0] || DEFAULT_PRIVATE_TARGET;
      const filePath = args[1];
      if (!filePath) {
        console.error(`用法: pnpm diagnose file [目标会话=${DEFAULT_PRIVATE_TARGET}] <文件路径>`);
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在向 [${target}] 发送文件: ${filePath} ...`);
      const res = await driver.sendFile(filePath, { targetSessionId: target });
      if (res.success) {
        console.log(`✅ 文件发送成功！`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'card':
    case 'voice':
    case 'voice-file': {
      const [target, kind, ...rest] = args;
      if (!target || !kind) {
        throw new Error(
          '用法: card <目标> <url|biz|app|record> <JSON>；voice <目标> <文本>；voice-file <目标> <路径>'
        );
      }
      let send: () => Promise<SendResult>;
      const options = { targetSessionId: target };
      if (cmd === 'card') {
        const payload: unknown = JSON.parse(rest.join(' '));
        switch (kind) {
          case 'url':
            send = () => driver.sendUrlCard(payload as KK9UrlCardOptions, options);
            break;
          case 'biz':
            send = () => driver.sendBizMessage(payload as KK9BizMsgOptions, options);
            break;
          case 'app':
            send = () => driver.sendAppMessage(payload as KK9AppMsgOptions, options);
            break;
          case 'record':
            send = () => driver.sendChatRecord(payload as KK9ChatRecordOptions, options);
            break;
          default:
            throw new Error('卡片类型必须为 url、biz、app 或 record');
        }
      } else if (cmd === 'voice-file') {
        send = () => driver.sendVoice({ filePath: [kind, ...rest].join(' ') }, options);
      } else {
        send = () =>
          driver.sendVoice(
            { text: decodeCliEscapedLineBreaks([kind, ...rest].join(' ')) },
            options
          );
      }
      try {
        await driver.connect();
        const result = await send();
        console.log(JSON.stringify(result, null, 2));
        if (!result.success) process.exitCode = 1;
      } finally {
        await driver.disconnect();
      }
      break;
    }

    case 'recall': {
      const msgId = args[0];
      const target = args[1] || DEFAULT_PRIVATE_TARGET;
      if (!msgId) {
        console.error('用法: pnpm diagnose recall <消息ID> [会话ID/会话名]');
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在通过底层 IPC 撤回消息 ${msgId} (会话: ${target})...`);
      const ok = await driver.recallMessage(msgId, target);
      if (ok) {
        console.log('✅ 消息撤回指令执行成功！');
      } else {
        console.error('❌ 消息撤回失败');
      }
      await driver.disconnect();
      break;
    }

    case 'user': {
      const uid = args[0] || '5761';
      await driver.connect();
      console.log(`正在查询员工档案 (UID: ${uid})...`);
      const profile = await driver.getUserProfile(uid);
      if (profile) {
        console.log('\n👤 员工档案详情:');
        console.log(`   姓名: ${profile.name}`);
        console.log(`   工号: ${profile.loginName}`);
        console.log(`   岗位: ${profile.position || '无'}`);
        console.log(`   办公区: ${profile.region || '无'}`);
        console.log(`   签名: ${profile.signature || '无'}`);
        console.log(
          `   部门: ${profile.deptPaths?.map((d: { name: string }) => d.name).join(' > ') || '无'}\n`
        );
      } else {
        console.log('❌ 未检索到该员工档案');
      }
      await driver.disconnect();
      break;
    }

    case 'org': {
      const timeoutMs = parseInt(args[0] || '10000', 10);
      await driver.connect();
      console.log(`正在通过 Bridge IPC 递归抽取企业全量组织树成员 (限时 ${timeoutMs}ms)...`);
      const emps = await driver.getOrgEmployees(timeoutMs);
      console.log(`\n🏢 共抽取到 ${emps.length} 名员工档案:`);
      emps.slice(0, 15).forEach((e, idx) => {
        console.log(`   [${idx + 1}] ${e.name} (${e.loginName}) - ${e.position || '未设置岗位'}`);
      });
      if (emps.length > 15) {
        console.log(`   ... 剩余 ${emps.length - 15} 名员工已全部提取到内存`);
      }
      await driver.disconnect();
      break;
    }

    case 'listen': {
      driver.on('status', s => console.log(`[状态变迁] => ${s}`));
      driver.on('heartbeat', up => console.log(`[心跳保活] 在线: ${(up / 1000).toFixed(0)}s`));
      driver.on('message', m => {
        console.log('\n🔔 [收到消息]');
        console.log(`   会话: [${m.sessionType}] ${m.sessionName} (${m.sessionId})`);
        console.log(`   发送人: ${m.sender} @ ${m.time} (来源: ${m.origin || 'unknown'})`);
        console.log(`   内容: ${m.content}`);
        if (m.images && m.images.length > 0) {
          console.log(
            `   🖼️ 图片附件 (${m.images.length}张): ${m.images.map(img => img.filePath || img.url).join(', ')}`
          );
        }
        if (m.fileInfo) {
          console.log(
            `   📎 文件卡片: ${m.fileInfo.fileName} (${m.fileInfo.fileSize || ''}) -> ${m.fileInfo.filePath || '未下载/云端'}`
          );
        }
        console.log(`   NativeID: ${m.id}\n`);
      });
      driver.on('at', m => {
        console.log(`\n📢 [@ 提及] 收到 @ 消息: [${m.sender}] -> ${m.content}`);
      });
      driver.on('recalled', evt => {
        console.log(`\n↩️ [撤回事件] 消息 ${evt.messageId} 已被撤回 (会话: ${evt.sessionId})`);
      });
      driver.on('error', e => console.error(`[错误]`, e));

      await driver.connect();
      console.log('✅ 已连接 KK9，启动实时 Bridge 监听 (按 Ctrl+C 退出)...');
      driver.startPolling();

      process.on('SIGINT', () => {
        void (async () => {
          console.log('\n退出监听...');
          await driver.disconnect();
          process.exit(0);
        })();
      });
      break;
    }

    case 'help':
    default: {
      console.log(`
=== KK9 Driver 综合实机诊断与测试套件 (Bridge 优先) ===

使用方式:
  pnpm --filter @kairo/driver run diagnose <command> [args...]

【会话与消息】
  status                          探测 CDP 端口与 Target 状态
  sessions                        读取全量会话列表 (Bridge IPC 驱动)
  messages [count=10] [target]    读取指定会话最近消息列表 (默认: ${DEFAULT_PRIVATE_TARGET})
  switch <target>                 切换至指定会话 (私聊 "${DEFAULT_PRIVATE_TARGET}" / 群聊 "${DEFAULT_GROUP_TARGET}")
  send [target] <text>            向目标会话发送纯文本 (静默后台发送，不切换UI)
  rich [target] <markdown>        向目标会话发送富文本/Markdown (静默后台发送)
  at [target] <text>              向目标群聊发送带 @全体成员 消息 (静默后台发送)
  reply <target> <msgId> <text>   向目标消息发送引用回复
  image [target] <path>           向目标会话发送图片
  file [target] <path>            向目标会话发送本地文件
  card <target> <url|biz|app|record> <JSON> 发送原生卡片
  voice <target> <text>           使用 Edge TTS 合成并发送语音
  voice-file <target> <path>      转换本地音频并发送语音
  recall <msgId> [target]         撤回指定已发送消息

【组织架构与通讯录】
  user <uid>                      单点查询员工详细档案
  org [timeoutMs=10000]           递归抽取企业组织架构全量员工列表

【实时监听】
  listen                          启动实时事件监听 (message, at, recalled, 含图片与文件路径输出)
`);
      break;
    }
  }
}

void main().catch(err => {
  console.error('运行异常:', err);
  process.exit(1);
});
