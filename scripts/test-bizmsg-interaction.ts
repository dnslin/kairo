/**
 * KK9 业务通知卡片 (BizMsg, contentType: 17) 渲染与交互实机验证脚本
 *
 * 验证目标：
 * 1. 验证自包含数据驱动的业务通知卡片 (Bizmsg.vue)
 * 2. 验证卡片标题 (title)、描述 (content)、多行键值对摘要 (summary)、任务角标 (task/bizType)
 * 3. 验证卡片整体点击与跳转行为 (data-url / openURL)
 */

interface CdpTarget {
  id: string;
  title: string;
  type: string;
  url: string;
  webSocketDebuggerUrl: string;
}

interface CdpEvalResponse<T> {
  id: number;
  result?: {
    result?: {
      type: string;
      value: T;
    };
  };
  error?: {
    code: number;
    message: string;
  };
}

async function evalInRenderer<T>(expression: string): Promise<T> {
  const resp = await fetch('http://127.0.0.1:9222/json');
  if (!resp.ok) {
    throw new Error(`无法连接 CDP 端口 (9222): HTTP ${resp.status}`);
  }
  const targets = (await resp.json()) as CdpTarget[];
  const renderer = targets.find(t => t.title === 'renderer.html' || t.url.includes('renderer.html'));
  if (!renderer) {
    throw new Error('未找到 KK9 renderer.html 页面目标');
  }

  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const ws = new globalThis.WebSocket(renderer.webSocketDebuggerUrl);
  const id = Math.floor(Math.random() * 1000000);

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true },
      })
    );
  };

  ws.onmessage = event => {
    const msg = JSON.parse(event.data.toString()) as CdpEvalResponse<T>;
    if (msg.id === id) {
      ws.close();
      if (msg.error) {
        reject(new Error(`CDP Eval 错误: ${msg.error.message}`));
      } else {
        resolve(msg.result?.result?.value as T);
      }
    }
  };

  ws.onerror = err => reject(new Error(`WebSocket 错误: ${String(err)}`));
  return promise;
}

