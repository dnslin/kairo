import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CdpConnector } from '../../src/cdp/connector.js';
import { DomLocator } from '../../src/dom/locator.js';
import { Sender } from '../../src/send/sender.js';
import { loadConfig } from '../../src/config/loader.js';
import type { SenderConfig } from '../../src/config/schema.js';

const SKIP_INTEGRATION = !process.env['KK9_INTEGRATION'];

describe.skipIf(SKIP_INTEGRATION)('Sender Integration Tests', () => {
  let connector: CdpConnector;
  let locator: DomLocator;
  let sender: Sender;
  let senderConfig: SenderConfig;

  beforeAll(async () => {
    const config = loadConfig();
    connector = new CdpConnector(config.cdp, config.page);
    await connector.connect();
    locator = new DomLocator(connector, config.selectors);
    senderConfig = config.sender || { verifyTimeoutMs: 3000, logMasking: false };
    sender = new Sender(locator, senderConfig);
  });

  afterAll(() => {
    connector.disconnect();
  });

  it('send() should complete within 5 seconds', async () => {
    const testMessage = `[测试消息] ${Date.now()}`;
    const start = Date.now();

    const result = await sender.send(testMessage);
    const duration = Date.now() - start;

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(duration).toBeLessThan(5000);
  });

  it('send() should return error when input box not found', async () => {
    const badLocator = new DomLocator(connector, {
      ...locator['selectors'],
      inputBox: '.nonexistent-input-box',
    });
    const badSender = new Sender(badLocator, senderConfig);

    const result = await badSender.send('test');

    expect(result.success).toBe(false);
    expect(result.error).toBe('输入框未找到');
  });
});
