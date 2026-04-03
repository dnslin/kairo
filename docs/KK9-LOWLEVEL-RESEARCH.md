# KK9 底层链路挖掘总结

## 目的

本文档总结当前对 KK9 Electron 渲染进程的只读挖掘结果，目标是为后续将 KKBot 从 DOM 轮询/DOM 发送逐步迁移到运行时对象、事件总线与 IPC 直连提供技术基线。

结论先行：

- 会话列表读取可以脱离 DOM，直接走内存对象或 IPC。
- 消息分页读取可以脱离 DOM，直接走 IPC。
- 单条消息定位可以脱离 DOM，直接走 IPC。
- 增量消息监听可以脱离 DOM 轮询，直接走原生事件桥和 bus 事件。
- 消息发送已经验证可走更低层链路，不必依赖输入框和发送按钮。
- 已读同步也已有明确的 bus -> IPC -> store 更新链路。

当前 DOM 更像“引导入口”和“兜底路径”，而不是唯一数据源。

## 当前仓库与低层链路的对照

当前仓库主路径仍偏 DOM：

- `src/send/sender.ts:35`：文本发送主入口
- `src/dom/locator.ts:431`：往输入框写文本
- `src/dom/locator.ts:505`：点击发送按钮

已验证的低层实验入口：

- `scripts/demo-hook-send.ts:137`：通过 `MessageEditor.sendPicTextMessage()` 发送
- `scripts/demo-lowlevel-send.ts:148`：通过 `chat-content.onSendMessage()` 发送
- `scripts/demo-batch-send.ts:289`：不切 DOM、按会话 ID 批量低层发送
- `scripts/demo-batch-send.ts:411`：通过会话列表 `lastMessage` 验证批量发送结果

这说明现有实现还在 UI 壳层，而 KK9 自己的业务发送和读取能力已经能被更低层直接调用。

## 核心分层模型

当前已确认的运行时分层如下：

### 1. 原生事件桥层

- `main-page.created()` 中直接注册：`v.a.on("message", this.onReceiveMessage)`
- 这是消息流进入渲染进程业务层的第一跳

### 2. 业务分发层

- `main-page.onReceiveMessage(...)`
- 负责：
  - 规范化 `session`
  - 更新部分 store
  - `$bus.$emit("receive-message", t)`
  - `sendMsgToOtherWin(...)`
  - `sendMsgToMsgWin(...)`

### 3. 会话与消息业务层

- `message.onReceiveMessage(...)`
- 当前会话页 `chat-content.created()` 中注册：
  - `${sesUUID}-msg`
  - `${sesUUID}-send`
  - `${sesUUID}-refreshUnread`
  - `${sesUUID}-updateMsg`
  - `${sesUUID}-sendMsgCallback`

### 4. 组件状态层

- `chat-content.onNewMessage(e)`
- 这里的 `e` 是消息数组，不是单条对象
- 负责：
  - 消息归一化
  - 撤回、@我、Pin、回执处理
  - `this.messages.push(...e)`
  - 未读数与滚动状态更新

### 5. IPC 数据层

- 通过渲染进程桥接方法 `toData("...")`
- 已从 `renderer.js` 中识别出 222 个 IPC 方法名

## 已确认可用的去 DOM 读取接口

### 会话列表：`getConversations`

调用方式：

```ts
toData('getConversations')
```

特征：

- 无参
- 返回 `code: 0`
- `data` 为对象，当前已确认至少包含：
  - `usersInfo`
  - `groupsInfo`
  - `sessionsInfo`
- 真正的会话列表在 `data.sessionsInfo`

关键字段：

- `id`
- `sesUUID`
- `sesTypeID`
- `type`
- `typeName`
- `createrName`
- `typeID`
- `maxMessageIndex`
- `userReadIndex`
- `lastMessage`
- `lastSender`
- `lastMsgTime`
- `userConfig`

P2P 会话名需要做一层规范化，不能直接显示 `typeName`：

```ts
function getDisplayName(session, currentUserId) {
  if (session.type === 0 && session.typeID === currentUserId) {
    return session.createrName || session.typeName;
  }
  return session.typeName || session.createrName;
}
```

原因：

- `sessionsInfo` 更接近底层原始会话记录
- 对于部分 P2P 会话，`typeID/typeName` 可能落在“自己”这一侧
- 此时真正应该显示的联系人名称在 `createrName`

结论：

