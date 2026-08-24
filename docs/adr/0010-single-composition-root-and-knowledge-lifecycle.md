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

每个进程只有一个 startup generation 和一个 Work Admission Gate。Static Validation 不取得资源；真实 Preflight 使用已取得的真实对象证明当前生效范围的全部必需事实，但不得创建 Delivery、Approval、Memory、Schedule trigger、发送或其他业务事实。只有同代 Ready Barrier 同时通过后才开放工作准入；初始化失败、关键运行事实失效和进程信号都先关 Gate，再进入同一幂等 Shutdown。

Composition Root 用 Acquisition Ledger 记录资源依赖与唯一 finalizer，并按依赖图逆拓扑释放。资源所有权转移必须替换唯一 closer：Mastra 接管 Storage 前由 Composition Root 关闭，接管后只由 `mastra.shutdown()` 关闭。已提交 migration 是持久 schema 事实，不是可回滚进程资源；CDP/EventBridge 失效时完整退出，由进程管理器启动新代次，不在原进程重建部分服务。

Knowledge 是独立领域模块，负责来源规范化、标题感知 AST Chunk、词法与向量检索以及可选 Rerank。Agent 通过业务 Tool 主动查询 PublicKnowledge；Gateway 不预读知识并拼接 Prompt。

PublicKnowledge 的查询一致性单元是全局不可变 KnowledgeGeneration，不是单个来源、Chunk 或索引表。文件型 KnowledgeSource 由受管来源根与规范化相对路径稳定标识；每个 Generation 以单一不透明 `generationId` 贯穿 `building`、`ready`、`committed`、`retired` 与 `failed`，其 manifest 把每个有效来源映射到恰好一个不可变 SourceVersion，并绑定同代 Chunk、FTS、Vector 与规则 fingerprint。

耗时转换、OCR、Chunk 和 Embedding 在不可见候选中完成。唯一可见性切点是 KKBot Client 的短写事务：以候选基线对唯一 Head 执行 CAS，并在同一事务中提交新 Generation、退休旧 Generation。查询通过本地只读快照一次固定 Head 与来源失效事实；远程 Rerank 只能在事务外重排已物化的同代候选。普通单层运行故障可以在同代降级；generation 绑定、覆盖率、fingerprint 或校验和无法证明一致时，查询必须不可用，不能任选 FTS 或 Vector。

来源删除、过期或禁用先提交单调 deny，再由后续完整 Generation 物理移除。进程重启只确认 Head 已指向的提交结果；其余遗留 `building/ready` 候选废弃并以新 `generationId` 重建，不自动提交或跨崩溃续建。查询物化期间使用短期 AssetLease 保护固定 Generation；当前 Head 与最近一个 retired Generation 通过持久 AssetReference 保留，下一代提交时在同一 KKBot Client 事务中释放更旧 retired Generation 的引用。任何清理都不得删除 Head、最近一个 retained Generation 或仍被查询租约保护的产物；具体资产状态、宽限期和恢复规则以总规格 §4.27 为准。具体启动顺序、关闭顺序、表结构、事务 API 和故障诊断字段以当前总规格为准。

## Current sources

- [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§3.2、§4.18–§4.20、§4.28、§9.6、§9.10、§12
- [#127 Storage 连接边界 resolution](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)
- [#130 Knowledge 摄取故障 resolution](https://github.com/dnslin/kkbot/issues/130#issuecomment-5391309063)
- [#136 Knowledge 索引原子替换](https://github.com/dnslin/kkbot/issues/136)
- [#137 资产保留与清理恢复](https://github.com/dnslin/kkbot/issues/137)
- [#133 Node.js 运行时基线 resolution](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)
- [#131 Mastra 兼容版本研究](https://github.com/dnslin/kkbot/issues/131)
- [#138 Bootstrapper Preflight 与逆序回滚](https://github.com/dnslin/kkbot/issues/138)
- [libSQL Client 事务契约](https://github.com/tursodatabase/libsql-client-ts/blob/main/packages/libsql-core/src/api.ts)
- [Turso / libSQL Vector 索引契约](https://docs.turso.tech/features/ai-and-embeddings)

## Open boundaries

[#161 高危 Tool Approval 范围](https://github.com/dnslin/kkbot/issues/161)决定当前产品最终要求的 Mastra Approval 能力集合；[#124 最终验收矩阵](https://github.com/dnslin/kkbot/issues/124)决定最终验收覆盖。本 ADR 不提前裁定两票，也不锁定具体 Mastra API、版本或进程退出码。
