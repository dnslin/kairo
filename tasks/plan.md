# Kairo 阶段一企业知识问答技术实施计划

> 状态：阶段一初始规划快照；当前进度以 GitHub Issues 为准，T15 本次实施见第 15 节
> 日期：2026-09-03
> 需求来源：[`docs/prd.md`](../docs/prd.md)、[`docs/SPEC-stage-1.md`](../docs/SPEC-stage-1.md)
> 任务定义快照：[`tasks/todo.md`](./todo.md)
> 任务追踪：[`GitHub Issues`](https://github.com/dnslin/kairo/issues)（唯一任务状态与依赖来源）；[`Stage 1 - 企业知识问答`](https://github.com/dnslin/kairo/milestone/5)（里程碑 #5）

## 1. 目标与范围

阶段一交付一个可由少量真实员工使用的企业知识问答闭环：

```text
员工私聊
  → Driver 确认消息方向
  → Kairo 持久化原始消息并确认员工身份
  → 合并分段消息并按会话排队
  → Mastra Agent 查询固定 RAGFlow Dataset
  → Kairo 检查企业证据
  → Driver 可靠发送完整答案
  → 确认送达后写入 Mastra thread 与 Observational Memory
```

本计划只覆盖：

- `@kairo/driver` 阶段一所需的 `direction`、`operationId`、发送三态和 `getSendStatus()`；
- 新建 `apps/kairo`，在一个 Node.js 进程内装配 Driver、Kairo 与 Mastra；
- PostgreSQL 的 `kairo`、`mastra` schema；
- 单 Bot 配置、SOUL、AGENTS 和用户提供的真实 Skill；
- 私聊身份、去重、消息合并、近期上下文、`/new`；
- 持久任务、同会话队列、全局并发、超时、重启恢复和发送状态；
- RAGFlow MCP-first 联调，最终只保留 MCP 或 HTTP 一种连接；
- 企业知识、通用知识一次性确认、证据检查、冲突、部分回答和反馈；
- 日志、运行状态、单元测试、集成测试和双员工真实 IM 验收。

明确不包含：文件读取或生成、OCR、审批、群聊、长期个人记忆、细粒度知识 ACL、管理后台、管理 CLI、Skill 脚本执行、Sandbox、Redis、NATS、消息中间件、第二套业务数据库、多 Bot 或配置热更新。

## 2. 当前仓库事实

- workspace 当前只包含 `packages/driver`：`pnpm-workspace.yaml:1-5`。
- 根脚本当前只构建和测试 Driver：`package.json:10-20`。
- 根规则仍写着“本仓库只保留 `@kairo/driver`”：`AGENTS.md:5-11`；但 Driver 只负责 CDP、桥接、消息规范化和 I/O 的边界必须保留：`AGENTS.md:13-18`。
- `KK9Message` 当前没有 `direction`：`packages/driver/src/types/index.ts:169-203`。
- `SendResult`、`SendOptions` 当前没有 `status`、`operationId`：`packages/driver/src/types/index.ts:300-347`。
- `IKK9Driver` 当前没有 `getSendStatus()`：`packages/driver/src/types/index.ts:361-410`。
- 消息来源当前由 `isMe + origin` 推断，且未识别 `isFromSelf`：`packages/driver/src/bridge/converter.ts:117-189`、`packages/driver/src/bridge/converter.ts:320-328`。
- Bot 发送消息 ID 和轮询去重只保存在内存：`packages/driver/src/driver.ts:200-227`、`packages/driver/src/driver.ts:616-635`。
- `getEmployeeBySession()` 已存在，但阶段一仍需由 Kairo 限定可信输入并核对 UID：`packages/driver/src/driver.ts:482-530`。
- 现有真实 E2E 只覆盖既有 outbound 成功路径，尚未覆盖阶段一新增合同。
- 当前没有 `apps/kairo`、Mastra、PostgreSQL 业务访问层、迁移、Bot 配置目录或应用级测试。

## 3. 第一性推导

### 3.1 需要放弃的默认假设

1. **不能先完成所有数据库、Agent 和 Tool，再在最后串联。** Driver 发送三态、Mastra Memory 写入时机和 RAGFlow 连接方式都可能改变整体设计，必须先验证。
2. **不能把发送失败统一重试。** 发送动作触发后回执丢失时，重试可能产生重复消息。
3. **不能直接使用 Mastra 默认 Memory 写入。** 默认 Agent 调用会在 IM 确认送达前保存本轮消息，与 SPEC 冲突。
4. **不能把 MCP“连通”当作通过。** 固定 Dataset、鉴权、错误分类、超时和重连都是独立条件。
5. **不能用进程内 Map、计时器或队列作为业务事实。** 它们在重启后消失，只能作为 PostgreSQL 状态的执行器。

### 3.2 不可再分的事实

- 原始消息、任务、发送意图必须先持久化，才能防重复并恢复。
- 员工身份只能来自可信私聊会话和 Driver 员工档案。
- 同一会话必须串行，不同会话可并行；阶段一全局并发只有 3，不需要外部队列。
- 企业答案必须关联当前任务的内部资料，员工只收到答案正文。
- IM 发送只有 `delivered`、`failed`、`unknown` 三种事实；`unknown` 不能被推断为失败。
- 只有确认送达的正式内容可以进入当前 Mastra thread。
- 真实 IM、真实员工、真实 PostgreSQL、真实 RAGFlow 和真实模型不能由 Mock 证明。

### 3.3 重建后的实施顺序

1. 建立可重复运行的 workspace 和命令。
2. 前置四个高风险门禁：Driver、PostgreSQL/Mastra Memory、Mastra 生产路由、RAGFlow MCP。
3. 建立配置、日志和最小业务账本。
4. 完成私聊消息到可靠排队通知的纵向闭环。
5. 接入唯一知识连接器、Agent、证据检查与 Memory 提交。
6. 通过跨进程恢复、故障矩阵和双员工真实 IM 验收。

传统的按组件堆砌会把真实接口风险留到最后。本计划先验证不可逆边界，再扩展纵向行为，因此能更早停止错误方向。

## 4. 推荐架构

### 4.1 运行形态

- `@kairo/driver`、Kairo 业务层和唯一 Mastra 实例运行在安装 KK9 的同一个 Node.js 进程。
- Kairo 通过进程内接口调用 Driver 和 Mastra，不在三者之间增加 HTTP、stdio 或消息中间件。
- 生产只开放 Kairo 的 localhost 健康接口，不注册可绕过 Kairo 的 Mastra Agent、Tool 或 Workflow 执行路由。
- 开发 Studio 使用独立开发数据库、测试员工和测试 Dataset，不连接正式数据。

### 4.2 Driver 合同

新增并保持向后兼容：

```ts
type MessageDirection = 'inbound' | 'outbound' | 'unknown';
type SendStatus = 'delivered' | 'failed' | 'unknown';
```

- `direction` 基于事实：明确自身为 `outbound`，明确外部员工为 `inbound`，证据不足为 `unknown`。
- 迁移期保留 `origin`、`success`、`isPreTrigger`、`messageId`、`recordBotSentMessageId()` 和 `isBotSentMessageId()`。
- Driver 定义可注入的 `SendOperationStore`，但不直接依赖 PostgreSQL或业务任务。
- `apps/kairo` 使用 `kairo.send_operations` 实现 Store。
- 同一 `operationId` 复用同一发送意图；目标、类型或内容摘要不同则在触发前拒绝。
- `getSendStatus(operationId)` 只查询，不发送。

### 4.3 PostgreSQL 与迁移

- Kairo 和 Mastra 共用一个 PostgreSQL 实例和连接池，分别使用 `kairo`、`mastra` schema。
- Kairo 使用 `pg`，不引入 ORM。
- 使用 `node-pg-migrate` 的 SQL loader、迁移锁和 migrations table 执行前向 SQL 迁移。
- 部署账号显式执行迁移；运行账号无 DDL 权限。
- Mastra 使用 `schemaName: 'mastra'`、`disableInit: true`。
- Mastra DDL 必须与锁定版本的 `exportSchemas('mastra')` 输出核对。

### 4.4 Mastra Agent、Skill 与近期上下文

- 锁定已核验的兼容版本线：
  - `@mastra/core@1.63.2`
  - `@mastra/memory@1.28.1`
  - `@mastra/pg@1.22.2`
  - `mastra@1.27.2`
  - 只有 MCP 最终通过时保留 `@mastra/mcp@1.17.2`
- Agent 使用完整非流式 `generate()`、业务 attempt 的 `runId`、任务 `AbortSignal`。
- `resource=employeeId`，`thread=contextId`；thread ID 全局唯一。
- Observational Memory 显式使用 `scope: 'thread'`，Observer 与 Reflector 使用同一个批准主模型。
- filesystem Skills 直接挂到 Agent；不创建通用 Skill 引擎、Workspace 或 Sandbox。
- 生产流程先真实验证：

```text
Agent.generate(memory.options.readOnly=true)
  → Kairo 检查答案
  → IM 确认 delivered
  → memory.saveMessages(仅正式 user/assistant 消息)
  → omEngine.observe(thread scope)
```

取消、失败、超时、证据检查失败或发送结果不明的模型文本不得进入正式 Memory。

### 4.5 RAGFlow 单连接器

- 先对 RAGFlow v0.27.1 做 MCP-first 真实门禁。
- 门禁同时验证固定 Dataset、入站鉴权、字段与 positions、超时、重连、错误分类、SSE fallback 和维护复杂度。
- 只有全部满足才保留 MCP；否则实现 HTTP `POST /api/v1/retrieval`。
- 联调结束删除未选方案、依赖和运行时切换，不允许自动 fallback。
- Agent 只看到 `knowledge-search({ query })`；Dataset、凭证和检索参数不暴露给模型。
- 发送到 RAGFlow 的内容只包含当前检索所需的最小查询文本。

### 4.6 任务调度与恢复

- PostgreSQL 是任务事实来源；进程内 scheduler 只领取和执行。
- 同一会话最多 1 个 `running` 和 3 个 `queued`；全局默认最多 3 个 `running`。
- collecting、queued、running、sending、Memory commit 都保存绝对截止时间或恢复状态。
- 重启不使用普通 Agent Run resume 或 Durable Agent；同一业务 task 最多新增一次只读 attempt，并共享原 4 分钟截止时间。
- `/new` 立即使旧 context 失效；迟到结果在交付前再次检查 context 版本。

### 4.7 PostgreSQL 完全不可用时的固定提示

正常发送必须先持久化 `operationId`。但 PostgreSQL 完全不可用时无法同时满足“先持久化”和“立即提示存储不可用”。根据用户反馈，该情况几乎不会出现，计划采用最小例外：

- 只允许固定“系统存储暂时不可用，请稍后重新发送”提示尽力发送；
- operationId 由 `sessionId + messageId + purpose` 确定生成，仅做当前进程防重；
- 不创建任务、不引入本地数据库、不在重启后补发；
- 极少数重复或结果未知作为已知降级风险记录。

## 5. 需要持久化的业务记录

| 记录 | 关键内容 |
|---|---|
| `raw_messages` | session/message 唯一键、方向、员工、正文、附件元数据、观察时间 |
| `message_batches` / `batch_messages` | 聚合消息、静默截止时间、最长截止时间、处理结果 |
| `contexts` | employee、bot、session、thread、有效版本、空闲起点 |
| `tasks` | 输入版本、状态、队列/执行截止时间、配置摘要、最终结果 |
| `task_attempts` | runId、开始/结束时间、错误类别、是否采用 |
| `user_waits` | 通用知识确认、10 分钟截止时间、当前状态 |
| `send_operations` | operationId、目标、类型、内容摘要、native key、三态、原生 ID |
| `knowledge_calls` / `knowledge_evidence` | query、结果类别、文档/片段/页码/positions/内部 ID |
| `memory_commits` | 正式消息确定性 ID、pending/saved/observed |
| `feedback` | task、员工反馈、处理状态；不作为企业事实 |
| `notice_limits` | 身份失败等固定提示的限频状态 |
| `runtime_boots` | Git commit、配置摘要、启动和关闭状态 |

`collecting` 由持久化 message batch 表达；队列已满时保留原始消息，但不创建业务 task。

## 6. 依赖图与检查点

```text
T01-T03 工作区与依赖
  ├─ T04-T09 Driver 合同与真机门禁
  ├─ T10-T13 PostgreSQL / Mastra 门禁
  └─ T14 RAGFlow MCP-first 门禁
             │
        Checkpoint A
             │
       T15-T20 配置、日志、业务账本
             │
        Checkpoint B
             │
       T21-T26 私聊、发送、队列、/new、恢复
             │
        Checkpoint C
             │
       T27-T32 知识、Agent、证据、Memory
             │
        Checkpoint D
             │
       T33-T35 装配、跨进程、双员工真实验收
```

### Checkpoint A：高风险合同

- Driver 真机 direction、回显、三态和 operationId 通过。
- PostgreSQL 迁移账号与运行账号隔离通过。
- Mastra delayed-memory 和生产路由隔离通过。
- RAGFlow 已确定唯一连接方式。
- 任一真实结果与 SPEC 冲突时停止，不用实现技巧掩盖。

### Checkpoint B：业务事实

- 配置错误阻止 ready。
- 运行启动不做 DDL。
- 消息、任务、发送、证据和 Memory commit 均有唯一约束或条件更新保护。
- 普通日志不含员工正文、答案、知识片段或凭证。

### Checkpoint C：私聊任务闭环

- direction、身份、allowlist、去重均由确定性代码完成。
- 聚合、输入拒绝、`/new`、队列、进度、超时和恢复通过。
- 所有通知经过统一发送协调器。
- 重启和 Driver generation 失效不会交付迟到结果。

### Checkpoint D：知识与 Memory

- 正式代码只有一个 RAGFlow 连接器。
- 企业、通用、无资料、冲突、部分回答和故障行为通过。
- 员工回复不含内部来源。
- 只有 delivered 的正式内容进入 thread/Observational Memory。
- 两个员工的 resource、thread、任务和回答隔离。

## 7. 任务索引

任务执行、状态、依赖和验收证据统一由 [`GitHub Issues`](https://github.com/dnslin/kairo/issues) 管理，全部任务归入 [`Stage 1 - 企业知识问答`](https://github.com/dnslin/kairo/milestone/5) 里程碑。issue 保持 open 表示未完成，完成全部验收后关闭；前置关系使用 GitHub 原生 `blocked by`。

- **阶段 A：基础与高风险门禁**
  - [`T01` #206](https://github.com/dnslin/kairo/issues/206) 建立 `@kairo/app` 最小工作区
  - [`T02` #207](https://github.com/dnslin/kairo/issues/207) 扩展仓库规则与根质量命令
  - [`T03` #208](https://github.com/dnslin/kairo/issues/208) 锁定依赖并验证干净检出启动
  - [`T04` #209](https://github.com/dnslin/kairo/issues/209) 增加 Driver `direction` 公共合同
  - [`T05` #210](https://github.com/dnslin/kairo/issues/210) 定义 Driver 发送意图与 Store port
  - [`T06` #211](https://github.com/dnslin/kairo/issues/211) 接通文本类 Bridge 发送三态与只读查询
  - [`T07` #212](https://github.com/dnslin/kairo/issues/212) 补齐图片、DOM 与 FakeDriver 兼容合同
  - [`T08` #213](https://github.com/dnslin/kairo/issues/213) 删除 Driver 正文日志
  - [`T09` #214](https://github.com/dnslin/kairo/issues/214) Driver 阶段一真实合同 E2E
  - [`T10` #215](https://github.com/dnslin/kairo/issues/215) 建立 PostgreSQL 迁移与 SendOperationStore
  - [`T11` #216](https://github.com/dnslin/kairo/issues/216) 建立 Mastra schema 与运行账号门禁
  - [`T12` #217](https://github.com/dnslin/kairo/issues/217) 验证 Mastra delayed-memory 合同
  - [`T13` #218](https://github.com/dnslin/kairo/issues/218) 验证 Mastra 生产路由与 Studio 隔离
  - [`T14` #219](https://github.com/dnslin/kairo/issues/219) 执行 RAGFlow MCP-first 真实门禁
- **阶段 B：配置、日志与业务账本**
  - [`T15` #220](https://github.com/dnslin/kairo/issues/220) 加载并校验受控 Bot 配置
  - [`T16` #221](https://github.com/dnslin/kairo/issues/221) 组合 SOUL、规则与用户真实 Skill
  - [`T17` #222](https://github.com/dnslin/kairo/issues/222) 统一日志、错误与 localhost 健康接口
  - [`T18` #223](https://github.com/dnslin/kairo/issues/223) 持久化原始消息、聚合批次、context 与提示限频
  - [`T19` #224](https://github.com/dnslin/kairo/issues/224) 持久化任务、attempt 与等待员工状态
  - [`T20` #225](https://github.com/dnslin/kairo/issues/225) 持久化知识证据、Memory commit、反馈与启动记录
- **阶段 C：私聊、发送、队列与恢复**
  - [`T21` #226](https://github.com/dnslin/kairo/issues/226) 实现统一出站发送协调器
  - [`T22` #227](https://github.com/dnslin/kairo/issues/227) 实现 direction、员工身份、allowlist 与持久去重
  - [`T23` #228](https://github.com/dnslin/kairo/issues/228) 实现 5秒/60秒消息合并与阶段一输入拒绝
  - [`T24` #229](https://github.com/dnslin/kairo/issues/229) 实现 `/new` 与 2 小时 context 边界
  - [`T25` #230](https://github.com/dnslin/kairo/issues/230) 实现同会话队列、全局并发与时间通知
  - [`T26` #231](https://github.com/dnslin/kairo/issues/231) 实现启动恢复与 Driver 重连监督
- **阶段 D：知识问答、Agent 与正式 Memory**
  - [`T27` #232](https://github.com/dnslin/kairo/issues/232) 实现最终选定的唯一 RAGFlow 连接器与知识 Tool
  - [`T28` #233](https://github.com/dnslin/kairo/issues/233) 装配唯一 Mastra Agent
  - [`T29` #234](https://github.com/dnslin/kairo/issues/234) 实现企业答案证据检查与首个完整回答闭环
  - [`T30` #235](https://github.com/dnslin/kairo/issues/235) 实现无资料与通用知识一次性确认
  - [`T31` #236](https://github.com/dnslin/kairo/issues/236) 实现资料冲突、部分回答与负反馈
  - [`T32` #237](https://github.com/dnslin/kairo/issues/237) 实现 delivered 后正式 Memory 提交与恢复
- **阶段 E：单进程装配、跨进程测试与真实放行**
  - [`T33` #238](https://github.com/dnslin/kairo/issues/238) 完成 Composition Root 与依赖状态管理
  - [`T34` #239](https://github.com/dnslin/kairo/issues/239) 执行跨进程恢复与故障矩阵 E2E
  - [`T35` #240](https://github.com/dnslin/kairo/issues/240) 执行双员工真实 IM 与知识回归放行

任务定义、验收条件、测试命令和真实环境要求仍保留在 [`tasks/todo.md`](./todo.md)；该文件不维护执行状态。

## 8. 实施后命令合同

应用至少提供：

```bash
pnpm --filter @kairo/app dev
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
pnpm --filter @kairo/app e2e
```

另外按测试层提供明确脚本，例如：

```bash
pnpm --filter @kairo/app test:unit
pnpm --filter @kairo/app test:integration
pnpm --filter @kairo/app e2e:process
pnpm --filter @kairo/app e2e:failures
pnpm --filter @kairo/app ragflow:mcp-gate
pnpm --filter @kairo/app db:migrate
```

Driver 继续保留：

```bash
pnpm --filter @kairo/driver build
pnpm --filter @kairo/driver typecheck
pnpm --filter @kairo/driver test
pnpm --filter @kairo/driver e2e
pnpm --filter @kairo/driver e2e:stage1
```

默认 `test` 不得触发真实 IM 副作用；真实 E2E 必须要求显式账号、会话、Dataset 和副作用确认变量。

## 9. 测试与真实验证矩阵

| 需求 | 任务 | 验证层 |
|---|---|---|
| Driver direction 与回显 | T04、T09 | 单元 + 真机 |
| operationId、三态、状态查询 | T05-T07、T10、T21、T34 | 单元 + PostgreSQL + 跨进程 + 真机 |
| `kairo` / `mastra` schema | T10-T12 | 真实 PostgreSQL 集成 |
| SOUL、AGENTS、真实 Skill | T15-T16、T28、T35 | 配置 + Mastra 集成 + 真机 |
| `(sessionId,messageId)` 唯一约束 | T18、T22 | 并发数据库集成 |
| 5秒/60秒、10条/30000字、附件拒绝 | T23 | fake timers + 恢复 + 真机 |
| `/new`、2小时 context | T24、T26、T32 | 单元 + 集成 + 真机 |
| 同会话顺序、并发3、队列3 | T25、T35 | 调度集成 + 双员工 |
| 10分钟排队、4分钟执行、10秒进度 | T25-T26 | fake timers + 重启 |
| RAGFlow MCP-first 与单连接器 | T14、T27 | 真实 RAGFlow + connector 集成 |
| 企业证据与来源隔离 | T29 | 单元 + 纵向集成 + 真机 |
| 通用知识一次性确认 | T30 | 状态测试 + 真机 |
| 冲突、部分回答、反馈 | T31 | 回归资料 + 人工判断 |
| delivered-only Memory | T12、T32、T34 | Mastra/PostgreSQL + 崩溃恢复 |
| 未就绪/降级/正常与日志隐私 | T08、T17、T33 | 单元 + 故障注入 + 本机端口 |
| 双员工隔离 | T22、T32、T35 | 集成 + 真实 IM |

自动化测试必须覆盖正常路径、边界、错误和状态变化。Mock 只验证逻辑，不作为阶段放行依据。

## 10. 真实环境输入与放行

真实门禁需要：

- 1 个 Bot 账号、2 个 allowlist 员工账号及各自私聊；
- Windows KK9，CDP 只绑定 `127.0.0.1`；
- PostgreSQL 迁移账号、运行账号和独立测试库；
- RAGFlow v0.27.1 URL、只读服务凭证、一个非敏感 Dataset；
- 最终批准的主模型 ID 与凭证；
- 用户真实 `SOUL.md`、`AGENTS.md` 和至少一个 Skill；
- 有明确答案、无答案、企业/通用歧义、资料冲突、部分命中的真实问题。

缺少真实输入时可以完成离线实现，但对应门禁不得标记通过。阶段一最终是否进入阶段二，只由用户根据真实 IM 使用结果判断。

## 11. 风险与处理

| 风险 | 处理 |
|---|---|
| 真实 direction 字段不足 | `unknown` fail closed；T09 用真实 payload 决定能否放行 |
| Driver 跨重启发送状态与纯 I/O 边界冲突 | Driver 只定义 Store port；PostgreSQL adapter 位于 `apps/kairo` |
| Mastra readOnly 跳过 OM 生命周期 | T12 前置验证 `saveMessages + explicit observe`；失败即停止 |
| 默认 Mastra Server 暴露执行路由 | T13 验证进程内 runtime + Kairo localhost health，不开放原生执行入口 |
| MCP 缺少鉴权或固定 Dataset | T14 失败即选 HTTP，删除 MCP 实现和依赖 |
| RAGFlow 检索参数并非由 UI 权威管理 | T14 真实验证；与 SPEC 冲突时先更新上游文档 |
| PostgreSQL 全不可用时无法持久化故障提示 | 只对固定提示做尽力发送例外，不建第二存储、不补发 |
| 模型没有独立健康 API | 仅在有明确失败证据时降级；使用不含员工内容的受控 probe 检测恢复 |
| 真机故障难以稳定制造 | E2E 脚本提供显式、可清理的故障步骤；无法证明的场景不得标通过 |

## 12. 可并行项

- T01-T03 可与 T04 并行。
- T05 完成后，可并行推进 Driver T06-T09、数据库/Mastra T10-T13、RAGFlow T14。
- Checkpoint A 后，T15 与 T17 可并行；T16 等用户文件到位。
- 迁移编号必须按 T18 → T19 → T20 串行。
- Checkpoint B 后，T21 与 T23 的纯规则部分可并行；T22 完成前不接真实消息。
- Checkpoint C 后，T27 与 T31 的纯规则测试可并行；T28 依赖最终 Tool 合同。
- `apps/kairo/package.json`、`pnpm-lock.yaml`、`recovery.ts`、`delayed-memory.ts` 同一时间只由一个任务修改。

## 13. 官方资料

Mastra：

- [Mastra Server](https://mastra.ai/docs/server/mastra-server)
- [Mastra CLI](https://mastra.ai/reference/cli/mastra)
- [Agent.generate](https://mastra.ai/reference/agents/generate)
- [createTool](https://mastra.ai/reference/tools/create-tool)
- [Agent Skills](https://mastra.ai/docs/agents/skills)
- [PostgreSQL storage](https://mastra.ai/reference/storage/postgresql)
- [Observational Memory](https://mastra.ai/reference/memory/observational-memory)
- [Memory readOnly semantics](https://github.com/mastra-ai/mastra/pull/11523)
- [MCPClient](https://mastra.ai/reference/tools/mcp-client)

RAGFlow：

- [RAGFlow v0.27.1](https://github.com/infiniflow/ragflow/releases/tag/v0.27.1)
- [MCP Server 启动说明](https://github.com/infiniflow/ragflow/blob/b9df87c4c75a5b0d35c90d15329fc0f6f91cb73e/docs/develop/mcp/launch_mcp_server.md)
- [MCP Server 源码](https://github.com/infiniflow/ragflow/blob/b9df87c4c75a5b0d35c90d15329fc0f6f91cb73e/mcp/server/server.py)
- [HTTP API Reference](https://github.com/infiniflow/ragflow/blob/b9df87c4c75a5b0d35c90d15329fc0f6f91cb73e/docs/references/http_api_reference.md)
- [Retrieval API 实现](https://github.com/infiniflow/ragflow/blob/b9df87c4c75a5b0d35c90d15329fc0f6f91cb73e/api/apps/restful_apis/chunk_api.py)

迁移：

- [node-pg-migrate SQL loader](https://github.com/salsita/node-pg-migrate/blob/main/docs/src/migration-loading-strategies.md)
- [node-pg-migrate API](https://github.com/salsita/node-pg-migrate/blob/main/docs/src/api.md)

## 14. 完成定义

阶段一实现完成、可以交给用户试用前，必须同时满足：

1. Driver 新合同通过单元和真机验证；
2. `apps/kairo` 的 dev/build/typecheck/test/e2e 命令可执行；
3. `kairo`、`mastra` schema 可由迁移账号建立，运行账号不做 DDL；
4. 两名员工身份、上下文、任务、回复和 Memory 不串用；
5. 聚合、排队、`/new`、超时、重启和发送不明行为符合 SPEC；
6. RAGFlow 正式环境只有一种连接；
7. 企业答案有内部资料，员工看不到来源和内部 ID；
8. 无资料、通用确认、冲突、部分回答和故障行为正确；
9. 只有确认送达的正式内容进入 thread 与 Observational Memory；
10. 用户提供的 SOUL、AGENTS 和真实 Skill 已加载；
11. 单元、集成、跨进程和双员工真实 IM 均有通过证据；
12. 用户根据真实使用决定是否进入阶段二。

## 15. T15 受控 Bot 配置实施计划（2026-09-07）

任务与验收以 [T15 #220](https://github.com/dnslin/kairo/issues/220) 为准；本节只记录本次实施顺序，不另建任务状态来源。工作分支为 `feature/t15-bot-config`。上文是阶段一初始规划快照，本次以当前 SPEC 和 Issue 为准，不恢复旧 MCP 方案。

### 实施前事实与边界

- 应用已有 `startKairo()`、进程内 Mastra 和 localhost 存活接口；没有正式配置目录、业务 Agent、知识 Tool 或用户真实 Skill。
- 复用已锁定的 `yaml@2.9.0`、`zod@4.5.4` 和 `pino@9.14.0`，不新增依赖、配置框架、热更新或兼容层。
- 配置由有仓库写权限的维护人员管理；员工消息不是配置输入。不增加第二套审批数据库、签名或发布机制。
- T15 只负责读取、校验和启动记录，不提前实现 T16 指令组合、T17 完整日志体系、T20 启动记录持久化或 T27 检索。

### 实施顺序与验收

1. **配置结构与引用检查**：新增 `apps/kairo/src/config/schema.ts`、`load.ts`、`config/bots/default/bot.yaml` 和 `apps/kairo/tests/unit/config.test.ts`。校验唯一模型、固定 Dataset、员工名单、启用引用和运行参数；覆盖缺失值、负数、矛盾参数、重复 Skill、未知 Tool、缺失 Skill 和凭证字段。YAML 解析错误不得把原始配置或凭证写入日志。
2. **启动接入与摘要**：在 `startKairo()` 创建运行时、监听端口之前完成校验，向应用提供本次加载结果；启动记录 Git commit 和配置内容摘要，不输出配置值或正文。不随工作目录选择另一份正式配置，不引入环境变量覆盖正式业务配置。同步现有 T13 启动合同调用，验证错误配置无法启动、正确配置保持原路由与关闭行为。
3. **真实启动与质量检查**：用批准的实际模型、ERP Dataset 和员工 UID 运行正式入口，检查 localhost 存活接口、启动摘要、错误配置非零退出，以及重启后配置改变生效。执行配置定向测试、受影响的 T13 集成测试和根 build/typecheck/test/lint；不把启动成功说成 Agent、IM 或检索业务已完成。

`maxSteps` 必须是显式正整数，表示 Agent 循环上限，不定义固定知识查询次数。配置文件写出阶段一约定的全部运行参数；时间使用有单位的字段。摘要不包含绝对路径或临时运行状态，覆盖正式配置内容；相同内容稳定，内容改变时变化。

### 已确认决策

- 用户已选择按建议实施：T15 允许显式空 `tools`、`skills` 列表；T16/T27 落地后再启用真实引用，不制造假 Tool 或正式 Skill。测试中的临时目录只用于验证配置读取，不用于真实 Skill 验收。
- 正式初始值沿用已验证环境：主模型 `sensenova/deepseek-v4-flash`、ERP Dataset `b55a0fc8a69211f1bad90f767650f6fc`、员工 UID `3585`。凭证继续只保留在环境变量中。
- 维护人员把 Skill 放入受控 `skills/` 目录并写入启用列表即表示批准；不另设审批表。Tool 名称还必须存在于应用实际注册列表，当前没有可启用的业务 Tool。

### 本次执行结果

- 已完成配置读取、严格校验、启动前阻断和 Git commit / 内容摘要记录，实现提交为 `ee6430fc021de64c9ba0c7d47a73faf6fccfe1ce`。
- 根 build/typecheck/test/lint 全部通过：Driver 308 个测试、App 31 个测试，其中 T15 定向测试 22 个；受影响 T13 PostgreSQL 集成测试另有 3 个通过。原 `startKairo()` 调用无需迁移，原接口和关闭合同已实际回归。
- 正式入口有效启动、凭证字段错误退出码 1、恢复后再次启动均已验证。真实测试数据库可用；修改文件不热更新，重启后读取新值，恢复原文件后摘要相同。
- 验证只向临时进程提供测试数据库连接，不改写正式数据库环境设置；未调用模型、RAGFlow 或 IM，不把配置交付当作业务 Agent 交付。
- 详细使用说明、执行命令与结果见 `docs/DEVELOPMENT.md` 的 T15 章节。临时程序和验证进程已清理；GitHub Issue 保持 open，等待分支交付与合并，不以本地完成提前关闭。

## 16. T17 正式 Driver 装配补齐计划（2026-09-08）

关联 #222 与 PR #260。用户已要求先规划并继续补齐：应用必须拥有真实 Driver，而不是只在测试程序里连接 Driver。对外状态继续记录在该 issue/PR，本轮执行进度用终端任务清单，不另建业务任务或修改 T18 的账本与迁移。

### 事实与决策

- 已有应用日志、健康服务以及 `IKK9Driver`、健康快照和健康事件合同，直接复用，不创建新 Driver 接口或恢复框架。
- `startKairo()` 创建并拥有 Driver；默认使用真实 `KK9Driver`，程序内测试通过显式工厂注入已有接口的测试实现。正式 CLI 不提供 Fake/禁用 Driver 的开关。
- 沿用现有基础设施变量 `CDP_URL`、`PAGE_MATCH`，默认 `http://127.0.0.1:9222` 和 `renderer.html`；仅连接回环 CDP，不启动、终止或重启 KK9。不向受控 Bot YAML 增加传输配置，不改变员工身份/业务规则合同。
- Driver 初次连接失败时，保留 live 与依赖诊断，明确记录 Driver 错误并保持 ready 503；不伪报启动就绪、不回退到替身。失效实例不原地重连，不添加后台重试；重启应用创建新实例。
- Driver 健康要求 CDP connected、EventBridge attached、两端非空连接身份属于同一启动代次且连接 ID 一致。关键 health/error 事件使本实例保持 down，单次发送返回 failed 不自动等同于连接失效。
- Driver up 且配置/PostgreSQL/Mastra 正常时，未接入的模型/RAGFlow 仍为 unknown，因此总状态为 degraded、ready HTTP 200，不声称六项真实依赖全部正常。

### 实施步骤与验收

1. **SDK 生命周期补足**：在 `event-bridge.ts`、`driver.ts`、`cdp/client.ts` 及对应回归中，保证 disconnect 清理本实例仍拥有的 Hook/binding，不清理更新实例的资源；页面已不可达时仍释放本机连接。修正 Driver 对 EventBridge error 的单次转发，握手复用既有超时值。验证新旧实例关闭顺序、真实错误事件、握手挂起和重复关闭，不新增公开重试 API。
2. **正式入口装配**：在应用入口创建 Driver、先订阅错误与健康事件，再进行连接；健康回调实时读取该实例，初次失败不关闭 live。关闭顺序与启动失败清理覆盖健康端口、Driver、Mastra，任何资源关闭失败也不能阻止其他资源回收，错误仍向调用者传播。应用返回自己拥有的 Driver。对应 App 单元/集成调用显式隔离测试依赖，不能自动访问 KK9。
3. **离线门禁**：执行 SDK 定向回归、App 启动与健康回归、build/typecheck/test/lint；验证核心正常时 degraded 200、Driver 失效后 not_ready 503、live 不受影响、错误对象不泄漏、启动失败/监听失败的资源回收。
4. **正式入口真机验收**：先只读确认真实 KK9 和既有 Hook 边界；用真实 `startKairo()`、真实 PostgreSQL 与真实 Driver 验证启动及健康状态，不使用独立 Driver 冒充应用依赖。只中断本应用自己的 WebSocket模拟连接失效，不重启 KK9或触碰其他工作树连接；验证 live/ready 转换、关闭、再次启动与最终 Hook 清理。若做定向消息验证，只操作已核对的 5761 → int2024/0-3585 和本次测试消息。
5. **交付**：更新开发文档、PR 和 issue 的当前事实与未验证项，提交推送；不自动合并或关闭 issue，不把模型/RAGFlow、业务 Agent 或全量入站矩阵算作已完成。

SDK 资源关闭与应用入口装配可以按文件边界并行；共用合同是既有 `IKK9Driver`，SDK 不依赖 App，App 不读取 SDK 私有字段。临时真机故障探针可定位自身连接用于测试，但不把测试入口加入产品 API。

### 实施结果

- SDK 生命周期与正式应用装配已完成；SDK 定向 41 项、App 装配与健康 26 项通过。完整 build/typecheck/test 通过（Driver 330、App 86），修正首次 lint 问题后 lint 与 App build 通过；受影响 Skill 集成 12 项、真实 PostgreSQL 路由隔离 3 项通过。
- 真实 `startKairo()` 自己拥有 Driver：启动 degraded/200；仅本应用 WebSocket 断开后 not_ready/503、live 200；重启新代恢复 degraded/200；正常关闭清理 Hook/binding。初次 CDP 失败仍保持 live。通过 application.driver 发送的消息 135821251 确认送达且已撤回。
- 默认 CLI 实际访问 127.0.0.1:4110 得到核心依赖 up、degraded；Ctrl+C 正常退出码 0。模型/RAGFlow 仍 unknown，不把结果写成全部依赖 ready。
- 详细命令、首次失败修正和验证边界已更新 docs/DEVELOPMENT.md；保留 issue/PR 未验证项，不合并或关闭。

## 17. T19 任务账本实施计划（2026-09-08）

任务与验收来源为 [#224](https://github.com/dnslin/kairo/issues/224)，不重复验收已合并的 T17/T18，不实现后续调度、发送、恢复或通用知识判断服务。

### 已确认合同

- 用户在本任务终端确认：等待员工不消耗执行预算；进入等待保存剩余毫秒数，恢复后以剩余预算形成新的执行绝对截止时间。进程重启本身不改变队列、执行或等待截止时间。
- 用户拒绝或新问题替换旧等待时，旧任务为 cancelled；等待到期为 timed_out；同意后同一任务回到 running，不直接 completed。
- 等待绑定 taskId、inputVersion、当前问题/缺失子问题标识及问题正文；员工回答关联原始消息键。授权不是允许回复的词语列表，不成为会话偏好；文字识别由 T30 负责。
- context ID 沿用 T18 的 threadId，身份从 ready batch 及其 context 派生；不创建 collecting task，不另建 context 标识。任务初始输入版本为 1，显式变更仅允许 queued/running，并清除旧执行尝试的采用资格；普通新消息进入下一批，不由本模块修改正在执行的输入。
- task 保存建任务时的配置摘要；attempt 保存实际运行配置摘要、runId、输入版本及起止/错误/采用记录，供重启使用当前配置时追溯，不增加配置版本框架。
- 连接池归调用方；复用 pg、既有迁移器、AppErrorType 和 T18 毫秒时间接口。数据库错误向调用方传播；条件不匹配返回 false/null，不能把数据库错误伪装成竞争失败。

### 状态转换表

| 当前状态 | 允许的后继 |
| --- | --- |
| queued | running、cancelled、timed_out |
| running | waiting_for_user、ready_to_send、failed、cancelled、timed_out |
| waiting_for_user | running、cancelled、timed_out |
| ready_to_send | sending、cancelled、timed_out |
| sending | completed、failed、cancelled、send_unconfirmed |
| completed、failed、cancelled、timed_out、send_unconfirmed | 无 |

领取、采用 attempt、进入等待、恢复等待分别使用专用原子接口，不允许普通状态更新绕过其字段和版本条件。重试和恢复产生新的 attempt，不让任务倒退至 queued；sending 内的发送重试不改变任务状态。发送已经触发后不再以执行超时推断发送失败；30 秒查询归 T21。

### 实施顺序与验收

1. **创建与领取**：新增 000005-tasks.sql、task-lifecycle/types.ts 和 store.ts；从非空 ready batch 建立唯一任务，保存完整归属、输入版本、配置摘要和队列绝对截止。queued 领取使用条件更新，首次开始时设置执行绝对截止。先建立真实 PostgreSQL 创建/双连接领取用例，运行失败基线后实现。
2. **尝试与等待**：开始 attempt 需比较当前 attempt 标识及输入版本；结束记录可在任务终止后保留，但采用结果必须匹配当前 running、当前 attempt、当前输入版本和未过执行期限。等待原子保存问题范围、剩余预算及 now+600000 的绝对截止；回答必须匹配本员工/会话的原始入站消息，接受/拒绝只消费一次等待。同一 Bot 私聊只保留一个未关闭等待。
3. **完整状态合同**：真实 PostgreSQL 覆盖表中所有边；遍历其余跨状态/同态迁移并拒绝；终态不能领取、采用、等待或改输入。验证输入版本变化、同版本新 attempt 替代旧 attempt、取消/超时与迟到结果竞争。
4. **隔离与恢复**：复用 T18 随机临时数据库模式；先核对实际数据库名及两个不同后端进程 ID 再迁移，不能迁移配置中的原库。关闭自有连接并重新连接验证 task、attempt、等待和毫秒截止；等待恢复只使用持久化剩余预算。结束仅删除本次创建的库，不强制断开其他连接。
5. **命令与质量**：补齐 db:migrate:test，显式定向运行 task-store 集成测试（现有 test:integration 的目录参数不能误扩大到真实模型测试）；执行 App typecheck/build、默认 App 测试、根 lint 和新增文件格式检查。另用普通 Node 进程对构建产物做数据库烟测，不连接 KK9、模型或 RAGFlow。

迁移与存储由主代理实现；接口固定后，测试隔离/命令入口与任务集成用例可按不同文件独立实施。所有并发编辑阶段不执行构建、lint 或测试，由主代理在集成后统一验证。完成后更新开发文档与 Orca comment，不合并分支或关闭 issue。

### 实施结果

- 三表迁移、十状态存储、attempt 采用条件、等待暂停预算与回答关联均已实施；不增加运行时调度或依赖。测试与存储按固定接口并行编写，首轮运行时已有实现，实际结果为 22/23；不是预实现的失败基线。真实回答消费竞争失败已修复并保留回归。
- 最终 `db:migrate:test` 为 1 项通过/23 项定向排除；task-store 真实 PostgreSQL 集成为 24/24，App typecheck/build、根 lint、默认 App 91 项测试、新增文件格式与脚本语法检查通过。
- 独立构建产物烟测确认双连接只有一方领取、全部写入连接关闭后状态与截止保留、等待后剩余预算恢复、最终 completed 和终态保护。证据仅覆盖存储与连接重建，不包含强杀故障矩阵、Agent、IM 或恢复调度。
- 两份独立只读审查未发现存储实现的合同缺陷；补齐测试审查发现的实际取消/采用竞争及真实 SQL 失败回滚验证。没有通过捕获异常、放宽断言或增加兼容框架解决问题。
- 本任务创建的六个精确临时库名最终只读查询均无残留；两个临时 Node 探针已删除，本地被忽略的 `.env` 仅保留测试连接以便复跑。实际命令、结果与边界见 `docs/DEVELOPMENT.md` 的 T19 节；没有合并分支或关闭 issue。

### 追加修复：旧 attempt 迟到失败

Advisor 指出的同版本 A 被 B 替代后仍能以 running→failed 终止 B 的缺陷已真实复现，先前 24 项用例和审查未覆盖此路径。修复为该迁移强制携带 expectedAttemptId，并在现有任务行锁内比较非空 currentAttemptId；整任务取消及发送阶段失败不增加这一条件，旧尝试仍可补记结束审计。没有新增迁移或兼容层。

两条新增真实 PostgreSQL 回归修复前均失败、修复后均通过；全量 task-store 26/26，类型检查、根 lint、App build 及默认 App 91 项通过。当前结果以 `docs/DEVELOPMENT.md` 的追加修复节为准。

## 18. T27 固定 Python 知识检索链路（2026-09-09）

任务状态以 [#232](https://github.com/dnslin/kairo/issues/232) 为准；依据 [T14 完整证据](https://github.com/dnslin/kairo/issues/219#issuecomment-5567272438)、T15/T16 配置、T17 日志及 T20 账本实施。不修改 T22 入口/身份/会话，不提前装配 T28/T29，不操作真实 KK9。

### 已确认边界与实现决策

- 用户批准把 T17 的 RAGFlow 健康检查也切换为同一个固定 Python 入口；保留五分钟周期和三十秒期限，不写业务查询账本、不改变模型检查。仓库不再保留 TypeScript HTTP 检索实现。
- 受控目录新增 `erp-search` Skill；只指导最少 query 和企业资料使用。裁剪 ragflow-skill 1.0.8（发布许可证 MIT-0）的 common.py 请求处理与 search.py 字段映射为单一 search.py；不下载或暴露管理能力，不新增 Python 第三方依赖。
- Node 固定启动 `python` 与受控脚本，关闭 shell，通过 stdin 传 query。Dataset 来自已加载 YAML；地址与凭证来自受控服务环境。模型没有程序、路径、Dataset 或 HTTP 参数入口。
- Python 每次只做一次 Retrieval 请求，正文仅 question/dataset_ids。TypeScript 是唯一重试层，网络/429/5xx 最多再试一次；认证、参数、无资料、格式错误、取消不重试。未知业务错误明确失败并保留诊断，不仅靠 code 102 分类。
- 使用 task 已有 executionDeadline，所有查询和重试共享截止时刻，不从 Tool 调用重新给四分钟。AbortSignal 与截止共同终止实际 Python，等待 close 和管道回收再结束；不声称远端计算取消。
- Python 与 TypeScript 分别校验外部响应及进程输出边界。成功必须有有效 data/chunks；保留原始响应、HTTP/业务码、片段和文档标识、名称、positions、相似度。未知物理页码为 null。
- Tool 绑定服务端 task/attempt/boot、调用次序分配和 T20 recordQuery；内部网络尝试及耗时保存在既有 rawResult，不加表。资料作为 Tool 数据返回，诊断和正文仅进业务表；普通日志沿用白名单标识、状态和耗时，凭证不进模型或日志。
- 不新增会话取消调度、配置热更新、执行框架、备用实现或检索调参项。独立验证 Agent 不注册到生产 Mastra 路由。

### 实施顺序与验收矩阵

1. **固定 Python 与进程合同**：先以本地 HTTP 服务和真实 Python 建立失败测试，再实现有资料/无资料、严格结构、分类、进程错误和回收。覆盖 Python 不存在、脚本启动失败、非零退出、非 JSON、stdout/stderr 读取异常；不把假 Python 输出当真实链路验收。
2. **专用 Tool 与账本**：严格拒绝 query 外字段；真实 Python 结果写入随机临时 PostgreSQL 库，核对同 task 调用顺序、耗时、类别、原始诊断及证据，正文不进入普通日志。资料中的命令或切换 Dataset 文本不能改变程序与目标。
3. **Skill 与健康切换**：沿用 Mastra filesystem Skills 和 createTool；独立 Agent 真正调用 skill 后调用 knowledge-search。切换 T17，验证正常、空结果、异常、缺凭证、周期、关闭与超时语义；更新受影响配置调用点，不装配正式业务 Agent。
4. **真实 ERP 样本**：完整 Agent/Skill/Tool/Python 链路验证有结果、无结果、错误 key、错误 Dataset/权限及参数错误，记录 HTTP 200 业务错误；positions 保留原值，不以 DOCX 推断物理页码。不得创建/修改 Dataset 或重启远端服务。
5. **受控故障矩阵**：真实 Python 经本地 HTTP 故障服务验证缺失 data/chunks、非对象 chunk、正文/元数据类型、未知业务错误、429/5xx、断线恢复和连续失败最多两次。真实 ERP 转发代理用于最少请求字段核对、在途挂起/取消/超时与取消后恢复；代理行为与真实服务结果分别标注。
6. **预算与注入**：首次/重试/后续查询均不重置 task 截止；真正等待四分钟总预算的独立场景与快速截止单元测试分别记录。取消后等待进程退出，无后台重试；额外参数与 query 内命令均不能修改 Dataset、凭证、脚本或参数，模型上下文不含凭证，最终员工说明不输出内部 ID/来源列表。
7. **质量与交付**：执行 issue 两个定向单元/集成命令、App typecheck/build、根 build/typecheck/test/lint 和受影响 Skill/健康/配置/账本测试。数据库复用已有随机库隔离，关闭自有连接并删除自建库。更新开发文档、许可来源及 Orca comment，记录实际命令和未验证项；未经授权不合并、不关闭 issue。

### 环境与待确认项

- 已确认 Python 3.14.3 和现有 Node/Mastra/zod/pg 依赖；无需安装检索 SDK。
- 初始当前工作树无 .env，主仓库测试配置无 RAGFlow key；向用户询问后，用户选择并在当前工作树配置凭证。仅从本地进程读取，未输出或提交。真实 ERP 全矩阵已通过，实际命令与真实/本地证据边界见 docs/DEVELOPMENT.md 的 T27 节。
- T14 已确认真实 ERP 的 DOCX positions 不能映射物理页码；本任务保留未知，不虚构 PDF 样本或历史解析版本。

### 实施结果

固定 Python、严格 Tool、任务原截止/取消、一次重试、T20 原始结果/证据及定制 Skill 已落地；T17 健康检查按用户批准切换同一入口，无 TypeScript 检索旁路。既有依赖足够，未新增库、迁移、执行框架或调参项。

完整本地矩阵、真实 ERP 矩阵及批准模型面对本地恶意资料的样例均已实际执行；四分钟 task 截止不是缩短的测试时间。根质量命令、定向单元/数据库集成、迁移幂等及构建产物健康烟测通过。首轮失败与审查修复、精确命令/计数及未声称覆盖的 PDF/远端取消/IM 边界均记录到开发文档。本分支不合并，不关闭 issue。

### PR #265 复核修复

按“先核实、再规划实施”完成四项已复现行为问题与配置反向依赖修正：落账后的交付截止/取消门禁、Python/Node 安全整数范围及精确诊断、Mastra 严格输入的未知空值拒绝、验收回调错误传播与资源回收、配置能力清单由入口注入。删除可推导的 retryable 状态；保留真正跨边界的格式与执行目标校验。

定向 128 项、真实 PostgreSQL 集成 28 项通过；完整真实 ERP 矩阵 254.76 秒通过，原任务四分钟截止 239982.8595ms，恢复请求 found；批准模型面对本地恶意资料样例通过。构建、类型检查、Driver 330 项和 lint 通过；App 首轮遇到 Vitest IPC 关闭，保留该失败记录，添加诊断选项后原命令 235 项通过，未修改测试范围或框架。两份独立只读复审无 Required。详细命令、故障烟测与边界见 `docs/DEVELOPMENT.md` 的 PR #265 复核节。

## 19. T24 控制消息与近期上下文（2026-09-09）

> 当前状态：再次恢复缺陷已修复并完成定向回归与独立烟测；PR #266 仍保持草稿待审，T35 真机放行未执行，不合并或关闭 #229。

任务来源为 [#229](https://github.com/dnslin/kairo/issues/229)。T22、T27 已完成，直接接入当前实现，不重复验收。用户在本终端确认：空闲恰好两小时继续原 thread，严格超过才切换；context-service 实例登记实际执行的 AbortController，切换提交后请求停止，不等待执行退出，Python 回收仍由 T27 负责。

### 合同与实施顺序

1. 控制处理器只消费 T22 的返回值；仅 accepted 的整条纯文本 trim 后等于 `/new` 且无附件时消费命令。其他消息返回当前 context，不聚合、不调用 Agent、不另建 Driver 订阅。固定反馈通过 T21。
2. 复用 T18 范围事务锁分配 thread 版本。同一事务先锁 context、再锁未完成 task 与对应 batch/wait；取得 context 锁后采样切换时间，废弃尚未形成任务的旧批次、取消未完成任务、关闭员工等待、使旧 context 失效并创建 UUID thread。历史保留。
3. 建批、建任务、领取、采用、等待恢复和输出交付统一先锁 context 再锁自身业务行。输出交付在有效性检查后的同步回调中发生，不能在检查后 await 再交给 Driver；数据库锁不等待 Driver 回执或 Agent 退出。
4. 实际执行登记 task/attempt/context 版本与控制器；提交切换后 abort 旧 thread 的登记项。T27 交付资料和 T19 采用 attempt 均校验当前 context，底层未及时响应取消也不交付旧结果。
5. 终态更新在同一任务事务保存空闲起点：delivered 使用首次确认送达时刻，send_unconfirmed 使用首次确定未确认时刻，其余失败/取消/超时使用任务结束时刻。T21 协调账本补充 result_at 保存首次最终判定时刻，恢复不得刷新或猜测历史时刻。进度、排队提示和收消息不更新起点；未完成任务及批次阻止空闲切换。

### 验收与阶段边界

- 单元覆盖精确命令、空白、句子、参数、其他命令、媒体/附件及固定反馈；真实 PostgreSQL 集成覆盖 T22 方向/防重/可信身份/allowlist 到控制处理的顺序。
- 覆盖 collecting、queued、running、waiting_for_user、ready_to_send、sending；双连接验证切换与建批/建任务/领取/采用/恢复等待/交付竞争，事务错误必须传播且无半截切换。
- 验证两小时前、恰好、超过，各种最终结果起点及恢复不刷新、进度不刷新、忙碌不切换、旧历史可读。真实 Mastra/Tool/Python 的取消与不及时 Abort 的迟到结果分别验证。
- 使用现有 createTaskTestDatabase 随机库助手，先核对实际库名和两连接 PID 再迁移，只关闭自有连接并删除本次库。用户已在当前工作区配置测试连接；未读取其他工作区凭证，未迁移配置所指原库。
- 最终运行精确定向单元、隔离数据库集成、App 类型检查/构建、相关 lint 与格式检查，并独立执行上下文切换/旧结果阻止烟测。T35 真实 KK9 各状态 `/new` 放行不由这些测试替代。
- 不实现 T23、T25、T28，不修改 Driver、正式订阅或 Python 管理，不合并分支、不关闭 issue。

### 实施结果

控制消息、原子切换、实际 AbortController 登记、T19/T21/T27 交付门禁和严格超过两小时边界已实现。T21 增加首次结果时刻，已持久化的原生送达证据在协调收尾中断恢复时仍保留原时间。Tool 消费者在锁内得到输出，事务结束与错误通过 settled 处理；没有提前装配正式 Agent。

审查的三项真实反例均先失败后修复：等锁期间新建员工等待、Tool 等 COMMIT 后才交付、原生送达与协调保存之间中断导致空闲时间后移。最终根 build/typecheck/test/lint 全部通过（Driver330/App298），真实 PostgreSQL 组合123/123，迁移专题2项通过。独立 Mastra/Python 上下文切换烟测通过，旧结果取消、新结果送达使用 FakeDriver，不冒称 T35 真机。32 个有输出记录的精确自建库只读核对无残留。实际命令、首次失败、清理与未验证边界见 docs/DEVELOPMENT.md 的 T24 节；不合并分支、不关闭 issue。

追加核实确认：初次发送和首次恢复的 delivered 协调写入均中断后，第二次恢复因 queryUsed=true 跳过持久送达证据，误记 send_unconfirmed，并把 idleSince 相对原证据后移三小时。真实 PostgreSQL 复现中仅发送一次、查询一次，独立复现库已清理；本轮只核实、未修复。用户随后要求提交并创建详细 PR，按草稿交付并关联 #229，保留该明确阻塞项。

用户要求执行修复后，发送恢复改为优先采用已持久化的 delivered 及原时间，再处理查询预算；等待结束后复读新落账证据，复用既有 context/task 校验，证据读取失败继续传播。五条新增单元回归分别先失败后通过，最终发送单元61项随全App通过，真实发送/上下文集成46/46；根 build/typecheck/test/lint 全部通过（Driver330/App303）。独立真实 PostgreSQL 烟测中连续两次协调写入失败后恢复仍 completed，空闲偏移0ms、发送一次、查询零次；烟测库已清理。实际命令和首轮夹具失败记录见开发文档，修复提交继续更新现有 PR，不新增迁移或改动 Driver。

## 20. T23 消息聚合与阶段一输入拒绝（2026-09-09）

任务来源为 [#228](https://github.com/dnslin/kairo/issues/228)，最新正文无评论。T22、T27、T24 已完成，当前基线具备所需接口，不重新验收、不合并依赖。用户已批准以下四项行为规则后开始实现。

### 已确认输入与批次合同

- 无附件且正文 trim 后为空：保留原始消息，不入批、不计条数、不刷新计时、不回复、不调用 Agent。非空正文原样保留，空格与换行计入字数。
- 字数按 Unicode 码点计数，普通中文、单码点表情各一；组合表情按组成码点累计，不按字节或 UTF-16 长度计数。各原文直接累计，系统拼接分隔符不占额度。
- 10 条与 30000 字允许，超过立即整批拒绝并结束，不截断。任意附件同样立即结束并拒绝本批；附件原因优先，只发一条 issue 原文提示。后续消息另起一批，包括第 12 条和附件后的文字。
- quietDeadline 来自最后普通消息观察时间加 quietMs；maxDeadline 来自第一条观察时间加 maxWaitMs，不重置。聚合取得 context 锁后采样当前时间，先结束已经到期的旧批，再接入新消息；等于截止属于下一批。延迟计时器不能延长批次，迟到的入站处理不回填已结束批次。
- 范围按 Bot、员工、会话及 thread 隔离；数据库 context 行锁串行化同范围追加、到期结束与 T24 切换。/new 只由原控制处理器消费，不入批；失效 context 禁止追加、建任务、提示交付与恢复。

### 实施边界与持久化合同

1. input-policy 只判断空白、附件与输入限制；不读取媒体，不增加依赖或配置。
2. collector.accept 只接收 T22 IngressResult，复用 createControlMessageHandler，只聚合 status=message；不新增 Driver 订阅或 T28 装配。
3. 在既有 PostgresPrivateChatStore 增加聚合专用原子操作，复用 message_batches/batch_messages、context 锁和共享事务。普通 T18 接口与测试仍保留，不建立第二套存储或事件框架。
4. 必要迁移只补批次结束时刻、拒绝原因及收尾完成时刻。拒绝原因一旦结束不随重启配置改变；结束时刻用于重建原任务创建/排队截止，收尾标记用于恢复“批次结束后、任务创建或提示确认前”的中断，不扫描重复提交全部已结束历史。
5. collecting 不创建 task；合法到期批次变 ready 后调用既有 T19 createTask，batch 唯一键阻止重复任务。当前 Agent/attempt 不修改、不取消、不重跑。仅建立合法任务账本，不实施 T25 的领取、排队容量或并发调度。
6. 拒绝用首条原始消息、固定用途和 thread 构成 T21 提示意图；send/recover 共享原 operation 与预算。恢复只在旧实例已停止后执行，同实例重复 recover 合并，终态收尾重复无副作用。
7. 恢复沿用两项持久绝对截止，取较早者安排剩余时间；到期立即结束。旧 timer 每次读当前持久状态，不复活 discarded。定时器异常记录并经 settled/close 向调用者传播，不静默降级。

### 完整验收顺序

1. 单元：5 秒静默重置、60 秒最长不重置、任一先到、恰好截止与迟到 timer；10/11 条、30000/30001 字、空文本/空白、中文/表情/组合字符、原文空白及分隔符。
2. 单元：文字后附件与反向、附件元数据与媒体类型、附件和超限同时发生、拒绝后新批、不同员工/会话/Bot、正在运行的任务不变；关闭和定时异常可观察。
3. 集成：真实 PostgreSQL 与生产 T22/T24/T21/T19，验证门禁与去重先于聚合、/new 不入批、原始消息保留、拒绝无任务无 Agent、提示同意图一次。
4. 集成：关闭旧实例/连接后恢复静默剩余、最长剩余、仅一种过期和两种全过期；结束后建任务前、提示发送前/发送后收尾前中断可恢复，重复恢复不重复任务或提示。
5. 集成：双连接并发追加与结束、同刻到期、新消息与迟到 timer、/new 废弃 collecting/ready 及恢复竞争，证明旧批不复活；运行中补充建立下一批且原 task/attempt 不变。
6. 数据库仅复用 createTaskTestDatabase 随机独立库，迁移前核对真实库名和双连接 PID，只删除本次自建库。用户已在本worktree提供测试连接，不读取其他工作区凭证。
7. 定向运行 exec vitest run tests/unit/collector.test.ts tests/unit/input-policy.test.ts；执行 issue 原单元命令并如实说明其筛选范围；集成使用 test:integration -- tests/integration/collector-recovery 前缀覆盖两个文件；执行受影响私聊/context/task/send 集成与迁移回归、App typecheck/build、相关 lint/Prettier 和默认测试。
8. 普通 Node/tsx 独立运行生产聚合与恢复，实际等待原生 5 秒与持续 60 秒，使用真实独立 PostgreSQL；恢复剩余与过期路径分别记录，不能把受控时钟当实际等待。FakeDriver 仅为出站边界，不冒充真机。

完成后检查复杂度，更新实际证据、开发说明与 Orca comment，移除一次性探针。T35 承担真实 IM 三段发送、持续发送、附件拒绝和 Agent 运行中补充放行；本任务不修改 Driver、不连接或干扰真实 KK9，不合并、不关闭 issue。

### 当前实施检查点

已完成collector、input-policy、既有存储的原子聚合操作与000011收尾迁移，新增对应单元和23项数据库集成场景。两条并发/关闭反例均先失败后修复：旧收尾快照吞掉立即拒绝、批量首个错误导致close漏等其他批次。额外收缩未使用的存储必需接口，不新增配置或事件框架。

最终App默认327项、类型/构建及相关ESLint/Prettier通过。用户补齐配置后，真实collector-recovery23项、受影响账本111项及迁移专题2项通过；原生计时烟测实际60103ms完成最长截止与剩余恢复，静默剩余、全过期、附件及/new废弃场景通过。交错员工和运行后新建批次用例补强后，再次23项集成通过；累计15个有输出记录的自建库精确只读核验无残留，一次性探针已清理。出站为明确FakeDriver，不替代T35真机；未合并或关闭issue。精确命令、首轮配置缺失及相对路径失败历史、证据边界见docs/DEVELOPMENT.md的T23节。
