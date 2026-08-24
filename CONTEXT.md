# KKBot 领域术语表

本文件只定义 KKBot 的统一领域语言。架构、API、表结构、固定时长、通道和生命周期编排以当前总规格与有效 ADR 为准。

## 人员与组织

**Employee**:
企业内部使用 KKBot、发起会话或参与审批的人员身份。
_Avoid_: 外部客户身份、泛化用户身份

**Department**:
企业组织树中的业务单元，可包含下级部门与多个 Employee。
_Avoid_: Org Unit, Team Node

**Affiliation**:
Employee 与 Department 之间的任职关系，可表达主职、兼职、职位和部门负责人身份。
_Avoid_: Membership Record, Employee Department Row

**DepartmentLeader**:
对某个 Department 承担正式负责人角色的 Employee。
_Avoid_: Manager Record, Leader Row

**ReportingLine**:
Employee 与其直接管理者之间的汇报关系。
_Avoid_: Leader Lookup, Manager Algorithm

## 会话与消息

**PrivateSession (Session)**:
KKBot 与单个 Employee 之间的一对一私聊连续会话；上下文明确时可简称 Session。
_Avoid_: 公共会话、群聊会话

**GroupSession**:
多个成员参与的群聊。群聊消息只保留为 KK Raw Store 原始事实，不形成 Agent、Memory、Tool、Approval 或 Delivery 处理链。
_Avoid_: 视为完全不进入系统、PrivateSession

**InboundMessage**:
KK 客户端已捕获并归属到某个会话的入站消息事实。
_Avoid_: 模型提示词、未归属会话的消息

**HumanTakeover**:
人工操作员接管某个 PrivateSession 并暂时停止机器人自动回复的业务状态。
_Avoid_: 自动静默计时器、会话超时

**MessageRecall**:
对既有消息的撤回事实；撤回不等同于删除其审计记录。
_Avoid_: Message Delete, History Cleanup

**ComplianceDeletion**:
经正式授权，对指定范围内的正文、附件及派生内容执行不可逆擦除的业务动作；保留不含正文的最小删除记录，不否认已发生的交付或外部副作用。
_Avoid_: MessageRecall, Transaction Rollback

## 认知与知识

**Soul**:
描述 KKBot 人设、语气和交互边界的声明式业务配置。
_Avoid_: 写死在代码中的系统提示词

**PublicKnowledge**:
所有获准使用的 Employee 共享、只读企业知识集合。
_Avoid_: PrivateMemory, Prompt Context

**KnowledgeSource**:
PublicKnowledge 中可独立更新或失效的逻辑来源；文件型来源以受管来源根下的规范化相对路径保持身份，重命名表示旧来源失效并新增来源。
_Avoid_: 内容相同即同一来源、文件系统 inode

**SourceVersion**:
KnowledgeSource 在特定源内容、转换/OCR 与规范化规则下形成的不可变知识版本；任一输入或规则变化都会产生新版本。
_Avoid_: 覆盖更新的文档行、可变当前版本

**KnowledgeGeneration**:
一次完整且不可变的 PublicKnowledge 查询快照；它把每个有效 KnowledgeSource 映射到恰好一个 SourceVersion，并包含同一代的 Chunk、词法索引与能力配置要求的向量索引。
_Avoid_: 单来源版本、可变活动索引、跨代候选集合

**PrivateMemory**:
只属于一个 Employee 与其 PrivateSession 边界的对话记忆，不能跨员工共享。
_Avoid_: 跨员工共享记忆、PublicKnowledge

**KnowledgeAvailability**:
一次 PublicKnowledge 查询的能力健康度；`available` 表示完整可用，`degraded` 表示部分能力失效但仍能安全查询，`unavailable` 表示无法安全查询。
_Avoid_: KnowledgeRetrievalOutcome, Not Found

**KnowledgeRetrievalOutcome**:
一次已安全完成的 PublicKnowledge 查询是否得到可用于 Grounding 的依据；`found` 表示存在依据，`not_found` 表示查询完成后没有依据。它不描述系统健康度，`unavailable` 也不是 `not_found`。
_Avoid_: KnowledgeAvailability, System Failure

## 资产生命周期

**ManagedAsset**:
KKBot 受管目录中的独立字节对象，使用永不复用的身份与唯一物理位置表示；原文件、OCR 中间文件、Knowledge 生成物和交付附件是不同资产。
_Avoid_: 用文件路径代替资产身份、把派生产物视为原文件

**AssetReference**:
一个明确业务 owner 对 ManagedAsset 的持久保护关系；只有 owner 的终态或替换事实已经持久化后，该关系才能释放。
_Avoid_: ref_count、目录扫描结果、隐式路径所有权

**AssetLease**:
处理器正在读取或写入 ManagedAsset 时持有的短期保护；它只证明当前 I/O 活跃，不能替代长期 AssetReference。
_Avoid_: 持久业务引用、自动续期的所有权

**AssetRetentionDeadline**:
ManagedAsset 最早允许物理删除的时间；到期不保证立即删除，任何活跃 AssetReference 或 AssetLease 都会继续阻止删除。
_Avoid_: 保证删除时间、最后访问时间

## 安全与交付

**Approval**:
针对一个高危动作的人工授权请求。业务终态只有 `approved` 或 `declined`；超时是 `declined` 的原因，不是独立终态。
_Avoid_: 第二套审批任务模型、独立超时终态

**Delivery**:
一份准备发送给 Employee 的生成结果及其交付生命周期的唯一业务身份；只有 `sent` 表示 Employee 已收到。
_Avoid_: 未发送内容的第二事实模型、发送尝试实体

## 配额

**DailyQuotaBucket**:
一个准入日期内的硬 Token 可用范围，按全局或单个 Employee 分别计算。
_Avoid_: 实时余额、跨日期总账

**RunQuotaReservation**:
一个 Agent Run 在模型调用前，以可证明最大 Token 预算同时占用全局与 Employee DailyQuotaBucket 的业务事实。
_Avoid_: 已消费 Usage、预扣款

**QuotaSettlement**:
取得整个 Agent Run 的完整权威 Usage 后，将 RunQuotaReservation 转为实际消耗并释放差额的业务事实。
_Avoid_: 估算结算、部分退款

**UnknownUsageHold**:
因整个 Agent Run 的权威 Usage 不完整而继续保留的 RunQuotaReservation；它既不表示零消耗，也不表示已经确认全部消费。
_Avoid_: 自动退款、失败即释放