- 足以替代会话栏 DOM 扫描
- 当前还可直接从 `MessageEditor.sortedSessions` 读取同层级信息

### 消息分页：`getMessages`

正确调用方式：

```ts
toData('getMessages', {
  sessionID,
  count,
  endIdx,
  sendTime,
})
```

错误方式：

```ts
toData('getMessages', sessionID, count)
```

分页语义：

- `endIdx` 是包含上界
- `count` 是窗口大小
- 返回结果按 `msgIdx` 升序
- 当前 P2P 实测中，主控制量是 `endIdx + count`
- `sendTime` 没有表现出明显主过滤作用，更像兼容或辅助字段

实测样例：

- `endIdx=423,count=5` -> 返回 `419..423`
- `endIdx=418,count=5` -> 返回 `414..418`
- `endIdx=403,count=5` -> 返回 `399..403`

返回消息对象关键字段：

- `id`
- `sender`
- `receiver`
- `sendTime`
- `contentType`
- `content`
- `notifyMsg`
- `sessionType`
- `sessionID`
- `msgIdx`
- `msgFlag`
- `atState`
- `reportSummary`
- `status`

结论：

- 足以替代消息区 DOM 提取
- 适合作为后续历史消息和增量消息的统一读取入口

### 单条消息：`getMessageBySessionIDAndMsgIdx`

正确调用方式：

```ts
toData('getMessageBySessionIDAndMsgIdx', sessionID, msgIdx)
```

错误方式：

```ts
toData('getMessageBySessionIDAndMsgIdx', { sessionID, msgIdx })
```

返回特征：

- 返回 `code: 0`
- `data` 是数组
- 通常取 `data[0]`

与 `getMessages` 返回值的差异：

- `getMessageBySessionIDAndMsgIdx` 更像数据库态：`content` 是 JSON 字符串，`atMemberIDList` 也是字符串
- `getMessages` 更像运行时态：`content` 已经是对象，`atMemberIDList` 已经是数组

结论：

- 适合做“跳转到具体消息”“精确补取单条消息”
- 接入时必须做一次归一化，不能直接假设返回结构与 `getMessages` 一致

### 未读与已读

`getAtMsgUnread`：

```ts
toData('getAtMsgUnread')
```

`readMessage` 正确调用方式：

```ts
toData('readMessage', {
  type,
  sessionID,
  maxMsgIdx,
})
```

业务闭环：

1. `message.setMessageReadFunc(e)`
2. `message.setMessageRead(e)`
3. `toData('readMessage', { type: e.type, sessionID: e.id, maxMsgIdx: e.maxMessageIndex })`
4. `this.$store.commit('setMessageRead', e)`
5. `$bus.$emit('reload-atMsg-list')`
6. `$bus.$emit('flush-unread-total')`
7. `sendMsgToOtherWin(...)`

结论：

- 已读同步不需要再从 DOM 红点或样式反推
- 业务链已经完整存在，可直接利用

## 已确认可用的去 DOM 事件链

### 最上游消息入口

来源：

- `main-page.created()`
- 注册：`v.a.on("message", this.onReceiveMessage)`

说明：

- 这里的 `v.a` 是更底层的原生事件桥
- 事件名为 `message`
- `main-page.onReceiveMessage(...)` 是应用层第一跳

### 中间分发层

`main-page.onReceiveMessage(...)` 负责：

- 规范化 `t.session`
- 按当前活动会话与窗口状态决定通知逻辑
- 必要时更新 `updateSession`
- `$bus.$emit("receive-message", t)`
- `sendMsgToOtherWin(...)`
- `sendMsgToMsgWin(...)`

可确认的 payload 结构：

- `t.session`
- 可选的 `t.message` 数组

### 增量消息入口

`message.onReceiveMessage(...)` 消费 `receive-message` 后：

- 如果目标会话已存在历史视图，则继续 `$bus.$emit(`${sesUUID}-msg`, messageArray)`
- 当前会话的 `chat-content` 在 `created()` 中监听 `${sesUUID}-msg`

### 当前会话消息落地

`chat-content.onNewMessage(e)` 的 `e` 是消息数组。

主要行为：

- 更新 `curMaxMsgIdx`
- 对每条消息执行归一化与事件处理
- `this.messages.push(...e)`
- 更新未读数、滚动状态、回执上报逻辑

结论：

- 新消息获取完全可以改成事件驱动
- 不必继续靠 DOM 轮询消息区

## 已确认可用的去 DOM 发送链

### 组件层发送

