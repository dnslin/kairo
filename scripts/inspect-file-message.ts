import { CdpConnector } from '../src/cdp/connector.js';
import { loadConfig } from '../src/config/loader.js';

async function inspectMessage(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  try {
    await connector.connect();

    const inspectScript = `
      (function() {
        const item = document.getElementById('msg-123327741');
        if (!item) return { found: false };
        
        const contentEl = item.querySelector('${config.selectors.messageContent}');
        
        return {
          found: true,
          hasContentEl: !!contentEl,
          contentHTML: contentEl ? contentEl.innerHTML : null,
          itemClasses: Array.from(item.classList),
          dataType: item.getAttribute('data-type'),
          fullHTML: item.outerHTML.slice(0, 1000)
        };
      })()
    `;

    const response = (await connector.evaluate(inspectScript)) as {
      result?: { value?: any };
    };

    const info = response.result?.value;
    console.log('msg-123327741 详细信息:');
    console.log(JSON.stringify(info, null, 2));
  } catch (error) {
    console.error('错误:', error);
  } finally {
    connector.disconnect();
  }
}

inspectMessage().catch(console.error);
