import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { Sender } from '../src/send/sender.js';
import { loadConfig } from '../src/config/loader.js';
import type { SenderConfig } from '../src/config/schema.js';

const TARGET_SESSIONS = ['陈鹏', 'int2024', '测试123'];

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testSender(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);
  const senderConfig: SenderConfig = config.sender || {
    verifyTimeoutMs: 3000,
    logMasking: false,
  };
  const sender = new Sender(locator, senderConfig);

  try {
    console.log('========== Sender 模块测试 ==========\n');
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接!\n');

    console.log('获取会话列表...');
    const sessions = await locator.getSessions();
    console.log(`找到 ${sessions.length} 个会话\n`);

    const results: Array<{ name: string; success: boolean; error?: string; duration: number }> = [];

    for (const targetName of TARGET_SESSIONS) {
      console.log(`\n---------- 测试: ${targetName} ----------`);
      const targetSession = sessions.find(s => s.name.includes(targetName));

      if (!targetSession) {
        console.log(`未找到会话: ${targetName}`);
        results.push({ name: targetName, success: false, error: '会话未找到', duration: 0 });
        continue;
      }

      console.log(`目标: ${targetSession.name} (${targetSession.type})`);

      if (!targetSession.isSelected) {
        console.log('切换会话...');
        const selected = await locator.selectSession(targetSession.id);
        if (!selected) {
          console.error('切换失败!');
          results.push({ name: targetName, success: false, error: '切换会话失败', duration: 0 });
          continue;
        }
        await sleep(1000);
        console.log('已切换');
      }

      const testMessage = `[Sender测试] ${targetName} - ${new Date().toLocaleTimeString()}`;
      console.log(`发送: "${testMessage}"`);

      const startTime = Date.now();
      const result = await sender.send(testMessage);
      const duration = Date.now() - startTime;

      results.push({ name: targetName, success: result.success, error: result.error, duration });
      console.log(`结果: ${result.success ? '✅' : '❌'} (${duration}ms)`);

      await sleep(500);
    }

    console.log('\n========== 测试汇总 ==========');
    results.forEach(r => {
      console.log(
        `${r.success ? '✅' : '❌'} ${r.name}: ${r.success ? `成功 (${r.duration}ms)` : r.error}`
      );
    });
    const passed = results.filter(r => r.success).length;
    console.log(`\n总计: ${passed}/${results.length} 成功`);
  } catch (error) {
    console.error('测试出错:', error);
  } finally {
    connector.disconnect();
  }
}

testSender().catch(console.error);
