import { CdpClient } from '../src/cdp/client.js';

async function main() {
  const cdp = new CdpClient({ url: 'http://127.0.0.1:9222', pageMatch: 'renderer.html' });
  await cdp.connect();

  const res = await cdp.evaluate(`
    (function() {
      var app = document.querySelector('#app');
      var v = app && app.__vue__;
      var store = v && v.$store;
      if (!store) return 'no store';
      return {
        messageState: Object.keys(store.state.message),
        messageData: store.state.message
      };
    })()
  `);
  console.log('Component messageList:', res);
  await cdp.disconnect();
}

void main();
