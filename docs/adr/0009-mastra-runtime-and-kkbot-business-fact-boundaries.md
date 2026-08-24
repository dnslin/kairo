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

进入 Agent 链后，Agent Loop、模型调用、低风险 Tool Calling、Memory、Workflow、Schedule、模型重试与回退以及 Agent Trace 的运行状态和执行语义只由 Mastra 持有。KKBot 只负责 KK I/O、KK 原始事实、企业业务数据、确定性上下文构造、低风险业务 Tool 定义、Delivery 投影和 KK 可靠交付；投影不得自行执行 Tool、恢复 Run 或覆盖 Mastra 状态。

当前产品不注册或调用高风险写 Tool。删除、权限、资金、敏感数据变更、大范围发送及其他无法明确归入低风险的意图，只生成明确说明“外部操作未执行”的普通 assistant 建议、拟写内容或操作清单。它们不形成 Draft、人工授权生命周期、Projection、挂起恢复或后续自动执行身份；人类在 Runtime 外操作后，KKBot 不猜测结果，也不恢复旧 Run 或 Tool Call。

唯一 Composition Root 持有且只创建一个进程级 Mastra `MCPClient`。MCP Server 的 `required` 默认 `true`；required Server 启动 discovery 失败阻止启动，只有显式 optional Server 可以进入可诊断降级，且其 Tools 在本次进程完全缺席，恢复后也不热加。自定义 `McpClientManager`、`ToolRegistry` 转换层、Gateway MCP 重试器和动态 Tool 热更新均不属于目标架构。

Agent Content Processors 以静态数组顺序执行，MCP 与本地 Tool 结果在进入下一模型 Step 前必须经过 Tool result Processor 检查。Quota Repository 只保存原子准入、预算预留和按稳定 `runId` 的 Usage 幂等结算事实，不接管 Agent Loop；Grounding 只验证本轮 Knowledge Tool 已返回的来源并转换最终答案，不发起第二轮模型或 Tool。安全、Quota 与 Grounding Processor 自身异常或超时均拒绝本轮，不得旁路原始输入、Tool 结果或模型输出。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.2–§2.7、§3.1–§3.2、§4.9–§4.13、§4.21–§4.28、§12
- [#112 群聊 Raw Store-only resolution](https://github.com/dnslin/kkbot/issues/112)
- [#117 Mastra 原生能力缺口 resolution](https://github.com/dnslin/kkbot/issues/117)
- [#129 Delivery 与 Memory 提交 resolution](https://github.com/dnslin/kkbot/issues/129#issuecomment-5389438847)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [#135 MCP 与 Processor 生命周期 resolution](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389833290)
- [#161 高危动作范围](https://github.com/dnslin/kkbot/issues/161)

## Historical Approval sources

[#123 审批超时语义](https://github.com/dnslin/kkbot/issues/123)、[#126 Approval 投影与 Run 恢复](https://github.com/dnslin/kkbot/issues/126#issuecomment-5389399723)与[#131 兼容版本研究](https://github.com/dnslin/kkbot/issues/131)保留审计价值，但不再定义当前产品实现要求或版本门槛。

## Open boundaries

[#168 兼容版本研究](https://github.com/dnslin/kkbot/issues/168)按当前能力范围锁定精确版本；[#124 最终验收矩阵](https://github.com/dnslin/kkbot/issues/124)决定最终验收覆盖。本 ADR 不锁定具体 Mastra API、版本或进程退出码。
