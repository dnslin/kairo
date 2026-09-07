import { CdpClient } from '../src/cdp/client.js';

async function main() {
  const cdp = new CdpClient({ url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' });
  await cdp.connect();

  const res = await cdp.evaluate(`
    (function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var v = all[i].__vue__;
        if (v && v.$options && v.$options.name === 'chat-content') {
          return {
            name: v.$options.name,
            sessionID: v.sessionID,
            curMaxMsgIdx: v.curMaxMsgIdx,
            orgnalMaxIdx: v.orgnalMaxIdx,
            messagesCount: v.messages ? v.messages.length : 0,
            messages: v.messages ? v.messages.map(function(m) {
              return {
                id: m.id,
                msgIdx: m.msgIdx,
                contentType: m.contentType,
                sender: m.sender,
                senderName: m.senderName,
                sendTime: m.sendTime,
                content: typeof m.content === 'object' ? JSON.stringify(m.content).slice(0, 80) : String(m.content).slice(0, 80)
              };
            }) : []
          };
        }
      }
      return 'chat-content not found';
    })()
  `);

  console.log('chat-content data:', JSON.stringify(res, null, 2));
  await cdp.disconnect();
}

void main();
