# SPEC：Kairo 阶段一企业知识问答

> 状态：已确认
> 日期：2026-09-07
> 上游需求：[`docs/prd.md`](./prd.md) v0.3
> 范围：只定义阶段一，不包含开发计划、任务清单或代码实现

## 1. 文档目的

本 SPEC 把 PRD 中已确认的阶段一需求整理为可以实现和验证的合同。

PRD 回答“产品最终要做什么”；本 SPEC 回答“阶段一各模块必须接收什么、产生什么、遇到问题怎么办，以及怎样证明它能真实使用”。后续技术计划和开发任务必须引用本文件，不得绕过本文件直接从 PRD 猜实现。

## 2. 当前阶段

```text
需求访谈       已完成
能力地图       已确认
PRD v0.3       已确认并提交
阶段一 SPEC    已确认
技术计划       已完成并获用户确认
开发任务       已拆分并获用户确认
任务管理       GitHub Issues 已建立（#206–#240）
代码实现       尚未开始
```

## 3. 前提与已确认事实

1. 阶段一只交付企业知识问答，不处理文件、不做审批、不支持群聊。
2. 至少使用两个不同员工账号和一个 Bot 账号进行真实 IM 验证。
3. 试用员工通过 `bot.yaml` 中的员工 UID allowlist 控制。
4. `@kairo/driver`、Kairo 和 Mastra 在安装 KK9 客户端的本机、同一个 Node.js 进程运行。
5. RAGFlow 和 PostgreSQL 已部署在内网服务器。
6. Kairo 通过项目 `pnpm` 脚本手动启动。
7. 阶段一 RAGFlow 只放一个非敏感 ERP Dataset。
8. 主模型由用户在 `bot.yaml` 中配置，PRD 和 SPEC 不固定厂商或型号。
9. 业务记录默认长期保存；2 小时只表示 Agent 是否继续使用当前对话，不表示删除数据。
10. 用户提供 `SOUL.md`、`AGENTS.md` 和至少一个真实 Skill。
11. 是否进入阶段二由用户根据真实使用直接判断，不规定试用天数或正式签字流程。

## 4. 阶段一目标

员工通过 KK9 私聊 Bot，可以自然地分多条消息提出问题。Kairo 必须确认员工身份、隔离不同员工的对话、查询企业知识、依据内部资料生成回答，并把完整答案通过一条普通文本消息发送回原私聊。

阶段一成功的核心不是“接口能调用”，而是至少两名真实员工能够持续使用且不会出现以下问题：

- 一个员工看到另一个员工的上下文；
- Bot 把自己发送的消息当成员工消息；
- 同一条 IM 消息被重复处理；
- 没有企业资料时编造公司规定；
- RAGFlow 内部 ID 或来源列表被发给员工；
- `/new` 后旧任务继续影响新对话；
- 服务重启后重复发送或继续使用未确认的草稿。

## 5. 阶段一不包含

- 群聊；
- 长期个人记忆；
- 部门、员工或文档级知识权限；
- 文件读取、OCR、表格处理和文件生成；
- 企业审批；
- Web 管理后台或 Kairo 管理 CLI；
- 正式环境 Mastra Studio；
- Agent 任意执行 Skill 脚本或通用命令；专用 `knowledge-search` Tool 固定调用批准的 Python 检索脚本除外；
- Sandbox、Redis、NATS、后台消息中间件或第二套业务数据库；
- 多 Bot、员工级 Bot 个性化或配置热更新。

## 6. 技术栈与运行边界

| 部分 | 阶段一决定 |
| --- | --- |
| 语言与运行时 | TypeScript、ESM、Node.js `>=22.13.0` |
| 包管理 | pnpm workspace |
| IM | 现有 `@kairo/driver` 2.x |
| 可运行应用 | 新建 `apps/kairo` |
| Agent | Mastra；具体版本在技术计划中锁定 |
| Agent 存储 | 官方 `@mastra/pg` PostgresStore |
| 业务存储 | PostgreSQL 的 `kairo` schema |
| Mastra 存储 | PostgreSQL 的 `mastra` schema |
| 企业知识 | 内网 RAGFlow，一个非敏感 Dataset |
| RAGFlow 连接 | 定制 RAGFlow Skill + 专用 `knowledge-search` Tool + 固定 Python 脚本 + HTTP Retrieval API |
| 主模型 | `bot.yaml` 配置一个模型，不配置运行时自动切换 |
| 日志 | 结构化日志；具体应用依赖在技术计划中确定 |
| 配置校验 | 必须有结构校验；具体库在技术计划中确定 |

RAGFlow 的内部数据库不是 Kairo 数据接口。Kairo 不直接读取或修改 RAGFlow 内部表。

## 7. 实施后必须提供的命令

当前仓库只有 Driver 命令。阶段一实现完成后，`apps/kairo` 至少应提供以下可执行命令：

```bash
pnpm --filter @kairo/app dev
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
pnpm --filter @kairo/app e2e
```

根目录可增加对应快捷脚本，但不能维护两套行为不同的启动方式。阶段一默认通过 `pnpm --filter @kairo/app dev` 或等价根脚本手动启动。

