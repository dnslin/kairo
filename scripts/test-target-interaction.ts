import { setTimeout as sleep } from 'node:timers/promises';
import { KK9Driver } from '../packages/driver/src/index.js';

async function main(): Promise<void> {
  console.log('====================================================');
  console.log('🔍 KK9 真实目标会话 (init2024 & 测试123) 连通性与结构探查');
  console.log('====================================================\n');

  const driver = new KK9Driver({
    cdp: {
      url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
      pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
    },
    polling: {
      intervalMs: 1500,
    },
  });

  try {
    console.log('1. 正在连接 CDP (127.0.0.1:9222)...');
    await driver.connect();
    console.log('  ✅ CDP 连接成功！\n');

    console.log('2. 获取全部会话列表...');
    const sessions = await driver.getSessions();
    console.log(`  共获取到 ${sessions.length} 个会话:`);
    sessions.forEach((s) => {
      console.log(`  - [${s.type === 'group' ? '群聊' : '私聊'}] ${s.name} (id: ${s.id}, unread: ${s.unread})`);
    });
    console.log();

    // 探查目标 1: 私聊 init2024 / int2024
    const userSession = sessions.find((s) => s.name.includes('int2024') || s.name.includes('init2024'));
    if (userSession) {
      console.log(`3. 🎯 找到私聊目标会话: "${userSession.name}" (id: ${userSession.id})`);
      console.log(`  正在切换到 "${userSession.name}" ...`);
      await driver.selectSession(userSession.id);
      await sleep(600);

      const msgs = await driver.getRecentMessages(5);
      console.log(`  最近 5 条消息:`);
      msgs.forEach((m, idx) => {
        console.log(`    [${idx + 1}] ${m.time} | ${m.isMe ? '我' : m.sender}: ${m.content}`);
      });
      console.log();
    } else {
      console.warn('  ⚠️ 未找到包含 int2024 或 init2024 的会话');
    }

    // 探查目标 2: 群聊 测试123
    const groupSession = sessions.find((s) => s.name.includes('测试123'));
    if (groupSession) {
      console.log(`4. 👥 找到群聊目标会话: "${groupSession.name}" (id: ${groupSession.id})`);
      console.log(`  正在切换到 "${groupSession.name}" ...`);
      await driver.selectSession(groupSession.id);
      await sleep(600);

      const groupMsgs = await driver.getRecentMessages(8);
      console.log(`  群聊最近 ${groupMsgs.length} 条消息:`);
      groupMsgs.forEach((m, idx) => {
        console.log(`    [${idx + 1}] ${m.time} | 发送者: ${m.sender} (${m.isMe ? '我' : '群员'}): ${m.content}`);
      });
      console.log();
    } else {
      console.warn('  ⚠️ 未找到名称包含 "测试123" 的群聊会话');
    }

    console.log('====================================================');
    console.log('✅ 探查完成！已成功连接并验证目标会话。');
    console.log('====================================================');
  } catch (error) {
    console.error('\n❌ 交互探查失败:', error);
  } finally {
    await driver.disconnect();
  }
}

void main();
