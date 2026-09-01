# KK9 客户端 CDP 启动与排障

本文只说明如何在 Windows 上以本机 CDP 端口启动 KK9、验证渲染页可达，并运行仓库中的真机检查。开发命令和代码规范见 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。

## 1. 前置条件

- 已安装并能正常登录 KK9。
- 已关闭现有 KK9 进程，避免旧实例复用后忽略新的启动参数。
- 本机 `9222` 端口未被其他程序占用。
- CDP 只允许绑定回环地址，不得暴露到局域网或公网。

## 2. 启动 KK9

在 PowerShell 中执行：

```powershell
& "C:\Path\To\KK9.exe" `
  --remote-debugging-address=127.0.0.1 `
  --remote-debugging-port=9222
```

也可以创建专用快捷方式，在“目标”末尾追加：

```text
--remote-debugging-address=127.0.0.1 --remote-debugging-port=9222
```

不要修改日常使用的快捷方式；调试端口只应在需要运行 Kairo 或真机验证时开启。

## 3. 验证 CDP 端点

等待 KK9 主界面加载完成，然后访问：

```text
http://127.0.0.1:9222/json
```

成功条件：

- 响应是 JSON 数组；
- 至少存在一个 `type` 为 `page` 的目标；
- 目标 `url` 或 `title` 能识别 KK9 渲染页；
- 目标包含 `webSocketDebuggerUrl`。

返回值示意：

```json
[
  {
    "type": "page",
    "title": "KK9",
    "url": "file:///.../renderer.html",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/..."
  }
]
```

如果实际渲染页不包含 `renderer.html`，后续脚本需要通过 `PAGE_MATCH` 指定稳定的标题或 URL 片段。

## 4. 配置当前终端

仓库脚本默认使用 `http://127.0.0.1:9222` 和 `renderer.html`。需要覆盖时，在同一 PowerShell 窗口设置：

```powershell
$env:CDP_URL = "http://127.0.0.1:9222"
$env:PAGE_MATCH = "renderer.html"
```

环境变量只影响当前终端。不要把账号、Cookie 或其他客户端凭据写入仓库。

## 5. 运行真机检查

### EventBridge 交互验证

```bash
pnpm verify:bridge
```

该脚本会连接真实 KK9，并提供以下交互命令：

- `status`：查看桥接状态；
- `sessions`：读取会话列表；
- `send <sessionId> <text>`：向指定会话发送真实消息；
- `exit`：断开并退出。

### 完整真实回归

PowerShell：

```powershell
$env:KK9_REAL_TEST_CONFIRM = "5761:0-3585:1-29467"
pnpm e2e
```

脚本会同时核对实际登录用户以及私聊/群聊的 ID、名称和类型；任一项不匹配、关键步骤失败或未提供确认变量时，会停止后续副作用并仅执行已知消息清理。它会真实发送文本、富文本、文件、图片和引用回复、切换 UI、标记已读，再按 native ID 撤回，因此不得在未授权会话运行。

## 6. 故障排查

| 现象                         | 检查                                        | 处理                                                |
| ---------------------------- | ------------------------------------------- | --------------------------------------------------- |
| `127.0.0.1:9222` 拒绝连接    | KK9 是否由专用命令启动                      | 完全退出 KK9 后重新启动                             |
| `/json` 返回空数组           | KK9 主渲染页是否加载完成                    | 等待登录和主界面完成，再刷新端点                    |
| 脚本找不到页面               | `PAGE_MATCH` 是否匹配实际目标               | 从 `/json` 复制稳定的标题或 URL 片段                |
| 端口已占用                   | 是否已有 KK9 或其他调试进程                 | 关闭占用者，或统一修改启动端口与 `CDP_URL`          |
| DOM 操作不稳定               | 窗口是否最小化、页面是否切换                | 恢复窗口并重新执行；EventBridge 与 DOM 路径分开诊断 |
| EventBridge 已连接但没有事件 | Hook 是否成功注入、测试消息是否到达目标账号 | 运行 `status`，重新连接后执行跨会话接收测试         |

## 7. 结束调试

先退出验证脚本，再关闭带调试参数启动的 KK9。确认不再需要调试后，不要让 `9222` 端口长期保持开放。
