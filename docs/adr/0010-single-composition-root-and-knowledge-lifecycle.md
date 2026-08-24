# ADR 0010: 唯一 Composition Root 与 Knowledge 生命周期

## Status
Accepted

## Date
2026-08-24

## Supersedes
[ADR 0006](./0006-unified-bootstrapper-and-dual-mode-rag.md)

## Context

旧 ADR 把启动器、固定关闭顺序和一套早期知识检索实现绑定在一起。长期需要保持的是唯一装配边界与 Knowledge 职责，而不是旧包清单、固定时长或具体连接假设。

## Decision

`apps/kkbot` 是唯一 Composition Root，负责配置校验、依赖构造、唯一 Mastra 实例、运行前自检以及进程级启动和关闭编排。各领域模块不私自创建第二个 Composition Root、Mastra 实例或独立生命周期。

Knowledge 是独立领域模块，负责来源规范化、标题感知 AST Chunk、词法与向量检索以及可选 Rerank。Agent 通过业务 Tool 主动查询 PublicKnowledge；Gateway 不预读知识并拼接 Prompt。具体启动顺序、关闭顺序和故障处理以当前总规格为准，不由本 ADR 固定实现步骤或超时数值。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§3.2、§4.18–§4.20、§4.28、§9.10、§12
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)

## Pending decisions

[#131 Mastra 兼容版本组](https://github.com/dnslin/kkbot/issues/131)、[#135 MCP 与 Processor 生命周期](https://github.com/dnslin/kkbot/issues/135)、[#136 Knowledge 索引原子替换](https://github.com/dnslin/kkbot/issues/136)、[#137 资产保留与清理恢复](https://github.com/dnslin/kkbot/issues/137)与[#138 Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)仍为开放票。本 ADR 不锁定精确版本、MCP/Processor 顺序、索引替换协议、资产清理协议或失败回滚细节。
