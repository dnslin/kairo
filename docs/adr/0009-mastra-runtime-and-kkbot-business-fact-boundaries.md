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

唯一 Composition Root 持有且只创建一个进程级 Mastra `MCPClient`。MCP Server 的 `required` 默认 `true`；required Server 启动 discovery 失败阻止启动，只有显式 optional Server 可以进入可诊断降级，且其 Tools 在本次进程完全缺席，恢复后也不热加。自定义 `McpClientManager`、`ToolRegistry` 转换层、Gateway MCP 重试器和动态 Tool 热更新均不属于目标架构。

Agent Content Processors 以静态数组顺序执行，MCP 与本地 Tool 结果在进入下一模型 Step 前必须经过 Tool result Processor 检查。Quota Repository 只保存原子准入、预算预留和按稳定 `runId` 的 Usage 幂等结算事实，不接管 Agent Loop；Grounding 只验证本轮 Knowledge Tool 已返回的来源并转换最终答案，不发起第二轮模型或 Tool。安全、Quota 与 Grounding Processor 自身异常或超时均拒绝本轮，不得旁路原始输入、Tool 结果或模型输出。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.2–§2.7、§3.1–§3.2、§4.9–§4.13、§4.21–§4.28、§12
- [#112 群聊 Raw Store-only resolution](https://github.com/dnslin/kkbot/issues/112)
- [#117 Mastra 原生能力缺口 resolution](https://github.com/dnslin/kkbot/issues/117)
- [#123 审批超时语义 resolution](https://github.com/dnslin/kkbot/issues/123)
- [#126 Approval 投影与 Run 恢复 resolution](https://github.com/dnslin/kkbot/issues/126#issuecomment-5389399723)
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#129 Delivery 与 Memory 提交 resolution](https://github.com/dnslin/kkbot/issues/129#issuecomment-5389438847)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [#135 MCP 与 Processor 生命周期的人类选择 C](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389748394)

## Pending decisions

[#131 Mastra 兼容版本组](https://github.com/dnslin/kkbot/issues/131)仍为开放票。本 ADR 不锁定精确依赖版本或尚未经兼容实验确认的具体 API 签名。
