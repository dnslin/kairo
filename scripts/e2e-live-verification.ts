import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { KK9Driver } from '../packages/driver/src/index.js';

async function runLiveVerification(): Promise<void> {
  console.log('====================================================');
  console.log('🚀 KK9 实机增强能力全面验证 (int2024 & 测试123)');
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
    console.log('Step 1: 连接 CDP...');
    await driver.connect();
    console.log('  ✅ 连接成功！\n');

    // 1. 切换到 int2024
    console.log('Step 2: 切换到私聊目标 int2024 (0-3585)...');
    await driver.selectSession('0-3585');
    await sleep(600);

    // 2. 测试富文本发送
    const richContent = `**[Driver v2 实机测试]** [color=#1890ff]富文本样式渲染[/color] - 时间戳: ${Date.now()}`;
    console.log(`Step 3: 测试向 int2024 发送富文本:\n  "${richContent}" ...`);
    const richRes = await driver.sendRichText(richContent, { targetSessionId: '0-3585' });
    console.log(`  ${richRes.success ? '✅' : '❌'} 富文本发送结果:`, richRes, '\n');

    // 3. 测试文件发送
    const tmpDir = path.resolve('tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const testDocPath = path.resolve(tmpDir, 'KKBot_Driver_Test.txt');
    fs.writeFileSync(testDocPath, `KKBot Driver 2.0 本地文件自动化传输测试\n生成时间: ${new Date().toLocaleString()}`);

    console.log(`Step 4: 测试向 int2024 发送本地文件: "${testDocPath}" ...`);
    const fileRes = await driver.sendFile(testDocPath, { targetSessionId: '0-3585' });
    console.log(`  ${fileRes.success ? '✅' : '❌'} 文件发送结果:`, fileRes, '\n');

    // 4. 测试切换到群聊 测试123
    console.log('Step 5: 切换到群聊目标 "测试123" (1-29467)...');
    await driver.selectSession('1-29467');
    await sleep(600);

    const groupMsgs = await driver.getRecentMessages(5);
    console.log(`  群聊最近消息 (${groupMsgs.length} 条):`);
    groupMsgs.forEach((m, idx) => {
      console.log(`    [${idx + 1}] ${m.time} | 发送者: ${m.sender} (isMe: ${m.isMe}, 类型: ${m.messageType || 'text'}): ${m.content}`);
    });
    console.log();

    // 5. 监听测试
    console.log('Step 6: 启动实时监听测试 (运行 3 秒)...');
    driver.on('message', (msg) => {
      console.log(`  🔔 [收到消息] [${msg.sessionName}] ${msg.sender}: ${msg.content}`);
    });
    driver.on('at', (msg) => {
      console.log(`  🎯 [收到 @ 提及] [${msg.sessionName}] ${msg.sender}: ${msg.content}`);
    });
    driver.startPolling({ intervalMs: 1000 });
    await sleep(3000);
    driver.stopPolling();
    console.log('  ✅ 监听测试完成！\n');

    console.log('====================================================');
    console.log('🎉 实机端到端增强能力测试完成！');
    console.log('====================================================');
  } finally {
    await driver.disconnect();
  }
}

void runLiveVerification();
