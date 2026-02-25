/**
 * Store 模块交互验证脚本（真实 CDP 集成）
 *
 * 用法：npx tsx scripts/store-verify.ts
 *
 * 逐项验证 Issue #20 的功能验收标准
 * 连接真实 KK9 客户端，读取 int2024 会话消息并存入 SQLite
 */

// 静默 pino 日志，避免 Windows 终端中文乱码
// 必须在动态 import 之前设置，ESM 的 import 声明会被提升
process.env['LOG_LEVEL'] = 'silent';

import { rmSync, existsSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

const DB_PATH = './tmp/store-verify.db';

// 清理上次验证残留
try {
  rmSync(DB_PATH, { force: true });
  rmSync(`${DB_PATH}-wal`, { force: true });
  rmSync(`${DB_PATH}-shm`, { force: true });
  rmSync('./tmp/store-verify-secure.db', { force: true });
  rmSync('./tmp/store-verify-secure.db-wal', { force: true });
  rmSync('./tmp/store-verify-secure.db-shm', { force: true });
} catch {
  /* 忽略 */
}

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean): void {
  if (ok) {
    console.log(`  \u2705 ${name}`);
    passed++;
  } else {
    console.log(`  \u274C ${name}`);
    failed++;
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function main(): Promise<void> {
  // 动态导入项目模块，确保 LOG_LEVEL=silent 已生效
  const { Store } = await import('../src/store/index.js');
  const { CdpConnector } = await import('../src/cdp/connector.js');
  const { DomLocator } = await import('../src/dom/locator.js');
  const { MessageExtractor } = await import('../src/extract/index.js');
  const { loadConfig } = await import('../src/config/loader.js');

  console.log('\n========================================');
  console.log('  Store 模块验证 — Issue #20');
  console.log('========================================');

  const store = new Store({ dbPath: DB_PATH, storeMessageContent: true });

  // ────────────────────────────────────
  // 1. 自动创建数据库
  // ────────────────────────────────────
  section('\uD83D\uDCE6 1. 自动创建数据库');
  check('数据库文件已创建', existsSync(DB_PATH));

  // ────────────────────────────────────
  // 2. 消息指纹去重
  // ────────────────────────────────────
  section('\uD83D\uDD0D 2. 消息指纹去重');
  check('未处理指纹返回 false', store.isProcessed('verify-fp-001') === false);

  store.markProcessed('verify-fp-001');
  check('标记后返回 true', store.isProcessed('verify-fp-001') === true);

  store.markProcessed('verify-fp-001');
  check('重复标记不报错', store.isProcessed('verify-fp-001') === true);

  check('不同指纹互不影响', store.isProcessed('verify-fp-002') === false);

  // ────────────────────────────────────
  // 3. 真实会话消息存取（CDP → int2024）
  // ────────────────────────────────────
  section('\uD83D\uDCAC 3. 真实会话消息存取（int2024）');

  let connector: InstanceType<typeof CdpConnector> | null = null;
  try {
    console.log('  \u23F3 连接 KK9 客户端...');
    const config = loadConfig();
    connector = new CdpConnector(config.cdp, config.page);
    const locator = new DomLocator(connector, config.selectors);
    const extractor = new MessageExtractor(locator);

    await connector.connect();
    console.log('  \u23F3 已连接，查找 int2024 会话...');

    // 查找并选择 int2024 会话
    const sessions = await locator.getSessions();
    const targetSession = sessions.find(s => s.name.includes('int2024'));

    if (!targetSession) {
      console.log('  \u26A0\uFE0F  未找到 int2024 会话，跳过真实数据测试');
      console.log(`  可用会话: ${sessions.map(s => s.name).join(', ')}`);
    } else {
      console.log(`  \u23F3 找到会话: ${targetSession.name} (${targetSession.id})`);

      // 切换到目标会话
      if (!targetSession.isSelected) {
        await locator.selectSession(targetSession.id);
        await new Promise(resolve => setTimeout(resolve, 1500));
        console.log('  \u23F3 已切换到目标会话，等待加载...');
      }

      // 提取真实消息
      const realMessages = await extractor.getRecentMessages(10);
      console.log(`  \u23F3 提取到 ${String(realMessages.length)} 条消息`);

      check('成功提取真实消息', realMessages.length > 0);

      // 存入 SQLite
      for (const msg of realMessages) {
        store.saveMessage(
          targetSession.id,
          {
            sender: msg.sender || '(未知)',
            content: msg.content,
            isFromSelf: msg.sender === '',
          },
          targetSession.name
        );

        // 同时标记指纹
        store.markProcessed(msg.fingerprint);
      }

      store.logEvent('messages_stored', {
        sessionId: targetSession.id,
        sessionName: targetSession.name,
        count: realMessages.length,
      });

      // 验证从 DB 读取
      const dbHistory = store.getSessionHistory(targetSession.id, 20);
      check('消息已持久化到 SQLite', dbHistory.length === realMessages.length);
      check('消息内容完整', dbHistory.length > 0 && dbHistory[0]!.content.length > 0);

      // 验证指纹去重
      if (realMessages.length > 0) {
        check('指纹已标记为已处理', store.isProcessed(realMessages[0]!.fingerprint));
      }

      // 打印真实消息预览
      console.log('\n  int2024 会话消息预览:');
      for (const msg of dbHistory) {
        const role = msg.isFromSelf ? '[Bot]' : '[User]';
        const preview = msg.content.length > 50 ? msg.content.slice(0, 50) + '...' : msg.content;
        console.log(`     ${role} ${msg.sender}: ${preview}`);
      }
    }
  } catch (error) {
    console.log(`  \u26A0\uFE0F  CDP 连接失败: ${String(error)}`);
    console.log(
      '  \u26A0\uFE0F  跳过真实数据测试（确保 KK9 已启动并开启 --remote-debugging-port=9222）'
    );
  } finally {
    if (connector) {
      connector.disconnect();
    }
  }

  // ────────────────────────────────────
  // 4. 事件日志
  // ────────────────────────────────────
  section('\uD83D\uDCDD 4. 事件日志');
  store.logEvent('message_sent', { sessionId: 'ses-v1', text: 'hello' });
  store.logEvent('llm_call', { model: 'gpt-4o-mini', tokens: 150 });
  store.logEvent('error', { code: 500, msg: 'timeout' });

  const allEvents = store.getEvents();
  check('事件记录成功', allEvents.length >= 3);
  check('按类型过滤', store.getEvents('error').length === 1);

  store.logEvent('heartbeat');
  const hbEvents = store.getEvents('heartbeat');
  check('无附加数据时 data 为 null', hbEvents[0]!.data === null);

  console.log('\n  事件日志预览:');
  for (const evt of store.getEvents(undefined, 5)) {
    console.log(`     [${evt.type}] ${evt.data ?? '(无数据)'}`);
  }

  // ────────────────────────────────────
  // 5. 安全：敏感信息控制
  // ────────────────────────────────────
  section('\uD83D\uDD12 5. 敏感信息控制');
  const secureStore = new Store({
    dbPath: './tmp/store-verify-secure.db',
    storeMessageContent: false,
  });
  secureStore.saveMessage('ses-sec', {
    sender: 'A',
    content: '这是机密消息不应被存储',
    isFromSelf: false,
  });
  const secureHistory = secureStore.getSessionHistory('ses-sec', 1);
  check('storeMessageContent=false 时内容显示 [已隐藏]', secureHistory[0]!.content === '[已隐藏]');
  secureStore.close();

  // ────────────────────────────────────
  // 6. 性能验收
  // ────────────────────────────────────
  section('\u26A1 6. 性能验收');
  for (let i = 0; i < 500; i++) {
    store.markProcessed(`perf-fp-${String(i)}`);
  }
  for (let i = 0; i < 500; i++) {
    store.saveMessage('perf-ses', {
      sender: `user-${String(i)}`,
      content: `消息 ${String(i)}`,
      isFromSelf: i % 2 === 0,
    });
  }

  const t1 = performance.now();
  store.isProcessed('perf-fp-250');
  const d1 = performance.now() - t1;
  check(`isProcessed 查询: ${d1.toFixed(2)}ms (< 50ms)`, d1 < 50);

  const t2 = performance.now();
  store.getSessionHistory('perf-ses', 20);
  const d2 = performance.now() - t2;
  check(`getSessionHistory 查询: ${d2.toFixed(2)}ms (< 50ms)`, d2 < 50);

  const t3 = performance.now();
  store.getEvents(undefined, 50);
  const d3 = performance.now() - t3;
  check(`getEvents 查询: ${d3.toFixed(2)}ms (< 50ms)`, d3 < 50);

  // ── 结果汇总 ──
  store.close();

  console.log('\n========================================');
  console.log(
    `  结果: ${String(passed)} 通过 / ${String(failed)} 失败 / ${String(passed + failed)} 总计`
  );
  console.log('========================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error('脚本执行失败:', err);
  process.exit(1);
});
