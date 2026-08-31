# @kkbot/driver 架构纯粹化与 Bridge 协议重构迁移总结报告

> **文档性质**：架构重构与底层逆向技术评审报告  
> **审查目标**：供第三方大模型或架构评审团队对本次重构的设计合理性、协议正确性、并发安全性与接口稳定性进行独立审计与评估。  
> **适用版本**：`@kkbot/driver@2.0.0` (基于 KK9 Electron 客户端运行时)

---

## 1. 重构背景与核心动因

### 1.1 核心问题诊断
在旧版实现中，`@kkbot/driver` 存在以下三项核心缺陷：
1. **职责边界泛化（非 IM 业务污染）**：Driver 内部混入了 Canvas 2D 卡片渲染、监控告警/决策报告模板等业务展示层逻辑，违背了「Driver 是纯粹 IM 协议/驱动器」的第一性原理。
2. **DOM 层的脆弱性与 UI 焦点冲突**：
   - 依赖 CSS 选择器（如 `.rcd-item`、`.chat-sendArea`）、虚拟滚动高度计算（`itemSize * index`）与剪贴板按键模拟（`Ctrl+V`）。
   - **致命缺陷**：向非当前激活会话发送消息时必须物理切换 UI 视图（`selectSession`），导致前台用户操作被打断，且在并发请求时产生严重的会话串线与竞争冒险（Race Condition）。
3. **未读状态伪消除**：通过 `badge.style.display = 'none'` 隐藏红点，未与服务端及移动端状态同步。

### 1.2 重构目标
- **纯粹化**：剥离 Canvas 渲染引擎及业务模板，将 Driver 收敛为纯粹的 KK IM 客户端操作驱动器。
- **Bridge 一等公民化**：全面逆向 Electron 主进程与渲染进程 IPC，建立基于数据层（`toData` / `callIce`）与 Vue 运行时（`$bus`）的通信机制，彻底取代 DOM 层。
- **接口契约抽象**：对外仅暴露 `IKK9Driver` 纯净接口，隐藏所有底层 CDP、IPC 与 DOM 回退细节。

---

## 2. KK9 底层四层通信架构全景

通过逆向分析主进程（`main.js`）与渲染进程（`renderer.js`），确立了 KK9 的真实分层模型：

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  Layer 1: UI / 展现层 (已废弃为主链路，仅保留为极窄 Fallback)                  │
│    • 虚拟滚动列表 (.vue-recycle-scroller)、输入框 DOM、模拟按键粘贴           │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 2: Vue 运行时事件总线 ($bus / chat-content / main-page)                 │
│    • 实时接收信令: $bus.$on('receive-message'), $bus.$on('${sesUUID}-msg')   │
│    • 实时撤回信令: $bus.$on('CancelMessage'), $bus.$on('${sesUUID}-revokeMsg')│
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 3: Electron IPC RPC 数据层 (toData 通信管道 - 核心驱动区)             │
│    • 渲染进程 -> 主进程: ipcRenderer.send('data', { id, args: [method, ...]})│
│    • 主进程挂载 26 个业务 Controller、570+ 个底层原生 RPC 方法                │
├──────────────────────────────────────────────────────────────────────────────┤
│  Layer 4: Native Engine / 本地 SQLite 存储 / ZeroC ICE (最底层)              │
│    • 本地数据引擎: SQLite (自动分配 Native MessageID、增量持久化)             │
│    • 网络通信引擎: C++ DLL / ZeroC ICE (callIce: sendUserMessage6e 等)      │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. 核心功能改造与底层 IPC 规范对照

