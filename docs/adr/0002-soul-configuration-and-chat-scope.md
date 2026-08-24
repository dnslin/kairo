# ADR 0002: 人设配置解耦 (soul.md)、单聊边界约束与异常降级策略

## Status
Superseded

- **Superseded on**: 2026-08-24
- **Current replacement**: [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §3.1、§4.7、§12
- **Resolved by**: [#112《确定群聊消息进入系统的边界》](https://github.com/dnslin/kkbot/issues/112)
- **Pending decisions**: [#135 MCP 与 Processor 生命周期](https://github.com/dnslin/kkbot/issues/135)
- **Historical note**: 以下 Context、Decision 与 Consequences 保留原文，仅用于说明当时的决策背景；其中“群聊完全 Out of Scope”不再是当前边界。

## Context
在 KKBot v2 的智能对话设计中，需要进一步明确人设配置模式、会话适用范围（单聊 vs 群聊）、知识库未命中兜底策略，以及外部工具/MCP 发生故障时的容错机制。

## Decision
1. **人设与语气独立配置 (soul.md)**：
   - 建立声明式的 `soul.md` 规范文件，专门用于定义机器人的口吻（Persona）、打招呼风格、客服话术准则、禁忌词与业务边界。
   - 运行时支持动态读取与热重载 `soul.md`，彻底将业务人设与 Agent 核心逻辑代码解耦。
2. **明确会话范围边界 (1v1 单聊优先)**：
   - 当前阶段仅支持 **1v1 私聊会话**（与 `@kkbot/driver` 底层驱动的实现范围严格对齐）。
   - 群聊场景明确列为 `Out of Scope`，避免在多人群聊中引入不必要的复杂度。
3. **知识库未命中严格防幻觉 (No-Hallucination Fallback)**：
   - 在系统提示词中设立强约束：当公共知识库与私有上下文未检索到相关事实依据时，严禁模型凭空脑补，必须诚实回答并友好引导转接人工客服。
4. **外部工具与 MCP 异常自我降级 (Tool Fault Tolerance)**：
   - 当调用外部 MCP 服务（如 OCR、订单查询）遇到网络超时或 500 错误时，Agent 捕获异常后结构化反馈给 LLM；
   - 由 LLM 组织通俗友好的解释性答复（如“相关系统正在维护中，稍后为您跟进”），保证 Agent 整体会话流程不中断、不崩溃。

## Consequences
- **Positive**: 
  - 运营人员无需修改代码或重启服务，即可通过编辑 `soul.md` 调整人设；
  - 边界清晰（聚焦私聊），大幅收窄系统复杂度；
  - 杜绝客服场景下的事实幻觉风险与工具宕机引发的系统崩溃。
- **Tradeoffs / Risks**: 
  - 暂不支持群聊场景；
  - 知识库覆盖不全时可能会增加人工转接率。
