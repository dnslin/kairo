import { CdpConnector } from '../src/cdp/connector.js';
import { loadConfig } from '../src/config/loader.js';

async function main() {
  const config = loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  await connector.connect();

  const result = (await connector.evaluate(`
    (function() {
      const items = document.querySelectorAll('.record-item');
      if (items.length === 0) return 'No messages found';
      
      const sample = items[items.length - 1];
      
      const html = sample.outerHTML;
      
      const selectors = [
        '.rcd-basic-name .username',
        '.rcd-basic-name',
        '.username',
        '.sender-name',
        '.message-sender',
        '.nick-name',
        '.nickname',
        '[class*="name"]',
        '[class*="sender"]',
        '[class*="user"]'
      ];
      
      const results = {};
      for (const sel of selectors) {
        const el = sample.querySelector(sel);
        results[sel] = el ? el.textContent.trim() : null;
      }
      
      return {
        html: html.slice(0, 3000),
        selectorResults: results
      };
    })()
  `)) as {
    result?: { value?: { html: string; selectorResults: Record<string, string | null> } | string };
  };

  console.log('\n=== 消息 DOM 结构分析 ===\n');
  const value = result.result?.value;

  if (typeof value === 'string') {
    console.log(value);
  } else if (value) {
    console.log('Selector 测试结果:');
    for (const [sel, text] of Object.entries(value.selectorResults)) {
      console.log(`  ${sel}: ${text === null ? '(未找到)' : `"${text}"`}`);
    }
    console.log('\nHTML 结构 (前 3000 字符):');
    console.log(value.html);
  }

  connector.disconnect();
}

main().catch(console.error);
