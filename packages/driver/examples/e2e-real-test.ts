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

  const capturedMessages: string[] = [];
  driver.on('message', (msg) => {
    console.log(`  [实时事件] 捕获到新消息: [${msg.sender}] ${msg.content} (指纹: ${msg.id.slice(0, 12)}...)`);
    capturedMessages.push(msg.content);
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
    const unreadSessions = sessions.filter((s) => s.unread);
    console.log(`  📊 未读会话数: ${unreadSessions.length} 个`);
    const groupSessions = sessions.filter((s) => s.type === 'group');
    console.log(`  👥 群聊会话数: ${groupSessions.length} 个\n`);

    // 3. 目标会话切换定位
    const targetSessionId = '0-11067'; // 董仕林
    console.log(`Step 3: 测试会话切换与定位 (目标: ${targetSessionId})...`);
    const switched = await driver.selectSession(targetSessionId);
    if (!switched) {
      throw new Error(`切换到会话 ${targetSessionId} 失败`);
    }
    await new Promise((r) => setTimeout(r, 600));
    const current = await driver.getCurrentSession();
    console.log(`  ✅ 切换成功！当前激活会话: ${current?.name} (${current?.id})\n`);

    // 4. 读取历史消息
    console.log('Step 4: 读取当前会话最近消息...');
    const messages = await driver.getRecentMessages(6);
    console.log(`  ✅ 检索到 ${messages.length} 条消息:`);
    messages.forEach((m, idx) => {
      console.log(`    [${idx + 1}] ${m.time} | ${m.isMe ? '我' : m.sender}: ${m.content.slice(0, 30)}`);
    });
    console.log();

    // 5. 文本发送与回读测试
    const testText = `[真机集成测试] Driver v2 自动化验证 ${Date.now()}`;
    console.log(`Step 5: 测试发送文本: "${testText}" ...`);
    const textSendRes = await driver.sendText(testText);
    if (!textSendRes.success) {
      throw new Error(`文本发送失败: ${textSendRes.error}`);
    }
    console.log(`  ✅ 文本发送成功！回读确认耗时: ${textSendRes.verifyLatencyMs || 0}ms\n`);

    // 6. 生成测试图片并测试图片发送
    const tmpDir = path.resolve('tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const testImgPath = path.resolve(tmpDir, 'test-pixel.png');
    // 写入一个合法的单像素 PNG 图片文件
    const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fs.writeFileSync(testImgPath, Buffer.from(pngBase64, 'base64'));

    console.log(`Step 6: 测试本地图片剪贴板注入与发送: ${testImgPath} ...`);
    const imgSendRes = await driver.sendImage(testImgPath);
    if (!imgSendRes.success) {
      throw new Error(`图片发送失败: ${imgSendRes.error}`);
    }
    console.log(`  ✅ 图片发送成功！回读确认耗时: ${imgSendRes.verifyLatencyMs || 0}ms\n`);

    // 7. 实时消息轮询与自消息过滤测试
    console.log('Step 7: 启动智能轮询监听 (运行 4 秒)...');
    driver.startPolling({ intervalMs: 1000 });
    await new Promise((r) => setTimeout(r, 4000));
    driver.stopPolling();
    console.log(`  ✅ 轮询测试完成，期间捕获有效外部新消息: ${capturedMessages.length} 条\n`);

    console.log('====================================================');
    console.log('🎉 所有真机端到端全链路测试 100% 成功通过！');
    console.log('====================================================');
  } finally {
    await driver.disconnect();
  }
}

void runRealDeviceE2ETest().catch((err) => {
  console.error('\n❌ 真机测试失败:', err);
  process.exit(1);
});