Driver 现有验证命令继续保留：

```bash
pnpm --filter @kairo/driver build
pnpm --filter @kairo/driver typecheck
pnpm --filter @kairo/driver test
pnpm --filter @kairo/driver e2e
```

## 8. 项目结构

阶段一目标结构如下，具体文件名可在技术计划中微调，但模块边界不能被打散：

```text
apps/kairo/
├── package.json
├── src/
│   ├── index.ts
│   ├── config/
│   ├── mastra/
│   └── modules/
│       ├── im-transport/
│       ├── private-chat-core/
│       ├── task-lifecycle/
│       ├── agent-runtime/
│       ├── bot-customization/
│       ├── tool-integration/
│       ├── knowledge-qa/
│       └── operability/
└── tests/
    ├── unit/
    ├── integration/
    └── e2e/

config/bots/default/
├── bot.yaml
├── SOUL.md
├── AGENTS.md
└── skills/
    └── <skill-name>/
        ├── SKILL.md
        ├── references/
        ├── scripts/
        └── assets/
```

`knowledge-management` 由 RAGFlow 管理界面承担，因此阶段一不要求在 `apps/kairo` 中创建知识上传模块或页面。

## 9. 总体处理流程

```text
Driver 收到消息
  → 判断是员工消息还是 Bot 自己的消息
  → 使用 (sessionId, messageId) 检查是否已处理
  → 根据私聊会话查询员工档案
  → 检查试用员工名单
  → 识别 /new 或正在等待的用户选择
  → 检查是否含附件、消息数量和总字数
  → 等待 5 秒短暂停顿并合并消息
  → 创建并保存任务
  → 按会话排队
  → 调用 Mastra Agent
  → Agent 按需查询 RAGFlow
  → Kairo 检查企业回答是否具有内部资料
  → 使用 operationId 发送最终答案
  → 确认发送成功后写入正式 thread
```

任何步骤失败，都必须停在该步骤，不得把不完整数据继续传给后续模块。

## 10. 模块规格

### 10.1 `im-transport`

#### 责任

- 连接 KK9；
- 接收真实消息；
- 明确消息方向；
- 提供消息、会话和员工身份信息；
- 发送文本回复；
- 查询一次发送操作最终是否成功。

#### 入站消息最低要求

每条可处理消息必须具有：

- `sessionId`；
- `messageId`；
- `direction`；
- 原始文本；
- 附件元数据；
- 当前观察时间；
- 可传给 `getEmployeeBySession` 的可信会话信息。

`messageId` 不是全局唯一。Kairo 使用 `(sessionId, messageId)` 判断是否处理过。

#### 员工身份

阶段一只处理私聊。流程固定为：

1. 使用 Driver 产生的 `message.sessionId` 调用 `getEmployeeBySession`；
2. 取得 `KK9Employee`；
3. 核对 `employee.id` 与 `0-<uid>` 中的 UID 一致；
4. 将 `employee.id` 作为 Kairo 员工 ID 和 Mastra `resource`；
5. 检查该 UID 是否在试用名单中。

不能把昵称、员工发送的文字或任意数字传给 `getEmployeeBySession`。

身份失败提示按 `(botId, sessionId, noticeType)` 持久限频，固定 60 秒。从确认身份失败、准备发送提示时起算，不使用消息原始时间或入口观察时间。发送前原子占用窗口；发送失败不退还，重启不重置。提示经过统一发送协调器，沿用其同一 operationId 的重试规则。群聊、讨论组、服务号、非法私聊编号和无法识别的会话不查询员工、不发送提示。

#### Driver 新增公共合同

当前 Driver 尚未满足以下合同，完成前阶段一不能上线：

```text
MessageDirection = inbound | outbound | unknown
SendStatus      = delivered | failed | unknown
```

- `direction=inbound`：员工发给 Bot，可以继续处理；
- `direction=outbound`：Bot 自己发送的消息，直接忽略；
- `direction=unknown`：无法判断，停止处理并记录原因。

发送前由 Kairo 生成并保存 `operationId`，Driver 必须接收该 ID。同一次发送重新尝试时复用同一 ID；同一 ID 携带不同目标或内容时必须拒绝。

Driver 必须返回：

- 已经发出：具有目标会话中的有效原生消息 ID；
- 确定没发出：能够证明发送动作没有发生；
- 暂时无法确认：发送动作可能已经发生，但没有明确回执。

Driver 还必须提供只查询、不重新发送的 `getSendStatus(operationId)`。该操作与原生消息 ID 的关系需要能够跨进程重启恢复。

现有 `success`、`isPreTrigger` 和消息 ID 字段在迁移期间保留，避免破坏已有调用方。

#### 断开连接

Driver 与 KK9 断开时：

- Kairo 停止接收新任务；
- 取消尚未完成的旧任务；
- 丢弃旧任务之后产生的结果；
- 自动创建新的 Driver 连接；
- 断线期间无法回复员工；
- 恢复后只处理新收到的消息。

### 10.2 `private-chat-core`

#### 消息合并

阶段一使用两个全局配置：

