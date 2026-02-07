import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CdpConnector } from '../../src/cdp/connector.js';
import { DomLocator } from '../../src/dom/locator.js';
import { MessageExtractor } from '../../src/extract/index.js';
import { loadConfig } from '../../src/config/loader.js';

const SKIP_INTEGRATION = !process.env['KK9_INTEGRATION'];

describe.skipIf(SKIP_INTEGRATION)('MessageExtractor Integration Tests', () => {
  let connector: CdpConnector;
  let locator: DomLocator;
  let extractor: MessageExtractor;

  beforeAll(async () => {
    const config = loadConfig();
    connector = new CdpConnector(config.cdp, config.page);
    await connector.connect();
    locator = new DomLocator(connector, config.selectors);
    extractor = new MessageExtractor(locator);
  });

  afterAll(() => {
    connector.disconnect();
  });

  it('getRecentMessages() 提取 20 条消息 < 1 秒', async () => {
    const start = Date.now();
    const messages = await extractor.getRecentMessages(20);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(1000);
    expect(Array.isArray(messages)).toBe(true);
    console.log(`提取 ${messages.length} 条消息，耗时 ${duration}ms`);
  });

  it('每条消息包含完整字段', async () => {
    const messages = await extractor.getRecentMessages(5);

    if (messages.length > 0) {
      const msg = messages[0];
      expect(msg).toHaveProperty('sessionId');
      expect(msg).toHaveProperty('sender');
      expect(msg).toHaveProperty('time');
      expect(msg).toHaveProperty('content');
      expect(msg).toHaveProperty('fingerprint');
      expect(msg.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('相同消息的指纹一致', async () => {
    const messages1 = await extractor.getRecentMessages(3);
    const messages2 = await extractor.getRecentMessages(3);

    if (messages1.length > 0 && messages2.length > 0) {
      // 相同位置的消息指纹应该一致
      expect(messages1[0].fingerprint).toBe(messages2[0].fingerprint);
    }
  });

  it('消息内容已规范化 (无首尾空白)', async () => {
    const messages = await extractor.getRecentMessages(10);

    for (const msg of messages) {
      expect(msg.content).toBe(msg.content.trim());
    }
  });
});
