/**
 * KK9 原生事件直连桥 (KK9EventBridge) 真机手动交互与实时监听验证脚本
 *
 * 运行方式:
 *   pnpm tsx scripts/verify-event-bridge-live.ts
 */

import readline from 'node:readline';
import { KK9Driver, KK9EventBridge } from '../packages/driver/src/index.js';

async function main(): Promise<void> {
  console.clear();
  console.log('========================================================================');
  console.log('🚀 KK9 原生事件直连桥 (EventBridge) 真机实时监听与功能验证');
  console.log('========================================================================\n');

  const cdpConfig = {
    url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
    pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
    timeoutMs: 10000,
  };

  // 1. 初始化原生事件直连桥
  const bridge = new KK9EventBridge({
    cdp: cdpConfig,
    bindingName: '__kkbot_native_bridge',
    maxFingerprints: 10000,
  });

  // 2. 初始化用于辅助测试发送的主驱动 (可选配合使用)
  const driver = new KK9Driver({
    cdp: cdpConfig,
  });

  // 3. 注册事件桥监听器
  bridge.on('status', status => {
    console.log(`📡 [连接状态变更] ${status}`);
  });

  bridge.on('heartbeat', uptimeMs => {
    // 降低心跳日志频率
    if (Math.floor(uptimeMs / 1000) % 30 === 0) {
      console.log(`💓 [心跳保活] 正常运行 ${(uptimeMs / 1000).toFixed(0)} 秒`);
    }
  });

  bridge.on('message', msg => {
    const typeLabel = msg.messageType ? `[${msg.messageType}]` : '[text]';
    const groupLabel = msg.sessionType === 'group' ? '👥 群聊' : '👤 私聊';
    console.log('\n------------------------------------------------------------------------');
    console.log(`📩 【收到新消息】 ${groupLabel} [${msg.sessionName || msg.sessionId}]`);
    console.log(`   ├─ 发送者: ${msg.sender} (ID: ${msg.senderId || '未知'})`);
    console.log(`   ├─ 消息类型: ${typeLabel} | 消息ID: ${msg.id}`);
    console.log(`   ├─ 时间: ${msg.time}`);
    console.log(`   ├─ 内容: ${msg.content || '(无纯文本)'}`);

    if (msg.images && msg.images.length > 0) {
      console.log(`   ├─ 包含图片: ${msg.images.length} 张 (${msg.images.map(img => img.filePath || img.url).join(', ')})`);
    }
    if (msg.fileInfo) {
      console.log(`   ├─ 包含文件: ${msg.fileInfo.fileName} (${msg.fileInfo.fileSize || '未知大小'})`);
    }
    if (msg.replyTo) {
      console.log(`   ├─ 引用回复: @${msg.replyTo.replyToSender}: ${msg.replyTo.replyToContent}`);
    }
    console.log('------------------------------------------------------------------------\n');
  });

  bridge.on('at', msg => {
    console.log('\n🎯🎯🎯 【捕获到 @ 提及事件】 🎯🎯🎯');
    console.log(`   会话: [${msg.sessionName}] | 发送者: ${msg.sender}`);
    console.log(`   @ 目标: ${msg.atAll ? '@全体成员' : '@我'}`);
    console.log(`   内容: ${msg.content}`);
    console.log('🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯🎯\n');
  });

  bridge.on('recalled', evt => {
    console.log('\n↩️↩️↩️ 【捕获到消息撤回事件】 ↩️↩️↩️');
    console.log(`   会话 ID: ${evt.sessionId}`);
    console.log(`   撤回消息 ID: ${evt.messageId}`);
    console.log(`   撤回操作者: ${evt.sender}`);
    console.log(`   时间: ${evt.time}`);
    console.log('↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️↩️\n');
  });

  bridge.on('error', err => {
    console.error('❌ [事件桥异常]:', err);
  });

  // 4. 执行连接
  console.log('⏳ 正在连接 KK9 渲染进程 (CDP: 9222)...');
  try {
    await bridge.connect();
    console.log('✅ 原生事件直连桥已成功注入并挂载！');
    console.log(`   - 状态: ${bridge.getStatus()}`);
    console.log(`   - 渲染进程 Hook 已激活: ${bridge.isAttached()}\n`);
  } catch (err) {
    console.error('❌ 连接失败，请确认 KK9 是否已使用 --remote-debugging-port=9222 启动。', err);
    process.exit(1);
  }

  // 5. 打印测试指南与交互控制台
  console.log('========================================================================');
  console.log('📋 手动验证推荐步骤 (可以在 KK9 客户端中进行操作):');
  console.log('   1. 【接收测试】在 KK9 中让好友发消息，或在任意群聊发送消息 -> 观察上方终端打印');
  console.log('   2. 【@ 提及测试】在群聊中发送包含 @机器人 或 @全体成员 的消息 -> 触发 🎯 艾特事件');
  console.log('   3. 【撤回测试】在 KK9 中发送一条消息并点击“撤回” -> 触发 ↩️ 撤回事件');
  console.log('   4. 【跨会话测试】保持在 A 会话界面，让 B 会话发消息 -> 验证无需切换会话即刻捕获');
  console.log('========================================================================\n');
  console.log('⌨️  交互指令 (输入后回车):');
  console.log('   - sessions                : 列出当前可见会话');
  console.log('   - send <sessionId> <text> : 通过主驱动向目标发送测试消息');
  console.log('   - status                  : 查看事件桥连接状态');
  console.log('   - help                    : 查看帮助');
  console.log('   - exit / quit             : 退出验证\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  rl.setPrompt('kkbot> ');
  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    const [cmd, ...args] = input.split(' ');

    try {
      if (cmd === 'exit' || cmd === 'quit') {
        console.log('正在断开并退出...');
        await bridge.disconnect();
        process.exit(0);
      } else if (cmd === 'status') {
        console.log(`当前事件桥状态: ${bridge.getStatus()} | Hook 注入: ${bridge.isAttached()}`);
      } else if (cmd === 'sessions') {
        console.log('正在读取会话列表...');
        await driver.connect();
        const sessions = await driver.getSessions();
        console.log(`找到 ${sessions.length} 个会话:`);
        sessions.forEach((s, idx) => {
          console.log(`  [${idx + 1}] ID: ${s.id.padEnd(10)} | 名称: ${s.name} (${s.type}) | 未读: ${s.unread}`);
        });
      } else if (cmd === 'send') {
        if (args.length < 2) {
          console.log('用法: send <sessionId> <text>');
        } else {
          const targetSessionId = args[0]!;
          const text = args.slice(1).join(' ');
          console.log(`正在向 ${targetSessionId} 发送: "${text}"...`);
          await driver.connect();
          const res = await driver.sendText(text, { targetSessionId });
          console.log(`发送结果: ${res.success ? '✅ 成功' : '❌ 失败'}`);
        }
      } else if (cmd === 'help') {
        console.log('可用指令: sessions, send <sessionId> <text>, status, exit');
      } else {
        console.log(`未知指令 "${cmd}"，输入 help 查看帮助`);
      }
    } catch (e) {
      console.error('执行指令出错:', e);
    }

    rl.prompt();
  });
}

void main();