| 功能模块 | 历史实现（DOM / 伪状态） | 新版实现（纯 Bridge / IPC 协议） | 底层 IPC / 运行时方法 | 性能与稳定性对比 |
| :--- | :--- | :--- | :--- | :--- |
| **会话列表** | 遍历 `.session-item` 节点或穿透虚拟 Scroller | 纯数据拉取全量会话 Map，计算 `maxMessageIndex - userReadIndex` 得到精确未读数 | `toData('getConversations')` | 耗时从 ~400ms 降至 **~15ms**，零 UI 依赖 |
| **历史消息** | 抓取 DOM 文本，正则匹配富文本 | 读取本地 SQLite 消息窗口，原生结构化 JSON 规范化 | `toData('getMessages', { sessionID, count, endIdx, sendTime })` | 无需滚动视口，任意后台会话毫秒级提取 |
| **出站发送 (文本/富文本/@)** | 填充输入框 DOM 节点 + 模拟按钮点击 | 本地 SQLite 落盘分配 ID + 网络引擎直接发送 | `insertSendBefoeMsg` ➔ `sendMessageNew` | **100% 静默后台并发发送**，前台 0 焦点切换 |
| **引用回复** | 查找 DOM 右键或模拟点击回复条 | 构造 `contentType: 13` 原生引用对象，原子投递 | `insertSendBefoeMsg` ➔ `sendMessageNew` | 精确绑定被引用消息 ID 与被引用人 |
| **文件发送** | 模拟拖拽/DOM 事件 | 构造 `contentType: 3` 原生文件载荷直接投递 | `insertSendBefoeMsg` ➔ `sendMessageNew` | 支持任意路径与 MIME 类型无感知投递 |
| **消息撤回** | 查找 DOM 右键菜单或模拟点击 | 原生撤回信令直发服务端并广播本地撤回事件 | `toData('cancelMessage', { type: 'own', sessionID, msgID, msgIdx })` | 支持任意历史消息精确秒级撤回 |
| **已读消除** | 修改 DOM `badge.style.display='none'` 伪消除 | 真正向服务器上报阅读索引，多端同步 | `toData('readMessage', { type, sessionID, maxMsgIdx })` | 消除假已读缺陷，服务端与移动端实时同步 |
| **组织架构** | 遍历点击展开 UI 部门树 (BFS 模拟点击 500 次) | 根部门自动嗅探 + 纯 IPC 递归拉取 | `toData('getChildDeptsAndMembers')` + `getMemberDetail` | **341 个部门、1321 名员工抽取耗时从 >30s 缩短至 3.3s** |

---

## 4. 架构设计与接口抽象

### 4.1 顶层接口契约 (`IKK9Driver`)
对外仅暴露操作 IM 所需的纯净接口，所有依赖完全面向接口编程：

```typescript
export interface IKK9Driver extends EventEmitter {
  // 1. 生命周期与健康状态
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  getStartupGenerationId(): string;
  getHealthSnapshot(): DriverHealthSnapshot;

  // 2. 会话管理 (全部走 Bridge 数据层)
  getSessions(): Promise<KK9Session[]>;
  getCurrentSession(): Promise<KK9Session | null>;
  selectSession(sessionId: string): Promise<boolean>;
  markSessionRead(sessionId: string): Promise<boolean>;

  // 3. 消息读取与补偿
  getRecentMessages(limit?: number, session?: KK9Session): Promise<KK9Message[]>;
  scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]>;

  // 4. 静默并发消息发送与撤回
  sendText(text: string, options?: SendOptions): Promise<SendResult>;
  sendRichText(content: FormattedText, options?: SendOptions): Promise<SendResult>;
  sendReply(replyTo: string | KK9ReplyTarget, content: FormattedText, options?: SendOptions): Promise<SendResult>;
  sendFile(filePath: string, options?: SendFileOptions): Promise<SendResult>;
  sendImage(imagePath: string, options?: SendOptions): Promise<SendResult>;
  recallMessage(messageId: string, session?: KK9Session | string): Promise<boolean>;

  // 5. 组织架构与人员档案
  getOrgEmployees(timeoutMs?: number): Promise<KK9Employee[]>;
  getUserProfile(userId: number | string): Promise<KK9Employee | null>;

  // 6. 实时事件监听 (0 轮询开销)
  on<U extends keyof DriverEvents>(event: U, listener: DriverEvents[U]): this;
}
```

