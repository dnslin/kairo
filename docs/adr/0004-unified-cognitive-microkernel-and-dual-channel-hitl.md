# ADR 0004: 基于 Mastra LibSQL 统一底座的全栈认知微内核与双通道 HITL 架构设计

## Status

Superseded

- **Superseded on**: 2026-08-24
- **Superseded by**: [ADR 0009：Mastra 运行时与 KKBot 业务事实边界](./0009-mastra-runtime-and-kkbot-business-fact-boundaries.md)
- **Current specification**: [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.2–§2.7、§4.12–§4.13、§4.21–§4.23、§12
- **Resolved by**: [#117《确定 Mastra 原生能力缺口的处理原则》](https://github.com/dnslin/kkbot/issues/117)、[#123《确定审批超时的唯一语义》](https://github.com/dnslin/kkbot/issues/123)、[#126《确定 Approval 投影与 Mastra Run 的恢复边界》](https://github.com/dnslin/kkbot/issues/126#issuecomment-5389399723)、[#127《确定单数据库下的 Storage 连接边界》](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)、[#129《确定回复交付与 Memory 提交协议》](https://github.com/dnslin/kkbot/issues/129#issuecomment-5389438847)、[#133《确定 Node.js 运行时基线》](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)、[#135《确定 MCP 与 Processor 的生命周期和故障边界》](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389833290)、[#161《重裁高危 Tool Approval 的本期产品范围》](https://github.com/dnslin/kkbot/issues/161)、[#168《锁定当前范围兼容版本》](https://github.com/dnslin/kkbot/issues/168#issuecomment-5403080615)、[#124《确定最终规格的契约验收矩阵》](https://github.com/dnslin/kkbot/issues/124)
- **Historical note**: 以下 Context、Decision 与 Consequences 保留原文，仅用于说明当时的决策背景，不再作为当前 Runtime、审批、Storage、版本或通道设计依据。

## Context

在 KKBot v2 的智能认知微内核（`@kkbot/agent`）与数据持久化架构选型中，为了彻底避免多数据库文件割裂（如同时存在多个 `.db` 文件导致跨库事务无法回滚、备份困难）以及重复造轮子的问题，系统需要确立一个统一、现代且高内聚的存储与认知调度底座。

面临的核心诉求：

1. **统一单库与全量生态复用**：全系统所有数据（会话、消息、L1/L2/L3 记忆、RAG 向量索引、Workflow 审批挂起与组织架构树）统一收敛在单个 SQLite 文件（`data/kkbot.db`）中；
2. **充分榨取开源生态红利**：直接复用 Mastra 全家桶（`@mastra/core`、`@mastra/libsql`、`@mastra/memory`、`@mastra/rag`）开箱即用的 3-Tier 记忆抽取（Working & Observational Memory）、向量库（`LibSQLVector`）、Workflow 审批挂起恢复（`suspend/resume`）与 MCP 客户端能力；
3. **企业组织架构与异步驱动统一**：全系统底层存储统一迁移至 `@libsql/client` 异步连接池，`@kkbot/store` 负责在同一个 LibSQL 实例上管理企业专有领域（`org_departments`、`org_employees`、拼音快搜与 Windows 文件锁防御）；
4. **企业级双通道审批流 (Dual-Channel HITL)**：结合组织架构汇报链（`OrgRepository`），实现 Web 控制台与 IM 直属主管私聊交互式审批。

## Decision

1. **全面采纳 Mastra LibSQL 作为全系统唯一存储底座 (Unified Substrate)**：
   - 统一引入 `@mastra/libsql` 作为核心数据访问底座，指向本地文件 `file:./data/kkbot.db`；
   - 将底层从 `better-sqlite3` 全面重构/升级至 `@libsql/client` 异步驱动，实现 100% 单数据库、单连接池与原子事务；
   - 系统所有数据领域均建立在同一个 LibSQL 实例之上。

2. **原生复用 Mastra 3-Tier 记忆引擎 (`MemoryLibSQL`)**：
   - **会话与消息**：KK9 会话映射为 Mastra `threadId`，员工标识映射为 `resourceId`，原生 `messageId`、撤回标记与图片载荷存放于消息元数据中；
   - **L1 短期滑动窗口**：通过 `memory.listMessages({ threadId, limit: 20 })` 物理隔离读取；
   - **L2 滚动工作记忆**：直接使用 Mastra 原生 `workingMemory` 增量压缩机制；
   - **L3 实体画像与认知反思**：直接启用 Mastra 1.60 原生 `ObservationalMemory`。

3. **原生复用 Mastra Workflow 审批状态机 (`WorkflowsLibSQL`)**：
   - 高危工具操作配置为 Mastra Workflow Step 中的 `suspend()` 挂起状态；
   - 挂起状态持久化于 `workflows` 表，默认触发 60 秒超时计时器；
   - **双通道通知**：
     1. 通道 1：Web 运维控制台展示待办卡片；
     2. 通道 2：结合组织架构仓储（`OrgRepository`）解析直属领导（`leaderId`），Bot 主动私聊推送审批提示；
   - **指令结算与恢复**：主管在私聊中回复“同意/通过”或 Web 端审批后，调用 `workflow.resume()` 恢复工具执行；超时未决议优雅降级输出转人工话术。

4. **原生复用 Mastra RAG 与向量存储 (`LibSQLVector`)**：
   - 使用 `@mastra/rag` 配合 `@mastra/libsql` 内置的向量存储能力，本地 Markdown 知识库切片经远程 Embedding 向量化后直接存入 LibSQL 进行余弦相似度检索。

5. **企业组织架构仓储异步升级 (`@kkbot/store`)**：
   - 组织架构三表（`org_departments`、`org_employees`、`org_employee_departments`）与媒体转存（`MediaStorage`）在 `@libsql/client` 驱动上运行，提供异步 API；
   - 继续保留拼音首字母快搜（`pinyin_abbr`）与针对 Windows Excel 独占锁的 CSV 导出防御（`AtomicRosterExport`）。

6. **ReAct 工具调度、多模态与安全护栏**：
   - 基于 Mastra `createTool` + Zod 模式校验定义内置工具；
   - 支持通过 `@mastra/mcp` 动态挂载外部标准 MCP 工具；
   - 只读工具并行并发（`Promise.allSettled`），写操作串行 + 异常结果回传大模型自愈；
   - 内部流式通信：实时剥离 `<think>...</think>` 思考标签，50ms 响应 `AbortSignal` 人工抢答打断。

7. **企业内部协同 6 大生产级防御规则 (Production Invariants)**：
   - **生成中并发互斥与瞬时中断 (In-flight Lock & Abort)**：会话生成中用户追加新消息时，立即通过 `AbortSignal` 掐断在途请求，合并新旧上下文重新生成；
   - **企业员工长期记忆协同 (Enterprise Colleague Memory)**：针对内部员工场景，保持 L3 员工画像（偏好、过往审批记录、身份部门）长期连续性，支持多轮话题自然平滑过渡；
   - **多笔审批指令消歧 (Multi-Approval Disambiguation)**：主管同时存在 $\ge 2$ 笔待审批任务时，回复“同意”自动提示选择序号（如“请回复【同意 1】或【同意 2】”）；
   - **Token 预算与步数熔断 (Token Quotas)**：单次输入强制截断为最多 2000 字符，单日回复频次保护，ReAct 步数硬锁定 `maxSteps: 5`；
   - **非图片文件元数据识别 (File Card Awareness)**：接收到 Excel/PDF/Zip 等文件附件时，提取文件名与大小转为系统结构化上下文；
   - **全局宕机兜底安抚 (Global Outage Fallback)**：大模型提供商彻底超时/503 且 Failover 失败时，向用户输出安抚话术并正常消除红点，防止死锁与静默无响应。

8. **企业级个人助理进阶能力 (Advanced Enterprise Capabilities)**：
   - **意图模型分流路由 (ModelRoutingByIntent)**：日常打招呼与简单查工位自动分流至极速轻量模型（300ms，降本 70%），复杂推理与长文档处理分流至 DeepSeek R1 / GPT-4o；
   - **事后异步反思 (ReflectiveMemoryPhase)**：对话结束后在后台利用 Mastra ObservationalMemory 异步提取员工特征，自动沉淀长期知识；
   - **实体交付物输出 (FileDeliverable)**：支持将报表或技术纪要直接生成 `.csv` / `.md` 文件并通过 KK9 发送给员工；
   - **主动定时调度 (ProactiveSchedule)**：支持自然语言设定工作提醒与定时周报/工单关怀推送（基于 Mastra Schedules）；
   - **异步长任务委托 (AsyncSubAgent)**：耗时重型任务立即确认并后台异步处理，完成后主动推送回执。

## Consequences

- **Positive**:
  - **最大化复用开源成熟生产力**：彻底免去自研 3-Tier 记忆算法、Workflow 挂起状态机与向量检索表，节省 70%+ 自研代码；
  - **绝对的单数据库一致性**：整个系统从底层存储到顶层 Agent 只有唯一一份 `data/kkbot.db`，无多 DB 冲突；
  - **企业组织能力与 Agent 深度协同**：主管审批路由与组织树在同一数据库中无缝连通。
- **Tradeoffs / Risks**:
  - `@kkbot/store` 需要从同步 `better-sqlite3` 重构成基于 `@libsql/client` 的异步仓储；
  - Monorepo 将引入 `@mastra/core`、`@mastra/libsql`、`@mastra/memory`、`@mastra/rag` 依赖。
