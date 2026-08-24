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

**PrivateMemory**:
只属于一个 Employee 与其 PrivateSession 边界的对话记忆，不能跨员工共享。
_Avoid_: 跨员工共享记忆、PublicKnowledge

## 安全与交付

**Approval**:
针对一个高危动作的人工授权请求。业务终态只有 `approved` 或 `declined`；超时是 `declined` 的原因，不是独立终态。
_Avoid_: 第二套审批任务模型、独立超时终态

**Delivery**:
一份准备发送给 Employee 的生成结果及其交付生命周期的唯一业务身份；只有 `sent` 表示 Employee 已收到。
_Avoid_: 未发送内容的第二事实模型、发送尝试实体