`MessageEditor` 暴露：

- `sendPicTextMessage`
- `sendMessage`
- `getContent`

其中：

- `sendMessage(e)` 本质是 `$bus.$emit(`${activedSes.sesUUID}-send`, e)``
- 发送按钮只是 `sendPicTextMessage()` 的模板事件壳

### 当前会话低层发送

`chat-content.onSendMessage()` 负责：

- `buildMessageObj`
- `insertSendBefoeMsg`
- 更新本地消息与 `updateSesLastMsg`
- 最终 `sendMessageNew`

### 不切 DOM 批量发送

已验证可以：

- 用当前 `chat-content` 作为桥接对象
- 用 `buildMessageObj()` 生成模板
- 按目标会话覆写 `sessionID / receiver / sessionType`
- 低层提交 `insertSendBefoeMsg + sendMessageNew`

这条路径已经在 `scripts/demo-batch-send.ts:289` 中验证。

## IPC 方法目录的高价值部分

从 `renderer.js` 中已抽出 222 个 IPC 方法名，当前最有价值的几类如下：

### 会话相关

- `getConversations`
- `getSessionBySessionID`
- `getSessionInfo6`
- `getServiceSessions`
- `setSession`

### 消息相关

- `getMessages`
- `getMessageByMsgId`
- `getMessageBySessionIDAndMsgIdx`
- `insertSendBefoeMsg`
- `updateMessage`
- `sendMessage`
- `sendMessageNew`
- `readMessage`

### 未读相关

- `getAtMsgUnread`
- `getMsgReportUnReadCount`
- `readVirtualService`

### 用户与群组相关

- `getUserByUserId`
- `getMemberDetail`
- `getGroupInfo`
- `getGroupsAllMembers`

## 当前最值得替代的 DOM 能力

### 已可替代

- 会话列表读取
- 消息分页读取
- 单条消息定位
- 新消息监听
- 已读同步
- 文本发送
- 当前会话低层发送
- 不切 DOM 的批量发送

### 仍建议保留 DOM 兜底的部分

- 初始引导拿到 `__vue__` / `$bus`
- 纯 UI 状态，如输入框焦点、未提交富文本、悬浮菜单等
- 极端情况下的兼容回退路径

## 风险与边界

### 优势

- 更少依赖 CSS selector 与 DOM 结构
- 更接近 KK 自己的业务逻辑
- 速度更稳，失败点更少
- 更容易做多会话批量发送与事件驱动收消息

### 风险

- 依赖私有运行时对象与 IPC 协议
- `getMessages` 与 `getMessageBySessionIDAndMsgIdx` 返回结构不一致，必须归一化
- 事件链和组件名仍可能在升级后变化

对当前场景的判断：

- 由于 KK 版本基本不升级，这条路线的收益明显大于风险

## 建议的演进路线

### 第一阶段：读链路去 DOM

- 会话列表改用 `getConversations`
- 历史消息改用 `getMessages`
- 单条精确补取改用 `getMessageBySessionIDAndMsgIdx`
- 新消息改走 `message` 事件桥和 `${sesUUID}-msg`

### 第二阶段：写链路双轨

- 优先走低层发送
- DOM 发送保留为兜底

### 第三阶段：未读与状态同步

- 已读统一走 `readMessage`
- 未读总数统一走 `getAtMsgUnread`

## 当前已确认、未确认项

### 已确认

- `getConversations` 无参可用
- `getMessages` 正确签名为对象参数
- `getMessageBySessionIDAndMsgIdx` 正确签名为位置参数
- `readMessage` 正确签名为对象参数
- `main-page.created()` 直接监听原生 `message`
- `main-page.onReceiveMessage()` 会发出 bus 事件 `receive-message`
- `chat-content` 通过 `${sesUUID}-msg` 接收当前会话增量消息

### 仍可继续深挖

- `v.a` 这一层到底是什么桥接对象
- 原生 `message` 事件的完整 payload 与注册来源
- 更多 IPC 方法的参数和返回规范化目录

## 总结

当前 KK9 客户端已经暴露出足够完整的低层读写链路，DOM 不再是唯一入口。对本项目而言，更合理的方向不是继续增强 selector，而是把 DOM 降级为“引导入口 + 兜底”，把主路径迁移到：

- IPC 读取会话与消息
- 事件驱动接收增量消息
- 低层发送与已读同步

这条路线已经有充分的运行时证据支撑，且与当前环境“版本几乎不升级”的约束相匹配。
