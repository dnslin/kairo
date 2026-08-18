import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { loadConfig } from '../src/config/loader.js';

async function diagnoseMessages(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);

  try {
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接!\n');

    const sessions = await locator.getAllSessions();
    const targetSession = sessions.find(s => s.name.includes('int2024'));

    if (!targetSession) {
      console.error('未找到 int2024 会话');
      return;
    }

    if (!targetSession.isSelected) {
      await locator.selectSession(targetSession.id);
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    console.log('=== 使用 getMessages() 获取消息 ===\n');
    const messages = await locator.getMessages(10);
    console.log(`检测到 ${messages.length} 条消息\n`);

    console.log('=== 检查所有消息节点的 DOM 结构 ===\n');
    const inspectScript = `
      (function() {
        const items = document.querySelectorAll('${config.selectors.messageItem}');
        const lastItems = Array.from(items).slice(-10);
        
        return lastItems.map((item, index) => {
          const contentEl = item.querySelector('${config.selectors.messageContent}');
          const isRight = item.querySelector('${config.selectors.messageRight}') !== null;
          const allImages = item.querySelectorAll('img');
          
          return {
            index: index,
            id: item.id || '',
            isMe: isRight,
            hasContentEl: !!contentEl,
            contentHTML: contentEl ? contentEl.innerHTML.slice(0, 300) : null,
            itemOuterHTML: item.outerHTML.slice(0, 600),
            imageCount: allImages.length,
            images: Array.from(allImages).map(img => ({
              classes: Array.from(img.classList),
              alt: img.alt || '',
              src: img.src?.slice(-50) || ''
            }))
          };
        });
      })()
    `;

    const response = (await connector.evaluate(inspectScript)) as {
      result?: { value?: any[] };
    };

    const domInfo = response.result?.value || [];

    console.log(`共找到 ${domInfo.length} 个消息节点:\n`);

    domInfo.forEach(info => {
      console.log(`--- 消息 ${info.index + 1} (ID: ${info.id}) ---`);
      console.log(`  isMe: ${info.isMe}`);
      console.log(`  hasContentEl (.pictext-text.js-highlight): ${info.hasContentEl}`);
      console.log(`  imageCount: ${info.imageCount}`);

      if (info.imageCount > 0) {
        console.log(`  图片信息:`);
        info.images.forEach((img: any, i: number) => {
          console.log(`    [${i + 1}] classes: ${img.classes.join(', ')}`);
          console.log(`        alt: ${img.alt}`);
        });
      }

      if (info.hasContentEl) {
        console.log(`  contentHTML: ${info.contentHTML}`);
      } else {
        console.log(`  ⚠️  没有 contentEl，查看完整 HTML:`);
        console.log(`  ${info.itemOuterHTML.slice(0, 400)}...`);
      }
      console.log('');
    });
  } catch (error) {
    console.error('诊断出错:', error);
  } finally {
    connector.disconnect();
  }
}

diagnoseMessages().catch(console.error);