### 4.2 模块划分与物理布局
```
packages/driver/src/
├── index.ts                 # 统一导出 (IKK9Driver, KK9Driver, FakeKK9Driver, 类型与异常)
├── driver.ts                # IKK9Driver 聚合实现 (Bridge 优先，DOM 后备)
├── fake-driver.ts           # 单元测试与故障注入测试桩 (实现 IKK9Driver)
├── bridge/                  # [核心] 纯数据层 Bridge 与 IPC 实现
│   ├── rpc.ts               # callIpcToData 底层 RPC 请求/响应封装
│   ├── session-ops.ts       # 会话数据拉取与 readMessage 同步
│   ├── message-ops.ts       # insertSendBefoeMsg + sendMessageNew 静默发送与 getMessages
│   ├── org-ops.ts           # 组织架构递归遍历与单点档案查询
│   ├── event-bridge.ts      # CDP Binding 原生实时事件直连桥
│   └── converter.ts         # 原生消息标准化与来源身份四分类
├── dom/                     # [后备] 保留的历史 DOM 操作层 (仅供极窄降级)
│   ├── rich-text.ts         # 富文本与 Markdown 解析
│   ├── selectors.ts         # DOM 选择器
│   ├── session-ops.ts       # DOM 会话回退
│   ├── message-ops.ts       # DOM 消息回退
│   ├── send-ops.ts          # DOM 发送回退
│   └── org-ops.ts           # DOM 组织架构回退
└── utils/
    ├── errors.ts            # 强类型异常 (DriverError, SendError, DomError 等)
    └── logger.ts            # UTF-8 编码防护日志模块
```

---

## 5. 安全机制与健壮性保障

1. **URI 安全编码隔离 (`encodePayload`)**：
   在向 CDP 注入参数时，全面采用 `JSON.stringify(encodeURIComponent(JSON.stringify(data)))` 并在浏览器端 `JSON.parse(decodeURIComponent(...))`，彻底根除模板字符串插值导致的多层反斜杠转义与换行符丢失问题。
2. **来源身份（`origin`）确定性分类**：
   不依赖任何概率或大模型猜测，依据本地账号 ID（`currentUserId`）、已记录发送指纹（`knownBotSentMessageKeys`）与消息载荷，严格判定为 `external`（外部成员）、`operator`（人工打字）、`bot_echo`（机器人自身回显）或 `system`（系统消息）。
3. **启动代次（`startupGenerationId`）与健康快照守卫**：
   在连接断开、重连或上下文漂移时，自动派发结构化 `DriverHealthEvent`，防止过期的闭包执行引发脑裂。
4. **防串线安全拦截 (Fail-Closed)**：
   每次执行发送前，严格比对目标会话与生成数据包中的 `sessionID` / `sesUUID`，一旦未命中目标会话立即拒绝发送（`isPreTrigger: true`），绝不向错误会话投递。

---

## 6. 自动化验证与审查清单

### 6.1 自动化测试覆盖
- **测试套件总数**：19 个测试文件
- **测试用例总数**：148 个测试用例（覆盖 Happy Path、边界值、网络超时、故障注入、消息撤回、防串线）
- **通过率**：**100% PASS**（0 错误、0 警告）
- **类型检查**：`pnpm typecheck` 0 错误
- **代码规范**：`pnpm lint` 0 警告

### 6.2 实机测试基准 (E2E)
- 私聊测试对象：`int2024`（会话 ID: `0-3585`）
- 群聊测试对象：`测试123`（会话 ID: `1-29467`）
- 组织架构全量抽取：**1321 名员工在 3.3 秒内抽取完成**（341 个部门递归全覆盖）。

---

## 7. 架构评审总结与结论

本次重构彻底解决了 `@kkbot/driver` 依赖 DOM 脆弱性、UI 焦点冲突及非 IM 业务耦合的历史技术债务，将底层通信全面下沉至 KK9 原生 IPC 与数据层，实现了 **100% 确定性、无感知后台并发收发与高性能组织架构抽取**，接口契约设计完备，已具备生产就绪水平。
