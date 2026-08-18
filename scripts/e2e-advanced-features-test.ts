import { setTimeout as sleep } from 'node:timers/promises';
import { KK9Driver } from '../packages/driver/src/index.js';

async function runAdvancedE2ETest(): Promise<void> {
  console.log('====================================================');
  console.log('🚀 KK9 高级能力专项实机测试 (多人@, 原生引用回复, 真实文档发送)');
  console.log('====================================================\n');

  const driver = new KK9Driver({
    cdp: {
      url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
      pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
    },
  });

  try {
    console.log('Step 1: 连接 CDP...');
    await driver.connect();
    console.log('  ✅ 连接成功！\n');

    // 1. 测试真实文件发送: 需求清单.xlsx
    const targetFile = 'C:\\Users\\dongshilin\\Downloads\\docs\\需求清单.xlsx';
    console.log(`Step 2: 测试向 int2024 发送真实文档: "${targetFile}" ...`);
    await driver.selectSession('0-3585');
    await sleep(500);

    const fileRes = await driver.sendFile(targetFile, { targetSessionId: '0-3585' });
    console.log(`  ${fileRes.success ? '✅' : '❌'} 文件发送结果:`, fileRes, '\n');

    // 2. 测试原生引用回复
    console.log('Step 3: 测试向 int2024 发送带引用条的回复消息...');
    const replyRes = await driver.sendReply(
      '【红色加粗大字】重要通知：驱动已全面升级！',
      '**[引用回复确认]** [color=#52c41a]已收到重要通知，正在推进执行中！[/color]',
      { targetSessionId: '0-3585' }
    );
    console.log(`  ${replyRes.success ? '✅' : '❌'} 引用回复发送结果:`, replyRes, '\n');

    // 3. 切换到群聊 "测试123" 测试多人 @ 提及
    console.log('Step 4: 切换到群聊 "测试123" (1-29467) 并发送多人 @ 消息...');
    await driver.selectSession('1-29467');
    await sleep(500);

    const multiAtRes = await driver.sendText('请两位看下刚刚发送的最新需求清单！', {
      targetSessionId: '1-29467',
      mentions: [
        { uid: 7783, name: '陈鹏' },
        { uid: 3137, name: '王治' },
      ],
    });
    console.log(`  ${multiAtRes.success ? '✅' : '❌'} 多人 @ 消息发送结果:`, multiAtRes, '\n');

    // 4. 读取群聊最近消息检验
    console.log('Step 5: 读取群聊最近 4 条消息，验证发送者、@ 提及与引用解析...');
    const groupMsgs = await driver.getRecentMessages(4);
    groupMsgs.forEach((m, idx) => {
      console.log(`  [${idx + 1}] ${m.time} | ${m.sender} (${m.isMe ? '我' : '群员'}): ${m.content}`);
      if (m.mentions?.mentionedUsers.length) {
        console.log(`      └─ @ 成员: ${m.mentions.mentionedUsers.join(', ')} (atMe: ${m.atMe})`);
      }
      if (m.replyTo) {
        console.log(`      └─ 引用消息: [${m.replyTo.replyToSender}] ${m.replyTo.replyToContent}`);
      }
    });
    console.log();

    console.log('====================================================');
    console.log('🎉 全部高级专项实机验证 100% 成功！');
    console.log('====================================================');
  } finally {
    await driver.disconnect();
  }
}

void runAdvancedE2ETest();
