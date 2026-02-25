import { CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';
import { loadConfig } from '../src/config/loader.js';

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testClipboardImage(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);

  try {
    console.log('========== 剪切板图片发送测试 ==========\n');
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接!\n');

    console.log('获取会话列表...');
    const sessions = await locator.getAllSessions();
    console.log(`找到 ${sessions.length} 个会话\n`);

    const targetSession = sessions.find(s => s.name.includes('int2024'));

    if (!targetSession) {
      console.error('未找到 int2024 会话');
      return;
    }

    console.log(`目标会话: ${targetSession.name}`);

    if (!targetSession.isSelected) {
      console.log('切换到 int2024 会话...');
      const selected = await locator.selectSession(targetSession.id);
      if (!selected) {
        console.error('切换会话失败!');
        return;
      }
      await sleep(1000);
      console.log('已切换');
    }

    console.log('\n开始测试剪切板粘贴...');

    const inputBox = await locator.getInputBox();
    if (!inputBox.found) {
      console.error('输入框未找到');
      return;
    }
    if (!inputBox.editable) {
      console.error('输入框不可编辑');
      return;
    }

    console.log('输入框已就绪');
    console.log('聚焦输入框并触发粘贴事件 (Ctrl+V)...');

    console.log('使用 CDP Input API 模拟 Ctrl+V 键盘操作...');

    // 聚焦输入框
    const focusScript = `
      (function() {
        const inputBox = document.querySelector('${config.selectors.inputBox}');
        if (!inputBox) return false;
        inputBox.focus();
        return true;
      })()
    `;

    const focusResponse = (await connector.evaluate(focusScript)) as {
      result?: { value?: boolean };
    };

    if (!focusResponse.result?.value) {
      console.error('聚焦输入框失败');
      return;
    }

    console.log('输入框已聚焦');
    await sleep(500);

    // 模拟 Ctrl+V 按键
    // keyDown Ctrl
    await connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 2, // Ctrl modifier
    });

    // keyDown V
    await connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2, // Ctrl modifier
    });

    // keyUp V
    await connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'v',
      code: 'KeyV',
      windowsVirtualKeyCode: 86,
      nativeVirtualKeyCode: 86,
      modifiers: 2,
    });

    // keyUp Ctrl
    await connector.sendCommand('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Control',
      code: 'ControlLeft',
      windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
      modifiers: 0,
    });

    console.log('✅ Ctrl+V 键盘事件已发送');


    console.log('等待 3 秒观察粘贴效果...');
    await sleep(3000);
      console.log('\n检查发送按钮状态...');
    const sendButton = await locator.getSendButton();
    console.log(
      `发送按钮: found=${sendButton.found}, visible=${sendButton.visible}, enabled=${sendButton.enabled}`
    );
      if (sendButton.found && sendButton.visible) {
      console.log('\n尝试点击发送按钮...');
      const clicked = await locator.clickSendButton();
      if (clicked) {
        console.log('✅ 发送按钮已点击');
        console.log('等待 3 秒验证发送结果...');
        await sleep(3000);
          const messages = await locator.getMessages(5);
        console.log(`\n最近 ${messages.length} 条消息:`);
        messages.forEach(m => {
          console.log(`  ${m.isMe ? '[我]' : `[${m.sender}]`}: ${m.content.slice(0, 50)}`);
        });
      } else {
        console.log('❌ 点击发送按钮失败');
      }
    } else {
      console.log('⚠️  发送按钮不可用，可能需要手动检查输入框内容');
    }

    console.log('\n========== 测试完成 ==========');
    console.log('请手动检查 KK9 窗口确认结果');
  } catch (error) {
    console.error('测试出错:', error);
  } finally {
    connector.disconnect();
  }
}

testClipboardImage().catch(console.error);
