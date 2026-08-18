import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { loadConfig } from '../src/config/loader.js';

async function verifyMessages(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);

  try {
    await connector.connect();

    const sessions = await locator.getAllSessions();
    const targetSession = sessions.find(s => s.name.includes('int2024'));

    if (!targetSession?.isSelected) {
      await locator.selectSession(targetSession!.id);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    const messages = await locator.getMessages(10);

    console.log(`检测到 ${messages.length} 条消息:\n`);
    messages.forEach((m, i) => {
      console.log(`[${i + 1}] ${m.isMe ? '[我]' : `[${m.sender}]`}`);
      console.log(`    ID: ${m.id}`);
      console.log(`    内容: ${m.content}`);
      console.log(`    时间: ${m.time}\n`);
    });
  } catch (error) {
    console.error('错误:', error);
  } finally {
    connector.disconnect();
  }
}

verifyMessages().catch(console.error);
