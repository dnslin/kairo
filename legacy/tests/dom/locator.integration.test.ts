import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { CdpConnector } from '../../src/cdp/connector.js';
import { DomLocator } from '../../src/dom/locator.js';
import { loadConfig } from '../../src/config/loader.js';

const SKIP_INTEGRATION = !process.env['KK9_INTEGRATION'];

describe.skipIf(SKIP_INTEGRATION)('DomLocator Integration Tests', () => {
  let connector: CdpConnector;
  let locator: DomLocator;

  beforeAll(async () => {
    const config = loadConfig();
    connector = new CdpConnector(config.cdp, config.page);
    await connector.connect();
    locator = new DomLocator(connector, config.selectors);
  });

  afterAll(() => {
    connector.disconnect();
  });

  it('getMessageList() should find container', async () => {
    const start = Date.now();
    const result = await locator.getMessageList();
    const duration = Date.now() - start;

    expect(result.found).toBe(true);
    expect(result.selector).toBeDefined();
    expect(duration).toBeLessThan(500);
  });

  it('getMessageNodes() should return nodes', async () => {
    const start = Date.now();
    const result = await locator.getMessageNodes();
    const duration = Date.now() - start;

    expect(result.found).toBeDefined();
    expect(Array.isArray(result.nodes)).toBe(true);
    expect(duration).toBeLessThan(500);
  });

  it('getSendButton() should find button', async () => {
    const start = Date.now();
    const result = await locator.getSendButton();
    const duration = Date.now() - start;

    expect(result.found).toBe(true);
    expect(result.visible).toBeDefined();
    expect(result.enabled).toBeDefined();
    expect(duration).toBeLessThan(500);
  });
});
