# KK9 底层链路研究记录

> 文档类型：逆向研究证据
> 适用对象：当前受控 KK9 Electron 客户端版本
> 维护要求：新增结论必须记录客户端版本、观测方式和可复现入口

本文保存 KK9 渲染进程中运行时对象、事件总线和 IPC 的观测结果。它不是产品需求、实施路线或公开 API 保证；相关私有接口可能随客户端升级变化。

## 1. 证据边界

研究结论按以下等级记录：

- **当前仓库可复现**：可通过现有源码、测试或 `scripts/` 中的验证入口重放。
- **历史实机记录**：曾在真实客户端中观测，但原始实验脚本已不在当前仓库。
- **静态逆向线索**：来自渲染 bundle、组件方法或字符串目录，尚未形成完整运行时合同。

当前仓库保留的主要验证入口：

- `packages/driver/src/bridge/event-bridge.ts`
- `packages/driver/src/dom/session-ops.ts`
- `packages/driver/src/dom/message-ops.ts`
- `packages/driver/src/dom/send-ops.ts`
- `scripts/verify-event-bridge-live.ts`

旧文档曾引用 `demo-hook-send.ts`、`demo-lowlevel-send.ts` 和 `demo-batch-send.ts`。这些脚本当前不存在，因此相关发送结论只能视为历史实机记录，不能作为当前提交的可复现证据。

## 2. 已观测的运行时分层

历史逆向记录显示，消息链路可以分为五层：

1. **原生事件桥**：`main-page.created()` 注册底层 `message` 事件。
2. **业务分发**：`main-page.onReceiveMessage()` 规范化会话并发出 `receive-message`。
3. **会话消息层**：`message.onReceiveMessage()` 把消息路由到 `${sesUUID}-msg` 等会话事件。
4. **组件状态层**：`chat-content.onNewMessage()` 更新当前消息数组、未读和滚动状态。
5. **IPC 数据层**：渲染进程通过 `toData(name, ...args)` 访问会话和消息数据。

该分层说明 DOM 不是唯一数据源，但不能推导所有 UI 行为都可直接删除。获取 Vue 实例、输入焦点、未提交富文本和悬浮菜单仍属于 UI 状态。

## 3. 历史实机读取记录

以下签名来自历史实机观测，接入前必须在目标客户端版本重新验证。

### `getConversations`

```ts
toData('getConversations');
```

已记录行为：

- 无参数；
- 成功结果的 `data` 包含 `usersInfo`、`groupsInfo` 和 `sessionsInfo`；
- 会话列表位于 `sessionsInfo`；
- 部分 P2P 会话需要结合当前用户身份规范化显示名称；
- 若需要 `sesUUID`，可能需要与运行时 `sortedSessions` 按会话 ID 合并。

### `getMessages`

```ts
toData('getMessages', {
  sessionID,
  count,
  endIdx,
  sendTime,
});
```

已记录行为：

- 使用单个对象参数，不是位置参数；
- `endIdx` 是包含上界，`count` 是窗口大小；
- 返回消息按 `msgIdx` 升序；
- `sendTime` 在历史样例中未表现为主要分页控制量。

### `getMessageBySessionIDAndMsgIdx`

```ts
toData('getMessageBySessionIDAndMsgIdx', sessionID, msgIdx);
```

已记录行为：

- 使用位置参数；
- `data` 是数组，单条查询通常读取第一项；
- `content`、`atMemberIDList` 等字段的表示可能与 `getMessages` 不同，必须经过统一转换器。

### 未读与已读

```ts
toData('getAtMsgUnread');

toData('readMessage', {
  type,
  sessionID,
  maxMsgIdx,
});
```

历史链路还包含 Store 更新、`reload-atMsg-list`、`flush-unread-total` 和跨窗口同步。调用 `readMessage` 会改变真实客户端状态，不能在只读探测中执行。

## 4. 历史事件链记录

```text
底层 message 事件
→ main-page.onReceiveMessage(...)
→ $bus.$emit('receive-message', payload)
→ message.onReceiveMessage(...)
→ $bus.$emit(`${sesUUID}-msg`, messageArray)
→ chat-content.onNewMessage(messageArray)
```

关键边界：

- `payload.message` 和 `${sesUUID}-msg` 的参数可能是消息数组；
- 主路径与补偿路径必须产生相同的公开消息身份；
- 事件 payload 在客户端升级后必须重新采样，不能依赖组件名长期稳定。

当前仓库的 EventBridge 真机入口为：

```bash
pnpm verify:bridge
```