| 配置 | 默认值 | 行为 |
| --- | ---: | --- |
| 短暂停顿 | 5 秒 | 每收到一条普通消息重新开始计时 |
| 最长合并时间 | 60 秒 | 从本轮第一条消息开始，不重新计时 |

任一时间先到，就把已经收到的内容组成一个任务。员工不需要发送“完成”。

#### 输入限制

- 员工单条消息受 IM 的 3,000 字限制；
- 一次最多合并 10 条消息；
- 一次合计最多 30,000 字；
- 超过限制时不截断、不调用 Agent；
- 回复“内容过长，请缩短问题；文件处理功能将在后续阶段提供”。

#### 阶段一附件行为

只要本轮包含文件、图片或其他附件，无论是否同时含文字：

- 不读取；
- 不下载；
- 不送入 RAGFlow；
- 不调用 Agent；
- 回复“当前暂不支持文件处理，请先使用文字描述需求”。

原始消息和附件元数据仍保存。

#### 会话顺序与并行

- 同一个 Bot、同一个会话一次只运行一个会改变上下文的任务；
- 不同会话可以同时运行；
- 全局默认最多同时运行 3 个 Agent 任务；
- 每个会话除当前任务外，最多排队 3 个任务；
- 超过队列上限时保留原始消息，但不创建任务，并提示稍后再试或使用 `/new`。

#### `/new`

只有去除首尾空白后整条纯文本消息等于 `/new`，并且不含附件时才触发。包含 `/new` 的普通句子不触发。

收到 `/new` 后：

1. 清空尚未形成任务的旧消息；
2. 取消旧对话中排队和正在运行的任务；
3. 丢弃尚未交给 IM 的旧答案；
4. 立即建立新的 thread；
5. `/new` 后的消息进入新 thread；
6. 已经交给 IM 的旧消息无法保证撤回，但它的方向必须是 outbound，不能再次触发 Bot。

没有未完成任务时回复“已开始新对话。”；有未完成任务时回复“已开始新对话，之前未完成的任务已取消。”

阶段一没有 `/clear` 和 `/cancel`。其他 `/xxx` 当作普通消息。

#### 近期上下文

- Mastra `resource` 使用稳定员工 ID；
- 每个当前对话使用独立 `thread`；
- 最终回复成功发送后开始计算空闲时间；
- 发送结果经过 30 秒查询仍无法确认时，从确定该结果时开始；
- 任务失败、取消或超时且没有最终回复时，从任务结束时开始；
- 默认空闲 2 小时后创建新 thread；
- 创建新 thread 不删除旧记录。

### 10.3 `task-lifecycle`

#### 责任

该模块保存 Kairo 业务任务，不代替 Mastra Workflow。它关联：

- 员工；
- Bot；
- 会话；
- context/thread；
- 原始消息；
- Agent Run；
- Tool 调用；
- 内部检索资料；
- 发送操作；
- 最终结果。

#### 阶段一任务状态

`collecting` 由 message batch 表达；非空 ready batch 才形成 queued task，不重复创建空任务。

| 内部状态 | 普通中文含义 |
| --- | --- |
| `queued` | 已形成任务，正在排队 |
| `running` | Agent 正在处理 |
| `waiting_for_user` | Bot 已提问，正在等员工选择 |
| `ready_to_send` | 答案已生成并通过检查 |
| `sending` | 正在交给 IM 发送 |
| `completed` | 已确认答案发送成功 |
| `failed` | 无法继续，已结束 |
| `cancelled` | 被 `/new` 或系统取消 |
| `timed_out` | 等待或执行超过时间 |
| `send_unconfirmed` | 30 秒后仍无法知道消息是否发出 |

`send_unconfirmed` 只是内部名字；员工不需要看到该英文词。

T19 的持久化状态出边固定如下；专用操作还必须满足当前输入版本、执行尝试及截止时间条件：

| 当前状态 | 允许的后继 |
| --- | --- |
| queued | running、cancelled、timed_out |
| running | waiting_for_user、ready_to_send、failed、cancelled、timed_out |
| waiting_for_user | running、cancelled、timed_out |
| ready_to_send | sending、cancelled、timed_out |
| sending | completed、failed、cancelled、send_unconfirmed |
| completed、failed、cancelled、timed_out、send_unconfirmed | 无，终态不可倒退 |

只读重试或重启恢复创建同一 running 任务的新 attempt，不退回 queued。迟到的 attempt 可以补记结束与错误，但只有当前版本、当前 attempt 的有效结果可以被采用。发送已触发后，不以执行期限推断发送失败。

`running → failed` 必须携带非空当前尝试标识 `expectedAttemptId`，并在同一任务行锁内与 `currentAttemptId` 匹配。被替代的旧 attempt 只能补记失败审计，不能终止新的 attempt；整任务取消和 sending 阶段的发送失败不绑定执行 attempt。

#### 时间规则

| 场景 | 时间 |
| --- | ---: |
| 排队最长等待 | 10 分钟 |
| Agent 最长执行 | 4 分钟 |
| 执行超过多久发送一次等待提示 | 10 秒 |
| 发送结果不明确时最长等待 | 30 秒 |
| 等待员工选择通用知识 | 10 分钟 |

