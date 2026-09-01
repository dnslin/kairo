import { KK9Driver } from '../src/index.js';

async function main() {
  console.log('=== KK9 Driver 基础功能快速冒烟验证 ===\n');

  const driver = new KK9Driver({
    cdp: {
      url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
      pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
    },
  });

  try {
    // 1. 连接
    console.log('1. 正在连接 KK9 客户端...');
    await driver.connect();
    console.log(`   ✅ 连接成功！状态: ${driver.getStatus()}\n`);

    // 2. 会话
    console.log('2. 获取全量会话列表 (Bridge 数据层)...');
    const sessions = await driver.getSessions();
    console.log(`   ✅ 成功获取 ${sessions.length} 个会话\n`);

    // 3. 私聊目标验证: "int2024"
    console.log('3. 私聊切换与消息读取 (目标: "int2024")...');
    const pSwitched = await driver.selectSession('int2024');
    console.log(`   私聊会话切换: ${pSwitched ? '✅ 成功' : '⚠️ 未命中'}`);
    const pMsgs = await driver.getRecentMessages(3);
    console.log(`   检索到 ${pMsgs.length} 条私聊消息`);
    pMsgs.forEach(m => console.log(`   - [${m.isMe ? '我' : m.sender}] ${m.time}: ${m.content.slice(0, 30)}`));
    console.log();

    // 4. 群聊目标验证: "测试123"
    console.log('4. 群聊切换与消息读取 (目标: "测试123")...');
    const gSwitched = await driver.selectSession('测试123');
    console.log(`   群聊会话切换: ${gSwitched ? '✅ 成功' : '⚠️ 未命中'}`);
    const gMsgs = await driver.getRecentMessages(3);
    console.log(`   检索到 ${gMsgs.length} 条群聊消息`);
    gMsgs.forEach(m => console.log(`   - [${m.sender}] ${m.time}: ${m.content.slice(0, 30)}`));
    console.log();

    // 5. 组织架构查询
    console.log('5. 组织架构员工档案查询 (UID: 5761)...');
    const profile = await driver.getUserProfile(5761);
    if (profile) {
      console.log(`   ✅ 查询成功: ${profile.name} (工号: ${profile.loginName}, 岗位: ${profile.position || '未设置'})\n`);
    } else {
      console.log('   ℹ️ 未检索到员工档案\n');
    }

    console.log('🎉 冒烟验证顺利通过！');
  } catch (err) {
    console.error('❌ 执行验证失败:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  } finally {
    await driver.disconnect();
  }
}

void main();
