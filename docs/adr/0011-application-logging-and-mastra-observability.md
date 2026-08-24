# ADR 0011: 应用日志与 Mastra Observability 分工

## Status

Accepted

## Date

2026-08-24

## Supersedes

[ADR 0008](./0008-unified-logging-tracing-and-production-preflights.md)

## Context

旧 ADR 让 UnifiedLogger 同时承担应用日志和完整 Agent Trace，无法表达 Mastra 对 Agent、模型、Tool、Memory 与 Workflow 内部运行的事实权威，也会形成重复追踪实现。

## Decision

UnifiedLogger 负责 KKBot 应用与基础设施日志，包括 Driver、Gateway、Store、Knowledge、CDP、文件和数据库操作。Mastra Observability 负责 Agent 内部的模型、Tool、Memory、Workflow、Token 和运行诊断。两者通过同一 TraceContext 及关联 ID 串联，但不互相替代。

应用日志和 Agent Trace 分别在导出前完成敏感信息脱敏。Trace `SensitiveDataFilter` 是 Observability Span Output Processor，只处理导出字段；它不是 Agent 的 `SensitiveInputProcessor` / `SensitiveOutputProcessor`，不得替代用户输入、Tool result 或最终输出安全门。Trace 单字段处理失败只允许导出 Mastra 原生错误标记，不得导出原字段，也不得改变 Agent、Delivery 或配额业务事实。

唯一 Composition Root 负责初始化、配置校验、Flush 和 Shutdown 接线。Observability 是 Ready Barrier 的必需事实；Observability/Mastra 持有 Trace `SensitiveDataFilter` 的关闭所有权，Composition Root 只调用一次 `mastra.shutdown()`，不得再次直接关闭该 Filter 或 Mastra Storage。初始化或关键运行事实失效先关闭唯一 Work Admission Gate，再进入同一幂等 Shutdown；导出、Flush 和 Shutdown 故障必须可诊断，关闭故障不得重新开放流量，也不得跳过其余 finalizer。日志与 Trace 都不是 Delivery 或其他业务事实源。

Shutdown 先完成 Observability Flush，再调用 `mastra.shutdown()`；数据库、文件和外部资源完成关闭尝试后释放单实例锁，UnifiedLogger 最后 Flush 并关闭，以保留全部关闭诊断。最终结果聚合原始触发错误与所有 finalizer 错误。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§4.24–§4.25、§4.28、§9.8–§9.10、§12
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [#135 MCP 与 Processor 生命周期 resolution](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389833290)
- [#131 Mastra 兼容版本历史研究](https://github.com/dnslin/kkbot/issues/131)
- [#138 Bootstrapper Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)
- [#161 高危动作范围](https://github.com/dnslin/kkbot/issues/161)

## Open boundaries

[#168 兼容版本研究](https://github.com/dnslin/kkbot/issues/168)按当前能力范围锁定精确版本；[#124 最终验收矩阵](https://github.com/dnslin/kkbot/issues/124)决定最终验收覆盖。本 ADR 不锁定 Observability 精确版本、具体构造 API、全局关闭 deadline 或进程退出码。
