# ADR 0010: 唯一 Composition Root 与 Knowledge 生命周期

## Status
Accepted

## Date
2026-08-24

## Supersedes
[ADR 0006](./0006-unified-bootstrapper-and-dual-mode-rag.md)

## Context

旧 ADR 把启动器、固定关闭顺序和一套早期知识检索实现绑定在一起。长期需要保持的是唯一装配边界与 Knowledge 职责，而不是旧包清单、固定时长或具体连接假设。

Knowledge 摄取包含可能耗时、超时或部分成功的转换、OCR、Chunk、FTS 和远程 Embedding，不能把整个构建过程放进长期数据库写事务。单个来源行、Chunk 行或向量请求也不能同时约束词法与向量可见性；原子边界必须是不可见构建完成后，以一个短事务切换全局可查询快照。

## Decision

`apps/kkbot` 是唯一 Composition Root，负责配置校验、依赖构造、唯一 Mastra 实例、运行前自检以及进程级启动和关闭编排。各领域模块不私自创建第二个 Composition Root、Mastra 实例或独立生命周期。

Knowledge 是独立领域模块，负责来源规范化、标题感知 AST Chunk、词法与向量检索以及可选 Rerank。Agent 通过业务 Tool 主动查询 PublicKnowledge；Gateway 不预读知识并拼接 Prompt。具体启动顺序、关闭顺序和故障处理以当前总规格为准，不由本 ADR 固定实现步骤或超时数值。

Knowledge 的领域事实固定为：`Source` 是由规范化 `sourcePath` 标识的稳定逻辑来源；`SourceVersion` 是包含来源哈希、转换器/OCR 指纹、规范化指纹和规范化文档哈希的不可变版本；`ChunkSet` 由 SourceVersion 与 Chunker 指纹唯一确定；`LexicalPart` 由 ChunkSet 与词法指纹派生；`VectorPart` 由 Chunk 内容与完整 Embedding 指纹派生。Embedding 指纹至少覆盖 provider、model、model revision、dimension、输入规范化版本、向量归一化方式和 distance metric，只有完整指纹相同才允许复用向量。

一次完整、全局可查询的 PublicKnowledge 快照称为不可变 `KnowledgeGeneration`。其 manifest 将每个仍存在的 Source 映射到恰好一个 SourceVersion，并引用同一 generation 的 Chunk、FTS 和 Vector 物理索引部分；来源删除通过新 manifest 不再包含该 Source 表达。FTS 与 Vector 必须使用 generation-scoped namespace，Embedding dimension 或 distance metric 等不兼容变化必须创建新的 Vector namespace，不得原地改变活动索引或混入旧向量。

状态机固定为：

```text
building ──完整性校验通过──> ready ──Head CAS 短事务──> committed ──后继提交──> retired ──安全回收──> collected
    └────────转换 / Chunk / FTS / Vector 任一步失败────────> failed ───────────────> collected
```

唯一切换原语是 KKBot Client 在同一规范化 LibSQL 文件上的短事务：验证候选 generation 已 `ready`，且 manifest、FTS、Vector 的数量、校验和、覆盖率和指纹完整；再以候选记录的 base generation 与 Head revision 为条件执行 CAS，同时把候选改为 `committed`、旧 committed generation 改为 `retired`。耗时构建全部在事务外完成；不得借 Mastra Storage 或跨 Client 事务伪造原子性。CAS 失败的并发构建不得覆盖胜者，必须基于新 Head 重新构建或重放 manifest。

查询在同一数据库读事务中只读取一次 Head，并显式使用该 committed generation 的 FTS 与 Vector namespace；候选和来源元数据物化后立即结束事务，远程 Rerank 只能重排这批候选，不能跨 generation 补查。`building`、`ready`、`failed`、`retired` 和 `collected` 均不可被新查询选中。

内容更新只重建受影响 SourceVersion 的派生产物，但候选必须形成完整全局 manifest 与 generation-scoped 索引后再切换；来源删除、Embedding 指纹或维度变化、部分失败和并发构建均服从同一协议。任一 manifest、Chunk、FTS 或 Vector 部分失败都会阻止整代提交，Head 保持不变。切换事务崩溃只允许全部提交或全部回滚；若提交成功但响应丢失，以 build ID 与 Head 重读结果幂等确认，禁止盲切。

`retired` 或 `failed` generation 只有在不再是 Head、进程内查询引用计数为零且超过保守宽限期后，才可删除其专属 FTS/Vector namespace；不可变文档、Chunk 和向量缓存只有在所有保留 generation 都不再引用时清理，并至少保留最近一个 retired generation 用于诊断。源资产保留时长与恢复策略仍由 #137 裁定。本 ADR 只冻结语义，不冻结表结构、DDL、迁移或物理 namespace 命名。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §4.18、§6.2–§6.3、§8、§9.6
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [#136 Knowledge 索引原子替换的人类选择 A（待正式 resolution）](https://github.com/dnslin/kkbot/issues/136#issuecomment-5389748422)

## Pending decisions

[#131 Mastra 兼容版本组](https://github.com/dnslin/kkbot/issues/131)、[#135 MCP 与 Processor 生命周期](https://github.com/dnslin/kkbot/issues/135)、[#137 资产保留与清理恢复](https://github.com/dnslin/kkbot/issues/137)与[#138 Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)仍为开放票。本 ADR 不锁定精确版本、MCP/Processor 顺序、源资产清理恢复协议或失败回滚细节。#136 已按人类选择 A 冻结本文语义，但仍须等待本次规格修改合入 master 后再发布正式 resolution 与关闭；本 ADR 和 Draft PR 均不构成结案。
