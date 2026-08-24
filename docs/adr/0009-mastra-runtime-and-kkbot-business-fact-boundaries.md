# ADR 0009: Mastra 运行时与 KKBot 业务事实边界

## Status
Accepted

## Date
2026-08-24

## Supersedes
[ADR 0004](./0004-unified-cognitive-microkernel-and-dual-channel-hitl.md)

## Context

旧 ADR 把 Agent Runtime、Storage、审批通道和 Workflow 恢复合并为一个决定，导致 KKBot 辅助层可能重新持有 Mastra 已负责的运行状态，也会提前锁定仍待裁定的连接、恢复、版本与时长。

## Decision

进入 Agent 链后，Agent Loop、模型调用、Tool Calling、Memory、Tool Approval、Workflow、Schedule、模型重试与回退以及 Agent Trace 的运行状态和执行语义只由 Mastra 持有。KKBot 只负责 KK I/O、KK 原始事实、企业业务数据、确定性上下文构造、业务 Tool 定义、审批与交付投影、主管路由和 KK 可靠交付；投影不得自行执行 Tool、恢复 Run 或覆盖 Mastra 状态。

Tool Approval 只裁定单个高危 Tool 是否执行，Workflow suspend/resume 只处理补充信息或多步骤流程等待，两者不得组合成第二套审批状态机。群聊消息只保留为 KK Raw Store 事实，不进入 Agent、Memory、Tool、Approval、Workflow 或 Delivery。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.2–§2.7、§3.1–§3.2、§4.12–§4.13、§4.21–§4.23、§12
- [#112 群聊 Raw Store-only resolution](https://github.com/dnslin/kkbot/issues/112)
- [#117 Mastra 原生能力缺口 resolution](https://github.com/dnslin/kkbot/issues/117)
- [#123 审批超时语义 resolution](https://github.com/dnslin/kkbot/issues/123)
- [#126 Approval 投影与 Run 恢复 resolution](https://github.com/dnslin/kkbot/issues/126#issuecomment-5389399723)
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#129 Delivery 与 Memory 提交 resolution](https://github.com/dnslin/kkbot/issues/129#issuecomment-5389438847)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)

## Pending decisions

[#131 Mastra 兼容版本组](https://github.com/dnslin/kkbot/issues/131)与[#135 MCP 与 Processor 生命周期](https://github.com/dnslin/kkbot/issues/135)仍为开放票。本 ADR 不锁定精确依赖版本、Processor 执行顺序或 MCP 故障协议。
