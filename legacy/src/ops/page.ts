/**
 * 返回 Web 控制台的 HTML 页面内容
 *
 * 重写为 React + TailwindCSS SPA。
 * 使用 CDN 加载 React 和 Tailwind，无构建步骤。
 */
export function getHtmlPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KKBot 控制台</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script>
    tailwind.config = {
      theme: {
        extend: {
          colors: {
            primary: '#3b82f6',
          }
        }
      }
    }
  </script>
  <script type="importmap">
    {
      "imports": {
        "react": "https://esm.sh/react@18.2.0",
        "react-dom/client": "https://esm.sh/react-dom@18.2.0/client"
      }
    }
  </script>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    /* 自定义滚动条 */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
    ::-webkit-scrollbar-thumb { background: #cbd5e1; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
  </style>
</head>
<body class="bg-gray-100 h-screen overflow-hidden text-sm text-gray-700">
  <div id="root" class="h-full"></div>

  <script type="module">
    import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
    import { createRoot } from 'react-dom/client';

    const h = React.createElement;

    // --- 工具函数 ---

    const api = {
      async get(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      },
      async post(url, body) {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {})
        });
        return res.json();
      },
      async del(url) {
        const res = await fetch(url, { method: 'DELETE' });
        return res.json();
      }
    };

    function formatTime(ts) {
      if (!ts) return '-';
      return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
    }

    function formatUptime(ms) {
      if (!ms) return '-';
      const sec = Math.floor(ms / 1000);
      const min = Math.floor(sec / 60);
      const hr = Math.floor(min / 60);
      if (hr > 0) return hr + 'h ' + (min % 60) + 'm';
      if (min > 0) return min + 'm ' + (sec % 60) + 's';
      return sec + 's';
    }

    // --- 组件 ---

    // 1. 状态栏
    function StatusBar({ status, onRefresh }) {
      if (!status) return h('div', { className: 'h-14 bg-white border-b flex items-center px-4' }, '加载中...');

      const cdpColor = {
        connected: 'bg-green-500',
        disconnected: 'bg-red-500',
        connecting: 'bg-yellow-500',
        reconnecting: 'bg-yellow-500'
      }[status.cdp] || 'bg-gray-400';

      const cdpText = {
        connected: '已连接',
        disconnected: '已断开',
        connecting: '连接中',
        reconnecting: '重连中'
      }[status.cdp] || status.cdp;

      const modeText = {
        draft_only: '草稿模式',
        auto_send: '自动发送'
      }[status.mode] || status.mode;

      const handlePause = async () => {
        if (confirm('确定要暂停自动回复吗？')) {
          await api.post('/api/control/pause');
          onRefresh();
        }
      };

      const handleResume = async () => {
        await api.post('/api/control/resume');
        onRefresh();
      };

      return h('div', { className: 'h-14 bg-white border-b border-gray-200 flex items-center px-4 justify-between shrink-0 shadow-sm z-10' },
        h('div', { className: 'flex items-center gap-4' },
          h('h1', { className: 'text-lg font-bold text-gray-800' }, 'KKBot 控制台'),
          h('div', { className: 'flex items-center gap-2 bg-gray-50 px-3 py-1 rounded-full border' },
            h('span', { className: 'w-2 h-2 rounded-full ' + cdpColor }),
            h('span', { className: 'text-xs font-medium' }, cdpText)
          ),
          h('div', { className: 'flex items-center gap-4 text-xs text-gray-500' },
            h('span', null, '模式: ' + modeText),
            h('span', null, '工作时间: ' + (status.withinWorkingHours ? '是' : '否'))
          )
        ),
        h('div', { className: 'flex items-center gap-4' },
          h('div', { className: 'text-xs text-gray-500 font-mono' }, '运行: ' + formatUptime(status.uptime)),
          status.paused
            ? h('button', {
                className: 'bg-green-500 hover:bg-green-600 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors',
                onClick: handleResume
              }, '恢复运行')
            : h('button', {
                className: 'bg-yellow-500 hover:bg-yellow-600 text-white px-3 py-1.5 rounded text-xs font-medium transition-colors',
                onClick: handlePause
              }, '暂停系统')
        )
      );
    }

    // 2. 会话列表
    function SessionList({ sessions, selectedId, onSelect }) {
      // 计算总数
      const totalCount = useMemo(() => {
        return sessions.reduce((sum, s) => sum + s.count, 0);
      }, [sessions]);

      const renderItem = (id, name, count, isAll = false) => {
        const isSelected = selectedId === id;
        return h('div', {
            key: isAll ? 'all' : id,
            className: 'flex items-center justify-between px-4 py-3 cursor-pointer border-l-4 transition-colors ' +
              (isSelected ? 'bg-blue-50 border-blue-500 text-blue-700' : 'border-transparent hover:bg-gray-50 text-gray-700'),
            onClick: () => onSelect(id)
          },
          h('div', { className: 'font-medium truncate pr-2' }, name),
          count > 0 && h('span', {
            className: 'px-2 py-0.5 rounded-full text-xs font-bold ' +
              (isSelected ? 'bg-blue-200 text-blue-800' : 'bg-gray-200 text-gray-600')
          }, count)
        );
      };

      // 过滤掉计数为0的会话 (除非是当前选中的)
      // 根据验收标准 9: "无待处理草稿的会话从列表移除"
      // 但如果当前选中了它（比如刚处理完），最好还是保留一下直到切走，或者直接移除也行。
      // 这里实现为：移除 count <= 0 的会话
      const activeSessions = sessions.filter(s => s.count > 0);

      return h('div', { className: 'w-64 bg-white border-r border-gray-200 flex flex-col h-full shrink-0' },
        h('div', { className: 'p-4 border-b border-gray-100' },
          h('h2', { className: 'font-bold text-gray-800' }, '会话列表')
        ),
        h('div', { className: 'flex-1 overflow-y-auto py-2' },
          renderItem(null, '全部会话', totalCount, true),
          activeSessions.map(s => renderItem(s.sessionId, s.sessionName, s.count))
        )
      );
    }

    // 3. 草稿卡片
    function DraftCard({ draft, onAction }) {
      const [isEditing, setIsEditing] = useState(false);
      const [content, setContent] = useState(draft.draftContent);
      const [loading, setLoading] = useState(false);

      const handleSend = async () => {
        if (!confirm('确认发送吗？')) return;
        setLoading(true);
        try {
          if (isEditing) {
             const res = await api.post('/api/drafts/' + draft.id + '/edit', { content });
             if (res.success) onAction();
             else alert('发送失败: ' + res.error);
          } else {
             const res = await api.post('/api/drafts/' + draft.id + '/send');
             if (res.success) onAction();
             else alert('发送失败: ' + res.error);
          }
        } catch (e) {
          alert('发送出错: ' + e.message);
        } finally {
          setLoading(false);
        }
      };

      const handleDiscard = async () => {
        if (!confirm('确认丢弃此草稿吗？')) return;
        setLoading(true);
        try {
          const res = await api.del('/api/drafts/' + draft.id);
          if (res.success) onAction();
          else alert('丢弃失败: ' + res.error);
        } catch (e) {
          alert('丢弃出错: ' + e.message);
        } finally {
          setLoading(false);
        }
      };

      return h('div', { className: 'bg-white border border-gray-200 rounded-lg p-4 mb-4 shadow-sm hover:shadow transition-shadow' },
        // 头部
        h('div', { className: 'flex justify-between items-center mb-3' },
          h('div', { className: 'font-bold text-gray-800' }, draft.sessionName),
          h('div', { className: 'text-xs text-gray-400' }, formatTime(draft.createdAt))
        ),

        // 原文
        h('div', { className: 'bg-gray-50 p-3 rounded text-xs mb-3 text-gray-600 border border-gray-100 whitespace-pre-wrap' },
          h('div', { className: 'font-semibold mb-1' }, draft.originalSender + ':'),
          h('div', { className: 'break-words' }, draft.originalMessage)
        ),

        // 草稿内容 (展示或编辑)
        isEditing
          ? h('textarea', {
              className: 'w-full p-3 rounded border border-blue-300 focus:ring-2 focus:ring-blue-100 focus:border-blue-400 outline-none text-sm mb-3 min-h-[80px]',
              value: content,
              onChange: e => setContent(e.target.value),
              autoFocus: true
            })
          : h('div', { className: 'bg-blue-50 p-3 rounded text-sm mb-3 border-l-4 border-blue-400 text-gray-800 break-words whitespace-pre-wrap' },
              draft.draftContent
            ),

        // 操作栏
        h('div', { className: 'flex items-center gap-2 mt-2' },
          h('button', {
            className: 'bg-blue-500 hover:bg-blue-600 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50',
            onClick: handleSend,
            disabled: loading
          }, loading ? '处理中...' : (isEditing ? '保存并发送' : '发送')),

          h('button', {
            className: 'bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50',
            onClick: () => setIsEditing(!isEditing),
            disabled: loading
          }, isEditing ? '取消编辑' : '编辑'),

          h('div', { className: 'flex-1' }), // Spacer

          h('button', {
            className: 'bg-red-500 hover:bg-red-600 text-white px-4 py-1.5 rounded text-xs font-medium transition-colors disabled:opacity-50',
            onClick: handleDiscard,
            disabled: loading
          }, '丢弃')
        )
      );
    }

    // 4. 草稿列表
    function DraftList({ drafts, onRefresh, loading }) {
      if (loading && drafts.length === 0) {
        return h('div', { className: 'flex-1 p-8 text-center text-gray-400' }, '加载中...');
      }

      if (drafts.length === 0) {
        return h('div', { className: 'flex-1 p-8 text-center text-gray-400 flex flex-col items-center justify-center' },
          h('div', { className: 'text-4xl mb-2' }, '☕'),
          h('div', null, '暂无待处理草稿')
        );
      }

      return h('div', { className: 'flex-1 overflow-y-auto p-4' },
        drafts.map(d => h(DraftCard, { key: d.id, draft: d, onAction: onRefresh }))
      );
    }

    // 5. 日志列表
    function LogList({ logs }) {
      return h('div', { className: 'h-72 bg-white border-t border-gray-200 flex flex-col shrink-0' },
        h('div', { className: 'px-4 py-2 border-b border-gray-100 bg-gray-50 font-bold text-gray-700 text-xs' }, '操作日志'),
        h('div', { className: 'flex-1 overflow-y-auto p-0' },
          logs.length === 0
            ? h('div', { className: 'p-4 text-center text-gray-400 text-xs' }, '暂无日志')
            : h('ul', { className: 'divide-y divide-gray-100' },
                logs.map(log =>
                  h('li', { key: log.id, className: 'px-4 py-2 flex gap-3 text-xs hover:bg-gray-50' },
                    h('span', { className: 'text-gray-400 font-mono shrink-0' }, formatTime(log.createdAt)),
                    h('span', { className: 'font-semibold text-gray-700 w-24 shrink-0 truncate', title: log.type }, log.type),
                    h('span', { className: 'text-gray-600 truncate flex-1', title: JSON.stringify(log.data) },
                      log.data ? (typeof log.data === 'string' ? log.data : JSON.stringify(log.data)) : ''
                    )
                  )
                )
              )
        )
      );
    }

    // --- 主应用 ---

    function App() {
      const [status, setStatus] = useState(null);
      const [sessions, setSessions] = useState([]);
      const [drafts, setDrafts] = useState([]);
      const [logs, setLogs] = useState([]);
      const [selectedSessionId, setSelectedSessionId] = useState(null);
      const [loadingDrafts, setLoadingDrafts] = useState(false);
      const [tick, setTick] = useState(0);

      const refresh = useCallback(() => setTick(t => t + 1), []);

      // 1. 轮询状态
      useEffect(() => {
        const fetchStatus = () => api.get('/api/status').then(setStatus).catch(console.error);
        fetchStatus();
        const id = setInterval(fetchStatus, 3000);
        return () => clearInterval(id);
      }, [tick]);

      // 2. 轮询会话列表
      useEffect(() => {
        const fetchSessions = () => api.get('/api/sessions').then(setSessions).catch(console.error);
        fetchSessions();
        const id = setInterval(fetchSessions, 3000);
        return () => clearInterval(id);
      }, [tick]);

      // 3. 轮询草稿
      useEffect(() => {
        // 如果当前选中的会话已经不在列表中（被处理完了），则重置为 null (全部)
        // 但为了用户体验，只有在用户显式操作后才切换可能更好。
        // 这里暂时不自动重置，除非 fetch 返回空
        const url = selectedSessionId ? '/api/drafts?sessionId=' + selectedSessionId : '/api/drafts';
        const fetchDrafts = async () => {
          try {
            const data = await api.get(url);
            setDrafts(data);
          } catch (e) {
            console.error(e);
          } finally {
            setLoadingDrafts(false);
          }
        };

        setLoadingDrafts(true); // 切换会话时显示 loading
        fetchDrafts();
        const id = setInterval(() => api.get(url).then(setDrafts).catch(console.error), 3000);
        return () => clearInterval(id);
      }, [selectedSessionId, tick]);

      // 4. 轮询日志
      useEffect(() => {
        const url = selectedSessionId ? '/api/logs?sessionId=' + selectedSessionId : '/api/logs';
        const fetchLogs = () => api.get(url).then(setLogs).catch(console.error);
        fetchLogs();
        const id = setInterval(fetchLogs, 5000);
        return () => clearInterval(id);
      }, [selectedSessionId, tick]);

      return h('div', { className: 'flex flex-col h-full' },
        h(StatusBar, { status, onRefresh: refresh }),
        h('div', { className: 'flex flex-1 overflow-hidden' },
          h(SessionList, { sessions, selectedId: selectedSessionId, onSelect: setSelectedSessionId }),
          h('div', { className: 'flex-1 flex flex-col min-w-0 bg-gray-50' },
            h(DraftList, { drafts, onRefresh: refresh, loading: loadingDrafts }),
            h(LogList, { logs })
          )
        )
      );
    }

    const root = createRoot(document.getElementById('root'));
    root.render(h(App));
  </script>
</body>
</html>`;
}
