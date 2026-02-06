import { CdpConnector } from '../src/cdp/connector.js';
import { loadConfig } from '../src/config/loader.js';

interface VerificationResult {
  sessionList: { found: boolean; count: number };
  currentSession: { found: boolean; name: string | null; isGroup: boolean | null };
  messages: {
    found: boolean;
    count: number;
    samples: Array<{ sender: string; content: string; time: string }>;
  };
  inputBox: { found: boolean; editable: boolean };
  sendButton: { found: boolean; text: string | null };
}

async function verifySelectors(): Promise<void> {
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);

  console.log('Connecting to CDP...');
  await connector.connect();
  console.log('Connected! Verifying selectors...\n');

  const verificationScript = `
    (function() {
      function extractContent(el) {
        if (!el) return '';
        let result = '';
        el.childNodes.forEach(node => {
          if (node.nodeType === 3) {
            const text = node.textContent?.trim();
            if (text) result += text;
          } else if (node.nodeType === 1) {
            const tag = node.tagName;
            if (tag === 'IMG') {
              result += node.getAttribute('alt') || '[image]';
            } else if (node.classList.contains('emoji-span')) {
              result += node.getAttribute('data-emoji') || '[emoji]';
            } else if (node.classList.contains('emoticon')) {
              result += node.textContent || '[emoticon]';
            } else if (node.classList.contains('sticker')) {
              result += '[sticker]';
            } else {
              result += extractContent(node);
            }
          }
        });
        return result.trim();
      }
      
      const results = {
        sessionList: { found: false, count: 0 },
        currentSession: { found: false, name: null, isGroup: null },
        messages: { found: false, count: 0, samples: [] },
        inputBox: { found: false, editable: false },
        sendButton: { found: false, text: null }
      };

      const sessionItems = document.querySelectorAll('.chat-item');
      results.sessionList.found = sessionItems.length > 0;
      results.sessionList.count = sessionItems.length;

      const selectedSession = document.querySelector('.chat-item.chat-selected');
      if (selectedSession) {
        results.currentSession.found = true;
        const nameEl = selectedSession.querySelector('.chat-item-username');
        results.currentSession.name = nameEl ? nameEl.textContent.trim() : null;
        
        const avatar = selectedSession.querySelector('.chat-item-avatar');
        const hasGroupAvatar = avatar && avatar.querySelector('.group-avatar-wrapper, .kk-icon-discuss');
        results.currentSession.isGroup = !!hasGroupAvatar;
      }

      const messageContainer = document.querySelector('.chat-content');
      const messageItems = document.querySelectorAll('.record-item');
      results.messages.found = messageItems.length > 0;
      results.messages.count = messageItems.length;

      const lastMessages = Array.from(messageItems).slice(-3);
      lastMessages.forEach(msg => {
        const contentEl = msg.querySelector('.pictext-text.js-highlight');
        const senderEl = msg.querySelector('.rcd-basic-name .username');
        const timeEl = msg.querySelector('.rcd-time');
        const isRight = msg.querySelector('.rcd-msg-right') !== null;
        
        results.messages.samples.push({
          sender: senderEl ? senderEl.textContent.trim() : (isRight ? '[ME]' : '[OTHER]'),
          content: contentEl ? extractContent(contentEl).slice(0, 100) : '[no text]',
          time: timeEl ? timeEl.textContent.trim() : ''
        });
      });

      const inputBox = document.querySelector('.chat-sendArea');
      if (inputBox) {
        results.inputBox.found = true;
        results.inputBox.editable = inputBox.getAttribute('contenteditable') === 'true';
      }

      const sendBtn = document.querySelector('.sendMsg-btn a.button');
      if (sendBtn) {
        results.sendButton.found = true;
        results.sendButton.text = sendBtn.textContent.trim();
      }

      return results;
    })()
  `;

  const response = (await connector.evaluate(verificationScript)) as {
    result?: { value?: VerificationResult };
  };
  const results = response.result?.value;

  if (!results) {
    console.error('Failed to get verification results');
    connector.disconnect();
    return;
  }

  console.log('========== SELECTOR VERIFICATION ==========\n');

  console.log('SESSION LIST:');
  console.log(`  Found: ${results.sessionList.found ? 'YES' : 'NO'}`);
  console.log(`  Count: ${results.sessionList.count} sessions`);

  console.log('\nCURRENT SESSION:');
  console.log(`  Found: ${results.currentSession.found ? 'YES' : 'NO'}`);
  console.log(`  Name: ${results.currentSession.name || 'N/A'}`);
  console.log(
    `  Type: ${results.currentSession.isGroup === null ? 'N/A' : results.currentSession.isGroup ? 'GROUP' : 'PRIVATE'}`
  );

  console.log('\nMESSAGES:');
  console.log(`  Found: ${results.messages.found ? 'YES' : 'NO'}`);
  console.log(`  Count: ${results.messages.count} messages`);
  if (results.messages.samples.length > 0) {
    console.log('  Last messages:');
    results.messages.samples.forEach((m, i) => {
      console.log(`    [${i + 1}] ${m.sender}: ${m.content} (${m.time})`);
    });
  }

  console.log('\nINPUT BOX:');
  console.log(`  Found: ${results.inputBox.found ? 'YES' : 'NO'}`);
  console.log(`  Editable: ${results.inputBox.editable ? 'YES' : 'NO'}`);

  console.log('\nSEND BUTTON:');
  console.log(`  Found: ${results.sendButton.found ? 'YES' : 'NO'}`);
  console.log(`  Text: ${results.sendButton.text || 'N/A'}`);

  const allPassed =
    results.sessionList.found &&
    results.currentSession.found &&
    results.messages.found &&
    results.inputBox.found &&
    results.inputBox.editable &&
    results.sendButton.found;

  console.log('\n==========================================');
  console.log(`VERIFICATION: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
  console.log('==========================================\n');

  connector.disconnect();
}

verifySelectors().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
