import { setTimeout as sleep } from 'node:timers/promises';
import { KK9Driver } from '../packages/driver/src/index.js';

async function runRecallVerification(): Promise<void> {
  console.log('====================================================');
  console.log('🚀 KK9 消息撤回双轨 API 与事件捕获实机验证');
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

  // 1. 注册消息撤回事件监听
  driver.on('recalled', (evt) => {
    console.log(`\n📢 【捕获到消息撤回事件】:`);
    console.log(`   - 消息 ID: ${evt.messageId}`);
    console.log(`   - 会话 ID: ${evt.sessionId}`);
    console.log(`   - 撤回者:  ${evt.sender}`);
    console.log(`   - 时间:    ${evt.time}\n`);
  });

  try {
    console.log('Step 1: 连接 CDP...');
    await driver.connect();
    console.log('  ✅ 连接成功！\n');

    // 2. 选择一个测试会话 (优先从当前会话或第一个可用会话)
    const currentSession = await driver.getCurrentSession();
    const sessions = await driver.getSessions();
    const targetSession = currentSession || sessions[0];

    if (!targetSession) {
      console.error('❌ 未找到可用会话，请先在 KK9 客户端打开一个聊天会话');
      return;
    }

    console.log(`Step 2: 当前测试会话: [${targetSession.name}] (ID: ${targetSession.id})`);
    await driver.selectSession(targetSession.id);
    await sleep(500);

    // 3. 测试轨道一：res.recall() 快捷链式撤回
    console.log('\n--- 测试 1: 轨道一 (res.recall 快捷方法) ---');
    const msgText1 = `【测试 1】快捷撤回测试消息 - 时间戳: ${Date.now()}`;
    console.log(`发送消息: "${msgText1}" ...`);
    const sendRes1 = await driver.sendText(msgText1, { targetSessionId: targetSession.id });
    console.log(`发送结果: success=${sendRes1.success}, messageId=${sendRes1.messageId}`);

    if (sendRes1.success && sendRes1.recall) {
      console.log('等待 2 秒后调用 sendRes1.recall() 进行撤回...');
      await sleep(2000);
      const recallRes1 = await sendRes1.recall();
      console.log(`  ${recallRes1 ? '✅' : '❌'} res.recall() 撤回结果: ${recallRes1 ? '成功' : '失败'}`);
    } else {
      console.error('❌ 发送未返回有效的 recall 方法');
    }

    await sleep(1000);

    // 4. 测试轨道二：driver.recallMessage(messageId) 全局方法
    console.log('\n--- 测试 2: 轨道二 (driver.recallMessage 全局方法) ---');
    const msgText2 = `【测试 2】全局 API 撤回测试消息 - 时间戳: ${Date.now()}`;
    console.log(`发送消息: "${msgText2}" ...`);
    const sendRes2 = await driver.sendText(msgText2, { targetSessionId: targetSession.id });
    console.log(`发送结果: success=${sendRes2.success}, messageId=${sendRes2.messageId}`);

    if (sendRes2.success && sendRes2.messageId) {
      console.log('等待 2 秒后调用 driver.recallMessage(messageId) 进行撤回...');
      await sleep(2000);
      const recallRes2 = await driver.recallMessage(sendRes2.messageId, targetSession.id);
      console.log(`  ${recallRes2 ? '✅' : '❌'} driver.recallMessage() 撤回结果: ${recallRes2 ? '成功' : '失败'}`);
    } else {
      console.error('❌ 发送未返回有效的 messageId');
    }

    // 5. 测试安全拦截守卫：尝试撤回他人发出的消息
    console.log('\n--- 测试 3: 安全守卫 (拦截撤回他人消息) ---');
    const recentMsgs = await driver.getRecentMessages(10);
    const otherMsg = recentMsgs.find(m => !m.isMe);
    if (otherMsg) {
      console.log(`尝试撤回他人消息 [发送者: ${otherMsg.sender}, 内容: "${otherMsg.content}"] ...`);
      const interceptRes = await driver.recallMessage(otherMsg.id, targetSession.id);
      console.log(`  ${!interceptRes ? '✅' : '❌'} 他人消息撤回拦截结果: ${!interceptRes ? '成功拦截 (返回 false)' : '异常放行'}`);
    } else {
      console.log('  ℹ️ 当前会话最近 10 条消息中无他人消息，跳过此项实机测试');
    }

    // 6. 实时捕获监听演示（保持运行 10 秒供用户在 KK 客户端手动操作撤回）
    console.log('\n--- 测试 4: 原生撤回事件实时监听 ---');
    console.log('💡 正在监听客户端撤回事件 (持续 10 秒)...');
    console.log('👉 你现在可以在 KK9 客户端手动右键撤回任意消息，观察下方事件捕获输出：');
    driver.startPolling({ intervalMs: 1000 });
    await sleep(10000);
    driver.stopPolling();

    console.log('\n====================================================');
    console.log('🎉 实机撤回功能与事件捕获验证完毕！');
    console.log('====================================================');
  } finally {
    await driver.disconnect();
  }
}

void runRecallVerification();
