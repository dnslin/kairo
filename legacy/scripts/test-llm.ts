import { LlmClient } from '../src/llm/client.js';
import { loadConfig } from '../src/config/loader.js';
import type { MessageInfo } from '../src/dom/locator.js';

async function main() {
  console.log('加载配置文件...');
  const config = loadConfig();

  console.log('测试 LLM 客户端连接...\n');
  console.log(`baseUrl: ${config.llm.baseUrl}`);
  console.log(`model: ${config.llm.model}\n`);

  const client = new LlmClient(config.llm, config.validation);

  const testMessage: MessageInfo = {
    id: 'test-1',
    sender: '测试用户',
    content: '你好，请用一句话介绍一下你自己。',
    time: '10:00',
    isMe: false,
  };

  console.log(`发送: ${testMessage.content}`);
  console.log('等待回复...\n');

  const start = Date.now();

  try {
    const reply = await client.generateReply(testMessage, []);
    const duration = Date.now() - start;

    if (reply) {
      console.log(`回复 (${duration}ms): ${reply}`);
      console.log('\n✓ LLM 客户端连接测试成功!');
    } else {
      console.log('返回 null (可能触发敏感词过滤)');
    }
  } catch (error) {
    console.error('调用失败:', error);
    process.exit(1);
  }
}

main();
