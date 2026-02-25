/**
 * 返回 Web 控制台的 HTML 页面内容
 *
 * 纯 HTML + vanilla JS，无外部依赖。
 * 自动轮询刷新状态、草稿列表和操作日志。
 */
export function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KKBot 控制台</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #f5f5f5;
      color: #333;
      padding: 20px;
      max-width: 960px;
      margin: 0 auto;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 20px;
      color: #1a1a1a;
    }
    .panel {
      background: #fff;
      border-radius: 8px;
      padding: 16px;
      margin-bottom: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.1);
    }
    .panel h2 {
      font-size: 16px;
      margin-bottom: 12px;
      color: #666;
      border-bottom: 1px solid #eee;
      padding-bottom: 8px;
    }
    .status-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 12px;
    }
    .status-item {
      text-align: center;
      padding: 12px;
      background: #f9f9f9;
      border-radius: 6px;
    }
    .status-item .label {
      font-size: 12px;
      color: #999;
      margin-bottom: 4px;
    }
    .status-item .value {
      font-size: 18px;
      font-weight: 600;
    }
    .status-connected { color: #52c41a; }
    .status-disconnected { color: #ff4d4f; }
    .status-reconnecting { color: #faad14; }
    .control-bar {
      display: flex;
      gap: 8px;
      margin-top: 12px;
    }
    button {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
      transition: opacity 0.2s;
    }
    button:hover { opacity: 0.8; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .btn-primary { background: #1890ff; color: #fff; }
    .btn-success { background: #52c41a; color: #fff; }
    .btn-danger { background: #ff4d4f; color: #fff; }
    .btn-warning { background: #faad14; color: #fff; }
    .btn-small { padding: 4px 10px; font-size: 12px; }
    .draft-list { list-style: none; }
    .draft-item {
      border: 1px solid #e8e8e8;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 10px;
    }
    .draft-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 8px;
    }
    .draft-session {
      font-weight: 600;
      font-size: 14px;
    }
    .draft-time {
      font-size: 12px;
      color: #999;
    }
    .draft-original {
      background: #f6f6f6;
      padding: 8px;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 13px;
    }
    .draft-original .sender {
      font-weight: 600;
      color: #666;
      margin-bottom: 4px;
    }
    .draft-content {
      background: #e6f7ff;
      padding: 8px;
      border-radius: 4px;
      margin-bottom: 8px;
      font-size: 13px;
      border-left: 3px solid #1890ff;
    }
    .draft-actions {
      display: flex;
      gap: 6px;
    }
    .edit-area {
      width: 100%;
      min-height: 60px;
      padding: 8px;
      border: 1px solid #d9d9d9;
      border-radius: 4px;
      font-size: 13px;
      resize: vertical;
      margin-bottom: 8px;
      display: none;
    }
    .log-list {
      list-style: none;
      max-height: 300px;
      overflow-y: auto;
    }
    .log-item {
      padding: 6px 0;
      border-bottom: 1px solid #f0f0f0;
      font-size: 13px;
      display: flex;
      gap: 8px;
    }
    .log-time {
      color: #999;
      flex-shrink: 0;
      font-family: monospace;
    }
    .log-type {
      font-weight: 600;
      flex-shrink: 0;
      min-width: 120px;
    }
    .log-data {
      color: #666;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .empty-state {
      text-align: center;
      color: #999;
      padding: 20px;
      font-size: 14px;
    }
    .loading { color: #999; font-style: italic; }
  </style>
</head>
<body>
  <h1>KKBot 控制台</h1>

  <div class="panel">
    <h2>系统状态</h2>
    <div class="status-grid" id="statusGrid">
      <div class="status-item">
        <div class="label">CDP 连接</div>
        <div class="value" id="cdpStatus">-</div>
      </div>
      <div class="status-item">
        <div class="label">运行模式</div>
        <div class="value" id="modeStatus">-</div>
      </div>
      <div class="status-item">
        <div class="label">工作时间</div>
        <div class="value" id="workingHoursStatus">-</div>
      </div>
      <div class="status-item">
        <div class="label">运行时长</div>
        <div class="value" id="uptimeStatus">-</div>
      </div>
    </div>
    <div class="control-bar">
      <button class="btn-warning" id="btnPause" onclick="controlPause()">暂停</button>
      <button class="btn-success" id="btnResume" onclick="controlResume()">恢复</button>
    </div>
  </div>

  <div class="panel">
    <h2>待确认草稿 (<span id="draftCount">0</span>)</h2>
    <ul class="draft-list" id="draftList">
      <li class="empty-state">暂无待确认草稿</li>
    </ul>
  </div>

  <div class="panel">
    <h2>操作日志</h2>
    <ul class="log-list" id="logList">
      <li class="empty-state">暂无日志</li>
    </ul>
  </div>

  <script>
    const POLL_INTERVAL = 3000;

    function formatTime(ts) {
      const d = new Date(ts);
      return d.toLocaleTimeString('zh-CN', { hour12: false });
    }

    function formatUptime(ms) {
      const sec = Math.floor(ms / 1000);
      const min = Math.floor(sec / 60);
      const hr = Math.floor(min / 60);
      if (hr > 0) return hr + 'h ' + (min % 60) + 'm';
      if (min > 0) return min + 'm ' + (sec % 60) + 's';
      return sec + 's';
    }

    function escapeHtml(text) {
      const div = document.createElement('div');
      div.textContent = text;
      return div.innerHTML;
    }

    async function api(method, path, body) {
      const opts = { method, headers: {} };
      if (body) {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
      const resp = await fetch(path, opts);
      return resp.json();
    }

    async function refreshStatus() {
      try {
        const s = await api('GET', '/api/status');
        const cdpEl = document.getElementById('cdpStatus');
        const cdpMap = { connected: '已连接', disconnected: '断开', connecting: '连接中', reconnecting: '重连中' };
        cdpEl.textContent = cdpMap[s.cdp] || s.cdp;
        cdpEl.className = 'value status-' + s.cdp;

        const modeMap = { draft_only: '草稿模式', auto_send: '自动发送' };
        document.getElementById('modeStatus').textContent = modeMap[s.mode] || s.mode;
        document.getElementById('workingHoursStatus').textContent = s.withinWorkingHours ? '是' : '否';
        document.getElementById('uptimeStatus').textContent = formatUptime(s.uptime);

        document.getElementById('btnPause').disabled = s.paused;
        document.getElementById('btnResume').disabled = !s.paused;
      } catch (e) {
        document.getElementById('cdpStatus').textContent = '获取失败';
      }
    }

    async function refreshDrafts() {
      try {
        const drafts = await api('GET', '/api/drafts');
        const list = document.getElementById('draftList');
        document.getElementById('draftCount').textContent = drafts.length;

        if (drafts.length === 0) {
          list.innerHTML = '<li class="empty-state">暂无待确认草稿</li>';
          return;
        }

        list.innerHTML = drafts.map(function(d) {
          return '<li class="draft-item" id="draft-' + d.id + '">'
            + '<div class="draft-header">'
            + '<span class="draft-session">' + escapeHtml(d.sessionName) + '</span>'
            + '<span class="draft-time">' + formatTime(d.createdAt) + '</span>'
            + '</div>'
            + '<div class="draft-original">'
            + '<div class="sender">' + escapeHtml(d.originalSender) + ':</div>'
            + '<div>' + escapeHtml(d.originalMessage) + '</div>'
            + '</div>'
            + '<div class="draft-content">' + escapeHtml(d.draftContent) + '</div>'
            + '<textarea class="edit-area" id="edit-' + d.id + '">' + escapeHtml(d.draftContent) + '</textarea>'
            + '<div class="draft-actions">'
            + '<button class="btn-primary btn-small" onclick="sendDraft(' + d.id + ')">发送</button>'
            + '<button class="btn-warning btn-small" onclick="toggleEdit(' + d.id + ')">编辑</button>'
            + '<button class="btn-danger btn-small" onclick="discardDraft(' + d.id + ')">丢弃</button>'
            + '</div>'
            + '</li>';
        }).join('');
      } catch (e) {
        console.error('刷新草稿失败', e);
      }
    }

    async function refreshLogs() {
      try {
        const logs = await api('GET', '/api/logs?limit=50');
        const list = document.getElementById('logList');

        if (logs.length === 0) {
          list.innerHTML = '<li class="empty-state">暂无日志</li>';
          return;
        }

        list.innerHTML = logs.map(function(l) {
          let dataStr = '';
          if (l.data) {
            try { dataStr = l.data; } catch(e) { dataStr = ''; }
          }
          return '<li class="log-item">'
            + '<span class="log-time">' + formatTime(l.createdAt) + '</span>'
            + '<span class="log-type">' + escapeHtml(l.type) + '</span>'
            + '<span class="log-data">' + escapeHtml(dataStr) + '</span>'
            + '</li>';
        }).join('');
      } catch (e) {
        console.error('刷新日志失败', e);
      }
    }

    function toggleEdit(id) {
      const textarea = document.getElementById('edit-' + id);
      const isVisible = textarea.style.display === 'block';
      textarea.style.display = isVisible ? 'none' : 'block';
      if (!isVisible) textarea.focus();
    }

    async function sendDraft(id) {
      const textarea = document.getElementById('edit-' + id);
      const isEditing = textarea.style.display === 'block';

      if (isEditing && textarea.value.trim()) {
        const result = await api('POST', '/api/drafts/' + id + '/edit', { content: textarea.value.trim() });
        if (result.success) {
          await refreshDrafts();
          await refreshLogs();
        } else {
          alert('发送失败: ' + (result.error || '未知错误'));
        }
      } else {
        const result = await api('POST', '/api/drafts/' + id + '/send');
        if (result.success) {
          await refreshDrafts();
          await refreshLogs();
        } else {
          alert('发送失败: ' + (result.error || '未知错误'));
        }
      }
    }

    async function discardDraft(id) {
      const result = await api('DELETE', '/api/drafts/' + id);
      if (result.success) {
        await refreshDrafts();
        await refreshLogs();
      } else {
        alert('丢弃失败: ' + (result.error || '未知错误'));
      }
    }

    async function controlPause() {
      await api('POST', '/api/control/pause');
      await refreshStatus();
      await refreshLogs();
    }

    async function controlResume() {
      await api('POST', '/api/control/resume');
      await refreshStatus();
      await refreshLogs();
    }

    // 初始化加载
    refreshStatus();
    refreshDrafts();
    refreshLogs();

    // 定时轮询
    setInterval(refreshStatus, POLL_INTERVAL);
    setInterval(refreshDrafts, POLL_INTERVAL);
    setInterval(refreshLogs, POLL_INTERVAL * 3);
  </script>
</body>
</html>`;
}
