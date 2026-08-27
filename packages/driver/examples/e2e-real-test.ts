import fs from 'node:fs';
import path from 'node:path';
import { KK9Driver } from '../src/index.js';

async function runRealDeviceE2ETest() {
  console.log('====================================================');
  console.log('🚀 开始执行 KKBot Driver 真机全链路端到端集成验证');
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

  let heartbeatCount = 0;
  driver.on('heartbeat', () => {
    heartbeatCount++;
  });

  const capturedMessages: Array<{ origin: string; messageId: string }> = [];
  driver.on('message', msg => {
    const origin = msg.origin ?? 'unknown';
    const messageId = msg.messageId || msg.id;
    console.log(
      `  [实时事件] 捕获到新消息: [${msg.sender}] ${msg.content} (origin: ${origin}, native message ID: ${messageId.slice(0, 12)}...)`
    );
    capturedMessages.push({ origin, messageId });
  });

  try {
    // 1. 建立连接
    console.log('Step 1: 正在连接真实 KK9 客户端...');
    await driver.connect();
    console.log(`  ✅ 连接成功！状态: ${driver.getStatus()}\n`);

    // 2. 会话穿透与读取
    console.log('Step 2: 穿透 Vue 虚拟滚动读取全量会话...');
    const sessions = await driver.getSessions();
    console.log(`  ✅ 成功读取到 ${sessions.length} 个会话`);
    const unreadSessions = sessions.filter(s => s.unread);
    console.log(`  📊 未读会话数: ${unreadSessions.length} 个`);
    const groupSessions = sessions.filter(s => s.type === 'group');
    console.log(`  👥 群聊会话数: ${groupSessions.length} 个\n`);

    // 3. 目标会话切换定位
    const targetSessionId = '0-3585'; // 专用测试用户: int2024
    console.log(`Step 3: 测试会话切换与定位 (目标: int2024 / ${targetSessionId})...`);
    const switched = await driver.selectSession(targetSessionId);
    if (!switched) {
      throw new Error(`切换到会话 ${targetSessionId} 失败`);
    }
    await new Promise(r => setTimeout(r, 600));
    const current = await driver.getCurrentSession();
    console.log(`  ✅ 切换成功！当前激活会话: ${current?.name} (${current?.id})\n`);

    // 4. 读取历史消息
    console.log('Step 4: 读取当前会话最近消息...');
    const messages = await driver.getRecentMessages(6);
    console.log(`  ✅ 检索到 ${messages.length} 条消息:`);
    messages.forEach((m, idx) => {
      console.log(
        `    [${idx + 1}] ${m.time} | ${m.isMe ? '我' : m.sender}: ${m.content.slice(0, 30)}`
      );
    });
    console.log();

    // 5. 文本发送与回读测试
    const testText = `[真机集成测试] Driver v2 自动化验证 ${Date.now()}`;
    console.log(`Step 5: 测试发送文本: "${testText}" ...`);
    const textSendRes = await driver.sendText(testText, { targetSessionId });
    if (!textSendRes.success) {
      throw new Error(`文本发送失败: ${textSendRes.error}`);
    }
    console.log(`  ✅ 文本发送成功！回读确认耗时: ${textSendRes.verifyLatencyMs || 0}ms\n`);

    // 6. 生成测试图片并测试图片发送
    const tmpDir = path.resolve('tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const testImgPath = path.resolve(tmpDir, 'test-pixel.png');
    // 写入一个合法的单像素 PNG 图片文件
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fs.writeFileSync(testImgPath, Buffer.from(pngBase64, 'base64'));

    console.log(`Step 6: 测试本地图片剪贴板注入与发送: ${testImgPath} ...`);
    const imgSendRes = await driver.sendImage(testImgPath, { targetSessionId });
    if (!imgSendRes.success) {
      throw new Error(`图片发送失败: ${imgSendRes.error}`);
    }
    console.log(`  ✅ 图片发送成功！回读确认耗时: ${imgSendRes.verifyLatencyMs || 0}ms\n`);

    // 7. 实时消息轮询与来源分类观测；Driver 会 emit bot_echo，Gateway 负责过滤
    console.log('Step 7: 启动智能轮询来源分类观测 (运行 4 秒)...');
    driver.startPolling({ intervalMs: 1000 });
    await new Promise(r => setTimeout(r, 4000));
    driver.stopPolling();
    const externalCount = capturedMessages.filter(message => message.origin === 'external').length;
    const botEchoCount = capturedMessages.filter(message => message.origin === 'bot_echo').length;
    const unknownCount = capturedMessages.filter(message => message.origin === 'unknown').length;
    const otherCount = capturedMessages.length - externalCount - botEchoCount - unknownCount;
    console.log(`  external: ${externalCount} 条`);
    console.log(`  bot_echo: ${botEchoCount} 条（Driver 会 emit，Gateway 才负责过滤）`);
    console.log(`  unknown: ${unknownCount} 条`);
    if (otherCount > 0) {
      console.log(`  其他来源: ${otherCount} 条`);
    }
    console.log('  来源分类观测完成；本步骤不验证 Gateway 过滤行为。\n');

    console.log('====================================================');
    console.log('Driver 真机端到端发送与来源分类观测完成');
    console.log('Gateway Bot 回显过滤不在本脚本验证范围内');
    console.log('====================================================');
  } finally {
    await driver.disconnect();
  }
}

void runRealDeviceE2ETest().catch(err => {
  console.error('\n❌ 真机测试失败:', err);
  process.exit(1);
});
