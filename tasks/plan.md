# Kairo 阶段一企业知识问答技术实施计划

> 状态：已确认；代码实现尚未开始
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
