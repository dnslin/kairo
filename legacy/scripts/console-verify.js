// 测试脚本
// /**
//  * KKBot Phase 0 - DevTools Console 验证脚本
//  *
//  * 用法：在 KK9 客户端的 DevTools Console 中直接粘贴执行
//  * 前提：已选中一个会话
//  *
//  * 验证内容：
//  * 1. 读取最近 5 条消息
//  * 2. 写入测试文本到输入框
//  * 3. 触发发送（可选，需手动确认）
//  */

// (async function KKBotConsoleVerify() {
//   console.log('========== KKBot Console Verification ==========');
//   console.log('开始验证...');

//   // === Selector 配置 ===
//   const SELECTORS = {
//     messageItem: '.record-item',
//     messageContent: '.pictext-text.js-highlight',
//     messageSender: '.rcd-basic-name .username',
//     messageTime: '.rcd-time',
//     messageRight: '.rcd-msg-right',
//     inputBox: '.chat-sendArea',
//     sendButton: '.sendMsg-btn a.button',
//   };

//   // === 工具函数：提取消息内容（处理表情/图片）===
//   function extractContent(el) {
//     if (!el) return '';
//     let result = '';
//     el.childNodes.forEach(node => {
//       if (node.nodeType === Node.TEXT_NODE) {
//         const text = node.textContent;
//         if (text) result += text;
//       } else if (node.nodeType === Node.ELEMENT_NODE) {
//         const tag = node.tagName;
//         if (tag === 'IMG') {
//           result += node.getAttribute('emoji') || node.getAttribute('alt') || '[image]';
//         } else if (node.classList && node.classList.contains('emoji-span')) {
//           result += node.getAttribute('data-emoji') || '[emoji]';
//         } else if (node.classList && node.classList.contains('emoticon')) {
//           result += node.textContent || '[emoticon]';
//         } else if (node.classList && node.classList.contains('sticker')) {
//           result += '[sticker]';
//         } else {
//           result += extractContent(node);
//         }
//       }
//     });
//     return result.trim();
//   }

//   // === Step 1: 读取最近 5 条消息 ===
//   console.log('\n[Step 1] 读取最近 5 条消息...');

//   const messageItems = document.querySelectorAll(SELECTORS.messageItem);
//   const recentMessages = Array.from(messageItems).slice(-5);

//   if (recentMessages.length === 0) {
//     console.error('未找到消息节点！请确保已选中一个会话。');
//     return { success: false, step: 1, error: 'No messages found' };
//   }

//   console.log(`找到 ${messageItems.length} 条消息，显示最近 5 条：`);
//   recentMessages.forEach((msg, i) => {
//     const contentEl = msg.querySelector(SELECTORS.messageContent);
//     const senderEl = msg.querySelector(SELECTORS.messageSender);
//     const timeEl = msg.querySelector(SELECTORS.messageTime);
//     const isMe = msg.querySelector(SELECTORS.messageRight) !== null;

//     const sender = senderEl ? senderEl.textContent.trim() : isMe ? '[我]' : '[对方]';
//     const content = contentEl ? extractContent(contentEl) : '[无文本内容]';
//     const time = timeEl ? timeEl.textContent.trim() : '';

//     console.log(
//       `  [${i + 1}] ${sender}: ${content.slice(0, 50)}${content.length > 50 ? '...' : ''} (${time})`
//     );
//   });

//   console.log('Step 1 PASSED');

//   // === Step 2: 写入测试文本到输入框 ===
//   console.log('\n[Step 2] 写入测试文本到输入框...');

//   const inputBox = document.querySelector(SELECTORS.inputBox);
//   if (!inputBox) {
//     console.error('未找到输入框！');
//     return { success: false, step: 2, error: 'Input box not found' };
//   }

//   const isEditable = inputBox.getAttribute('contenteditable') === 'true';
//   if (!isEditable) {
//     console.error('输入框不可编辑！');
//     return { success: false, step: 2, error: 'Input box not editable' };
//   }

//   const testText = `[KKBot测试] ${new Date().toLocaleTimeString()}`;

//   // 聚焦并写入
//   inputBox.focus();
//   inputBox.textContent = testText;

//   // 触发必要事件
//   inputBox.dispatchEvent(new Event('input', { bubbles: true }));
//   inputBox.dispatchEvent(new Event('change', { bubbles: true }));

//   // 验证写入
//   const writtenText = inputBox.textContent.trim();
//   if (writtenText !== testText) {
//     console.error(`写入验证失败！期望: "${testText}"，实际: "${writtenText}"`);
//     return { success: false, step: 2, error: 'Text write verification failed' };
//   }

//   console.log(`已写入: "${testText}"`);
//   console.log('Step 2 PASSED');

//   // === Step 3: 检查发送按钮 ===
//   console.log('\n[Step 3] 检查发送按钮...');

//   const sendBtn = document.querySelector(SELECTORS.sendButton);
//   if (!sendBtn) {
//     console.error('未找到发送按钮！');
//     return { success: false, step: 3, error: 'Send button not found' };
//   }

//   console.log(`发送按钮已找到，文本: "${sendBtn.textContent.trim()}"`);
//   console.log('Step 3 PASSED');

//   // === 结果汇总 ===
//   console.log('\n========== 验证结果 ==========');
//   console.log('Step 1 读取消息: PASSED');
//   console.log('Step 2 写入输入: PASSED');
//   console.log('Step 3 发送按钮: PASSED');
//   console.log('\n所有验证通过！');
//   console.log('\n注意：输入框中已写入测试文本，但未自动发送。');
//   console.log('如需测试发送，请执行: document.querySelector(".sendMsg-btn a.button").click()');

//   return {
//     success: true,
//     selectors: SELECTORS,
//     messagesFound: messageItems.length,
//     inputBoxEditable: true,
//     sendButtonFound: true,
//     testText: testText,
//   };
// })();