启动前按 [`KK9-STARTUP.md`](./KK9-STARTUP.md) 开启 CDP。该脚本可以验证消息、@提及、撤回和跨会话接收，但不会自动证明所有 IPC 签名仍兼容。

## 5. 历史发送链记录

历史观测到两类低层入口：

- `MessageEditor.sendMessage()` 通过 `${activedSes.sesUUID}-send` 发布会话事件；
- `chat-content.onSendMessage()` 调用 `buildMessageObj`、`insertSendBefoeMsg` 和 `sendMessageNew`。

旧实验还记录过通过当前 `chat-content` 构造目标会话消息并低层发送，但对应实验脚本已经缺失。除非重新建立可复现夹具并确认发送结果，否则不得仅凭本记录把该路径升级为生产主链。

### 5.1 2026-08-31 当前客户端实机证据

在 `renderer.html` 与 CDP `127.0.0.1:9222` 上重新建立了可重复发送夹具，并确认：

- `insertSendBefoeMsg` 返回的是临时身份，例如 `id: -22`、`msgIdx: "161.001"`，不得作为公开 `messageId`；
- `sendMessageNew` 返回 `{ code: 0 }` 只表示 native sender 已接受请求，不包含最终消息 ID；
- 自定义唯一 `msgFlag` 会原样保存到落库消息，可通过后续 `getMessages` 无歧义解析正整数 ID 与整数 `msgIdx`；
- 文本、富文本和文件均按上述方式完成真实 ID 绑定；文件的 `uri` 由 native 层上传后补齐；
- `contentType: 13` 回复必须先读取被回复消息的原始 `sender/msgIdx/contentType/content`，仅凭公开摘要会生成无效内容；
- 图片仍走 UI/剪贴板路径，必须先真实切换并确认当前会话；只赋值 `editor.activedSes` 会把图片发送到原 UI 会话；
- 本轮指定 `int2024 / 0-3585` 与 `测试123 / 1-29467` 执行 27 个真实步骤并全部通过，随后按真实 ID 完成消息撤回清理。

以上结论绑定本次 KK9 客户端版本；客户端升级后必须重新运行 `pnpm e2e`。

## 6. IPC 名称线索

历史 bundle 扫描记录过 222 个 IPC 名称，但完整清单和提取脚本未保留。以下名称仅用于定向研究：

| 类别       | 名称                                                                                                                                                        |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话       | `getConversations`, `getSessionBySessionID`, `getSessionInfo6`, `getServiceSessions`, `setSession`                                                          |
| 消息       | `getMessages`, `getMessageByMsgId`, `getMessageBySessionIDAndMsgIdx`, `insertSendBefoeMsg`, `updateMessage`, `sendMessage`, `sendMessageNew`, `readMessage` |
| 未读       | `getAtMsgUnread`, `getMsgReportUnReadCount`, `readVirtualService`                                                                                           |
| 用户与群组 | `getUserByUserId`, `getMemberDetail`, `getGroupInfo`, `getGroupsAllMembers`                                                                                 |

静态出现某个方法名不代表签名、权限、返回值或副作用已经确认。

## 7. 工程结论

1. 会话和消息读取应优先使用已验证的运行时或 IPC 数据，避免从 DOM 文本反推业务事实。
2. 增量消息应优先使用 EventBridge；轮询和 DOM 只能作为补偿路径，并共享同一去重身份。
3. 不同 IPC 返回结构必须先规范化，不能直接泄漏到 `KK9Message` 等公开类型。
4. 发送、已读和撤回会改变客户端状态，必须与纯读取探测分开验证。
5. DOM 仍可用于引导定位和无法从运行时获得的 UI 状态；删除兜底前需要真实证据。
6. 所有私有接口结论都绑定客户端版本。客户端升级后，先重跑契约探测，再决定是否继续使用。

## 8. 待验证问题

- 底层 `message` 事件桥对象的真实来源和完整生命周期；
- 语音、视频、位置等尚未覆盖消息类型的完整 payload；
- IPC 方法在未来客户端版本中的参数、错误和返回 Schema 漂移；
- `msgFlag` 真实 ID 绑定在客户端升级、重连和高并发下的持续稳定性；
- 客户端升级、重连和多窗口场景下 Hook 的恢复行为。

## 9. 新增证据的记录格式

每次新增或修改结论时，至少记录：

- KK9 客户端版本和渲染页标识；
- 观测日期；
- 使用的脚本、源码位置或 bundle 校验值；
- 输入参数与已脱敏的返回结构；
- 是否改变客户端状态；
- 成功、失败和重连后的结果；
- 结论等级：当前可复现、历史实机记录或静态逆向线索。
