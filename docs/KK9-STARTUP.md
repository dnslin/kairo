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

仓库根目录的 `start-kk9-cdp.bat` 使用相同的 `--remote-debugging-address=127.0.0.1` 与 `--remote-debugging-port=9222` 参数。

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

### 阶段一真实合同验证（T09）

`e2e:stage1` 只使用真实 `KK9Driver`，不能用 `FakeDriver` 代替。脚本会先精确核对登录 Bot、目标员工和私聊会话，再执行真实消息副作用；任一授权值缺失或不匹配都会在发送前失败。

在同一个已启动 KK9 的 PowerShell 窗口设置实际值：

```powershell
$env:KK9_STAGE1_BOT_UID = "<登录 Bot UID>"
$env:KK9_STAGE1_EMPLOYEE_UID = "<目标员工 UID>"
$env:KK9_STAGE1_SESSION_ID = "0-<目标员工 UID>"
$env:KK9_STAGE1_SESSION_NAME = "<目标员工会话名>"
$env:KK9_STAGE1_CONFIRM = "<登录 Bot UID>:<目标员工 UID>:0-<目标员工 UID>"
pnpm --filter @kairo/driver e2e:stage1
```

`KK9_STAGE1_CONFIRM` 必须完全等于 `Bot UID:员工 UID:sessionId`。运行后按终端提示让目标员工发送一条真实消息。脚本会验证员工消息为 `inbound`、Bot 回显为 `outbound`、证据不足消息为 `unknown`、同一 `(sessionId,messageId)` 可识别 EventBridge 与轮询重复，并覆盖 `delivered`、确定的 `pre-trigger failed`、发送后 `unknown`、状态查询和 operationId 防重。发送后 `unknown` 会在重连后查询最终状态并再次核对员工 UID 与 sessionId。

若真实历史没有可用的非 `system` unknown，脚本会使用刚收到的真实消息 payload 去除 self/source/sender 身份字段做受控探针；该探针只验证证据不足时保持 `unknown`，不替代员工入站与 Bot 回显的真机方向验收。

脚本会尽量撤回测试产生的 Bot 消息；清理失败时，`阶段一合同测试汇总` 会列出未撤回的原生消息 ID。

### 企业完整回答闭环（T29）

使用上节相同的 `KK9_STAGE1_BOT_UID`、`KK9_STAGE1_EMPLOYEE_UID`、`KK9_STAGE1_SESSION_ID`、`KK9_STAGE1_SESSION_NAME`、`KK9_STAGE1_CONFIRM`。环境文件还需提供 `KAIRO_TEST_DATABASE_URL`、既有批准模型凭证 `KAIRO_T12_MODEL_API_KEY` 和 `RAGFLOW_API_KEY`；模型、Dataset、员工 allowlist 仍只来自正式 YAML，不为验收临时改名单或换模型。

从仓库根目录执行，环境文件路径替换为实际本地路径：

```powershell
node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=<本地环境文件> apps/kairo/scripts/verify-enterprise-answer.ts --preflight
node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=<本地环境文件> apps/kairo/scripts/verify-enterprise-answer.ts
```

第一条只读实际登录 UID 和已有桥接占用；第二条启动同一 `startKairo()` 业务入口及本次随机 PostgreSQL 库。只有看见“等待员工真实IM提问”后，才让授权员工从真实客户端提问。脚本不会直接通过 HTTP 伪造员工输入，也不会代替员工发送问题。

验收过程中会真实发送答案和必要固定提示，只允许指定私聊；不会自动撤回。Driver 在安装 Hook 时拒绝接管其他代次，实际连接及每次发送前还核对批准 Bot 身份。发现已有连接、账号不符或未授权目标必须停止，不重启他人服务或修改用户会话。

脚本在 PostgreSQL 核对成功检索、当前采用证据与正式回答，并从真实会话历史核对原生消息 ID、正文一致及 outbound 方向。终端只打印关联 ID 和检查结果，不打印答案或知识片段。员工还需确认答案内容正确且没有来源/内部 ID；输入“完成”才结束人工验收，输入“失败”或未确认即关闭终端不能算通过。完成后关闭自有应用与连接，并只删除本次创建的隔离库。

需要逐题探索而不是单题验收时，在同一脚本命令后加 `--continuous`。看到“持续测试已就绪”后即可继续提问，输入“停止”结束；此模式不自动确认内容正确，也不执行单题模式的全局 Tool 调用断言。每道企业答案仍经过正式入口的证据检查和发送状态管理。脚本会打印健康地址；检查 `/health/dependencies` 的 driver/model/ragflow 状态，而不是仅凭进程还活着判断正在监听。

两种模式均通过 `enterprise-answer-driver.ts` 将入站消息、@事件和撤回限制为授权会话，发送前的 Bot/收件人检查仍保留。正式 YAML 与员工 allowlist 不变，其他会话不进入此验收进程，避免为其他员工发送准入提示；真正的连接异常仍传播，不被范围限制吞掉。

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
