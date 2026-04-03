import { loadConfig } from '../src/config/loader.js';
import { CdpConnectionError, CdpConnector } from '../src/cdp/connector.js';
import { DomLocator } from '../src/dom/locator.js';

interface CliOptions {
  send: boolean;
  text: string;
  verifyTimeoutMs: number;
}

interface HookProbeResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  sessionName?: string;
  methods?: string[];
}

interface HookSendResult {
  ok: boolean;
  error?: string;
  sessionId?: string;
  sessionName?: string;
  text?: string;
}

function parseArgs(argv: string[]): CliOptions {
  let send = false;
  let text = `[Hook发送Demo] ${new Date().toLocaleString('zh-CN')}`;
  let verifyTimeoutMs = 5000;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--send') {
      send = true;
      continue;
    }

    if (arg === '--text') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --text 参数值');
      }
      text = value;
      index += 1;
      continue;
    }

    if (arg === '--verify-timeout-ms') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('缺少 --verify-timeout-ms 参数值');
      }
      const parsed = Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--verify-timeout-ms 必须是正整数');
      }
      verifyTimeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    throw new Error(`未知参数: ${arg}`);
  }

  return { send, text, verifyTimeoutMs };
}

function printUsage(): void {
  console.log('用法: pnpm exec tsx scripts/demo-hook-send.ts [--send] [--text 文本] [--verify-timeout-ms 毫秒]');
  console.log('说明: 默认只探测页面内部发送能力，带 --send 才实际发送消息。');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function evaluateValue<T>(
  connector: CdpConnector,
  expression: string,
  awaitPromise = false
): Promise<T> {
  const response = await connector.sendCommand('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise,
  });

  if (response.error) {
    throw new CdpConnectionError(`执行页面脚本失败: ${response.error.message}`);
  }

  const payload = response.result as {
    exceptionDetails?: { text?: string };
    result?: { value?: T; description?: string };
  };

  if (payload.exceptionDetails) {
    throw new CdpConnectionError(payload.exceptionDetails.text || '页面脚本执行异常');
  }

  return payload.result?.value as T;
}

async function probeHook(connector: CdpConnector): Promise<HookProbeResult> {
  return await evaluateValue<HookProbeResult>(
    connector,
    `(() => {
      const vm = document.querySelector('.chat-editor')?.__vue__;
      if (!vm) {
        return { ok: false, error: '未找到 MessageEditor 组件' };
      }

      if (typeof vm.sendPicTextMessage !== 'function') {
        return { ok: false, error: '未找到 sendPicTextMessage 方法' };
      }

      const methods = Object.keys(vm.$options?.methods || {})
        .filter(name => /send|getContent|reply/i.test(name))
        .sort();

      return {
        ok: true,
        sessionId: vm.activedSes?.sesUUID || '',
        sessionName: vm.activedSes?.showName || vm.activedSes?.typeName || vm.activedSes?.name || '',
        methods,
      };
    })()`
  );
}

async function sendByHook(connector: CdpConnector, text: string): Promise<HookSendResult> {
  const payload = JSON.stringify([{ type: 0, text }]);

  return await evaluateValue<HookSendResult>(
    connector,
    `(async () => {
      const vm = document.querySelector('.chat-editor')?.__vue__;
      if (!vm) {
        return { ok: false, error: '未找到 MessageEditor 组件' };
      }

      if (typeof vm.sendPicTextMessage !== 'function') {
        return { ok: false, error: '未找到 sendPicTextMessage 方法' };
      }

      try {
        await vm.sendPicTextMessage(${payload});
        return {
          ok: true,
          sessionId: vm.activedSes?.sesUUID || '',
          sessionName: vm.activedSes?.showName || vm.activedSes?.typeName || vm.activedSes?.name || '',
          text: ${JSON.stringify(text)},
        };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })()`,
    true
  );
}

async function verifyMessage(locator: DomLocator, text: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const probeText = text.slice(0, 20);

  while (Date.now() < deadline) {
    const messages = await locator.getMessages(10);
    if (messages.some(message => message.isMe && message.content.includes(probeText))) {
      return true;
    }
    await sleep(200);
  }

  return false;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig();
  const connector = new CdpConnector(config.cdp, config.page);
  const locator = new DomLocator(connector, config.selectors);

  try {
    console.log('连接 CDP...');
    await connector.connect();
    console.log('已连接到 KK9 渲染页面。');

    const probe = await probeHook(connector);
    if (!probe.ok) {
      throw new Error(probe.error || 'Hook 探测失败');
    }

    console.log(`Hook 可用，会话 ID: ${probe.sessionId || '未知'}`);
    console.log(`Hook 会话名: ${probe.sessionName || '未知'}`);
    console.log(`可见方法: ${(probe.methods || []).join(', ')}`);

    if (!options.send) {
      console.log('当前为探测模式，未实际发送。');
      console.log(`如需发送，请执行: pnpm exec tsx scripts/demo-hook-send.ts --send --text "${options.text}"`);
      return;
    }

    console.log(`准备通过页面内部 Hook 发送消息: ${options.text}`);
    const sendResult = await sendByHook(connector, options.text);
    if (!sendResult.ok) {
      throw new Error(sendResult.error || 'Hook 发送失败');
    }

    console.log('Hook 调用已完成，开始验证消息是否进入当前会话。');
    const verified = await verifyMessage(locator, options.text, options.verifyTimeoutMs);
    if (!verified) {
      throw new Error('发送后验证超时，未在最近消息中看到目标文本');
    }

    console.log('发送成功，已在当前会话中检测到新消息。');
  } finally {
    connector.disconnect();
  }
}

main().catch(error => {
  console.error('Demo 执行失败:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