等待员工不消耗四分钟执行预算：进入 waiting_for_user 时保存剩余执行毫秒数及十分钟绝对等待截止；同意后仍是同一任务，以“恢复时刻 + 剩余预算”设置下一段执行绝对截止。拒绝或新问题替换旧等待时为 cancelled，等待到期为 timed_out。重启本身不延长任何期限。

Agent 在 10 秒内完成时直接回复。超过 10 秒只发送一次“正在查询企业知识，请稍候”，之后只在完成、失败或取消时通知。

#### 排队提示

任务进入已有会话队列时，只发送一次：

> 已收到，将在当前任务完成后处理。

不提供预计完成时间或队列位置。

#### 临时错误

RAGFlow、模型或其他只读服务出现临时网络错误、限流或 `5xx` 时，当前外部请求最多自动重试 1 次。Agent 可以在 4 分钟内按需要多次查询知识，不限制固定查询次数。

权限拒绝、参数错误、没有知识结果或用户取消不属于临时错误，不自动重试。

#### 发送结果

- 确定发送动作没有发生：使用同一个 `operationId` 最多再发送 1 次；
- 已经发出：任务完成；
- 暂时无法确认：最多等待 30 秒，再查询一次；
- 30 秒后仍无法确认：保存发送记录、通知维护人员、继续处理后续任务，不永久卡住会话；
- 此类答案不进入后续 Agent 上下文。

T21 的协调预算单独保存在 `send_dispatches`，不提前占用 Driver 的 `send_operations.claim`。每个 task/purpose 唯一，最多占用两次发送预算、一次查询机会；预算必须在调用前保存，绝对查询截止从首次占用发送预算起计算三十秒，重启不延长。协调终态不倒退，Driver 原生送达证据与任务是否仍可采用分开保存。

用户于 T21 终端批准严格总次数：查询机会已占用但结果未保存时崩溃，恢复记为 `send_unconfirmed`，不再次查询或重发；接受实际查询尚未发生的崩溃窗口。若查询已明确失败且结果已保存，可使用同 ID 剩余重试预算。普通重复事件不能冒充恢复、接管仍在执行的发送；恢复入口仅在旧进程已停止后调用。

#### 服务重启

- 原始消息和任务在执行前保存；
- 正在合并的消息恢复剩余时间，时间已到则立即形成任务；
- 排队未超过 10 分钟的任务恢复排队；
- 正在运行的只读知识任务可以在同一任务下重新执行一次；
- 重启前后共享原来的 4 分钟结束时间；
- 已进入发送阶段的任务先查询发送状态，不能直接重发；
- 已经向员工报告失败的任务不自动重新执行；
- 修改配置后直接重启，恢复的任务使用重启后加载的当前配置。

### 10.4 `agent-runtime`

#### 责任

- 在同一 Node.js 进程中运行唯一 Mastra 实例；
- 使用 `bot.yaml` 中配置的唯一主模型；
- 组织当前任务的 Agent 输入；
- 调用允许的 Skills 和 Tools；
- 使用 thread 范围的 Observational Memory；
- 返回给员工的答案与内部资料记录；
- 不直接负责 IM 发送和任务排队。

#### 模型

- PRD 和 SPEC 不固定模型厂商或型号；
- 阶段一只配置一个主模型；
- 运行时故障不能自动切换到第二个模型；
- Observational Memory 的 Observer 和 Reflector 使用同一个主模型；
- 更换模型后重启，并重新执行知识回归问题。

#### 输出方式

IM 不支持流式回复，因此 Agent 可以在内部使用框架能力，但 Kairo 只接收完整最终结果。员工不会看到生成到一半的文本。

最终结果必须分开保存：

| 部分 | 用途 |
| --- | --- |
| 答案正文 | 唯一允许发送给员工的文字 |
| 回答类型 | 企业知识、通用知识、需要追问、无资料、资料冲突或服务错误 |
| 内部资料 | 文档、片段、页码、内部 ID 和相似度，仅内部使用 |

#### 正式聊天记录

Agent 运行中的草稿、Tool 原始结果和未通过检查的答案只能放在当前执行尝试中。

只有满足以下全部条件的最终答案才能进入 Mastra thread 和 Observational Memory：

1. 仍属于当前有效 thread；
2. 已通过企业资料检查或具有当前问题的通用知识同意；
3. 已确认通过 IM 发送成功。

失败、取消、超时、未通过检查或发送结果仍不明确的模型文字不能进入后续上下文。

#### Observational Memory

- 使用 `scope: thread`；
- 不使用跨 thread 的 resource 范围；
- 较早内容由 Mastra 压缩；
- `/new` 或空闲 2 小时创建新 thread；
- 压缩结果不能作为企业事实、员工身份或权限来源；
- 只读取正式聊天内容；
- TokenLimiter 仅作为极端超长上下文的最后保护。

### 10.5 `bot-customization`

#### 配置目录

```text
config/bots/default/
├── bot.yaml
├── SOUL.md
├── AGENTS.md
└── skills/
```

#### 文件责任

