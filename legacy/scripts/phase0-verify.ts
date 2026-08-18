/**
 * KKBot Phase 0 - 完整验证脚本
 *
 * 通过 CDP 连接 KK9 客户端，验证：
 * 1. 读取消息
 * 2. 写入输入框
 * 3. 触发发送
 * 4. 验证新消息出现
 */

import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { loadConfig } from '../src/config/loader.js';

interface Phase0Result {
  step1_readMessages: {
    success: boolean;
    count: number;
    samples: Array<{ sender: string; content: string; time: string }>;
  };
  step2_writeInput: {
    success: boolean;
    text: string;
  };
  step3_triggerSend: {
    success: boolean;
  };
  step4_verifyNewMessage: {
    success: boolean;
    found: boolean;
    newMessageContent?: string;
  };
  overallSuccess: boolean;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runPhase0Verification(): Promise<Phase0Result> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);

  const result: Phase0Result = {
    step1_readMessages: { success: false, count: 0, samples: [] },
    step2_writeInput: { success: false, text: '' },
    step3_triggerSend: { success: false },
    step4_verifyNewMessage: { success: false, found: false },
    overallSuccess: false,
  };

  try {
    console.log('========== KKBot Phase 0 Verification ==========\n');
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接!\n');

    // === Step 1: 读取消息 ===
    console.log('[Step 1] 读取最近 5 条消息...');
    const messages = await locator.getMessages(5);

    if (messages.length === 0) {
      console.error('未找到消息！请确保已选中一个会话。');
      return result;
    }

    result.step1_readMessages.success = true;
    result.step1_readMessages.count = messages.length;
    result.step1_readMessages.samples = messages.map(m => ({
      sender: m.sender || (m.isMe ? '[我]' : '[对方]'),
      content: m.content.slice(0, 50) + (m.content.length > 50 ? '...' : ''),
      time: m.time,
    }));

    console.log(`找到 ${messages.length} 条消息：`);
    result.step1_readMessages.samples.forEach((m, i) => {
      console.log(`  [${i + 1}] ${m.sender}: ${m.content} (${m.time})`);
    });
    console.log('Step 1 PASSED\n');

    // === Step 2: 写入输入框 ===
    console.log('[Step 2] 写入测试文本到输入框...');

    const inputStatus = await locator.getInputBox();
    if (!inputStatus.found || !inputStatus.editable) {
      console.error('输入框未找到或不可编辑！');
      return result;
    }

    const testText = `[KKBot验证] ${new Date().toLocaleTimeString()}`;
    const writeSuccess = await locator.setInputText(testText);

    if (!writeSuccess) {
      console.error('写入输入框失败！');
      return result;
    }

    result.step2_writeInput.success = true;
    result.step2_writeInput.text = testText;
    console.log(`已写入: "${testText}"`);
    console.log('Step 2 PASSED\n');

    // === Step 3: 触发发送 ===
    console.log('[Step 3] 触发发送...');

    // 记录发送前的消息数量
    const messagesBeforeSend = await locator.getMessages(100);
    const countBefore = messagesBeforeSend.length;
    console.log(`发送前消息数: ${countBefore}`);

    const sendSuccess = await locator.clickSendButton();

    if (!sendSuccess) {
      console.error('点击发送按钮失败！');
      return result;
    }

    result.step3_triggerSend.success = true;
    console.log('发送按钮已点击');
    console.log('Step 3 PASSED\n');

    // === Step 4: 验证新消息出现 ===
    console.log('[Step 4] 验证新消息出现...');
    console.log('等待 2 秒...');
    await sleep(2000);

    const messagesAfterSend = await locator.getMessages(100);
    const countAfter = messagesAfterSend.length;
    console.log(`发送后消息数: ${countAfter}`);

    if (countAfter > countBefore) {
      // 检查最后一条消息是否是我们发送的
      const lastMessage = messagesAfterSend[messagesAfterSend.length - 1];
      const isOurMessage = lastMessage.isMe && lastMessage.content.includes('[KKBot验证]');

      result.step4_verifyNewMessage.success = isOurMessage;
      result.step4_verifyNewMessage.found = true;
      result.step4_verifyNewMessage.newMessageContent = lastMessage.content;

      if (isOurMessage) {
        console.log(`新消息已出现: "${lastMessage.content}"`);
        console.log('Step 4 PASSED\n');
      } else {
        console.log(`新消息出现但内容不匹配: "${lastMessage.content}"`);
        console.log('Step 4 PARTIAL\n');
      }
    } else {
      console.log('未检测到新消息');
      result.step4_verifyNewMessage.success = false;
      result.step4_verifyNewMessage.found = false;
    }

    // === 结果汇总 ===
    result.overallSuccess =
      result.step1_readMessages.success &&
      result.step2_writeInput.success &&
      result.step3_triggerSend.success &&
      result.step4_verifyNewMessage.success;

    console.log('========== 验证结果汇总 ==========');
    console.log(`Step 1 读取消息: ${result.step1_readMessages.success ? 'PASSED' : 'FAILED'}`);
    console.log(`Step 2 写入输入: ${result.step2_writeInput.success ? 'PASSED' : 'FAILED'}`);
    console.log(`Step 3 触发发送: ${result.step3_triggerSend.success ? 'PASSED' : 'FAILED'}`);
    console.log(
      `Step 4 验证新消息: ${result.step4_verifyNewMessage.success ? 'PASSED' : 'FAILED'}`
    );
    console.log(`\n整体结果: ${result.overallSuccess ? 'ALL PASSED' : 'SOME FAILED'}`);

    return result;
  } catch (error) {
    console.error('验证过程出错:', error);
    throw error;
  } finally {
    connector.disconnect();
  }
}

// 运行验证
runPhase0Verification()
  .then(result => {
    console.log('\n验证完成');
    if (!result.overallSuccess) {
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('验证失败:', err);
    process.exit(1);
  });
