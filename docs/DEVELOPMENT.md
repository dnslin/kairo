# KKBot 开发与验证指南

本文只说明如何在当前仓库中安装依赖、修改代码和验证结果。产品范围见 [`kkbot-prd.md`](./kkbot-prd.md)，KK9 客户端启动见 [`KK9-STARTUP.md`](./KK9-STARTUP.md)，底层私有接口证据见 [`KK9-LOWLEVEL-RESEARCH.md`](./KK9-LOWLEVEL-RESEARCH.md)。架构边界和实施规格不在本文重复。

## 1. 开发环境

- 使用 Windows 运行需要连接真实 KK9 客户端的脚本。
- 使用 pnpm 工作区管理依赖；工作区范围由根目录 `pnpm-workspace.yaml` 定义。
- 项目目标运行时基线是 Node.js `>=22.13`。当前根 `package.json` 仍声明 `>=20.0.0`，属于待收敛的仓库元数据差异；开发和验证不得因此降回 Node.js 20。
- 首次进入仓库后运行 `pnpm install`，后续安装必须复用锁文件，避免无意漂移依赖版本。

## 2. 常用命令

以下命令均从仓库根目录执行。

| 命令                    | 作用                               |
| ----------------------- | ---------------------------------- |
| `pnpm build`            | 递归构建所有工作区包               |
| `pnpm typecheck`        | 执行根 TypeScript 静态检查         |
| `pnpm test`             | 运行 Vitest 测试                   |
| `pnpm test:watch`       | 以监听模式运行 Vitest              |
| `pnpm lint`             | 检查包内 TypeScript 源码和测试     |
| `pnpm format`           | 格式化包内 TypeScript 源码和测试   |
| `pnpm bench`            | 运行全部基准入口                   |
| `pnpm bench:latency`    | 运行延迟基准                       |
| `pnpm bench:resource`   | 运行资源基准                       |
| `pnpm bench:throughput` | 运行吞吐基准                       |
| `pnpm verify:bridge`    | 连接真实 KK9，交互验证 EventBridge |

根脚本中没有 `pnpm dev`。新增或删除脚本时，应同时更新本节，不能在文档中保留不存在的命令。

### 单包验证

优先把反馈环收窄到实际改动的包：

```bash
pnpm --filter @kkbot/driver test
pnpm --filter @kkbot/driver build
```

只有跨包契约发生变化时，才需要扩大到根级构建、类型检查和测试。

## 3. 修改流程

1. 阅读目标实现、类型、调用方和相邻测试，确认现有边界。
2. 修改最小必要范围；不要顺带重构无关模块。
3. 先运行目标包测试或实际脚本，确认改动路径可工作。
4. 再运行与改动直接相关的类型检查、Lint 和构建。
5. 行为变化必须更新可观察合同测试；文档变化必须核对命令、路径和链接确实存在。

## 4. 代码约束

### TypeScript 与模块

- 保持严格类型；禁止 `any` 和 `as any`。
- 相对 ESM 导入必须携带 `.js` 后缀。
- 类型依赖使用 `import type` 和 `export type`。
- 子包通过 `src/index.ts` 明确公开 API，不让调用方依赖内部路径。
- 自定义错误保留原始原因链，不能吞掉底层诊断。

### 日志与语言

- 源码中不使用 `console.log`；库代码通过项目 logger 输出结构化日志。
- 日志和代码注释使用中文。
- 注释解释非显然意图，不复述代码表面行为。

### Driver 边界

- `@kkbot/driver` 只负责 KK9 的 CDP、运行时桥接和 I/O，不引入数据库或文件持久化职责。
- 不在后台静默清除未读红点。
- DOM、运行时对象和 IPC 返回值必须先规范化，再进入公开类型。

## 5. 验证类型

### 离线验证

单元测试必须可在没有 KK9、网络和真实账号的环境中运行。Mock 只替代外部边界，测试仍应验证公开行为、错误和状态转换。

### 真机验证

先按 [`KK9-STARTUP.md`](./KK9-STARTUP.md) 启动客户端，再选择脚本：

- `pnpm verify:bridge`：监听消息、@提及和撤回，并提供会话读取与发送命令。
- `pnpm tsx scripts/e2e-live-verification.ts`：执行富文本、文件、会话读取和轮询验证。

`e2e-live-verification.ts` 当前包含固定会话 ID，并会发送真实消息和文件。运行前必须检查目标账号、会话 ID 和测试数据，不能把它当作无副作用测试。

## 6. 文档维护规则

- 产品需求只写入 `kkbot-prd.md`，不在开发指南复制架构或实施状态。
- KK9 启动参数和 CDP 排障只写入 `KK9-STARTUP.md`。
- 私有 IPC、运行时对象和事件链的观测只写入 `KK9-LOWLEVEL-RESEARCH.md`，并标注证据强度与客户端版本。
- 当前任务、完成状态和阻塞关系以 GitHub Issues 为准，文档不维护第二份勾选清单。
- 命令、路径、依赖或行为发生变化时，优先链接其权威来源，不复制容易漂移的大段内容。