| 文件 | 责任 |
| --- | --- |
| `bot.yaml` | 模型、Dataset、员工 allowlist、启用的 Tools、Skills 和运行参数 |
| `SOUL.md` | Bot 身份、语气和表达风格 |
| `AGENTS.md` | 业务规则、工作边界和 Skill 使用提示 |
| `SKILL.md` | 具体任务方法和参考内容 |

凭证不得放入这些文件。

#### 配置顺序

1. 服务端写死的身份、知识范围、Tool 权限和数据安全规则；
2. `AGENTS.md`；
3. 当前 Skill；
4. `SOUL.md`；
5. 员工当前消息。

低层内容不能覆盖高层规则。

#### 修改方式

- 用户编写 SOUL、AGENTS 和至少一个真实 Skill；
- 技术维护人员提交到 Git；
- 修改后进行结构与引用检查；
- 直接重启生效；
- 不进行文件热更新；
- 不等待任务队列清空；
- 配置错误时 Kairo 不进入可用状态。

#### Skill

- 使用 Mastra 原生 filesystem Skills；
- 员工不能通过 `/xxx` 选择或安装 Skill；
- Mastra 根据自然语言、Skill 名称、描述和 AGENTS 提示自动选择；
- Mastra 加载 Skill 说明不等于获得脚本执行能力；Agent 默认不能运行任意 Skill 脚本，只有专用 `knowledge-search` Tool 可以固定调用批准的 Python 检索脚本；
- `/new` 是 Kairo 控制消息，不是 Skill。

### 10.6 `tool-integration`

#### 阶段一 Tool

阶段一只要求一个业务 Tool：`knowledge-search`。Mastra 加载定制 RAGFlow Skill，用于说明检索时机、最小查询组织和资料使用方式；Skill 本身不执行检索，也不决定 Dataset 或脚本权限。

Tool 的业务输入只有当前查询文本 `query`。Kairo 固定注入 ERP Dataset，并以固定程序、固定脚本和固定参数启动批准的 Python 检索入口。模型不能提供或修改：

- Dataset ID；
- 程序名、脚本路径或命令；
- `top_k`、相似度阈值、向量权重或重排模型；
- RAGFlow 凭证；
- 员工、会话或任务内部 ID。

Python 脚本通过 HTTP Retrieval API 执行唯一的检索请求。除固定 Dataset 外，当前不发送其他检索参数，使用接口默认值；不复制上游 Skill 的默认数字，不新增调参配置，也不假定会自动继承 RAGFlow 网页中的检索设置。

#### 最少发送数据

发送到 RAGFlow 的请求只包含当前查询对应的 `question` 和服务端固定的 `dataset_ids`。不发送完整 thread、历史消息、Observational Memory 摘要、员工身份或 Kairo 内部 ID。

#### Tool 输出

专用 Tool 必须先校验 Python 返回的结构化结果，并区分：

- 查询成功且有资料；
- 查询成功且有效 chunks 为空；
- 没有权限或凭证错误；
- 参数或业务错误；
- RAGFlow 暂时不可用；
- 返回数据格式错误。

只有请求成功、业务结果成功且有效 chunks 为空时才是“没有资料”。缺少 `data`/`chunks`、chunk 不是对象或字段类型错误都按格式错误处理，不能静默转换为空结果。HTTP 200 但业务 code 非零仍是失败；无法可靠分类时保留诊断信息并明确失败，不能只根据单个错误码猜测原因。

RAGFlow 返回的文字始终视为资料，不是系统命令。文档中的指令不能修改 SOUL、AGENTS、员工身份、Tool 列表、Dataset、脚本执行范围或权限。

#### 固定检索链路

阶段一正式调用链固定为：

```text
Mastra Agent 加载定制 RAGFlow Skill 的说明
  → 调用仅接收 query 的 knowledge-search
  → Kairo 注入固定 ERP Dataset 和所需执行环境
  → Tool 启动批准的 Python 检索脚本
  → Python 调用 RAGFlow HTTP Retrieval API
  → Tool 校验结构化结果并返回资料或明确错误
```

不使用 MCP、备用 endpoint、TypeScript 平行 HTTP 实现或运行时自动切换。Agent 看不到 RAGFlow 原始 Dataset/Chat tools、通用 shell 或任意脚本执行工具。T14 只完成最小临时验证、真实样本和文档同步；正式 Skill 裁剪、脚本接入、预算/取消、重试、结果校验与业务证据接入由 T27 实施。

### 10.7 `knowledge-management`

该能力由 RAGFlow 管理界面提供。

- 持有 RAGFlow 管理账号的人负责知识资料；
- Kairo 不建设知识上传页面、账号体系或 IM 入库命令；
- RAGFlow 管理人员负责知识资料、格式、Embedding、重排、解析和 RAGFlow 侧模型设置；
- Kairo 的 Retrieval API 调用暂用接口默认检索参数，不复制网页配置，也不会自动随网页设置变化；
- 阶段一只有一个非敏感 ERP Dataset；
- 普通员工不能通过 IM 发布企业知识；
- 员工附件不会自动进入企业知识库。

普通替换时，新资料准备好后再替换旧资料。管理员明确停用资料时，资料立即不可继续用于新查询。不为“更新刚好发生在几秒钟查询期间”的理论情况增加阶段一设计。

