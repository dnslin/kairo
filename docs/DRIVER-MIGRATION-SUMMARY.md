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
| **历史消息** | 抓取可视 DOM 文本 | `toData('getMessages')` 读取原生结构化消息 | 成功空结果与 Bridge 不可用显式区分；显式目标仅在当前 DOM 会话 ID 精确一致时允许 fallback |
| **文本 / 富文本 / @** | 输入框与按钮模拟 | `insertSendBefoeMsg` ➔ `sendMessageNew` ➔ `getMessages(msgFlag)` | `sendMessageNew code: 0` 后仍需按唯一 `msgFlag` 解析落库正 ID；超时或无法解析真实 ID 均不得 DOM 重发 |
| **引用回复** | DOM 回复条 | 从目标会话历史读取原消息元数据，再构造 `contentType: 13` | 有 `msgIdx` 时精确查询并解析 JSON 字符串 content；否则有界分页；按 `msgFlag` 返回真实 ID |
| **文件发送** | 模拟拖拽或 DOM 事件 | 构造 `contentType: 3` 后走 native sender | 文件落库后按 `msgFlag` 返回真实 ID；路径、大小和 native ack 均验证 |
| **图片发送** | 剪贴板、按键与发送按钮 | 先真实切换并确认当前会话，再执行 UI 发送 | 目标未激活时 Fail-Closed；该路径会获取前台焦点，不宣称静默发送 |
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
│   ├── renderer-script.ts   # 共享 renderer 会话解析、请求 ID 与精确 listener cleanup
│   ├── rpc.ts               # callIpcToData 底层 RPC 请求/响应封装
│   ├── session-ops.ts       # 会话数据拉取与 readMessage 同步
│   ├── message-ops.ts       # 文本、回复、文件发送与历史读取编排
│   ├── ui-image-ops.ts      # 图片 UI/剪贴板窄路径
│   ├── recall-ops.ts        # native cancelMessage 撤回事务
│   ├── org-ops.ts           # 组织架构递归遍历与单点档案查询
│   ├── event-bridge.ts      # 唯一实时消息/撤回 Hook 所有者
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
   文本、回复和文件区分“native ack/落库确认成功”“可证明脚本未提交”和“提交后结果未知”；只有第一种成功，第三种不得自动进入 DOM 重试。图片没有已验证的 native ack，`success` 仅表示剪贴板、按键和按钮触发完成，真实验收必须再按 baseline、发送者与图片指纹从历史绑定 native ID。
4. **统一 renderer IPC 生命周期**：
   RPC、文本、回复、文件、撤回、已读和组织根探测统一使用 renderer 单调请求 ID；成功、timeout 与 `ipc.send` 抛错均只移除本次具名 listener，禁止 `removeAllListeners(replyChannel)`。
5. **目标与读取 Fail-Closed**：
   Driver 先从权威会话列表全局解析目标：`sesUUID/id` 精确优先，名称只在唯一时接受，随后仅向 Bridge/DOM 传递精确 ID。Bridge 成功空历史不会触发 DOM fallback；Bridge 不可用时，显式目标只有与当前 DOM active ID 精确一致才允许读取。图片目标未命中时在剪贴板和键盘动作前拒绝；撤回只使用精确消息 ID，并且仅 native ack 成功后更新本地事件总线。
6. **启动代次与健康事实**：
   `startupGenerationId` 和结构化健康事件用于识别连接身份变化；单次业务失败不会自动升级为 Driver 身份失效。

---

## 6. 自动化验证与审查清单

### 6.1 自动化测试覆盖
- **测试套件总数**：19 个测试文件
- **测试用例总数**：208 个离线辅助用例；它们不替代真实 KK9 验收
- **新增关键场景**：成功空历史与 Bridge unavailable 判别、显式 DOM active ID 守卫、Driver 全局重名拒绝、精确 `msgIdx`/有界分页回复、JSON 字符串 content 规范化、RPC timeout 只移除自身 listener、图片焦点重试、EventBridge 单一 Hook 所有权，以及原有真实 ID、ack、分页、mention 和转义边界
- **验证命令**：`pnpm test`、`pnpm typecheck`、`pnpm lint`、`pnpm build`

### 6.2 实机 E2E 结果与边界
- **执行日期**：2026-09-01；KK9 `renderer.html`，CDP `127.0.0.1:9222`。
- **目标锁定**：实际登录用户 `5761`；私聊 `int2024 / 0-3585`；群聊存在两个同名会话，测试明确选择 `测试123 / 1-29467`。
- **真实结果**：`pnpm e2e` 覆盖授权确认、目标身份、文本、富文本、字面反斜杠、文件、图片唯一关联、群聊普通消息、引用回复原生结构、历史回读、已读、组织架构与撤回清理，共 **28/28 PASS**。
- **身份验证**：文本、富文本、文件、群聊消息和回复均返回并回读到真实正 native ID；图片使用同一 baseline、发送者和 `7×11` 指纹精确关联，确认落入 `int2024` 且未进入群聊；6 条测试消息均成功撤回。
- **专项真机结果**：两个同名 `测试123` 时名称选择返回 false；窗口外 `123307983 / msgIdx=1` 回复成功并形成 `contentType: 13`；1ms 真实 IPC timeout 后同 channel 观察 listener 保持存在。
- **组织观测**：单次实机抽取 341 个部门、1357 名员工，耗时约 4.6 秒。该数值是本次环境观测，不是稳定性能承诺。
- `pnpm e2e` 会真实发送消息并切换 UI，只能在明确授权的测试会话运行，不能作为无副作用的默认 CI 门禁；运行前必须设置 `KK9_REAL_TEST_CONFIRM=5761:0-3585:1-29467`，脚本禁止 `@全体`、关键失败立即停止后续副作用，并自动按真实 ID 清理。

---

## 7. 架构评审总结与结论

本次重构完成了 Canvas/Card 职责剥离，并将文本、回复、文件、会话、已读和组织架构的主路径迁移到 Bridge / IPC。208 个离线辅助用例与授权实机 28 个步骤均已通过；真实 ID、窗口外回复、图片目标、全局重名拒绝、RPC listener 所有权、已读、组织读取和撤回清理均获得当前客户端版本的直接证据。图片发送仍依赖 UI，部分读取与轮询仍保留受 active ID 约束的 DOM 回退，私有 IPC 结论也绑定当前 KK9 版本；因此结论是“当前版本已通过代码门禁与指定会话实机验收”，而不是对未来客户端版本的无条件兼容承诺。
