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

应用日志和 Agent Trace 分别在导出前完成敏感信息脱敏。唯一 Composition Root 负责初始化、配置校验、Flush 和 Shutdown 接线；相关故障必须可诊断。日志与 Trace 都不是 Approval、Delivery 或其他业务事实源。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§4.24–§4.25、§4.28、§9.8–§9.10、§12
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)

## Pending decisions

[#131 Mastra 兼容版本组](https://github.com/dnslin/kkbot/issues/131)与[#138 Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)仍为开放票。本 ADR 不锁定 Observability 精确版本、Flush/Shutdown 次序或失败回滚协议。