用户或 RAGFlow 管理人员维护一组真实回归问题，至少覆盖：

- 有明确企业答案；
- 没有企业答案；
- 企业知识和通用知识容易混淆；
- 资料互相冲突；
- 一个问题只有部分内容能回答。

不规定题目数量或自动准确率。最终效果由用户直接判断。

### 10.8 `knowledge-qa`

#### 默认查询规则

除非员工明确说“按通用知识回答”或“不考虑公司制度”，所有问题先查询企业 Dataset。模型不能自己决定跳过企业查询。

#### 企业知识回答

- 必须有本任务返回的内部资料；
- 员工消息只包含答案，不显示来源列表、链接、文档 ID 或片段 ID；
- Kairo 在发送前检查内部资料是否非空且属于当前任务；
- 语义是否真正正确由真实问题和人工判断验证，不能假装程序能够完全证明自然语言结论。

#### 没有企业资料

服务正常但没有找到资料时：

1. 告知员工“未找到企业资料依据”；
2. 询问是否改用通用知识；
3. 不自动给出通用答案。

#### 通用知识

- 员工必须对当前问题明确同意；
- 同意只对当前问题或当前缺失的子问题有效；
- 回答以 `【非企业资料】` 开头；
- 后续企业问题重新查询并重新判断。

Bot 等待员工回答时：

- 同一私聊只允许一个等待中的问题；
- 下一条明确的“可以”或“不用”属于该问题；
- 员工明确拒绝，或直接提出新问题时，旧任务进入 cancelled；新问题按普通流程处理；
- 最多等待 10 分钟；到期旧任务进入 timed_out；
- `/new` 立即取消等待；
- 已排队任务不能越过等待中的问题。
- 等待记录绑定 taskId、inputVersion、问题正文及当前问题/缺失子问题标识，员工回答关联原始消息的 sessionId/messageId；这些标识不是允许回复的词语列表，也不形成会话级偏好。

#### 资料冲突

有明确生效版本时使用有效资料。无法知道哪份资料有效时，不让模型自行选择，回复：

> 企业资料中存在不一致，当前无法确认，请联系知识维护人员。

内部保存冲突资料，供 RAGFlow 管理人员处理。

#### 部分回答

一个问题有多个部分时，有资料的部分正常回答；没有资料的部分明确说明。不能因为部分缺失而拒绝全部，也不能补猜缺失内容。

#### 服务不可用

- RAGFlow 不可用但主模型可用：说明企业知识服务不可用，并询问是否改用通用知识；
- 主模型不可用：直接提示稍后重试；
- 已知服务离线时，新问题不进入队列；
- 故障前已排队任务最多继续等待原有 10 分钟。

#### 员工反馈

员工指出回答错误时：

- 保存原问题、答案、内部资料和反馈；
- 可以追问哪里不对，但员工可以跳过；
- 员工提供的“正确答案”不能立刻成为企业知识；
- 不写入长期记忆或 Observational Memory；
- 由 RAGFlow 管理人员更新资料后才正式生效。

### 10.9 `operability`

#### 日志

普通日志不记录：

- 员工问题正文；
- Bot 回答正文；
- 知识片段正文；
- 密码、API Key 或其他凭证；
- 文件正文。

普通日志记录：

- messageId、sessionId、employeeId；
- contextId、taskId、runId；
- Tool 名称、调用次数、耗时和结果；
- 内部资料 ID；
- 状态变化和错误类型。

完整消息、回答、任务、内部检索资料和 thread observations 保存在 PostgreSQL，默认长期保留，不自动删除。长期保存不表示全部内容进入模型。

企业 IT 管理员可以使用 PostgreSQL 现有管理工具查看业务记录。阶段一不建设 Kairo 管理 UI、管理 CLI 或专门访问审计系统。

#### 运行状态

| 状态 | 含义 |
| --- | --- |
| 未就绪 | 配置、PostgreSQL、Mastra 或 Driver 不可用，不能处理任务 |
| 降级 | Kairo 可运行，但 RAGFlow 或主模型暂时不可用 |
| 正常 | 阶段一依赖均可用 |

PostgreSQL 不可用但 Driver 仍收到消息时，直接提示“系统存储暂时不可用，请稍后重新发送”，不创建任务。恢复后只处理新消息。

RAGFlow 或模型恢复后，已经向员工报告失败的任务不自动重新执行。只有故障前已排队且未超过 10 分钟的任务可以继续。

### 10.10 `mastra-runtime-bootstrap`

该项是 `agent-runtime` 的阶段一搭建工作，不是新的产品模块。

必须完成：

- 在 `apps/kairo` 中创建唯一 Mastra 实例；
- 注入 PostgreSQL PostgresStore；
- 注册唯一阶段一 Agent；
- 加载 SOUL、AGENTS、用户提供的 Skill 和 `knowledge-search`；
- Kairo 通过进程内接口调用 Mastra；
- 提供本机健康检查；
- 正确关闭 Mastra、数据库连接和 Driver；
- 正式环境不启用 Studio；
- 开发 Studio 使用独立开发数据库和测试 Dataset；
- 不开放可绕过 Kairo 的原生 Agent、Tool 或 Workflow 执行入口。

