import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { Sender } from '../src/send/sender.js';
import { loadConfig } from '../src/config/loader.js';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testSendImage(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);
  const sender = new Sender(locator, config.sender);

  try {
    console.log('========== 图片发送测试 ==========\n');
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接!\n');

    console.log('获取会话列表...');
    const sessions = await locator.getAllSessions();
    console.log(`找到 ${sessions.length} 个会话\n`);

    const targetSession = sessions.find(s => s.name.includes('int2024'));

    if (!targetSession) {
      console.error('未找到 int2024 会话');
      console.log('可用会话:');
      sessions.forEach(s => console.log(`  - ${s.name}`));
      return;
    }

    console.log(`目标会话: ${targetSession.name}`);

    if (!targetSession.isSelected) {
      console.log('切换到目标会话...');
      const selected = await locator.selectSession(targetSession.id);
      if (!selected) {
        console.error('切换会话失败!');
        return;
      }
      await sleep(1000);
      console.log('已切换\n');
    }

    // 使用 tmp 目录下的测试图片
    const imagePath = 'tmp/image.png';
    console.log(`发送图片: ${imagePath}\n`);

    const result = await sender.sendImage(imagePath);

    if (result.success) {
      console.log('✅ 图片发送成功!\n');
      console.log('等待 2 秒后检查最近消息...');
      await sleep(2000);

      const messages = await locator.getMessages(5);
      console.log(`\n最近 ${messages.length} 条消息:`);
      messages.forEach(m => {
        console.log(`  ${m.isMe ? '[我]' : `[${m.sender}]`}: ${m.content.slice(0, 50)}`);
      });
    } else {
      console.log(`❌ 图片发送失败: ${result.error}`);
    }

    console.log('\n========== 测试完成 ==========');
  } catch (error) {
    console.error('测试出错:', error);
  } finally {
    connector.disconnect();
  }
}

testSendImage().catch(console.error);
