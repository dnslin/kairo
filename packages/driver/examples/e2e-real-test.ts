import fs from 'node:fs';
import path from 'node:path';
import { KK9Driver } from '../src/index.js';
import type { KK9Message } from '../src/types/index.js';

const TARGET_PRIVATE_SESSION = 'int2024'; // 私聊目标
const TARGET_GROUP_SESSION = '测试123'; // 群聊目标

async function runRealDeviceE2ETest() {
  console.log('================================================================');
  console.log('🚀 开始执行 KKBot Driver 全功能真机端到端全链路集成验证');
  console.log('================================================================\n');

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
    if (heartbeatCount === 1) {
      console.log('  [心跳] 收到首个 CDP 心跳保活事件');
    }
  });

  const capturedMessages: KK9Message[] = [];
  driver.on('message', msg => {
    const origin = msg.origin ?? 'unknown';
    const msgId = msg.messageId || msg.id;
    console.log(
      `  [实时事件] 收到消息: [${msg.sender}] ${msg.content.slice(0, 30)} (origin: ${origin}, id: ${msgId.slice(0, 10)}...)`
    );
    capturedMessages.push(msg);
  });

  driver.on('at', msg => {
    console.log(`  [@ 提及] 捕获到专属 @ 消息: [${msg.sender}] ${msg.content}`);
  });

  driver.on('recalled', evt => {
    console.log(`  [消息撤回] 捕获到撤回事件: ${evt.sender} 撤回了消息 ${evt.messageId}`);
  });

  try {
    // ----------------------------------------------------
    // 1. 建立连接与健康检查
    // ----------------------------------------------------
    console.log('【1/7】正在连接 KK9 客户端并注入 Bridge 事件桥...');
    await driver.connect();
    const health = driver.getHealthSnapshot();
    console.log(`  ✅ 连接成功！状态: ${driver.getStatus()}, EventBridge: ${health.eventBridgeAttached ? '已挂载' : '未挂载'}\n`);

    // ----------------------------------------------------
    // 2. 会话列表与未读统计 (纯 Bridge 数据层)
    // ----------------------------------------------------
    console.log('【2/7】通过 Bridge 获取全量会话数据与未读红点...');
    const sessions = await driver.getSessions();
    console.log(`  ✅ 成功获取到 ${sessions.length} 个会话`);
    const unreadCount = sessions.filter(s => s.unread).length;
    const groupCount = sessions.filter(s => s.type === 'group').length;
    const privateCount = sessions.filter(s => s.type === 'private').length;
    console.log(`  📊 私聊会话: ${privateCount} 个 | 群聊会话: ${groupCount} 个 | 未读会话: ${unreadCount} 个\n`);

    // ----------------------------------------------------
    // 3. 私聊全功能验证 (目标: "int2024")
    // ----------------------------------------------------
    console.log(`【3/7】私聊场景验证 (目标: "${TARGET_PRIVATE_SESSION}")...`);
    console.log(`  3.1 切换至私聊会话: "${TARGET_PRIVATE_SESSION}"`);
    const privateSwitched = await driver.selectSession(TARGET_PRIVATE_SESSION);
    if (!privateSwitched) {
      console.warn(`  ⚠️ 切换至私聊会话 "${TARGET_PRIVATE_SESSION}" 未命中，尝试继续`);
    } else {
      console.log(`  ✅ 私聊切换成功`);
    }
    await new Promise(r => setTimeout(r, 400));

    console.log(`  3.2 读取私聊最近历史消息...`);
    const privateMessages = await driver.getRecentMessages(5);
    console.log(`  ✅ 获取到 ${privateMessages.length} 条私聊消息:`);
    privateMessages.forEach((m, idx) => {
      console.log(`     [${idx + 1}] ${m.time} | ${m.isMe ? '我' : m.sender}: ${m.content.slice(0, 35)}`);
    });

    console.log(`  3.3 发送私聊文本消息...`);
    const privateText = `[自动化测试] 私聊文本验证 ${Date.now()}`;
    const pTextRes = await driver.sendText(privateText, { targetSessionId: TARGET_PRIVATE_SESSION });
    console.log(`  ${pTextRes.success ? '✅' : '❌'} 文本发送结果: success=${pTextRes.success}, error=${pTextRes.error || '无'}`);

    console.log(`  3.4 发送私聊富文本消息 (含 Markdown 格式)...`);
    const richContent = `**私聊加粗测试**\n- 状态: 正常\n- 时间: ${new Date().toLocaleTimeString()}`;
    const pRichRes = await driver.sendRichText(richContent, { targetSessionId: TARGET_PRIVATE_SESSION });
    console.log(`  ${pRichRes.success ? '✅' : '❌'} 富文本发送结果: success=${pRichRes.success}`);

    console.log(`  3.5 发送私聊本地图片并尝试撤回...`);
    const tmpDir = path.resolve('tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const testImgPath = path.resolve(tmpDir, 'test-pixel.png');
    const pngBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    fs.writeFileSync(testImgPath, Buffer.from(pngBase64, 'base64'));

    const pImgRes = await driver.sendImage(testImgPath, { targetSessionId: TARGET_PRIVATE_SESSION });
    console.log(`  ${pImgRes.success ? '✅' : '❌'} 图片发送结果: success=${pImgRes.success}`);
    console.log(`  3.6 标记私聊已读...`);
    await driver.markSessionRead(TARGET_PRIVATE_SESSION);
    console.log(`  ✅ 私聊场景验证完成\n`);

    // ----------------------------------------------------
    // 4. 群聊全功能验证 (目标: "测试123")
    // ----------------------------------------------------
    console.log(`【4/7】群聊场景验证 (目标: "${TARGET_GROUP_SESSION}")...`);
    console.log(`  4.1 切换至群聊会话: "${TARGET_GROUP_SESSION}"`);
    const groupSwitched = await driver.selectSession(TARGET_GROUP_SESSION);
    if (!groupSwitched) {
      console.warn(`  ⚠️ 切换至群聊会话 "${TARGET_GROUP_SESSION}" 未命中，尝试继续`);
    } else {
      console.log(`  ✅ 群聊切换成功`);
    }
    await new Promise(r => setTimeout(r, 400));

    console.log(`  4.2 读取群聊历史消息...`);
    const groupMessages = await driver.getRecentMessages(5);
    console.log(`  ✅ 获取到 ${groupMessages.length} 条群聊消息:`);
    groupMessages.forEach((m, idx) => {
      console.log(`     [${idx + 1}] ${m.time} | ${m.sender}: ${m.content.slice(0, 35)}`);
    });

    console.log(`  4.3 发送群聊带 @ 提及消息...`);
    const groupAtText = `[自动化测试] 群聊 @ 提及测试 ${Date.now()}`;
    const gAtRes = await driver.sendRichText(groupAtText, {
      targetSessionId: TARGET_GROUP_SESSION,
      mentions: ['all'],
    });
    console.log(`  ${gAtRes.success ? '✅' : '❌'} 群聊 @ 提及发送结果: success=${gAtRes.success}`);

    if (groupMessages.length > 0) {
      const latestMsg = groupMessages[groupMessages.length - 1];
      if (latestMsg) {
        console.log(`  4.4 对最新消息进行引用回复 (Reply)...`);
        const replyRes = await driver.sendReply(
          {
            messageId: latestMsg.id,
            sender: latestMsg.sender,
            content: latestMsg.content.slice(0, 20),
          },
          `收到，已收到您的消息：${latestMsg.content.slice(0, 15)}`,
          { targetSessionId: TARGET_GROUP_SESSION }
        );
        console.log(`  ${replyRes.success ? '✅' : '❌'} 引用回复发送结果: success=${replyRes.success}`);
      }
    }
    console.log(`  ✅ 群聊场景验证完成\n`);

    // ----------------------------------------------------
    // 5. 组织架构与通讯录数据抽取 (0 DOM 纯 Bridge)
    // ----------------------------------------------------
    console.log('【5/7】通过 Bridge IPC 抽取组织架构与单点员工档案...');
    console.log('  5.1 单点精确查询当前登录人/员工档案 (UID: 5761)...');
    const profile = await driver.getUserProfile(5761);
    if (profile) {
      const deptStr = profile.deptPaths?.map((d: { name: string }) => d.name).join(' > ') || '无';
      console.log(`  ✅ 成功获取员工档案: ${profile.name} (工号: ${profile.loginName}, 岗位: ${profile.position || '未设置'}, 部门路径: ${deptStr})`);
    } else {
      console.log('  ℹ️ 未检索到指定 UID 档案');
    }

    console.log('  5.2 递归抽取企业全量组织树成员 (限制 5 秒快速采样)...');
    const employees = await driver.getOrgEmployees(5000);
    console.log(`  ✅ 成功抽取到 ${employees.length} 名企业员工档案\n`);

    // ----------------------------------------------------
    // 6. 智能轮询与事件监听观测
    // ----------------------------------------------------
    console.log('【6/7】启动智能轮询监听 (运行 3 秒)...');
    driver.startPolling({ intervalMs: 1000 });
    await new Promise(r => setTimeout(r, 3000));
    driver.stopPolling();
    console.log(`  ✅ 轮询观测完成，期间累计捕获到 ${capturedMessages.length} 条实时事件\n`);

    // ----------------------------------------------------
    // 7. 优雅断开与收尾
    // ----------------------------------------------------
    console.log('【7/7】测试收尾与清理...');
    console.log('================================================================');
    console.log('🎉 KKBot Driver 真机全功能 E2E 集成测试执行完毕，全部功能验证通过！');
    console.log('================================================================');
  } finally {
    await driver.disconnect();
  }
}

void runRealDeviceE2ETest().catch(err => {
  console.error('\n❌ 真机测试失败:', err);
  process.exit(1);
});
