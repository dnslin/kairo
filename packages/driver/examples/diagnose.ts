#!/usr/bin/env tsx
/**
 * KK9 Driver 综合实机诊断与测试套件
 * 使用方式:
 *   pnpm --filter @kkbot/driver run diagnose [command] [args...]
 * 命令:
 *   status           探测 CDP 端口与 Target 状态
 *   sessions         读取会话列表 (Vue 虚拟滚动穿透与 DOM 状态)
 *   messages [count] 读取当前会话最近消息 (默认 10 条)
 *   listen           启动实时轮询监听
 *   send <text>      向当前激活会话发送文本
 *   image <path>     向当前激活会话发送图片
 *   switch <id>      切换到指定会话
 */

import { KK9Driver } from '../src/index.js';

const cdpUrl = process.env['CDP_URL'] || 'http://127.0.0.1:9222';
const pageMatch = process.env['PAGE_MATCH'] || 'renderer.html';

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
        const targets = (await res.json()) as Array<{ title: string; type: string; url: string; webSocketDebuggerUrl?: string }>;
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
      console.log('✅ 已连接 CDP，正在获取会话列表...');
      const sessions = await driver.getSessions();
      console.log(`\n📋 共检索到 ${sessions.length} 个会话:`);
      sessions.forEach((s, i) => {
        const unreadTag = s.unread ? ` [未读${s.unreadCount ? ` (${s.unreadCount})` : ''}]` : '';
        const activeTag = s.active ? ' [当前激活]' : '';
        console.log(`${(i + 1).toString().padStart(3)}. [${s.type.padEnd(7)}] ${s.name} (id: ${s.id})${unreadTag}${activeTag}`);
        if (s.lastMessage) {
          console.log(`     └─ 最新消息: ${s.lastMessage} (${s.lastMessageTime || '无时间'})`);
        }
      });
      await driver.disconnect();
      break;
    }

    case 'messages': {
      const count = parseInt(args[0] || '10', 10);
      await driver.connect();
      const current = await driver.getCurrentSession();
      console.log(`当前激活会话: ${current ? `${current.name} (${current.id})` : '无'}`);
      console.log(`正在读取最近 ${count} 条消息...\n`);
      const msgs = await driver.getRecentMessages(count);
      msgs.forEach((m, i) => {
        const who = m.isMe ? '我 (发送)' : `${m.sender} (接收)`;
        console.log(`[${i + 1}] ${m.time} | ${who}`);
        console.log(`    指纹: ${m.id}`);
        console.log(`    内容: ${m.content}\n`);
      });
      await driver.disconnect();
      break;
    }

    case 'listen': {
      driver.on('status', (s) => console.log(`[状态变迁] => ${s}`));
      driver.on('heartbeat', (up) => console.log(`[心跳保活] 在线时长: ${(up / 1000).toFixed(0)}s`));
      driver.on('message', (m) => {
        console.log('\n🔔 [收到新消息]');
        console.log(`   会话: [${m.sessionType}] ${m.sessionName} (${m.sessionId})`);
        console.log(`   发送: ${m.sender} @ ${m.time}`);
        console.log(`   内容: ${m.content}`);
        console.log(`   指纹: ${m.id}\n`);
      });
      driver.on('error', (e) => console.error(`[错误]`, e));

      await driver.connect();
      console.log('✅ 已连接 KK9，启动实时轮询监听 (按 Ctrl+C 退出)...');
      driver.startPolling();

      process.on('SIGINT', async () => {
        console.log('\n退出监听...');
        await driver.disconnect();
        process.exit(0);
      });
      break;
    }

    case 'send': {
      let target = 'int2024';
      let text = '';
      if (args.length >= 2) {
        target = args[0] || 'int2024';
        text = args.slice(1).join(' ');
      } else {
        text = args[0] || '';
      }

      if (!text) {
        console.error('用法: pnpm diagnose send [目标会话=int2024] <发送文本>');
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在确保切换到目标会话: ${target} ...`);
      const switched = await driver.selectSession(target);
      if (!switched) {
        console.error(`❌ 切换到目标会话 ${target} 失败，为防误发已安全中止！`);
        await driver.disconnect();
        process.exit(1);
      }

      const current = await driver.getCurrentSession();
      console.log(`当前激活会话: ${current?.name} (${current?.id})`);
      console.log(`正在发送文本: "${text}" ...`);
      const res = await driver.sendText(text);
      if (res.success) {
        console.log(`✅ 发送成功！DOM 回读确认耗时: ${res.verifyLatencyMs || 0}ms`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'image': {
      let target = 'int2024';
      let imgPath = '';
      if (args.length >= 2) {
        target = args[0] || 'int2024';
        imgPath = args[1] || '';
      } else {
        imgPath = args[0] || '';
      }

      if (!imgPath) {
        console.error('用法: pnpm diagnose image [目标会话=int2024] <图片文件路径>');
        process.exit(1);
      }

      await driver.connect();
      console.log(`正在确保切换到目标会话: ${target} ...`);
      const switched = await driver.selectSession(target);
      if (!switched) {
        console.error(`❌ 切换到目标会话 ${target} 失败，为防误发已安全中止！`);
        await driver.disconnect();
        process.exit(1);
      }

      const current = await driver.getCurrentSession();
      console.log(`当前激活会话: ${current?.name} (${current?.id})`);
      console.log(`正在发送图片: ${imgPath} ...`);
      const res = await driver.sendImage(imgPath);
      if (res.success) {
        console.log(`✅ 发送图片成功！耗时: ${res.verifyLatencyMs || 0}ms`);
      } else {
        console.error(`❌ 发送图片失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'switch': {
      const sessionId = args[0];
      if (!sessionId) {
        console.error('用法: pnpm diagnose switch <会话ID或会话名>');
        process.exit(1);
      }
      await driver.connect();
      console.log(`正在切换到会话: ${sessionId} ...`);
      const success = await driver.selectSession(sessionId);
      if (success) {
        console.log(`✅ 切换成功！`);
      } else {
        console.error(`❌ 切换失败，未在视口或虚拟滚动列表中找到该会话`);
      }
      await driver.disconnect();
      break;
    }
    case 'special': {
      const target = 'int2024';
      const specialText = `【特殊符号测试】
换行 1
换行 2: <script>alert("xss")</script> & 'single' "double"
Emoji: 👍🎉🚀🤖🔥
特殊公式: a < b && b > c || x & y`;

      await driver.connect();
      console.log(`正在确保切换到目标会话: ${target} ...`);
      await driver.selectSession(target);
      console.log('正在发送特殊符号与多行富文本...');
      const res = await driver.sendText(specialText, { targetSessionId: '0-3585' });
      if (res.success) {
        console.log(`✅ 特殊字符文本发送并确认成功！耗时: ${res.verifyLatencyMs}ms`);
      } else {
        console.error(`❌ 发送失败: ${res.error}`);
      }
      await driver.disconnect();
      break;
    }

    case 'presend-guard': {
      await driver.connect();
      console.log('=== 开始测试防串线安全拦截 (PreSendCheck) ===');
      console.log('💡 说明: 此测试会临时将窗口切离目标以模拟串线场景，测试完毕后会自动切回！\n');

      const initialSession = await driver.getCurrentSession();
      const initialTarget = initialSession?.name || 'int2024';
      console.log(`0. 记录当前原始会话: ${initialTarget} (${initialSession?.id})`);

      try {
        console.log('1. [模拟误操作] 故意临时切换到其他会话 (如: 工单异常联络群)...');
        await driver.selectSession('工单异常联络群');
        const tempCur = await driver.getCurrentSession();
        console.log(`   当前临时处于: ${tempCur?.name} (${tempCur?.id})`);

        console.log('2. [触发安全红线] 尝试向 int2024 (0-3585) 发送敏感文本 (期望被拦截)...');
        const res = await driver.sendText('【绝密内容】这是一条绝对不应该发给其他人的敏感消息', {
          targetSessionId: '0-3585',
        });

        if (!res.success && res.error?.includes('发送前检查未通过')) {
          console.log(`\n🛡️ 拦截成功！系统安全拒绝发送: "${res.error}"`);
          console.log('✅ 防串线安全校验测试 100% 成功！绝密内容未发生泄露！');
        } else {
          console.error('❌ 安全校验失效！消息被异常放行！', res);
        }
      } finally {
        console.log(`\n3. [自动恢复] 正在自动切回原会话: ${initialTarget} ...`);
        await driver.selectSession(initialTarget);
        const restored = await driver.getCurrentSession();
        console.log(`   ✅ 恢复完成！当前会话已还原为: ${restored?.name} (${restored?.id})`);
        await driver.disconnect();
      }
      break;
    }

    case 'stress': {
      const count = parseInt(args[0] || '5', 10);
      const target = 'int2024';
      await driver.connect();
      console.log(`正在切换到目标会话: ${target} ...`);
      await driver.selectSession(target);
      console.log(`\n🚀 开始连续高频发送 ${count} 条消息...`);

      let successCount = 0;
      const start = Date.now();
      for (let i = 1; i <= count; i++) {
        const msg = `[高频压测 #${i}/${count}] 时序测试 ${Date.now()}`;
        process.stdout.write(`- 发送第 ${i} 条... `);
        const res = await driver.sendText(msg, { targetSessionId: '0-3585' });
        if (res.success) {
          console.log(`✅ 成功 (${res.verifyLatencyMs}ms)`);
          successCount++;
        } else {
          console.log(`❌ 失败: ${res.error}`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      const totalTime = Date.now() - start;
      console.log(`\n📊 压测总结: 成功 ${successCount}/${count} 条，总耗时: ${(totalTime / 1000).toFixed(2)}s`);
      await driver.disconnect();
      break;
    }

    case 'heartbeat': {
      let count = 0;
      driver.on('status', (s) => console.log(`[状态] => ${s}`));
      driver.on('heartbeat', (uptime) => {
        count++;
        console.log(`[心跳 #${count}] 连接正常保活，累计在线: ${(uptime / 1000).toFixed(1)}s`);
      });
      await driver.connect();
      console.log('✅ 已连接，正在连续观察 15 秒心跳保活机制...');
      await new Promise((r) => setTimeout(r, 15000));
      await driver.disconnect();
      console.log(`✅ 心跳测试完成，共收到 ${count} 次心跳事件`);
      break;
    }

    case 'help':
    default: {
      console.log(`
=== KK9 Driver 综合实机诊断与测试套件 ===

使用方式:
  pnpm --filter @kkbot/driver run diagnose <command> [args...]

【基础探测与会话】
  status                探测本地 CDP 端口与 Target 状态
  sessions              读取并打印 128+ 全量会话列表 (Vue 虚拟滚动穿透)
  messages [count=10]   读取当前会话最近消息列表
  switch <id/name>      精准切换到指定会话 (支持虚拟滚动自动定位)

【消息收发与监听】
  send [target] <text>  向目标会话发送文本 (默认: int2024, 带 DOM 回读)
  image [target] <path> 向目标会话发送图片 (默认: int2024, 剪贴板注入 + 按键粘贴)
  listen                启动实时消息轮询与自消息过滤监听

【高级专项与安全测试】
  special               特殊字符/多行排版/HTML/Emoji 富文本发送测试
  presend-guard         防串线原子校验测试 (验证会话不一致时 100% 拦截)
  stress [count=5]      高频连续发送稳定性与时序压测
  heartbeat             连续观察 15 秒 CDP 心跳保活状态
`);
      break;
    }
  }
}

void main().catch((err) => {
  console.error('运行异常:', err);
  process.exit(1);
});
