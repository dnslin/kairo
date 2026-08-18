/**
 * MessageWatcher 验证脚本
 *
 * 通过 CDP 连接 KK9 客户端，验证 MessageWatcher 轮询功能：
 * 1. 连接 CDP
 * 2. 初始化 MessageExtractor 和 MessageWatcher
 * 3. 启动轮询，监控新消息
 * 4. 显示检测到的新消息
 */

import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { MessageExtractor } from '../src/extract/extractor.js';
import { MessageWatcher } from '../src/watch/watcher.js';
import { loadConfig } from '../src/config/loader.js';

async function runWatcherVerification(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);
  const extractor = new MessageExtractor(locator);
  const watcher = new MessageWatcher(extractor, config.watcher);

  let messageCount = 0;

  try {
    console.log('========== MessageWatcher 验证 ==========\n');
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接!\n');

    console.log(`轮询间隔: ${config.watcher.intervalMs}ms`);
    console.log(`每次提取: ${config.watcher.maxMessages} 条消息`);
    console.log('\n开始监控新消息... (Ctrl+C 退出)\n');

    watcher.start(message => {
      messageCount++;
      console.log(`[新消息 #${messageCount}]`);
      console.log(`  会话: ${message.sessionId}`);
      console.log(`  发送方: ${message.sender}`);
      console.log(`  时间: ${message.time}`);
      console.log(
        `  内容: ${message.content.slice(0, 100)}${message.content.length > 100 ? '...' : ''}`
      );
      console.log(`  指纹: ${message.fingerprint.slice(0, 16)}...`);
      console.log('');
    });

    await new Promise<void>(resolve => {
      process.on('SIGINT', () => {
        console.log('\n收到 SIGINT，停止监控...');
        resolve();
      });
    });
  } catch (error) {
    console.error('验证过程出错:', error);
    throw error;
  } finally {
    watcher.stop();
    connector.disconnect();
    console.log(`\n共检测到 ${messageCount} 条新消息`);
    console.log('验证完成');
  }
}

runWatcherVerification().catch(err => {
  console.error('验证失败:', err);
  process.exit(1);
});
