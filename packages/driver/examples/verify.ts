import { KK9Driver } from '../src/index.js';

async function main() {
  console.log('=== KK9 Driver 独立验证工具 ===\n');

  const driver = new KK9Driver({
    cdp: {
      url: process.env['CDP_URL'] || 'http://127.0.0.1:9222',
      pageMatch: process.env['PAGE_MATCH'] || 'renderer.html',
    },
    polling: {
      intervalMs: 2000,
    },
  });

  driver.on('status', (status) => {
    console.log(`[Status Change] => ${status}`);
  });

  driver.on('heartbeat', (uptimeMs) => {
    console.log(`[Heartbeat] 在线时长: ${(uptimeMs / 1000).toFixed(1)}s`);
  });

  driver.on('message', (msg) => {
    console.log('\n[新消息到达]');
    console.log(`  会话: [${msg.sessionType}] ${msg.sessionName} (${msg.sessionId})`);
    console.log(`  发送者: ${msg.sender}`);
    console.log(`  时间: ${msg.time}`);
    console.log(`  指纹: ${msg.id}`);
    console.log(`  内容: ${msg.content}\n`);
  });

  driver.on('error', (err) => {
    console.error(`[Error]`, err.message);
  });

  try {
    console.log('1. 正在连接 KK9 客户端...');
    await driver.connect();
    console.log('   连接成功！\n');

    console.log('2. 获取全部会话列表...');
    const sessions = await driver.getSessions();
    console.log(`   共检索到 ${sessions.length} 个会话:`);
    for (const s of sessions.slice(0, 10)) {
      console.log(`   - [${s.type}] ${s.name} (id=${s.id}) ${s.unread ? '[未读]' : ''} ${s.active ? '[当前激活]' : ''}`);
    }
    console.log();

    console.log('3. 获取当前会话最近消息...');
    const messages = await driver.getRecentMessages(5);
    console.log(`   检索到 ${messages.length} 条消息:`);
    for (const m of messages) {
      console.log(`   - [${m.isMe ? '我' : m.sender}] ${m.time}: ${m.content}`);
    }
    console.log();

    console.log('4. 启动实时轮询监听 (按 Ctrl+C 退出)...');
    driver.startPolling();

    // 保持进程运行
    process.on('SIGINT', () => {
      void (async () => {
        console.log('\n正在优雅退出...');
        await driver.disconnect();
        process.exit(0);
      })();
    });
  } catch (err) {
    console.error('执行验证失败:', err instanceof Error ? err.message : String(err));
    await driver.disconnect();
    process.exit(1);
  }
}

void main();
