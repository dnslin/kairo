# ADR 0008: 生产级全链路统一日志、Trace 追踪与启动自检规范

## Status

Superseded

- **Superseded on**: 2026-08-24
- **Superseded by**: [ADR 0011：应用日志与 Mastra Observability 分工](./0011-application-logging-and-mastra-observability.md)
- **Current specification**: [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§4.24–§4.25、§4.28、§9.8–§9.10、§12
- **Resolved by**: [#127《确定单数据库下的 Storage 连接边界》](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)、[#131《锁定 Mastra 兼容版本组》](https://github.com/dnslin/kkbot/issues/131)、[#133《确定 Node.js 运行时基线》](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)、[#135《确定 MCP 与 Processor 的生命周期和故障边界》](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389833290)、[#138《确定 Bootstrapper Preflight 与逆序回滚契约》](https://github.com/dnslin/kkbot/issues/138)
- **Open boundaries**: [#161 高危 Tool Approval 范围](https://github.com/dnslin/kkbot/issues/161)、[#124 最终验收矩阵](https://github.com/dnslin/kkbot/issues/124)
- **Historical note**: 以下 Context、Decision 与 Consequences 保留原文，仅用于说明当时的决策背景；UnifiedLogger 不再承担 Mastra Agent 内部 Trace。

## Context

目前 KKBot Monorepo 下的四个核心包（`@kkbot/driver`、`@kkbot/store`、`@kkbot/agent`、`@kkbot/gateway`）各自独立实例化了一个本地 Pino logger。
这导致：

1. `config.yaml` 中的全局日志级别、输出文件路径与格式无法统一向下注入；
2. 跨模块处理单条消息时缺乏唯一的 `traceId` 关联，线上多会话并发时无法追踪完整调用链路；
3. 缺少集中式的敏感数据脱敏（PII Redaction）和日志按天滚动落盘（Log Rotation）；
4. 缺乏启动前的环境自检（Preflight Healthcheck）与单进程文件锁（PID Lock）。

## Decision

### 1. 全局统一日志中枢 (`UnifiedLogger`)

- 统一在系统顶层启动器由 `UnifiedBootstrapper` 根据 `config.yaml` 的 `logging` 节点完成全局 Root Logger 的单例初始化；
- 提供 `configureGlobalLogger(options)`，所有子包的 `createChildLogger(moduleName)` 自动继承该统一 Root Logger；
- **双路输出架构 (Dual Outputs)**：
  - 控制台：开发/调试友好的彩色格式输出（`pino-pretty`）；
  - 文件落盘：写入 `data/logs/kkbot.log`，支持按天或按 50MB 自动滚动归档，默认保留最近 7 天。

### 2. 全链路上下文追踪 (`TraceContextPropagation`)

- 每当 Gateway 接收到新消息或聚合消息批次时，生成唯一 `traceId`（如 `tr_17242...`）；
- 将 `traceId`、`sessionId`、`senderId` 绑定到 Child Logger 上下文并在 Driver $\to$ Gateway $\to$ Agent $\to$ Store 之间透传；
- 所有相关模块输出的日志自动携带 `[traceId=...]`，支持线上故障一键全链路 grep 追踪。

### 3. 全局敏感信息脱敏 (`PiiRedactionPolicy`)

- 启用 Pino 原生 `redact` 能力与正则过滤器，在序列化输出前对以下字段与敏感模式执行自动脱敏：
  - 字段名匹配：`apiKey`, `token`, `password`, `secret`, `authorization`, `cookie` ➔ 替换为 `[REDACTED]`；
  - 模式匹配：手机号脱敏为 `138****1234`，身份证号脱敏为前 6 后 4 位。

### 4. 启动前自检探针与进程锁 (`PreflightHealthcheck` & `PidLock`)

- **PID 单实例锁**：启动时在 `data/kkbot.pid` 创建互斥锁，防止多实例并发冲突；
- **启动探针自检**：
  1. 验证 `data/` 目录可写性与 SQLite 单库完整性；
  2. 探测 `127.0.0.1:9222` CDP 端口连通性；
  3. 执行极简 LLM 端点连通性测试；
  4. 自检全部通过后再开放服务接入。

### 5. 客户端断线指数退避重连 (`CdpReconnectBackoff`)

- 针对 KK9 客户端离线/重启，采用指数退避重试（1s, 2s, 4s, 8s... 最大 30s），重连后自动重新挂载会话与补偿同步。

## Consequences

- **Positive**:
  - 彻底终结 4 个模块日志割裂的现状，所有日志级别、文件落盘与脱敏全局统一收敛；
  - 获得企业级 APM 追踪体验，线上高并发会话排障效率提升 10 倍；
  - 杜绝多实例文件损坏与无自检带病启动隐患。
- **Tradeoffs / Risks**:
  - 需要在各子包中轻量重构 logger 模块以支持全局单例共享。