## 11. 需要持久保存的业务记录

以下是逻辑记录，不是最终数据库表设计：

| 记录 | 最少内容 |
| --- | --- |
| 原始消息 | sessionId、messageId、员工、文本、附件元数据、收到时间、方向 |
| 当前对话 | employeeId、threadId、开始时间、最后活动时间、是否有效 |
| 任务 | taskId、员工、会话、thread、输入、状态、时间限制、配置版本 |
| 执行尝试 | attemptId、runId、开始/结束时间、结果和错误 |
| 发送操作 | operationId、目标会话、内容摘要、发送状态、原生消息 ID |
| 内部资料 | taskId、查询、文档/片段信息、原始 Tool 结果引用 |
| 员工反馈 | taskId、反馈文字、时间和处理状态 |

`(sessionId, messageId)` 必须具有数据库唯一约束，不能使用“先查询再插入”的方式防重复。

## 12. 失败行为表

| 场景 | 员工看到什么 | 系统行为 |
| --- | --- | --- |
| 员工不在试用名单 | 当前功能仍在试用，暂未向你开放 | 不创建 Agent 任务 |
| 私聊员工身份查询失败 | 暂时无法确认您的员工身份，请稍后重试或联系维护人员 | 停止处理并限制提示频率 |
| 非私聊消息 | 无回复 | 只记录必要诊断 |
| Bot 自己的消息 | 无回复 | 直接忽略 |
| 输入超过 10 条或 30,000 字 | 内容过长，请缩短问题 | 不截断、不调用 Agent |
| 包含附件 | 当前暂不支持文件处理，请先使用文字描述需求 | 不读取附件、不调用 Agent |
| 会话队列已满 | 请稍后再试，或使用 `/new` | 保留原始消息，不创建任务 |
| 排队超过 10 分钟 | 该请求等待时间过长，已取消，请重新发送 | 取消任务 |
| 执行超过 4 分钟 | 本次查询超时，请稍后重试 | 停止任务并丢弃迟到结果 |
| RAGFlow 无资料 | 未找到企业资料依据，是否改用通用知识 | 等待员工回答 |
| RAGFlow 不可用 | 企业知识服务暂时不可用，可选择通用知识 | 不冒充无资料 |
| 主模型不可用 | 服务暂时不可用，请稍后重试 | 不创建新的执行任务 |
| PostgreSQL 不可用 | 系统存储暂时不可用，请稍后重新发送 | 不创建任务 |
| 发送结果无法确认 | 通常无额外消息 | 30 秒后查询一次，仍不明确则记录并继续队列 |
| 配置错误 | 无法启动服务 | 不进入可用状态 |

## 13. 代码风格合同

阶段一代码保持简单、单一职责，模块之间使用明确类型，不传递无结构对象。

推荐使用可区分状态的类型，而不是多个互相矛盾的布尔值：

```ts
type SendOutcome =
  | { status: 'delivered'; operationId: string; messageId: string }
  | { status: 'failed'; operationId: string; reason: string }
  | { status: 'unknown'; operationId: string; reason: string };
```

约束：

- 函数只完成一个动作；
- 缩进不超过三层；
- 外部输入在模块边界检查；
- 内部代码使用已检查类型；
- 不创建巨型 Utils 包；
- 注释只解释不明显的原因；
- 日志使用结构化字段，不拼接正文；
- 不在 SOUL、AGENTS、Skill 或 Prompt 中实现本应由代码执行的权限规则。

## 14. 测试策略

测试必须从本 SPEC 的可见行为出发，而不是只验证内部函数。

### 14.1 单元测试

至少覆盖：

- 5 秒与 60 秒消息合并；
- 10 条与 30,000 字输入边界；
- `/new` 精确匹配与普通句子不误触；
- `/new` 清空消息、任务和等待中的问题；
- 同会话顺序与每会话 3 个排队上限；
- 10 分钟排队和 4 分钟执行时间；
- 等待通用知识选择及 10 分钟结束；
- 企业、通用、无资料、冲突和部分回答；
- RAGFlow 返回格式错误；
- 发送三种结果；
- 取消、超时和未通过检查的草稿不进入正式上下文；
- `(sessionId, messageId)` 数据库唯一约束。

### 14.2 集成测试

至少覆盖：

- Kairo 与 PostgreSQL `kairo` schema；
- Mastra 与 PostgreSQL `mastra` schema；
- thread 范围 Observational Memory；
- 配置文件加载和错误配置拒绝启动；
- 用户提供的 Skill 可被 Mastra 发现和选择；
- `knowledge-search` 固定 Dataset；
- 定制 Skill → 专用 `knowledge-search` → 固定 Python 脚本 → HTTP Retrieval API 的成功、无结果和错误；
- 服务重启后恢复正在合并、排队和运行中的任务；
- Driver operationId 查询发送结果；
- PostgreSQL、RAGFlow、模型和 Driver 的故障行为。

### 14.3 真实 IM 测试

FakeDriver 不能作为阶段一最终证明。真实测试至少覆盖：