async function main() {
  console.log('================================================================');
  console.log('🚀 开始验证 KK9 业务通知卡片 (contentType: 17 - BizMsg) 渲染效果');
  console.log('================================================================\n');

  const shouldClean = process.argv.includes('--clean');
  const testMsgId = 99992222;

  // 第一步：探测当前客户端状态
  console.log('【步骤 1】探测 KK9 当前聊天窗口...');
  const probe = await evalInRenderer<{
    ok: boolean;
    sessionName?: string;
    hasBizMsgComponent: boolean;
    error?: string;
  }>(`(() => {
    const containers = Array.from(document.querySelectorAll('.chat-container'));
    const container = containers.find(c => c.__vue__ && c.__vue__.$options.name === 'chat-content');
    if (!container) return { ok: false, error: '未找到活动聊天窗口 (.chat-container)' };
    const vm = container.__vue__;
    const msgItemCtor = vm.$options.components?.MsgItem;
    const bizComp = msgItemCtor?.options?.components?.Bizmsg;

    return {
      ok: true,
      sessionName: vm.sesInfo?.name || vm.sesInfo?.typeName || '当前会话',
      hasBizMsgComponent: !!bizComp
    };
  })()`);

  if (!probe.ok) {
    console.error('❌ 探测失败:', probe.error);
    process.exit(1);
  }
  console.log(`✅ 当前会话: [${probe.sessionName}]`);
  console.log(`✅ 内核 BizMsg 组件检测: ${probe.hasBizMsgComponent ? '已就绪 (Bizmsg.vue)' : '未找到'}\n`);

  if (shouldClean) {
    console.log('检测到 --clean 参数，执行卡片清理...');
    await evalInRenderer<{ ok: boolean }>(`(() => {
      const containers = Array.from(document.querySelectorAll('.chat-container'));
      const container = containers.find(c => c.__vue__ && c.__vue__.$options.name === 'chat-content');
      if (!container) return { ok: false };
      const vm = container.__vue__;
      const idx = vm.messages.findIndex(m => m.id === ${testMsgId});
      if (idx !== -1) vm.messages.splice(idx, 1);
      return { ok: true };
    })()`);
    console.log('✅ 清理完成\n');
    return;
  }

  // 第二步：组装业务卡片并推送到聊天视图
  console.log('【步骤 2】组装结构化业务卡片并呈现在视图中...');
  const bizData = {
    title: '【系统审批待办】生产数据库迁移任务',
    content: '发起人：KKBot 智能体助手\n风险等级：高危变更 (P1 级)',
    summary: [
      '工单编号：TASK-20260819-01',
      '目标环境：192.168.1.100 (Prod DB Cluster)',
      '变更内容：用户表历史索引重构与分表',
      '当前状态：待管理员人工审核确认',
      '有效时限：15 分钟内有效'
    ],
    bizUrl: 'https://kk.union-optech.com:8443/',
    bizType: 1 // 1: 渲染 task 待办样式角标
  };

  const pushRes = await evalInRenderer<{ ok: boolean; error?: string }>(`(() => {
    try {
      const containers = Array.from(document.querySelectorAll('.chat-container'));
      const container = containers.find(c => c.__vue__ && c.__vue__.$options.name === 'chat-content');
      if (!container) return { ok: false, error: 'chat-content not found' };
      const vm = container.__vue__;

      const mockMsg = {
        id: ${testMsgId},
        contentType: 17, // EContentType.BizMsg
        content: ${JSON.stringify(bizData)},
        sender: vm.userInfo.id,
        senderName: vm.userInfo.name,
        receiver: vm.sesInfo.sesTypeID,
        sessionType: vm.sesInfo.type,
        sessionID: vm.sesInfo.id,
        sendTime: Math.floor(Date.now() / 1000),
        msgFlag: 'A000',
        status: 1
      };

      const existIdx = vm.messages.findIndex(m => m.id === ${testMsgId});
      if (existIdx !== -1) vm.messages.splice(existIdx, 1);
      vm.messages.push(mockMsg);
      vm.scrollToBottom();

      return { ok: true };
    } catch(e) {
      return { ok: false, error: e.message };
    }
  })()`);

  if (!pushRes.ok) {
    console.error('❌ 推送失败:', pushRes.error);
    process.exit(1);
  }

  // 等待 Vue DOM 更新
  await new Promise(r => setTimeout(r, 150));

  // 第三步：读取 DOM 渲染结果
  console.log('【步骤 3】读取卡片在真实界面的渲染树与结构...');
  const domInspect = await evalInRenderer<{
    found: boolean;
    title?: string;
    content?: string;
    summaryItems: string[];
    dataUrl?: string;
    isTask?: boolean;
  }>(`(() => {
    const bizEl = document.querySelector('.rcd-bizmsg');
    if (!bizEl) return { found: false, summaryItems: [] };

    return {
      found: true,
      title: bizEl.querySelector('.bizmsg-title-name')?.textContent?.trim(),
      content: bizEl.querySelector('.bizmsg-content')?.textContent?.trim(),
      summaryItems: Array.from(bizEl.querySelectorAll('.bizmsg-summary-list')).map(e => e.textContent.trim()),
      dataUrl: bizEl.getAttribute('data-url'),
      isTask: bizEl.classList.contains('task')
    };
  })()`);

  if (!domInspect.found) {
    console.error('❌ 页面未找到 .rcd-bizmsg 节点');
    process.exit(1);
  }

  console.log(`✅ 成功渲染卡片主标题: "${domInspect.title}"`);
  console.log(`✅ 成功渲染正文描述: "${domInspect.content?.replace(/\n/g, ' ')}"`);
  console.log(`✅ 待办任务角标: ${domInspect.isTask ? '已激活 (.task)' : '无'}`);
  console.log(`✅ 跳转目标 URL: ${domInspect.dataUrl}`);
  console.log('   多行摘要列表:');
  for (const item of domInspect.summaryItems) {
    console.log(`   - ${item}`);
  }
  console.log();

  console.log('================================================================');
  console.log('💡 您现在可以直接在 KK9 客户端当前聊天窗口中查看该业务卡片！');
  console.log('   - 鼠标悬浮可见卡片整体阴影与点击手型 (cursor: pointer)');
  console.log('   - 点击卡片整体将自动调用 KK 内置浏览器/外部链接打开对应审批页');
  console.log('   - 清理卡片指令: pnpm tsx scripts/test-bizmsg-interaction.ts --clean');
  console.log('================================================================');
}

main().catch(err => {
  console.error('运行异常:', err);
  process.exit(1);
});
