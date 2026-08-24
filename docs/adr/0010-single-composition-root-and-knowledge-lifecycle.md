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

跨 Composition Root、Knowledge、Driver、Delivery 与 Mastra Workflow/Schedule 使用的物理字节统一建模为 **ManagedAsset**。长期业务 owner 通过持久 **AssetReference** 保护资产，短期 I/O 通过可续租 **AssetLease** 保护；路径、打开句柄、内存引用计数、搜索结果或 Mastra snapshot 都不构成删除授权。

跨 KKBot Client 与 Mastra Storage 的边界采用 **protect-before-publish**：先持久化 ManagedAsset 和 active AssetReference，再发布 `assetId`；owner 终态或替换事实持久化后才 release。该顺序把不可原子提交的崩溃窗口固定为“可能多保留一个可审计孤儿”，而不是“可能发布一个未受保护资产”。

物理资产默认具有 30 天 retentionDeadline，并采用持久状态 `staging → ready → delete_marked → deleting → deleted`；非预期外部缺失进入 `missing`。清理使用两阶段 Mark/Sweep：Mark 前检查所有 active AssetReference、未过期 AssetLease 与 hold，写入 grace；Sweep 在 grace 后二次检查并以 CAS 取得删除执行权。合法删除意图下的 `ENOENT` 幂等完成；失败持久化并有上限退避；启动与周期任务恢复未完成 Mark、过期 staging/deleting lease 和删除尝试；无元数据字节先进入 quarantined orphan，经过 grace 和来源核对后才能处理。

Delivery=`unknown`、pending Approval、非终态 Workflow、会复用资产的活跃 Schedule，以及 building/candidate/current/rollback Knowledge generation 均保持 active AssetReference。Knowledge 旧 generation 只有在 #136 定义的原子切换事实持久化后才能 release；本 ADR 不提前规定 #136 的切换实现。物理删除只删除字节，必须保留资产 tombstone、引用历史、checksum、deadline、删除尝试和原因；审计元数据的最终淘汰由独立合规策略决定。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§3.2、§4.18–§4.20、§4.27–§4.28、§9.6.1、§9.10、§12
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [#137 人类选择 A：持久化类型引用表、短租约与两阶段 Mark/Sweep](https://github.com/dnslin/kkbot/issues/137#issuecomment-5389748475)

## Pending decisions

[#131 Mastra 兼容版本组](https://github.com/dnslin/kkbot/issues/131)、[#135 MCP 与 Processor 生命周期](https://github.com/dnslin/kkbot/issues/135)、[#136 Knowledge 索引原子替换](https://github.com/dnslin/kkbot/issues/136)与[#138 Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)仍为开放票。本 ADR 不锁定精确版本、MCP/Processor 顺序、Knowledge generation 原子切换协议或失败回滚细节。
