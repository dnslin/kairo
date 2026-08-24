# ADR 0003: 存储层分层架构、多部门组织关系、会话状态机与健壮性防护设计

## Status

Superseded

- **Superseded on**: 2026-08-24
- **Current replacement**: [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §4.7、§4.21–§4.23、§4.27、§12
- **Resolved by**: [#111《确定 Draft 是否保留独立事实模型》](https://github.com/dnslin/kkbot/issues/111)、[#129《确定回复交付与 Memory 提交协议》](https://github.com/dnslin/kkbot/issues/129#issuecomment-5389438847)、[#137《确定资产保留的引用保护与清理恢复协议》](https://github.com/dnslin/kkbot/issues/137)
- **Historical note**: 以下 Context、Decision 与 Consequences 保留原文，仅用于说明当时的决策背景；其中独立 `DraftRepository` 与草稿事实模型不再生效。

## Context

在 KKBot v2 的演进过程中，系统从单体架构走向 Monorepo 模块化拆分。随着企业级协同功能的引入，面临以下核心架构与领域挑战：

1. **组织架构的多维度与复杂层级**：企业员工不仅属于多级部门树，且普遍存在跨部门兼职、不同部门兼任主管/工程师等 N:N 关系，同时需要支持根据工号、姓名、拼音首字母和部门路径的毫秒级模糊检索与每日 CSV 导出。
2. **驱动层与存储层的分层解耦**：`@kkbot/driver` 必须保持纯 I/O 驱动定位（零数据库依赖），而持久化与调度需求需要一个清晰独立的 `@kkbot/store` 模块。
3. **消息全生命周期控制与精准撤回**：消息撤回时需要利用客户端原生 `message_id` 实现 100% 精确匹配并同步标记 `is_recalled = 1`，避免失效上下文污染 LLM 对话。
4. **会话生命周期与人机协同防抢话**：IM 场景下存在碎片消息并发、人类操作员介入打字、陈旧会话上下文残留与红点消除策略等边界问题。
5. **Windows 文件锁与离职数据一致性**：Excel 独占锁定 CSV 导致的写盘崩溃、全量同步时的离职废弃数据清理、以及多模态图片缓存过期成为现实风险。

## Decision

1. **分层仓储聚合架构 (Repository Pattern)**：
   - 在 `packages/store` 下建立统一的 SQLite 连接底座（单数据库文件，启用 WAL 模式与 Pragma 优化）；
   - 内部按领域拆分为 `OrgRepository`、`MessageRepository`、`DraftRepository` 等独立仓储；
   - Store 保持为纯数据访问层（DAO），零 Driver 运行时依赖，零内部定时器。定时同步与调度由上层应用编排。

2. **组织架构三表关联与全量原子刷新**：
   - 建立 `org_departments`（部门树、层级、负责人）、`org_employees`（员工自然属性、拼音简写、工位、汇报链）与 `org_employee_departments`（任职关系中间表）；
   - 通过中间表联合主键 `(employee_id, dept_id)` 完整表达主职 (`is_primary = 1`) 与兼职 (`is_primary = 0`)，以及员工在不同部门的具体职位和主管身份；
   - `syncOrganization` 采用单事务原子覆盖策略，全量刷新部门树与在职员工名录，杜绝离职员工与废弃部门残留，依赖 SQLite 事务保证多任务安全排队；
   - 支持工号、中文名及拼音缩写（`pinyin_abbr`）的联合索引模糊快搜。

3. **CSV 导出与 Windows Excel 文件锁防御 (AtomicRosterExport)**：
   - 导出为带 UTF-8 BOM 规范的 `data/organization_roster.csv`，一人一行，兼职信息采用 `[主]...; [兼]...` 单列合并；
   - **防御机制**：先写入 `.tmp` 临时文件后原子 `rename`；若检测到 Windows 上 Excel 占用产生 `EBUSY` 独占写锁，自动降级输出为带日期的副本（如 `organization_roster_2026-08-19.csv`）并告警，保证服务不中断、不崩溃。

4. **消息历史、精准撤回与多模态转存**：
   - `session_messages` 表显式记录客户端原生 `message_id`、`message_type`、`raw_payload`（图片/文件/引用元数据）与 `is_recalled` 标记；
   - 收到撤回事件直接按 `(session_id, message_id)` 精准标记；`getSessionHistory` 自动在 SQL 层面过滤已撤回消息；
   - **多模态本地化转存**：接收到图片与关键文件时，异步复制到 `data/media/` 目录下永久受控管理，数据库存储相对路径，杜绝客户端临时缓存被清理导致的死链。

5. **Session 状态机与人机协同防护**：
   - **智能防抖合并 (1.5s Debounce)**：同会话 1.5 秒内多条短消息自动合并为单次上下文；防抖期内收到撤回事件立即从队列剔除并支持静默熔断；
   - **人类接管退避 (Human Takeover)**：检测到人类发送消息后进入 10 分钟静默退避期（持久化 `human_takeover_until` 字段），彻底杜绝抢话；
   - **对话轮次衰减**：会话闲置超过 2 小时自动视为全新对话轮次，截断陈旧历史；
   - **视觉红点守卫**：仅在 Bot 自动回复成功后显式调用 `markSessionRead` 消除红点；草稿模式、人工退避期或发生错误时坚决保留红点。

## Consequences

- **Positive**:
  - 数据模型严格表达企业级复杂组织关系（树形部门、汇报链、一人多职），支持拼音毫秒级快搜与 Excel 友好导出；
  - 架构分层清晰，Store 易于单测与独立 Mock；
  - 彻底解决 Windows Excel 文件独占锁引发的崩溃风险与离职人员残留脏数据；
  - 消除消息撤回误伤风险与多模态文件死链隐患；
  - 彻底杜绝人机抢答、碎片回复与红点乱消问题。
- **Tradeoffs / Risks**:
  - 引入了多对多关系中间表，查询员工完整档案时需要做单次连表聚合；
  - 需引入本地媒体目录文件复制与存储管理。
