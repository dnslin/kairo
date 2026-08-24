# ADR 0010: 唯一 Composition Root 与 Knowledge 生命周期

## Status

Accepted

## Date

2026-08-24

## Supersedes

- [ADR 0006](./0006-unified-bootstrapper-and-dual-mode-rag.md)
- [ADR 0007](./0007-production-edge-cases-and-asset-retention.md) §2

## Context

旧 ADR 把启动器、固定关闭顺序和一套早期知识检索实现绑定在一起，并把单文件 Delete-then-Insert 当作知识一致性边界。长期需要保持的是唯一装配边界、Knowledge 职责和可证明的整代查询一致性，而不是旧包清单、固定时长、具体连接假设或单来源活动索引。

## Decision

`apps/kkbot` 是唯一 Composition Root，负责配置校验、依赖构造、唯一 Mastra 实例、运行前自检以及进程级启动和关闭编排。各领域模块不私自创建第二个 Composition Root、Mastra 实例或独立生命周期。

Knowledge 是独立领域模块，负责来源规范化、标题感知 AST Chunk、词法与向量检索以及可选 Rerank。Agent 通过业务 Tool 主动查询 PublicKnowledge；Gateway 不预读知识并拼接 Prompt。

PublicKnowledge 的查询一致性单元是全局不可变 KnowledgeGeneration，不是单个来源、Chunk 或索引表。文件型 KnowledgeSource 由受管来源根与规范化相对路径稳定标识；每个 Generation 以单一不透明 `generationId` 贯穿 `building`、`ready`、`committed`、`retired` 与 `failed`，其 manifest 把每个有效来源映射到恰好一个不可变 SourceVersion，并绑定同代 Chunk、FTS、Vector 与规则 fingerprint。

耗时转换、OCR、Chunk 和 Embedding 在不可见候选中完成。唯一可见性切点是 KKBot Client 的短写事务：以候选基线对唯一 Head 执行 CAS，并在同一事务中提交新 Generation、退休旧 Generation。查询通过本地只读快照一次固定 Head 与来源失效事实；远程 Rerank 只能在事务外重排已物化的同代候选。普通单层运行故障可以在同代降级；generation 绑定、覆盖率、fingerprint 或校验和无法证明一致时，查询必须不可用，不能任选 FTS 或 Vector。

来源删除、过期或禁用先提交单调 deny，再由后续完整 Generation 物理移除。进程重启只确认 Head 已指向的提交结果；其余遗留 `building/ready` 候选废弃并以新 `generationId` 重建，不自动提交或跨崩溃续建。查询引用保护与清理的具体租约、宽限期和保留策略由 #137 裁定；任何清理都不得删除 Head 指向或仍被查询引用的 Generation。具体启动顺序、关闭顺序、表结构、事务 API 和故障诊断字段以当前总规格为准。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§3.2、§4.18–§4.20、§4.28、§9.6、§9.10、§12
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#130 Knowledge 摄取故障 resolution](https://github.com/dnslin/kkbot/issues/130#issuecomment-5391309063)
- [#136 Knowledge 索引原子替换](https://github.com/dnslin/kkbot/issues/136)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [libSQL Client 事务契约](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-core/src/api.ts)
- [Turso / libSQL Vector 索引契约](https://docs.turso.tech/features/ai-and-embeddings)

## Pending decisions

[#137 资产保留与清理恢复](https://github.com/dnslin/kkbot/issues/137)与[#138 Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)仍为开放票。本 ADR 不锁定资产租约、清理宽限期、rollback 保留数量、Knowledge 能力是否阻止应用开放消息处理、精确依赖版本或具体 API 签名。
