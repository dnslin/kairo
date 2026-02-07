import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { MessageExtractor } from '../src/extract/index.js';
import { loadConfig } from '../src/config/loader.js';

async function main() {
  const config = loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  await connector.connect();
  const locator = new DomLocator(connector, config.selectors);
  const extractor = new MessageExtractor(locator);

  console.log('\n=== 最近 10 条消息 ===\n');
  const messages = await extractor.getRecentMessages(10);

  for (const msg of messages) {
    console.log(`[${msg.time}] ${msg.sender}: ${msg.content}`);
    console.log(`  fingerprint: ${msg.fingerprint.slice(0, 16)}...`);
    console.log('');
  }

  console.log(`总计: ${messages.length} 条消息`);
  console.log(`会话ID: ${messages[0]?.sessionId || 'N/A'}`);

  connector.disconnect();
}

main().catch(console.error);
