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

### 1.2 重构目标与明确边界
- **纯粹化**：Canvas 渲染引擎、卡片类型和业务模板从 Driver 中直接剥离。本次迁移明确不保留 Card API 兼容层；仍需该能力时应由独立模块重新实现。
- **Bridge 优先**：文本、富文本、回复、文件、会话数据、已读和组织架构优先使用 Electron IPC / Vue 数据层；图片发送仍保留 UI、剪贴板和按键路径。
- **接口契约抽象**：`IKK9Driver` 是推荐的顶层业务契约。包当前仍导出 Bridge、CDP 与 DOM 类供诊断和高级调用，因此尚未形成物理上的完全隐藏。

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

| 功能模块 | 历史实现 | 当前实现 | 已验证边界 |
| :--- | :--- | :--- | :--- |
| **会话列表** | 遍历 DOM / 虚拟列表 | `toData('getConversations')` 读取会话 Map 并计算未读数 | Bridge 失败时仍可能回退 DOM |
| **历史消息** | 抓取可视 DOM 文本 | `toData('getMessages')` 读取原生结构化消息 | 目标会话需先解析为 native session ID |
| **文本 / 富文本 / @** | 输入框与按钮模拟 | `insertSendBefoeMsg` ➔ `sendMessageNew` | 仅 `sendMessageNew` 明确返回 `code: 0` 才成功；超时属于未知结果且不得 DOM 重发；指定目标时 Bridge 安全拒绝也不得被 DOM fallback 绕过 |
| **引用回复** | DOM 回复条 | 构造 `contentType: 13` 后走 native sender | 与文本发送共享相同 ack 规则 |
| **文件发送** | 模拟拖拽或 DOM 事件 | 构造 `contentType: 3` 后走 native sender | 路径、大小与 native ack 均需验证 |
| **图片发送** | 剪贴板、按键与发送按钮 | 当前仍使用相同 UI 路径 | 目标未命中时在剪贴板和按键操作前 Fail-Closed；该路径会获取前台焦点 |
| **消息撤回** | DOM 菜单 | 精确 `messageId` 与目标会话组装 `cancelMessage` | 仅 native `code: 0` 成功；`$bus` 只用于 ack 后更新本地 UI |
| **已读消除** | 仅隐藏本地红点 | `readMessage` native RPC | ack 成功后才更新本地状态；多端效果仍需实机验证 |
| **组织架构** | DOM 展开部门树 | `getChildDeptsAndMembers` 分页 BFS | 已覆盖首页恰好 200 人且同时返回子部门的边界 |

---

## 4. 架构设计与接口抽象

### 4.1 推荐顶层接口契约 (`IKK9Driver`)
业务调用应优先依赖 `IKK9Driver`；当前包为诊断与高级场景仍保留底层类导出：

```typescript
export interface IKK9Driver extends EventEmitter {
  // 1. 生命周期与健康状态
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getStatus(): ConnectionStatus;
  getStartupGenerationId(): string;
  getHealthSnapshot(): DriverHealthSnapshot;

  // 2. 会话管理 (Bridge 优先，必要时回退)
  getSessions(): Promise<KK9Session[]>;
  getCurrentSession(): Promise<KK9Session | null>;
  selectSession(sessionId: string): Promise<boolean>;
  markSessionRead(sessionId: string): Promise<boolean>;

  // 3. 消息读取与补偿
  getRecentMessages(limit?: number, session?: KK9Session): Promise<KK9Message[]>;
  scanCompensationWindow(options: CompensationScanOptions): Promise<KK9Message[]>;

  // 4. 消息发送与撤回
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

## 5. 安全机制与健壮性边界

1. **CDP 参数编码 (`encodePayload`)**：
   注入参数使用 JSON + URI 编码，避免把用户内容直接拼入脚本。核心 `FormattedText` 解析保留字面反斜杠；只有诊断 CLI 在明确边界解码转义换行。
2. **来源与 @ 状态分类**：
   `origin` 依据账号 ID、已记录发送身份和原生载荷分类。`atState: 1` 视为普通消息，`atState: 2` 或明确包含当前账号的成员列表才判定为 `@我`。
3. **发送结果三态**：
   发送结果区分“native ack 成功”“可证明脚本未提交”和“提交后结果未知”。只有第一种成功；第三种不得自动进入 DOM 重试。
4. **变更性操作的 IPC 请求 ID**：
   文本、回复、文件、撤回和已读路径使用 renderer 单调计数器分配唯一 reply channel；组织根部门探测仍有独立内部请求序列，不在此保证范围内。
5. **目标与撤回 Fail-Closed**：
   Bridge 与 DOM 解析会话时均优先匹配 `sesUUID/id`；仅在没有 ID 命中且名称唯一时接受名称。指定目标的 Bridge 拒绝不会再进入 DOM fallback；只有未指定目标、明确发送当前会话时保留该 fallback。图片目标未命中时在剪贴板和键盘动作前拒绝；撤回只使用精确消息 ID，并且仅 native ack 成功后更新本地事件总线。
6. **启动代次与健康事实**：
   `startupGenerationId` 和结构化健康事件用于识别连接身份变化；单次业务失败不会自动升级为 Driver 身份失效。

---

## 6. 自动化验证与审查清单

### 6.1 自动化测试覆盖
- **测试套件总数**：19 个测试文件
- **测试用例总数**：190 个测试用例
- **新增关键场景**：发送超时与未知状态、并发 IPC ID、listener 精确清理、目标列表缺失、ID 优先与名称歧义拒绝、指定目标禁止 DOM 绕过、图片目标未命中、撤回精确身份与 ack、已读 ack、200 人分页边界、普通 `atState: 1`、字面反斜杠与 CLI 解码边界
- **验证命令**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`

### 6.2 实机 E2E 边界
- `pnpm e2e` 会向真实 KK9 会话发送文本、富文本和图片，不能作为无副作用的默认 CI 门禁。
- 本轮修复未运行真实发送 E2E；生产环境中的多端已读效果、图片 UI 行为和性能指标仍需在授权测试会话中验证。
- 仓库当前没有可重复执行的性能基准，因此本文不再把特定毫秒数、员工数或部门数作为自动化通过结论。

---

## 7. 架构评审总结与结论

本次重构完成了 Canvas/Card 职责剥离，并将文本、回复、文件、会话、已读和组织架构的主路径迁移到 Bridge / IPC。自动化测试已经覆盖本轮审计发现的确定性缺陷，但图片发送仍依赖 UI，部分读取与轮询仍保留 DOM 回退，真实 KK9 的跨端效果与性能也尚未纳入可重复 E2E。因此当前结论是“代码级迁移与回归门禁完成，等待授权实机验收”，而不是无条件的生产就绪声明。