1. 两个不同员工同时私聊 Bot；
2. `getEmployeeBySession` 返回各自稳定 UID；
3. 两个员工的上下文、任务和回复不串用；
4. 员工分三条消息提出一个问题；
5. Agent 运行时员工继续发送消息；
6. `/new` 取消旧任务并开启新对话；
7. Bot 自己的发送回显不会重新触发 Agent；
8. 重复上报同一消息只处理一次；
9. 企业答案、无资料、通用知识、冲突和部分回答；
10. RAGFlow 与模型不可用；
11. Bot 发送成功、确定未发送和无法确认；
12. Kairo 重启后的恢复；
13. Driver 断开并重新连接；
14. 一个真实用户提供的 Skill 被自然语言触发。

### 14.4 回归问题

用户或 RAGFlow 管理人员提供真实问题。资料、主模型、Embedding、重排或检索设置变化后重新执行。系统记录问题、回答和内部资料，结果由用户直接判断。

## 15. 始终遵守、先确认、禁止事项

### 始终遵守

- 先保存原始消息和任务，再调用 Agent；
- 员工身份来自 Driver 员工档案，不来自消息正文；
- 企业答案必须有当前任务的内部资料；
- 发送操作在调用 Driver 前先保存 operationId；
- 外部服务返回值先检查；
- 不同员工的数据在查询和写入时都带员工 ID；
- 所有重要状态变化可通过 taskId 查询。

### 实施前先确认

- 新增 PRD 未批准的产品行为；
- 增加第二个 Dataset；
- 更换 PostgreSQL、Mastra 或 RAGFlow；
- 增加新的模型供应商；
- 增加消息中间件、Redis 或后台队列；
- 正式环境开启 Studio；
- 允许 Agent 任意执行 Skill 脚本、选择程序或拼接命令；专用 Tool 固定调用批准的检索脚本必须遵守既定合同；
- 创建管理 UI 或 CLI。

### 禁止事项

- 相信员工消息中声明的身份；
- 把 Bot 自己的消息交给 Agent；
- 把附件当作已经读取；
- 没有企业资料时编造公司规定；
- 把 RAGFlow 内部 ID、来源列表或链接发给员工；
- 把未发送、被取消或未通过检查的模型草稿写入正式上下文；
- 在运行时自动切换主模型；
- 为阶段一知识接入增加 MCP、备用 endpoint、TypeScript 平行 HTTP 实现或运行时自动切换；
- 把凭证写入 Git、Prompt、SOUL、AGENTS、Skill、Memory 或普通日志；
- 直接读取 RAGFlow 内部数据库；
- 为阶段二或阶段三提前建设通用平台。

## 16. 阶段一完成条件

阶段一可以交给用户真实试用前，必须同时满足：

1. Driver 新消息方向与发送查询合同已实现并通过真实测试；
2. `apps/kairo` 可以通过 pnpm 手动启动；
3. 配置、PostgreSQL、Driver 和 Mastra 正常时服务进入正常状态；
4. 两名 allowlist 员工可以独立连续对话；
5. 分段消息、排队、`/new`、时间限制和重启行为符合本 SPEC；
6. RAGFlow 正式环境只启用“定制 Skill + 专用 Tool + 固定 Python 脚本 + HTTP Retrieval API”一条知识链路；
7. 企业回答具有内部资料且员工看不到来源和内部 ID；
8. 无资料、通用知识、冲突、部分回答和服务故障行为正确；
9. 只有确认发送成功的答案进入正式 thread 和 Observational Memory；
10. 用户提供的 SOUL、AGENTS 和至少一个真实 Skill 已加载；
11. 单元、集成和真实 IM 场景均有通过证据；
12. 用户根据真实使用认为可以继续进入阶段二。

## 17. 仍需通过实现或联调确认

以下不是未澄清的产品需求，而是技术前置工作：

1. Driver 如何可靠产生 `direction`；
2. Driver 如何保存 operationId 并实现跨重启的 `getSendStatus`；
3. Mastra 是否原生支持“检查通过并发送成功后再写入正式 thread”；若不支持，Kairo 需要在调用边界暂存本次消息；
4. Observational Memory 与 PostgreSQL 的实际表初始化和清理行为；
5. T14 已在 2026-09-07 用临时链路验证锁定 Mastra 加载 Skill、专用 Tool 调用 Python 检索 ERP、自动超时与取消后的恢复；真实模型检索策略、正式四分钟预算与重试等仍归 T27 及后续验收。ERP DOCX 的原始 positions 不能推定 Word 物理页码，证据见 `docs/DEVELOPMENT.md`；
6. RAGFlow API Key 是否能限制权限；阶段一实例只有一个非敏感 Dataset，因此不能为了权限再造一套系统；
7. 用户最终提供的主模型配置、SOUL、AGENTS、Skill 和试用员工 UID；
8. 内网 PostgreSQL 与 RAGFlow 的实际连接地址、证书和凭证；
9. `@kairo/app` 的最终依赖版本、构建脚本和数据库迁移工具。

这些项目应在后续技术计划中拆成可验证任务。任何一项真实结果与本 SPEC 冲突时，先更新 PRD/SPEC，再进入实现。
