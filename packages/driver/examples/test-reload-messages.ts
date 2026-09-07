import { CdpClient } from '../src/cdp/client.js';

async function main() {
  const cdp = new CdpClient({ url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' });
  await cdp.connect();

  const res = await cdp.evaluate(`
    (async function() {
      var all = document.querySelectorAll('*');
      for (var i = 0; i < all.length; i++) {
        var v = all[i].__vue__;
        if (v && v.$options && v.$options.name === 'chat-content') {
          var msgs = await v.getMessages(324, 15);
          return {
            count: msgs ? msgs.length : 0,
            items: msgs ? msgs.map(function(m) {
              return { id: m.id, msgIdx: m.msgIdx, type: m.contentType, text: typeof m.content === 'object' ? JSON.stringify(m.content).slice(0, 50) : String(m.content).slice(0, 50) };
            }) : []
          };
        }
      }
      return 'chat-content not found';
    })()
  `);

  console.log('getMessages(324, 15):', JSON.stringify(res, null, 2));
  await cdp.disconnect();
}

void main();
