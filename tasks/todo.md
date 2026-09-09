# Kairo 阶段一企业知识问答任务定义与验收快照

> 状态：已确认；执行状态以 GitHub Issues 为准
> 日期：2026-09-07
> 上游：[`tasks/plan.md`](./plan.md)、[`docs/SPEC-stage-1.md`](../docs/SPEC-stage-1.md)
> 任务追踪：[`GitHub Issues`](https://github.com/dnslin/kairo/issues)（唯一任务状态与依赖来源）
> 阶段一里程碑：[`Stage 1 - 企业知识问答`](https://github.com/dnslin/kairo/milestone/5)（里程碑 #5）
> 已建立任务 issues：#206–#240

## 使用规则

- 只实施阶段一企业知识问答；不得顺手加入文件处理、审批、群聊、长期个人记忆、知识 ACL、管理后台、Redis、NATS 或 Sandbox。
- 开始任务前确认其前置依赖与上一个 Checkpoint 已通过。
- 每个任务完成后执行该任务列出的定向测试；到 Checkpoint 时再执行整组测试。
- 标为“真实环境”的项目不能用 FakeDriver、Mock PostgreSQL、Mock RAGFlow 或假员工替代。
- 若 Driver、Mastra 或 RAGFlow 的真实行为与 PRD/SPEC 冲突，停止后续任务，保存证据并先更新上游文档。
- 默认 `test` 不得触发真实 IM 副作用；真实 E2E 必须要求显式确认变量。
- 本清单不给工期；任务按依赖和可验证纵向结果排序。
- GitHub Issues（#206–#240）管理任务状态、前置依赖、执行评论和完成证据；本文件只保留任务定义与验收快照。
- 任务状态使用 issue 的 open/closed；前置关系使用 GitHub 原生 `blocked by`，issue 正文同步保留可读链接。

---

# 阶段 A：基础与高风险门禁

## T01：建立 `@kairo/app` 最小工作区

**说明：**建立可独立构建、检查和测试的 Kairo 应用包，不接入业务能力。

**前置依赖：**无。

**修改文件（5）：**

- `pnpm-workspace.yaml`
- `apps/kairo/package.json`
- `apps/kairo/tsconfig.json`
- `apps/kairo/vitest.config.ts`
- `apps/kairo/src/index.ts`

**用户可见结果：**暂无员工功能；开发者可以通过统一 pnpm 命令操作 `@kairo/app`。

**验收条件：**

- [ ] workspace 包含 `apps/*`，现有 `packages/driver` 保持有效。
- [ ] 包名为 `@kairo/app`，使用 ESM、NodeNext、strict 和 Node.js `>=22.13.0`。
- [ ] 包脚本至少包含 `dev`、`build`、`typecheck`、`test`、`e2e`。
- [ ] 初始入口只验证启动边界，不创建 Agent、数据库表或外部连接。

**测试场景：**

- [ ] 最小入口可以编译。
- [ ] 空测试集或 smoke test 能由应用级 Vitest 配置运行。
- [ ] Driver 现有包仍可单独构建和测试。

**执行命令：**

```bash
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
pnpm --filter @kairo/driver build
```

**真实环境验证：**不需要 KK9、PostgreSQL、RAGFlow 或模型。

---

## T02：扩展仓库规则与根质量命令

**说明：**让根规则和质量命令覆盖 Driver 与新应用，同时保留 Driver 的纯 I/O 边界。

**前置依赖：**T01。

**修改文件（5）：**

- `package.json`
- `eslint.config.js`
- `tsconfig.eslint.json`
- `AGENTS.md`
- `docs/DEVELOPMENT.md`

**用户可见结果：**暂无员工功能；仓库根命令可以统一检查两个包。

**验收条件：**

- [ ] 文档不再声称仓库只保留 Driver。
- [ ] `AGENTS.md` 仍明确 Driver 不承担 Agent、Memory、数据库、知识或业务编排。
- [ ] 根 `build`、`typecheck`、`test`、`lint` 覆盖 Driver 和 Kairo。
- [ ] ESLint type-aware project 包含应用源码和测试。
- [ ] 删除或修正对不存在的 `docs/KK9-LOWLEVEL-RESEARCH.md` 的强制引用。

**测试场景：**

- [ ] 两个包都被根命令发现。
- [ ] 应用测试文件不会触发 ESLint parser project 错误。
- [ ] Driver 原有命令行为不变。

**执行命令：**

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

**真实环境验证：**不需要。

---

## T03：锁定依赖并验证干净检出启动

**说明：**锁定阶段一依赖，并解决应用从干净检出消费 Driver 时 `dist` 不存在的问题。

**前置依赖：**T01、T02。

**修改文件（3）：**

- `apps/kairo/package.json`
- `pnpm-lock.yaml`
- `apps/kairo/tests/unit/dependency-smoke.test.ts`

**用户可见结果：**暂无员工功能；干净检出后应用命令不会因 Driver 未构建而失败。

**验收条件：**

- [ ] 精确锁定 `@mastra/core@1.63.2`、`@mastra/memory@1.28.1`、`@mastra/pg@1.22.2`、`mastra@1.27.2`。
- [ ] 精确锁定与 Node.js 22 兼容的 `pg`、`node-pg-migrate`、`zod`、`yaml`、`pino` 版本。
- [ ] `@kairo/driver` 是 `workspace:` 直接依赖，不依赖 pnpm 偶然提升。
- [ ] app 的 pre-scripts 在需要时先构建 Driver；运行时通过 package exports 使用 `dist`，不混用源码 alias。
- [ ] 阶段一正式依赖中不保留 `@mastra/mcp`；RAGFlow 检索所需 Python 运行依赖由 T27 按最终固定链路补充。
- [ ] `pnpm-lock.yaml` 与 `package.json` 一致，不使用 `@latest`。

**测试场景：**

- [ ] 从无 `dist` 的干净 checkout 执行 app build/typecheck/test。
- [ ] 导入 `@kairo/driver` 实际解析到构建产物。
- [ ] Mastra 包的 peer dependencies 无冲突。

**执行命令：**

```bash
pnpm install --frozen-lockfile
pnpm --filter @kairo/app test -- tests/unit/dependency-smoke.test.ts
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app dev
```

**真实环境验证：**在一个干净 checkout 中验证；不需要外部服务。

---

## T04：增加 Driver `direction` 公共合同

**说明：**基于真实 self/外部证据产生 inbound、outbound、unknown，避免 Bot 回显递归和无证据猜测。

**前置依赖：**无；可与 T01–T03 并行。

**修改文件（5）：**

- `packages/driver/src/types/index.ts`
- `packages/driver/src/index.ts`
- `packages/driver/src/bridge/converter.ts`
- `packages/driver/tests/source-classification.test.ts`
- `packages/driver/tests/inbound-normalization.test.ts`

**用户可见结果：**Bot 自己的消息不会再次触发回答；方向无法确认时不会误当成员工问题。

**验收条件：**

- [ ] 导出 `MessageDirection = 'inbound' | 'outbound' | 'unknown'`。
- [ ] 标准化消息始终产生 direction；迁移期保留 legacy `origin`。
- [ ] 识别 `isFromSelf`、`fromMe`、`isMe` 和当前登录 UID。
- [ ] 明确 self 事实优先于低可信 raw `origin/source`。
- [ ] 明确非 self 才能是 inbound；证据冲突或不足时为 unknown。
- [ ] 系统消息和不能处理的会话不会被猜成 inbound。

**测试场景：**

- [ ] 员工入站、Bot 自身、operator、自身历史消息。
- [ ] `isFromSelf=true`。
- [ ] raw origin 与 self 事实冲突。
- [ ] 缺少 self/source 证据。
- [ ] EventBridge 与轮询标准化得到相同 direction。

**执行命令：**

```bash
pnpm --filter @kairo/driver test
pnpm --filter @kairo/driver build
pnpm --filter @kairo/driver typecheck
```

**真实环境验证：**T09 使用真实员工入站、Bot 回显和历史消息验证字段与时序。

---

## T05：定义 Driver 发送意图与 Store port

**说明：**定义稳定发送意图、三态结果和可注入 Store，让 Kairo 能在 PostgreSQL 中保存 operation，而 Driver 保持无数据库依赖。

**前置依赖：**T04。

**修改文件（5）：**

- `packages/driver/src/types/index.ts`
- `packages/driver/src/index.ts`
- `packages/driver/src/send-operation.ts`
- `packages/driver/src/fake-driver.ts`
- `packages/driver/tests/send-operation.test.ts`

**用户可见结果：**同一回复的安全重试不会被当作新的发送意图。

**验收条件：**

- [ ] 导出 `SendStatus`、发送操作记录和 `SendOperationStore` 接口。
- [ ] `SendOptions` / `SendFileOptions` 可接收 operationId。
- [ ] SendResult 提供 operationId 和 status，同时保留 `success`、`isPreTrigger`、`messageId`。
- [ ] fingerprint 至少覆盖规范化目标会话、消息类型和内容摘要。
- [ ] 同一 operationId 的不同 fingerprint 在发送触发前拒绝。
- [ ] 提供默认内存 Store 以兼容旧调用方；Kairo 主流程不得依赖它跨重启。
- [ ] FakeDriver 可注入共享 Store。

**测试场景：**

- [ ] 同 ID、同内容重放。
- [ ] 同 ID、不同目标/类型/内容。
- [ ] delivered 重放不再次发送。
- [ ] unknown 重放不盲目发送。
- [ ] 两个并发调用竞争同一 operationId。

**执行命令：**

```bash
pnpm --filter @kairo/driver exec vitest run --root ../.. packages/driver/tests/send-operation.test.ts
pnpm --filter @kairo/driver typecheck
```

**真实环境验证：**T09 验证 native 发送；T34 验证 PostgreSQL Store 跨进程恢复。

---

## T06：接通文本类 Bridge 发送三态与只读查询

**说明：**把稳定 operationId 接入文本、富文本、回复和文件共用的 Bridge 发送链，并实现不触发发送的状态查询。

**前置依赖：**T05。

**修改文件（5）：**

- `packages/driver/src/driver.ts`
- `packages/driver/src/bridge/message-ops.ts`
- `packages/driver/src/bridge/send-status.ts`
- `packages/driver/tests/driver.test.ts`
- `packages/driver/tests/bridge-message-ops.test.ts`

**用户可见结果：**发送前确定失败可以安全重试；发送后回执不明时不会立即重复发送。

**验收条件：**

- [ ] 同一 operationId 使用稳定 native 关联键，不在重试时生成新随机键。
- [ ] 只有在目标会话找到有效原生消息 ID 时返回 delivered。
- [ ] 只有能证明未触发/未创建时返回 failed。
- [ ] 触发后超时、断连或丢回执返回 unknown。
- [ ] `getSendStatus(operationId)` 只查询 Store 与 native 历史，不调用发送接口。
- [ ] 查询不到记录时返回 unknown，不推断为 failed。
- [ ] operation-aware 路径不会落入无法关联的 DOM 双发。

**测试场景：**

- [ ] insert 前失败、insert 后响应丢失、send 后超时、CDP 断连。
- [ ] native 消息已存在时返回 delivered。
- [ ] 查询调用次数不增加发送调用次数。
- [ ] 同 ID 重试使用同一 native key。
- [ ] 目标会话不一致时拒绝 delivered。

**执行命令：**

```bash
pnpm --filter @kairo/driver exec vitest run --root ../.. packages/driver/tests/driver.test.ts packages/driver/tests/bridge-message-ops.test.ts
pnpm --filter @kairo/driver build
pnpm --filter @kairo/driver typecheck
```

**真实环境验证：**T09 强制验证文本；非文本仅保持兼容，真实文件/图片交付留到阶段二。

---

## T07：补齐图片、DOM 与 FakeDriver 兼容合同

**说明：**让其余公开发送实现正确映射三态，不扩大阶段一产品范围。

**前置依赖：**T05、T06。

**修改文件（5）：**

- `packages/driver/src/bridge/image-ops.ts`
- `packages/driver/src/dom/send-ops.ts`
- `packages/driver/src/fake-driver.ts`
- `packages/driver/tests/send-ops.test.ts`
- `packages/driver/tests/fake-driver.test.ts`

**用户可见结果：**阶段一没有新增图片/文件功能；旧 Driver 调用方不会因结果类型扩展而损坏。

**验收条件：**

- [ ] 所有公开 SendResult 可映射到 delivered/failed/unknown。
- [ ] DOM 无 native ACK 时不得报告 delivered。
- [ ] operation-aware 图片发送使用稳定关联键，或在无法保证时明确拒绝而非降级双发。
- [ ] FakeDriver 支持 success、pre-trigger failure、post-trigger timeout/disconnect/lost-response。
- [ ] 新 FakeDriver 实例可通过共享 Store 查询旧 operation。
- [ ] legacy `success/isPreTrigger` 语义保持兼容。

**测试场景：**

- [ ] DOM 触发后未知。
- [ ] 图片 native ID 成功确认。
- [ ] FakeDriver 三态和故障序列。
- [ ] 同 ID 冲突与跨实例查询。

**执行命令：**

```bash
pnpm --filter @kairo/driver exec vitest run --root ../.. packages/driver/tests/send-ops.test.ts packages/driver/tests/fake-driver.test.ts
pnpm --filter @kairo/driver test
pnpm --filter @kairo/driver typecheck
```

**真实环境验证：**阶段一不要求真实图片/文件 E2E；文本合同由 T09 验证。

## T08：删除 Driver 正文日志

**说明：**移除 Driver 轮询和 EventBridge 中的消息正文日志，只保留排障所需的结构化标识。

**前置依赖：**T04。

**修改文件（3）：**

- `packages/driver/src/driver.ts`
- `packages/driver/src/bridge/event-bridge.ts`
- `packages/driver/tests/logging-privacy.test.ts`

**用户可见结果：**功能不变；普通技术日志不再泄露员工消息正文。

**验收条件：**

- [ ] 日志不记录 `message.content`、raw payload 正文或附件正文。
- [ ] 保留 messageId、sessionId、direction、状态、耗时和错误类型。
- [ ] 测试捕获日志输出并断言敏感正文不存在。
- [ ] 调试开关也不能恢复普通日志中的正文。

**测试场景：**

- [ ] 轮询收到文本消息。
- [ ] EventBridge 收到文本、富文本和错误 payload。
- [ ] 日志对象包含可关联 ID，但不包含测试正文和凭证。

**执行命令：**

```bash
pnpm --filter @kairo/driver exec vitest run --root ../.. packages/driver/tests/logging-privacy.test.ts
pnpm --filter @kairo/driver test
```

**真实环境验证：**T09 完成后抽查真机日志，确认员工问题和 Bot 回复未出现。

---

## T09：Driver 阶段一真实合同 E2E

**说明：**用真实 KK9 验证 direction、身份、发送三态、operationId 和回显行为；FakeDriver 不作为放行依据。

**前置依赖：**T04–T08。

**修改文件（4）：**

- `packages/driver/examples/e2e-stage1-contract.ts`
- `packages/driver/package.json`
- `docs/KK9-STARTUP.md`
- `start-kk9-cdp.bat`

**用户可见结果：**真实 Bot 回显不会触发新回答；发送异常不会自动产生第二条回复。

**验收条件：**

- [ ] 启动脚本将 CDP 明确绑定 `127.0.0.1`，文档与实际命令一致。
- [ ] E2E 要求登录 Bot、目标员工、会话 ID 和副作用确认值完全匹配。
- [ ] 真实员工入站为 inbound，Bot 回显为 outbound；证据不足样本为 unknown。
- [ ] `getEmployeeBySession(message.sessionId)` 返回 UID 与 `0-<uid>` 后缀一致。
- [ ] 覆盖 delivered、确定 pre-trigger failed、post-trigger unknown。
- [ ] 同 operationId、同内容安全重试；不同内容复用被拒绝。
- [ ] `getSendStatus()` 查询不发送消息。
- [ ] 同一消息经 EventBridge 与轮询上报时，业务可用 `(sessionId,messageId)` 识别重复。
- [ ] 测试产生的消息尽量撤回；无法清理时明确列出原生消息 ID。

**测试场景：**

- [ ] 员工向 Bot 发一条真实消息。
- [ ] Bot 发出一条真实文本并观察回显先后顺序。
- [ ] 使用无效目标制造触发前失败。
- [ ] 使用受控极短确认窗口或连接中断制造发送后 unknown，再查询最终状态。
- [ ] 同 ID 再调用一次，确认没有双发。
- [ ] 客户端/Driver 重连后再次核对员工 UID 和 sessionId。

**执行命令：**

```bash
pnpm --filter @kairo/driver build
pnpm --filter @kairo/driver typecheck
pnpm --filter @kairo/driver test
pnpm --filter @kairo/driver e2e:stage1
```

**真实环境验证：**必须在 Windows、已登录 KK9、CDP 已开放且只绑定回环地址的环境人工执行。当前本机 CDP 和环境变量未就绪时，本任务不得标记通过。跨 Kairo 进程持久化由 T34 验证。

---

## T10：建立 PostgreSQL 迁移与 SendOperationStore

**说明：**建立 `kairo` schema、迁移入口和 Driver Store 的 PostgreSQL 实现，证明 operation 可跨实例恢复。

**前置依赖：**T03、T05。

**修改文件（5）：**

- `apps/kairo/src/db/pool.ts`
- `apps/kairo/src/db/migrate.ts`
- `apps/kairo/migrations/000001-send-operations.sql`
- `apps/kairo/src/modules/im-transport/postgres-send-operation-store.ts`
- `apps/kairo/tests/integration/send-operation-store.test.ts`

**用户可见结果：**发送意图不会因 Kairo 或 Driver 重启而丢失。

**验收条件：**

- [ ] 迁移账号显式创建 `kairo` schema 和迁移记录表。
- [ ] 使用 `node-pg-migrate` SQL loader；迁移默认前向执行并受迁移锁保护。
- [ ] `send_operations.operation_id` 为主键或等价唯一约束。
- [ ] 保存规范化目标、消息类型、内容摘要、native key、状态、原生 ID 和时间。
- [ ] claim 使用唯一约束和单次原子写入，不使用“先查再插”防重。
- [ ] 同 ID 不同 fingerprint 不可覆盖原记录。
- [ ] 运行时连接不自动执行 DDL。

**测试场景：**

- [ ] 新库迁移和重复迁移。
- [ ] 两个数据库连接并发 claim 同一 operation。
- [ ] 相同意图重放和不同内容冲突。
- [ ] 新 Driver/FakeDriver 实例查询旧 delivered/failed/unknown。
- [ ] 数据库错误不会被当作发送失败。

**执行命令：**

```bash
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app test:integration -- tests/integration/send-operation-store.test.ts
```

**真实环境验证：**使用独立测试 PostgreSQL 和两个真实连接并发执行；内存数据库或单连接 Mock 不算通过。

---

## T11：建立 Mastra schema 与运行账号门禁

**说明：**生成、审查并迁移 `mastra` schema，确保正式运行账号不需要建表权限。

**前置依赖：**T03、T10。

**修改文件（5）：**

- `apps/kairo/src/mastra/storage.ts`
- `apps/kairo/src/db/export-mastra-schema.ts`
- `apps/kairo/migrations/000002-mastra-storage.sql`
- `apps/kairo/tests/integration/mastra-storage.spike.test.ts`
- `apps/kairo/package.json`

**用户可见结果：**暂无直接界面；thread、消息、Run 和 Observational Memory 可以在重启后保留。

**验收条件：**

- [ ] PostgresStore 使用 `schemaName: 'mastra'`。
- [ ] 正式运行配置使用 `disableInit: true`。
- [ ] 提交的 SQL 与锁定 `@mastra/pg` 版本的 `exportSchemas('mastra')` 输出一致或有可解释差异。
- [ ] 空库初始化成功；已存在同版本 schema 时重复执行安全。
- [ ] 升级演练不会把完整建库 SQL误当作未经审查的增量迁移。
- [ ] 运行账号可以完成所需 DML，但 `CREATE/ALTER/DROP` 明确失败。

**测试场景：**

- [ ] 迁移账号初始化空库。
- [ ] 运行账号初始化 Mastra 实例且不发出 DDL。
- [ ] thread/message 最小读写。
- [ ] 运行账号尝试建表被 PostgreSQL 拒绝。

**执行命令：**

```bash
pnpm --filter @kairo/app db:mastra:verify
pnpm --filter @kairo/app test:integration -- tests/integration/mastra-storage.spike.test.ts
```

**真实环境验证：**必须使用权限真正分离的迁移账号和运行账号；同一个超级用户切换参数不算通过。

---

## T12：验证 Mastra delayed-memory 合同

**说明：**前置验证“读取旧上下文但不保存草稿，送达后再提交正式消息并触发 OM”的完整行为。

**前置依赖：**T11。

**修改文件（4）：**

- `apps/kairo/src/mastra/memory.ts`
- `apps/kairo/src/mastra/delayed-memory.ts`
- `apps/kairo/tests/helpers/test-model.ts`
- `apps/kairo/tests/integration/mastra-delayed-memory.spike.test.ts`

**用户可见结果：**未发送、取消、超时或未通过检查的草稿不会影响下一轮；已送达内容可以延续。

**验收条件：**

- [ ] `generate(memory.options.readOnly=true)` 能读取既有 thread，但不保存本轮输入/输出。
- [ ] read-only 调用不自动执行 observation 生命周期。
- [ ] delivered 后只保存清洗后的正式 user/assistant 消息，不回写 recalled history、Tool 消息或模型草稿。
- [ ] `saveMessages()` 后显式调用 thread 范围的 `omEngine.observe()`。
- [ ] Observer 与 Reflector 显式使用主 Agent 同一个批准模型。
- [ ] 重复 save、重复 observe 和重启恢复不会产生重复正式消息。
- [ ] 验证 save 前、save 后、observe 后三个崩溃点。
- [ ] 关闭前 `memory.settled()` 与 `mastra.shutdown()` 顺序正确。

**测试场景：**

- [ ] delivered、failed、cancelled、timed_out、send unknown。
- [ ] 相同确定性 Mastra message ID 重放。
- [ ] 两个 employee resource 和两个 thread。
- [ ] `/new` 后新 thread 不读取旧 thread observation。

**执行命令：**

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/mastra-delayed-memory.spike.test.ts
```

**真实环境验证：**使用真实 PostgreSQL 和最终批准的主模型。若锁定版本无法满足幂等提交或显式 observe，停止 T28/T32，并先更新 PRD/SPEC。

---

## T13：验证 Mastra 生产路由与 Studio 隔离

**说明：**确保生产只进程内调用 Mastra，不能通过默认 Server 路由绕过 Kairo。

**前置依赖：**T03、T11。

**修改文件（4）：**

- `apps/kairo/src/mastra/runtime.ts`
- `apps/kairo/src/mastra/dev-server.ts`
- `apps/kairo/tests/integration/mastra-route-isolation.spike.test.ts`
- `apps/kairo/package.json`

**用户可见结果：**正式环境不存在可匿名直接执行 Agent、Tool 或 Workflow 的入口。

**验收条件：**

- [ ] 正式启动只创建进程内 Mastra 实例，不使用会自动注册执行路由的默认 `mastra dev/start`。
- [ ] 生产端口不暴露 `/api/agents`、Tool 或 Workflow 执行接口。
- [ ] localhost 健康接口由 Kairo operability 模块提供。
- [ ] 开发 Studio 使用独立启动命令、独立数据库、测试身份和测试 Dataset。
- [ ] 生产 build 不包含 `--studio`。
- [ ] 关闭时调用 `mastra.shutdown()`。

**测试场景：**

- [ ] 生产模式端口探测。
- [ ] 开发模式可连接 Studio。
- [ ] dev 配置指向正式数据库或正式 Dataset 时拒绝启动。
- [ ] 生产环境变量不能启用 Studio。

**执行命令：**

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/mastra-route-isolation.spike.test.ts
pnpm --filter @kairo/app build
pnpm --filter @kairo/app dev:studio
```

**真实环境验证：**本机检查实际监听端口；开发 Studio 只能连接独立开发数据。

---

## T14：验证 RAGFlow Skill 复用方案与检索合同

**说明：**验证并确认“定制 RAGFlow Skill + 专用 `knowledge-search` Tool + 复用 Python 检索脚本”的可行性与合同。T14 负责方案验证、真实样本和上游文档一致性；正式代码、Skill 裁剪和脚本接入在 T27 实施，不在 T14 提前完成业务连接器。

**前置依赖：**T03；目标版本为 RAGFlow v0.27.1，使用用户已配置的非敏感 ERP Dataset。版本实际验收依据需记录，不能将官方源码版本当作已部署版本证明。

**已确认方案：**

- Mastra 加载定制 Skill，提供检索时机、查询组织和资料使用说明。
- Agent 通过专用 `knowledge-search` Tool 查询；Tool 固定调用选定的 Python 脚本，不向 Agent 开放通用命令执行工具。
- 复用并裁剪 `ragflow-skill` 的检索脚本。Python 底层调用 RAGFlow HTTP Retrieval API；不另写 TypeScript HTTP 检索实现，也不增加 MCP、备用 endpoint 或第二通道。
- 查询只发送 `query` 对应的 `question` 和服务端固定的 ERP Dataset ID；其余检索参数使用接口默认值，不复制默认数字，不增加调参配置。接口默认值不会自动继承 RAGFlow 网页设置。
- Mastra 加载 Skill 说明与执行脚本是两种能力。Skill 不承担 Dataset 或执行权限限制；这些限制由专用 Tool 和固定脚本入口执行。

**涉及范围：**最小临时验证、真实样本与脱敏证据、`docs/prd.md`、`docs/SPEC-stage-1.md` 和本任务快照。临时验证不作为正式业务实现交付，结束后清理未选实现和依赖；正式 Skill、脚本、Tool、连接器和长期测试归 T27。

**用户可见结果：**暂无直接回答；先证明固定链路和结果合同可行，避免在 T27 引入错误实现边界。

**已有证据边界（不等于完整验收）：**

- 直接 HTTP 只读调用已观察 ERP 有结果、无结果、认证失败和 HTTP 200 业务错误；错误 Dataset 与错误参数不能仅靠单个业务 code 推定分类。
- 真实 chunk 已观察到正文、Dataset、document、positions 和相似度等字段。RAGFlow v0.27.1 的 DOCX naive 路径会生成模拟 positions，不能据此推定 Word 物理页码或严格段落号；正式链路保留原始 positions，不猜测缺失页码。
- 当前部署的 `/mcp` 响应不证明 MCP 鉴权，且用户说明部署似乎不提供 MCP；按已选方案，MCP 启用、SSE 回退和 MCP 重连不再是验收要求，也不能记为通过。
- 已静态核对锁定 Mastra 版本的 Skill 读取与命令执行接口，以及上游 Skill 1.0.8。上游脚本注入 `top_k=5` 等默认参数、会把部分缺失字段当作空结果，且错误输出缺少结构化分类，须在 T27 修正。
- 2026-09-07 最小临时链路已运行：锁定 Mastra 加载 Skill，经专用 Tool 启动 Python 检索 ERP；有结果、无结果、错误 key/业务错误、格式错误及 Agent 信号取消后的恢复已有证据。自动截止使用 10 秒实验预算，正式四分钟任务预算和重试仍归 T27。运行材料见 T14 Issue 与 `docs/DEVELOPMENT.md`；本文件复选框只保留验收定义，不作为实时状态。

**验收条件：**

- [ ] 记录上游 Skill 版本、许可证、拟复用文件和必须修改的行为，说明 Mastra 加载说明与执行脚本是两种不同能力。
- [ ] 用最小临时验证证明锁定 Mastra 版本可加载定制 Skill，专用 Tool 可调用 Python 检索脚本并取得 ERP 真实结果；不向 Agent 开放通用 shell。
- [ ] 确认最小输入、固定 ERP、环境变量凭证、结构化结果/错误和内部证据字段的合同；识别 HTTP 200 业务错误与缺失数据问题。
- [ ] 记录真实有结果、空结果、认证失败、错误 Dataset、错误参数、文档元数据与 positions/page 的样本和核对结果，不记录企业资料正文或凭证。
- [ ] 验证取消和超时可以终止本地在途 Python 调用，回收进程后能再次成功检索；明确本地终止不证明 RAGFlow 服务端计算已取消。正式总预算、重试和故障矩阵由 T27 实施。
- [ ] 同步 PRD、SPEC 和本文件：选定 Skill + 专用 Tool + Python；检索使用接口默认值；不再用“阶段一不运行 Skill 脚本”禁止专用 Tool 调用固定检索脚本，也不因此允许 Agent 任意运行 Skill 脚本。
- [ ] 删除本任务临时验证产生的未选实现和依赖，正式实现留给 T27；不安装或暴露上传、删除、Dataset/Chat 管理能力。
- [ ] 将真实验证与静态核对、尚未验证项分开记录。未完成验收不关闭 T14。

**测试场景：**

- [ ] 锁定 Mastra 版本加载定制 Skill，并只注册专用知识 Tool。
- [ ] 专用 Tool 固定调用 Python 脚本，对 ERP 检索有结果和无结果。
- [ ] 错误凭证、错误 Dataset、错误参数和 HTTP 200 业务错误可观察且不误报无资料。
- [ ] 缺失 `data`/`chunks`、非对象 chunk 和字段类型错误不会被静默转换为空结果。
- [ ] 超时或取消终止本地脚本后进程被回收，下一次查询仍可成功。
- [ ] 文档元数据与 positions/page 结合真实样本核对，不凭字段名猜测页码。

**验证方式：**保留可重复的临时验证命令和脱敏结果到 T14 Issue 或关联 PR。原 `ragflow:mcp-gate` 不再是要求的交付命令，也不声称该命令已存在。无需为方案验证建立正式连接器、业务 Agent 或另一套长期测试框架。

**真实环境边界：**使用现有 ERP，不创建、删除或修改知识资料，不擅自重启 RAGFlow。发现新的合同冲突时停止后续知识连接器工作，先更新上游文档。

---

# Checkpoint A：高风险合同

- [ ] T09：Driver 真机 direction、回显、三态、operationId 和身份通过。
- [ ] T10：PostgreSQL operation Store 的并发与跨实例行为通过。
- [ ] T11：迁移账号/运行账号分离，空库和重复初始化通过。
- [ ] T12：read-only 生成、送达后保存、显式 observe 和崩溃恢复通过。
- [ ] T13：生产无 Mastra 原生执行路由，开发 Studio 数据隔离通过。
- [ ] T14：Skill + 专用 Tool + Python 检索方案、最小真实调用和结果合同已验证；正式实现归 T27，上游文档已同步，临时未选实现和依赖已清理。
- [ ] 任一真实结果与 SPEC 冲突时已停止，没有继续实现业务模块。
- [ ] 执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过。



---

# 阶段 B：配置、日志与业务账本

## T15：加载并校验受控 Bot 配置

**说明：**把 `config/bots/default/` 作为唯一正式配置来源，启动时完成结构、引用和安全边界校验。

**前置依赖：**Checkpoint A。

**修改文件（4）：**

- `apps/kairo/src/config/schema.ts`
- `apps/kairo/src/config/load.ts`
- `config/bots/default/bot.yaml`
- `apps/kairo/tests/unit/config.test.ts`

**用户可见结果：**配置有效时重启后统一生效；配置错误时服务不接收员工任务。

**验收条件：**

- [ ] 校验唯一主模型、固定 Dataset、员工 UID allowlist、启用 Tools 和 Skills。
- [ ] 校验短静默 5 秒、最长合并 60 秒、最多 10 条、30000 字。
- [ ] 校验全局并发 3、每会话排队 3、排队 10 分钟、执行 4 分钟、进度 10 秒、发送查询 30 秒、通用知识等待 10 分钟、上下文空闲 2 小时。
- [ ] 显式校验 Agent `maxSteps`，并说明它不是知识检索次数限制。
- [ ] YAML 中出现密码、API key、Authorization 或数据库凭证字段时拒绝启动。
- [ ] Tool/Skill 引用不存在或未获批准时拒绝启动。
- [ ] 启动记录 Git commit 和配置内容摘要，不记录凭证或正文。
- [ ] 不实现热更新；修改后通过重启生效。

**测试场景：**

- [ ] 最小有效配置。
- [ ] 缺少模型、Dataset 或 allowlist。
- [ ] 时间/并发/输入限制为负数或互相矛盾。
- [ ] 未知 Tool、缺失 Skill、重复 Skill。
- [ ] 凭证误写入 YAML。
- [ ] 配置摘要稳定且内容改变时变化。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/config.test.ts
pnpm --filter @kairo/app typecheck
```

**真实环境验证：**使用用户最终提供的模型 ID、Dataset ID 和真实员工 UID 进行一次有效启动、一次无效启动。

---

## T16：组合 SOUL、规则与用户真实 Skill

**说明：**显式组合 Bot 人格、业务规则和用户提供的真实 filesystem Skill，不让 Prompt 文件覆盖服务端边界。

**前置依赖：**T12、T15；用户已提供真实文件。

**修改文件（5）：**

- `apps/kairo/src/modules/bot-customization/instructions.ts`
- `config/bots/default/SOUL.md`
- `config/bots/default/AGENTS.md`
- `config/bots/default/skills/<user-skill>/SKILL.md`
- `apps/kairo/tests/integration/bot-customization.test.ts`

**用户可见结果：**Bot 使用用户定义的身份、语气和真实 Skill；员工不能通过消息启用未批准能力。

**验收条件：**

- [ ] 指令权威顺序为：服务端规则 > AGENTS > 当前启用 Skill > SOUL > 员工请求。
- [ ] SOUL 只影响身份、语气和表达，不改变身份、Dataset、Tool 或数据安全规则。
- [ ] 使用 Mastra 原生 filesystem Skills，不创建自研 Skill 引擎。
- [ ] 只向 Agent提供 `bot.yaml` 启用的 Skill。
- [ ] 员工不能通过 `/xxx` 安装、选择或强制执行 Skill。
- [ ] 不创建 Workspace 或 Sandbox；普通 Agent 不能执行任意 Skill 脚本。专用 `knowledge-search` Tool 固定调用检索脚本的实现归 T27，不在 T16 开放通用执行能力。
- [ ] `/new` 由 Kairo 处理，不属于 Skill。

**测试场景：**

- [ ] 真实 Skill 的名称、description 和 `SKILL.md` 可被发现。
- [ ] 自然语言匹配时选择真实 Skill。
- [ ] 无关请求不强制选择 Skill。
- [ ] 未启用 Skill 目录不能被员工消息绕过 allowlist。
- [ ] Skill 文本尝试覆盖 Dataset/Tool 权限时无效。
- [ ] scripts 目录存在时普通 Agent 仍没有脚本执行能力；尚未注册 T27 专用 Tool 时也不能借 Skill 说明执行脚本。

**执行命令：**

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/bot-customization.test.ts
```

**真实环境验证：**使用用户真实 Skill 对应问题和一个相似但不应触发的问题，由用户观察选择结果与表达风格。

---

## T17：统一日志、错误与 localhost 健康接口

**说明：**建立应用级结构化日志、稳定错误类型和只读运行状态接口。

**前置依赖：**T03、T15。

**修改文件（5）：**

- `apps/kairo/src/modules/operability/logger.ts`
- `apps/kairo/src/modules/operability/errors.ts`
- `apps/kairo/src/modules/operability/health.ts`
- `apps/kairo/src/modules/operability/health-server.ts`
- `apps/kairo/tests/unit/operability.test.ts`

**用户可见结果：**员工收到普通中文失败说明；维护人员可从本机判断未就绪、降级或正常。

**验收条件：**

- [ ] Pino 日志只记录 message/session/employee/context/task/run/tool/evidence ID、耗时、状态和错误类型。
- [ ] redact 覆盖 password、token、apiKey、authorization、问题正文、答案正文和知识片段。
- [ ] 错误类型区分配置、身份、存储、Driver、模型、知识服务、超时、取消和发送不明。
- [ ] 健康接口仅绑定 `127.0.0.1` 或 `localhost`。
- [ ] 只提供 live、ready、dependencies 等只读状态，不提供 Agent/Tool/Workflow 执行入口。
- [ ] ready 需要配置、PostgreSQL、Mastra 和 Driver 正常；RAGFlow/模型离线为 degraded。

**测试场景：**

- [ ] 日志字段可关联，但无正文和凭证。
- [ ] 未就绪、降级、正常三种状态。
- [ ] 非回环 host 配置被拒绝。
- [ ] 健康响应不泄露连接串、key 或员工内容。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/operability.test.ts
pnpm --filter @kairo/app typecheck
```

**真实环境验证：**从本机访问健康端点；从局域网地址访问应失败。真机运行后抽查日志。

---

## T18：持久化原始消息、聚合批次、context 与提示限频

**说明：**建立私聊最小账本，使重复消息、正在合并的输入和当前 thread 能在重启后恢复。

**前置依赖：**T10、T15。

**修改文件（4）：**

- `apps/kairo/migrations/000003-private-chat.sql`
- `apps/kairo/src/modules/private-chat-core/types.ts`
- `apps/kairo/src/modules/private-chat-core/store.ts`
- `apps/kairo/tests/integration/private-chat-store.test.ts`

**用户可见结果：**重复上报不会重复回答；服务重启后尚未到期的分段输入不会无故丢失。

**验收条件：**

- [ ] `raw_messages` 对 `(session_id,message_id)` 建数据库唯一约束。
- [ ] 保存 direction、观察时间、文本、附件元数据、可信员工关联和处理结果。
- [ ] 身份尚未确认时允许原始消息的 employee 为空，确认后只能写入匹配身份。
- [ ] `message_batches` 保存首条时间、短静默截止时间、最长截止时间和当前状态。
- [ ] `batch_messages` 保留原始消息顺序。
- [ ] `contexts` 按 employee、bot、session 隔离，thread ID 全局唯一并带有效版本。
- [ ] `notice_limits` 支持身份失败等固定提示限频。
- [ ] 历史记录不因 2 小时空闲自动删除。

**测试场景：**

- [ ] 两个连接并发插入同一消息。
- [ ] 两个会话使用相同原生 messageId。
- [ ] 同员工不同会话、不同员工同名会话隔离。
- [ ] 批次内消息顺序和绝对截止时间。
- [ ] context 失效后创建新 thread，旧记录仍存在。
- [ ] 提示限频的首次、窗口内重复、窗口后恢复。

**执行命令：**

```bash
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app test:integration -- tests/integration/private-chat-store.test.ts
```

**真实环境验证：**使用真实 PostgreSQL 的两个连接并发写入；单线程 Mock 不算通过。

---

## T19：持久化任务、attempt 与等待员工状态

**说明：**建立阶段一任务状态账本，并以条件更新防止迟到结果覆盖终态。

**前置依赖：**T18。

**修改文件（4）：**

- `apps/kairo/migrations/000004-tasks.sql`
- `apps/kairo/src/modules/task-lifecycle/types.ts`
- `apps/kairo/src/modules/task-lifecycle/store.ts`
- `apps/kairo/tests/integration/task-store.test.ts`

**用户可见结果：**任务不会因进程退出而无记录，也不会在取消或超时后被迟到结果改回成功。

**验收条件：**

- [ ] 支持 `queued`、`running`、`waiting_for_user`、`ready_to_send`、`sending`、`completed`、`failed`、`cancelled`、`timed_out`、`send_unconfirmed`。
- [ ] collecting 状态由 message batch 表达，不重复创建空 task。
- [ ] task 记录 employee、session、context/thread、输入版本、配置摘要、队列和执行绝对截止时间。
- [ ] attempt 记录 attemptId、runId、开始/结束时间、错误类别、是否被采用。
- [ ] user wait 记录问题、允许的回答关联和 10 分钟绝对截止时间。
- [ ] 状态变化使用 compare-and-set 或等价条件更新；终态不可倒退。
- [ ] 两个 worker 竞争时只有一个能把任务从 queued 变为 running。

**测试场景：**

- [ ] 所有合法状态变化。
- [ ] 非法跨状态和终态倒退。
- [ ] 两个连接并发领取。
- [ ] 重启后保留原队列/执行截止时间。
- [ ] 输入版本改变后旧 attempt 结果不可采用。

**执行命令：**

```bash
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app test:integration -- tests/integration/task-store.test.ts
```

**真实环境验证：**真实 PostgreSQL 双连接竞争同一 queued task。

---

## T20：持久化知识证据、Memory commit、反馈与启动记录

**说明：**保存员工不可见但维护所需的证据链，以及送达后 Memory 提交的恢复状态。

**前置依赖：**T19。

**修改文件（4）：**

- `apps/kairo/migrations/000005-knowledge-memory.sql`
- `apps/kairo/src/modules/knowledge-qa/knowledge-record-store.ts`
- `apps/kairo/src/modules/agent-runtime/memory-commit-store.ts`
- `apps/kairo/tests/integration/knowledge-record-store.test.ts`

**用户可见结果：**员工回复不显示来源；维护人员可按 taskId 查看问题、答案、内部资料、反馈和当时配置。

**验收条件：**

- [ ] 保存每次 knowledge Tool query、调用次序、耗时和结果类别。
- [ ] 保存文档、片段、页码/positions、内部 ID、相似度和冲突标记；正文只进入业务表。
- [ ] feedback 关联原问题、正式回答和证据，员工提供的正确答案标记为未验证。
- [ ] memory commit 支持 `pending`、`saved`、`observed` 和稳定正式消息 ID。
- [ ] runtime boot 保存 Git commit、配置摘要、启动/关闭时间和状态。
- [ ] 关键查询列有索引并支持分页。
- [ ] 不增加自动清理任务；阶段一业务记录长期保存。

**测试场景：**

- [ ] 多次检索与一个 task 关联。
- [ ] 有结果、无结果、格式错误、服务错误和冲突证据。
- [ ] feedback 不进入企业事实或 Memory commit。
- [ ] memory commit 的重复写入与状态前进。
- [ ] 按 taskId 分页查询完整链路。

**执行命令：**

```bash
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app test:integration -- tests/integration/knowledge-record-store.test.ts
```

**真实环境验证：**使用 PostgreSQL 管理工具按 taskId 核对完整记录，并确认普通日志中没有正文。

---

# Checkpoint B：配置与可恢复业务事实

- [ ] 无效 Bot 配置阻止服务进入 ready。
- [ ] 用户提供的 SOUL、AGENTS 和真实 Skill 可加载，且不能覆盖服务端规则。
- [ ] `kairo` 和 `mastra` schema 由迁移账号建立，运行启动不做 DDL。
- [ ] 原始消息、批次、context、任务、attempt、发送、证据、反馈和 Memory commit 均可按 ID 查询。
- [ ] 唯一约束与条件更新的并发测试通过。
- [ ] 普通日志无员工问题、Bot 回答、知识片段或凭证。
- [ ] 执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过。



---

# 阶段 C：私聊、发送、队列与恢复

## T21：实现统一出站发送协调器

**说明：**所有固定提示、排队通知、进度通知和最终回答统一经过同一发送策略。

**前置依赖：**T06、T07、T10、T17、T19。

**修改文件（4）：**

- `apps/kairo/src/modules/im-transport/send-service.ts`
- `apps/kairo/src/modules/im-transport/send-policy.ts`
- `apps/kairo/tests/unit/send-service.test.ts`
- `apps/kairo/tests/integration/send-service.test.ts`

**用户可见结果：**发送结果不明确时不会立即收到重复消息；后续会话任务不会永久卡住。

**验收条件：**

- [ ] 每种 task/purpose 在调用 Driver 前生成并持久化唯一 operationId。
- [ ] delivered 立即完成该发送操作。
- [ ] failed 使用同一个 operationId 最多自动重试 1 次。
- [ ] unknown 不立即重发；最多等待 30 秒后只调用一次 `getSendStatus()`。
- [ ] 查询后 delivered 正常完成；failed 同 ID 重试；仍 unknown 标为 `send_unconfirmed` 并释放后续队列。
- [ ] 同一 task 的排队提示、进度提示和最终回答各有独立且唯一 purpose。
- [ ] PostgreSQL 完全不可用时，只有固定存储故障提示可走尽力发送例外；不创建任务、不补发。
- [ ] 所有发送在交付前检查 task/context 仍有效。

**测试场景：**

- [ ] delivered、failed 后成功、failed 两次、unknown 后 delivered、unknown 后 failed、unknown 仍 unknown。
- [ ] 同一事件重复调用协调器。
- [ ] `/new` 在 ready_to_send 与 sending 之间到达。
- [ ] 30 秒查询计时与进程重启。
- [ ] 数据库全不可用固定提示使用确定性 operationId，当前进程内不重复。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/send-service.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/send-service.test.ts
```

**真实环境验证：**T34 验证跨进程；T35 验证真实 KK9 delivered/failed/unknown。

---

## T22：实现 direction、员工身份、allowlist 与持久去重

**说明：**建立真实私聊入站门禁，只有可信、开放且首次收到的员工消息才能进入聚合。

**前置依赖：**T04、T15、T18、T21。

**修改文件（4）：**

- `apps/kairo/src/modules/im-transport/driver-adapter.ts`
- `apps/kairo/src/modules/private-chat-core/ingress.ts`
- `apps/kairo/tests/unit/ingress.test.ts`
- `apps/kairo/tests/integration/ingress-dedup.test.ts`

**用户可见结果：**

- 未在试用名单：`当前功能仍在试用，暂未向你开放`。
- 私聊身份失败且通过限频：`暂时无法确认您的员工身份，请稍后重试或联系维护人员`。
- 群聊、Bot 回显或方向不明：不回复、不进入 Agent。

**验收条件：**

- [ ] `direction=outbound` 直接忽略；`unknown` 只记录诊断；只有 inbound 继续。
- [ ] 先以 `(sessionId,messageId)` 原子插入原始消息；唯一冲突直接结束。
- [ ] 只把 Driver 产生的 `message.sessionId` 传给 `getEmployeeBySession()`。
- [ ] 阶段一只接受严格 `0-<数字UID>` 私聊。
- [ ] `String(employee.id)` 必须等于会话 UID；员工消息正文、昵称和 senderId 不能切换身份。
- [ ] employee UID 不在 allowlist 时不创建 context batch、task、Memory 或知识调用。
- [ ] 群聊、讨论组、服务号和无法识别的会话只记录诊断。
- [ ] 身份失败提示使用持久限频，避免同一异常反复刷屏。

**测试场景：**

- [ ] inbound/outbound/unknown。
- [ ] 两个会话相同 messageId 和同一会话重复 messageId。
- [ ] EventBridge 与轮询重复上报。
- [ ] 有效员工、档案为空、UID 错配、非法 `0-abc`。
- [ ] allowlist 内外员工。
- [ ] 消息正文伪造另一名员工 UID。
- [ ] 身份失败提示限频。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/ingress.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/ingress-dedup.test.ts
```

**真实环境验证：**T35 使用两个员工和一个 Bot；验证 UID、sessionId 和客户端重启后的稳定性。

---

## T23：实现 5秒/60秒消息合并与阶段一输入拒绝

**说明：**把同员工同会话的连续文本组成一次输入，并在附件或上限不符合时停止在 Agent 前。

**前置依赖：**T18、T22。

**实际实现与测试文件（10）：**

- `apps/kairo/src/modules/private-chat-core/collector.ts`
- `apps/kairo/src/modules/private-chat-core/input-policy.ts`
- `apps/kairo/tests/unit/collector.test.ts`
- `apps/kairo/tests/integration/collector-recovery.test.ts`
- `apps/kairo/src/modules/private-chat-core/collector-types.ts`
- `apps/kairo/src/modules/private-chat-core/store.ts`
- `apps/kairo/migrations/000011-collector-settlement.sql`
- `apps/kairo/tests/unit/input-policy.test.ts`
- `apps/kairo/tests/helpers/collector-runtime.ts`
- `apps/kairo/tests/integration/collector-recovery-concurrency.test.ts`

**用户可见结果：**

- 停止发送 5 秒后，分段内容作为一次问题处理。
- 超过限制：`内容过长，请缩短问题；文件处理功能将在后续阶段提供`。
- 含附件：`当前暂不支持文件处理，请先使用文字描述需求`。

**验收条件：**

- [x] 短静默默认 5 秒，每条普通消息到达后重置。
- [x] 最长聚合默认 60 秒，从第一条开始且不重置。
- [x] 任一计时先到即提交当前批次。
- [x] 同一批次最多 10 条、合计最多 30000 字；边界值允许，超过即整批拒绝。
- [x] 不截断、不调用 Agent；原始消息仍保留。
- [x] 任意文件、图片或附件导致整批拒绝，不读取、不下载、不检索。
- [x] 不同员工或不同会话永不合并。
- [x] Agent 已开始后到达的消息进入下一批，不取消或重跑当前任务。
- [x] 重启恢复两个计时器的剩余时间；期限已过时立即结束批次。

**测试场景：**

- [x] 5 秒静默、持续发送触发 60 秒。
- [x] 第 10 条/第 11 条，30000/30001 字。
- [x] 空文本、纯空白、多字节中文计数。
- [x] 先文字后附件、先附件后文字。
- [x] 两员工交错消息。
- [x] 重启时静默剩余、最长剩余和均已到期。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/collector.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery
```

**真实环境验证：**T35 验证三段发送、持续发送、附件拒绝和 Agent 运行中补充消息。

**本次实现验收（2026-09-09）：**定向单元24项、App默认327项、真实PostgreSQL恢复23项、受影响账本回归111项通过；迁移专题2项通过、6项按名称排除。原生计时烟测实际60.103秒结束最长批次，覆盖静默/最长剩余、全过期和/new旧批不复活。最长场景使用现有quietMs=10000及7条每9秒消息，避免默认5秒/10条先拒绝，正式YAML不变。运行中补充通过真实任务账本、attempt及AbortController验证，不冒充真实Agent运行；FakeDriver出站不替代上述T35真机。精确命令和历史失败见docs/DEVELOPMENT.md的T23节，不合并、不关闭issue。

---

## T24：实现 `/new` 与 2 小时 context 边界

**说明：**精确识别 `/new`，立即使旧 context 失效；按最终任务结果计算近期上下文空闲时间。

**前置依赖：**T12、T18、T19、T21。

**修改文件（4）：**

- `apps/kairo/src/modules/private-chat-core/control-message.ts`
- `apps/kairo/src/modules/private-chat-core/context-service.ts`
- `apps/kairo/tests/unit/context-service.test.ts`
- `apps/kairo/tests/integration/new-context.test.ts`

**用户可见结果：**

- 无未完成任务：`已开始新对话。`
- 有未完成任务：`已开始新对话，之前未完成的任务已取消。`

**验收条件：**

- [ ] 仅去除首尾空白后整条纯文本等于 `/new` 且无附件时触发。
- [ ] 包含 `/new` 的普通句子、带参数命令、`/clear`、`/cancel` 和其他 `/xxx` 不触发。
- [ ] `/new` 不进入消息聚合或 Agent。
- [ ] 立即废弃 collecting batch、取消 queued、请求停止 running、取消 waiting_for_user。
- [ ] 已生成但未交给 Driver 的旧答案不得发送。
- [ ] 立即创建全局唯一的新 thread，不等待旧 Agent 真正退出。
- [ ] 迟到结果和 Tool 输出在交付前因 context 版本不匹配被丢弃。
- [ ] 默认空闲 2 小时后新请求创建新 thread，但不删除历史。
- [ ] 空闲起点严格遵守 delivered、send unconfirmed、失败、取消和超时规则；进度提示不重置。

**测试场景：**

- [ ] 精确 `/new`、前后空白、普通句子、带参数、带附件。
- [ ] collecting、queued、running、waiting_for_user、ready_to_send。
- [ ] 底层无法及时 Abort，迟到结果仍不交付。
- [ ] 2 小时前、恰好 2 小时、超过 2 小时。
- [ ] delivered、send unknown、失败/取消/超时的不同空闲起点。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/context-service.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/new-context.test.ts
```

**真实环境验证：**T35 在无任务、排队、执行和等待员工回答时分别发送 `/new`。

---

## T25：实现同会话队列、全局并发与时间通知

**说明：**使用 PostgreSQL task 状态和进程内 scheduler 保证同会话顺序、跨会话并行及所有时间边界。

**前置依赖：**T19、T21、T23、T24。

**修改文件（5）：**

- `apps/kairo/src/modules/task-lifecycle/scheduler.ts`
- `apps/kairo/src/modules/task-lifecycle/task-runner.ts`
- `apps/kairo/src/modules/task-lifecycle/deadlines.ts`
- `apps/kairo/tests/unit/scheduler.test.ts`
- `apps/kairo/tests/integration/scheduler.test.ts`

**用户可见结果：**

- 会话已有任务时只提示一次：`已收到，将在当前任务完成后处理`。
- 执行超过 10 秒只提示一次：`正在查询企业知识，请稍候`。
- 队列满时提示稍后再试或使用 `/new`，不显示预计时间和队列位置。
- 排队超过 10 分钟：`该请求等待时间过长，已取消，请重新发送`。
- 执行超过 4 分钟：`本次查询超时，请稍后重试`。

**验收条件：**

- [ ] 同一 Bot、同一会话最多 1 个 running。
- [ ] 每会话最多 3 个 queued；超过时保留原始消息但不创建 task。
- [ ] 全局默认最多 3 个 Agent running；不同会话可并行。
- [ ] 排队提示、进度提示分别只发送一次并通过唯一 purpose 防重。
- [ ] 10 秒内完成不发送进度；超过 10 秒只发送一次。
- [ ] 排队 10 分钟和执行 4 分钟使用不同绝对截止时间。
- [ ] 四分钟到期触发 AbortController，迟到结果不可交付。
- [ ] 外部只读请求首次和一次临时重试共享同一四分钟预算。
- [ ] waiting_for_user 阻塞同会话后续队列。

**测试场景：**

- [ ] 同会话两个、四个、五个任务。
- [ ] 三个会话并行和第四个等待全局槽位。
- [ ] 9.999 秒、10 秒、10.001 秒进度。
- [ ] 排队和执行截止边界。
- [ ] `/new` 与领取任务竞争。
- [ ] waiting_for_user 不被后续任务越过。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/scheduler.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/scheduler.test.ts
```

**真实环境验证：**T35 使用两个员工并发、同一员工连续提问和慢查询验证顺序与通知。

---

## T26：实现启动恢复与 Driver 重连监督

**说明：**恢复可安全恢复的状态；Driver 连接失效时取消旧 generation，避免旧结果进入新连接。

**前置依赖：**T06、T18、T19、T21、T25。

**修改文件（4）：**

- `apps/kairo/src/modules/task-lifecycle/recovery.ts`
- `apps/kairo/src/modules/im-transport/driver-supervisor.ts`
- `apps/kairo/tests/unit/recovery.test.ts`
- `apps/kairo/tests/integration/recovery.test.ts`

**用户可见结果：**重启后不会直接重发已进入发送阶段的答案；Driver 断线后的旧结果不会迟到交付。

**验收条件：**

- [ ] collecting 恢复剩余静默/最长时间，已到期立即形成输入。
- [ ] queued 未超过原 10 分钟截止时间时恢复排队，超过则 timed_out。
- [ ] running 的只读知识任务仅在原 4 分钟截止前新增 1 个 attempt；不重置预算。
- [ ] sending 先调用 `getSendStatus()`，不得直接重新生成或重发。
- [ ] 已向员工报告失败的任务保持终态，不自动执行。
- [ ] Memory pending 状态交给 T32 的幂等恢复处理。
- [ ] Driver 断线停止 intake，使旧 startupGenerationId 失效并取消所有未完成任务。
- [ ] 自动创建新 Driver 连接；恢复后只处理新收到的消息，不补做断线期间旧消息。
- [ ] 旧 Agent/Tool 的迟到结果因 generation/context/task 状态失效而丢弃。

**测试场景：**

- [ ] collecting、queued、running、sending、waiting_for_user 各状态重启。
- [ ] 原截止时间已过和未过。
- [ ] running 重启一次和再次重启。
- [ ] sending 查询 delivered/failed/unknown。
- [ ] Driver connection_lost 与 Agent 完成并发。
- [ ] 新 Driver generation 接收新消息，旧 generation 结果被拒绝。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/recovery.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/recovery.test.ts
```

**真实环境验证：**T34 进行跨进程恢复；T35 关闭/恢复 KK9 CDP 连接验证真实 generation 行为。

---

# Checkpoint C：私聊任务闭环

- [ ] outbound/unknown/非私聊不会进入身份、Memory 或知识检索。
- [ ] 两个员工的 UID、context、batch、task 和通知不串用。
- [ ] `(sessionId,messageId)` 跨 EventBridge/轮询重复只处理一次。
- [ ] 5秒/60秒、10条/30000字和附件拒绝测试通过。
- [ ] `/new`、2小时 context 和迟到结果测试通过。
- [ ] 每会话顺序、队列3、全局并发3、10分钟/4分钟/10秒规则通过。
- [ ] delivered/failed/unknown 和 30 秒查询行为通过。
- [ ] collecting、queued、running、sending 的重启恢复通过。
- [ ] 执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过。



---

# 阶段 D：知识问答、Agent 与正式 Memory

## T27：实现定制 RAGFlow Skill、专用知识 Tool 与 Python 检索链路

**说明：**实现 T14 确认的“定制 RAGFlow Skill + 专用 `knowledge-search` Tool + 复用 Python 检索脚本”。这是正式接入的实施任务；不是另写 TypeScript HTTP 客户端，也不是让 Agent 自由执行上游 Skill 的管理命令。

**前置依赖：**T14、T15、T17、T20。选择方案不等于依赖任务已经验收完成。

**正式调用链：**

```text
Mastra Agent 加载定制 Skill 的说明
  → 调用仅接收 query 的 knowledge-search
  → Kairo 固定注入 Dataset/凭证并启动选定 Python 脚本
  → 脚本调用 RAGFlow HTTP Retrieval API
  → 专用 Tool 校验结构化结果并返回资料或明确错误
```

**实施范围：**

- 以 T14 核对的 `ragflow-skill` 为基础，只保留检索所需说明、`search.py` 与其必要依赖；记录来源、版本和许可证，不引入整套上传、修改、删除、解析或模型管理能力。
- 定制 Skill 描述检索时机、最少查询内容和如何使用企业资料；删除直接操作管理脚本、向员工输出内部 ID/来源列表等不适用说明。
- 裁剪 Python 查询入口：只接受查询文本；Dataset 和凭证由 Kairo 受控注入，不能由模型或命令参数覆盖。移除 `top_k=5` 等上游默认参数和备用 `retrieval_test` 路径，只调用一个 Retrieval API。
- TypeScript 只负责专用 Tool、固定脚本调用、预算/取消、结果校验和业务证据接入；不复制 Python 的 HTTP 检索实现。
- 使用已有 Mastra/Node 进程执行能力中满足合同的最简单方式，固定程序、脚本和参数，不拼接模型提供的 shell 命令；不向业务 Agent 暴露 `execute_command` 或任意脚本执行能力。
- 修正上游脚本的缺失数据、字段类型及错误输出行为。返回稳定结构化 JSON，保留诊断所需的 HTTP 状态与业务错误码；Python 和 TypeScript 不分别重试导致次数相乘。
- 明确 Python 运行环境与启动检查、配置说明、来源许可及相关依赖；遵循现有 Skill 配置目录，不提前固定未经核对的文件数量或增加通用执行框架。

**主要涉及位置：**

- `apps/kairo/src/modules/tool-integration/knowledge-tool.ts`
- `apps/kairo/src/modules/tool-integration/` 中的固定 Python 脚本调用与结果合同，复用既有模式，不强制新增两层 connector 抽象
- 受控 Bot 配置中的定制 Skill 目录及其检索脚本
- `apps/kairo/tests/unit/knowledge-tool.test.ts`
- `apps/kairo/tests/integration/ragflow-connector.test.ts`
- 必要的运行配置、依赖声明与开发文档；不修改 Driver 职责

**用户可见结果：**Bot 只查询固定企业 Dataset；知识服务错误不会被说成“没有资料”。

**验收条件：**

- [ ] 正式代码只有“Skill + 专用 Tool + Python HTTP 检索”一条调用链，不保留 MCP、备用 API、TypeScript 直连检索或运行时自动切换。
- [ ] Mastra 能加载并使用定制 Skill；Tool 的业务输入只有当前最小查询文字 `query`，不接受程序名、脚本路径或任意命令。
- [ ] Dataset ID 由服务端固定注入，初始使用 ERP；模型不能提供或覆盖。凭证只进入所需执行环境，不进入 Skill 内容、模型上下文、命令行或普通日志。
- [ ] HTTP 请求只发送当前检索所需 `question` 和固定 `dataset_ids`，不发送完整 thread、Observational Memory、历史消息、employeeId、sessionId 或 taskId。
- [ ] 其他检索参数使用 RAGFlow 接口默认值，不注入上游 Skill 的 `top_k=5` 等默认数字，也不新增检索调参配置；明确不会自动跟随 RAGFlow 网页设置。
- [ ] 不向 Agent 暴露管理脚本、原始 Dataset/Chat tools、通用 shell 或任意脚本执行工具。Skill 中的说明不能替代代码中的固定执行边界。
- [ ] 外部结果先校验格式，返回可区分结果：有资料、无资料、认证/权限、参数错误、临时故障、格式错误；缺失 `data`/`chunks`、非对象 chunk 和字段类型错误不能被静默丢弃或转换为空结果。
- [ ] 只有成功且有效 chunks 为空才是“无资料”。保留 chunk/document/Dataset 标识、名称、positions 和相似度等内部证据，不猜测缺失页码。
- [ ] 正确处理 HTTP 200 但业务 code 非零的结果；错误 Dataset 和错误参数可能同为 code 102，不使用错误码单独推定所有分类。无法可靠归类的错误保留诊断信息并明确失败，不当作无结果。
- [ ] 网络错误、429、5xx 最多自动重试 1 次；认证、参数、无资料和取消不重试。只在一个明确层次负责重试。
- [ ] 首次与重试共享 task 四分钟总预算；AbortSignal 能终止实际在途脚本调用及本地网络等待，进程正确回收，不残留后台重试。不能宣称杀掉 Python 等于取消远端 RAGFlow 计算。
- [ ] Python 缺失、脚本启动失败、非零退出、无效 JSON 和输出读取失败均有明确错误；不能静默降级到另一个实现。
- [ ] 保存调用次数、耗时、结果类别和内部证据；普通日志不记录 query/chunk 正文或凭证，证据关联在 Kairo 内完成。
- [ ] RAGFlow 返回文字始终是非可信资料，不能成为系统指令；资料不能改变 Tool、Dataset 或脚本执行范围。

**测试场景：**

- [ ] Mastra 加载定制 Skill，通过专用 Tool 调用真实 Python 脚本，固定 ERP 检索有资料和无资料。
- [ ] 错误 key、无权限、错误 Dataset、错误参数及 HTTP 200 业务错误。
- [ ] HTTP 成功但 `data`/`chunks` 缺失、chunk 类型错误、正文/元数据格式错误，不得误报无资料。
- [ ] 429、5xx、网络断开与恢复的一次重试；确认两端重试没有叠加。
- [ ] 在途 Abort、总预算到期、进程退出清理；取消后新请求可以成功。
- [ ] Python/脚本不可启动、脚本非零退出、输出无效 JSON、stdout/stderr 读取异常。
- [ ] Agent 输入尝试修改 Dataset、阈值、凭证、脚本路径或注入命令，无法改变真实检索/执行目标。
- [ ] 对发出的真实请求核对最少数据范围；内部证据可供业务使用，员工输出不包含内部 ID 或来源列表。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/knowledge-tool.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/ragflow-connector.test.ts
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app build
```

**真实环境验证：**必须运行完整 Skill → 专用 Tool → Python → ERP 链路；直接 HTTP 调用或假 Python 输出不能替代。验证有结果、空结果、错误 key、格式、超时、取消、断线恢复和 positions/page 映射。受控本地故障注入与真实 RAGFlow 样本分别记录，不擅自重启或修改 RAGFlow。

---

## T28：装配唯一 Mastra Agent

**说明：**加载批准模型、服务端规则、SOUL、AGENTS、真实 Skill、thread Memory 和 `knowledge-search`，返回结构化完整结果。

**前置依赖：**T12、T13、T16、T25、T27。

**修改文件（5）：**

- `apps/kairo/src/mastra/agent.ts`
- `apps/kairo/src/mastra/index.ts`
- `apps/kairo/src/modules/agent-runtime/run-agent.ts`
- `apps/kairo/src/modules/knowledge-qa/answer-schema.ts`
- `apps/kairo/tests/integration/agent-runtime.test.ts`

**用户可见结果：**Agent 完整生成一条普通文本结果；员工看不到流式半成品，运行故障不会自动切换模型。

**验收条件：**

- [ ] 只创建并注册一个阶段一 Agent。
- [ ] 使用 `bot.yaml` 中唯一批准模型，不配置 fallback。
- [ ] 主 Agent、Observer 和 Reflector 使用同一个模型。
- [ ] 使用非流式 `generate()`；业务 attemptId 作为 runId。
- [ ] 传入 task AbortSignal、`resource=employeeId`、`thread=contextId` 和 `memory.options.readOnly=true`。
- [ ] 只注册 `knowledge-search` 与 `bot.yaml` 启用的 filesystem Skills。
- [ ] 明确企业问题默认必须先检索；只有员工明确要求通用知识时才能跳过。
- [ ] 输出结构严格分离答案正文、回答类型、当前证据引用、子问题结果和内部诊断。
- [ ] `maxSteps` 是 Agent 循环安全边界，不限制固定知识查询次数。
- [ ] Agent 不负责 IM 发送、任务排队或状态真相。

**测试场景：**

- [ ] 企业问题触发知识 Tool。
- [ ] 明确“按通用知识回答”跳过知识 Tool。
- [ ] 模型试图返回未注册 Tool 或修改 Dataset。
- [ ] 多次知识查询仍在四分钟预算内。
- [ ] AbortSignal 到 Agent 和 Tool。
- [ ] 真实 Skill 自然语言选择。
- [ ] 输出 schema 不合法时按系统错误处理。

**执行命令：**

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/agent-runtime.test.ts
```

**真实环境验证：**使用最终批准模型运行企业问题、明确通用问题、需要多次检索的问题和真实 Skill 问题。

---

## T29：实现企业答案证据检查与首个完整回答闭环

**说明：**把 Agent 结构化结果与当前任务证据核对，只发送答案正文，并阻止无依据企业结论和内部来源泄漏。

**前置依赖：**T20、T21、T27、T28。

**修改文件（4）：**

- `apps/kairo/src/modules/knowledge-qa/validate-answer.ts`
- `apps/kairo/src/modules/knowledge-qa/knowledge-service.ts`
- `apps/kairo/tests/unit/answer-validation.test.ts`
- `apps/kairo/tests/integration/enterprise-answer-flow.test.ts`

**用户可见结果：**有可靠企业资料时收到一条完整答案；员工回复不显示来源列表、链接、文档 ID、片段 ID 或相似度。

**验收条件：**

- [ ] 企业回答必须引用本 task 成功返回且非空的 evidence ID。
- [ ] evidence 必须属于当前 task/context，不能复用其他员工或旧任务证据。
- [ ] Kairo 只把结构化结果中的 answer 正文交给发送服务。
- [ ] 文档、片段、页码、RAGFlow ID、相似度和 Tool 原始结果只存业务表。
- [ ] answer 中出现本次已知内部 ID、来源列表字段或来源链接时拒绝模型原文。
- [ ] 未调用知识 Tool、返回为空、格式错误或证据检查失败时不得发送企业结论。
- [ ] RAGFlow 文档中的“忽略规则”“调用其他 Tool”等指令无效；诊断记录疑似 Prompt Injection。
- [ ] 任务/context 失效、取消或超时时，即使模型结果正确也不交付。
- [ ] delivered 前状态为 ready_to_send/sending；只有确认送达后 completed。
- [ ] 自然语言事实是否正确仍由真实回归题和人工判断，不伪装成程序可完全证明。

**测试场景：**

- [ ] 当前 task 有有效证据。
- [ ] 无 Tool 调用、空证据、其他 task 证据、旧 context 证据。
- [ ] answer 与内部 metadata 分离。
- [ ] answer 嵌入已知文档 ID、URL 或来源清单。
- [ ] 知识片段包含 Prompt Injection。
- [ ] `/new` 在生成后、发送前到达。
- [ ] delivered、failed、unknown 三种发送结果。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/answer-validation.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/enterprise-answer-flow.test.ts
```

**真实环境验证：**通过真实 IM 提问一个有明确企业依据的问题；在 PostgreSQL 核对证据，在员工消息中核对无来源和内部 ID。

---

## T30：实现无资料与通用知识一次性确认

**说明：**知识无结果或知识服务不可用时暂停当前任务，只有员工对当前问题明确同意后才使用通用知识。

**前置依赖：**T19、T21、T24、T28、T29。

**修改文件（4）：**

- `apps/kairo/src/modules/knowledge-qa/consent.ts`
- `apps/kairo/src/modules/knowledge-qa/waiting-service.ts`
- `apps/kairo/tests/unit/consent.test.ts`
- `apps/kairo/tests/integration/general-knowledge-flow.test.ts`

**用户可见结果：**

- 无资料：明确说明“未找到企业资料依据”，询问是否改用通用知识。
- RAGFlow 不可用：说明企业知识服务暂时不可用，并询问是否改用通用知识。
- 同意后的回答固定以 `【非企业资料】` 开头。

**验收条件：**

- [ ] 同一私聊同时只允许一个 `waiting_for_user`。
- [ ] 下一条明确“可以”“不用”等短回答优先关联当前等待，不创建新普通 task。
- [ ] 同意/拒绝使用保守确定性规则，不把含糊日常用语交给模型自由批准。
- [ ] 员工直接提出新问题时，旧等待结束，新问题按普通流程处理。
- [ ] waiting 最多 10 分钟；超时关闭当前问题。
- [ ] `/new` 立即取消 waiting。
- [ ] 同会话 queued task 不得越过 waiting。
- [ ] 授权只对当前问题或当前缺失子问题有效，不形成上下文偏好。
- [ ] 员工在原始问题中明确要求通用知识时，本次可直接授权并跳过 RAGFlow。
- [ ] 通用回答发送前自动添加前缀；模型不能自行省略。
- [ ] RAGFlow 故障不能伪装成无资料，也不能自动降级。

**测试场景：**

- [ ] 无资料后同意、拒绝、含糊回答。
- [ ] RAGFlow 不可用后同意。
- [ ] 直接提出新问题。
- [ ] 10 分钟边界和 `/new`。
- [ ] 后续 queued task 阻塞。
- [ ] 下一个企业问题重新检索。
- [ ] 多子问题只授权缺失部分。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/consent.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/general-knowledge-flow.test.ts
```

**真实环境验证：**通过真实 IM 完成同意、拒绝、直接新问题、等待超时和 `/new`；实际断开 RAGFlow但保持模型可用。

---

## T31：实现资料冲突、部分回答与负反馈

**说明：**按子问题处理证据，无法确定有效版本时拒绝选择；保存员工反馈但不把它变成企业事实。

**前置依赖：**T20、T21、T28、T29。

**修改文件（4）：**

- `apps/kairo/src/modules/knowledge-qa/result-policy.ts`
- `apps/kairo/src/modules/knowledge-qa/feedback-service.ts`
- `apps/kairo/tests/unit/result-policy.test.ts`
- `apps/kairo/tests/integration/knowledge-edge-cases.test.ts`

**用户可见结果：**

- 无法判断有效版本：`企业资料中存在不一致，当前无法确认，请联系知识维护人员`。
- 多子问题中，有依据部分正常回答，无依据部分明确说明，不整题补猜。
- 员工指出错误时，反馈被保存，可选择补充哪里不对。

**验收条件：**

- [ ] 只有明确可靠版本、生效时间或当前有效标记才能选择冲突资料。
- [ ] 无法判断时不让模型自行挑选；保存全部冲突 evidence 与检索上下文。
- [ ] 多子问题分别记录回答类型和 evidence。
- [ ] 局部缺失不导致已有依据部分被丢弃，也不允许补猜缺失部分。
- [ ] 反馈关联原问题、已送达回答和内部证据。
- [ ] 员工提供的“正确答案”标记为未验证，不进入 RAGFlow、企业事实、长期记忆或 Observational Memory。
- [ ] 反馈不会自动改变其他员工回答。

**测试场景：**

- [ ] 有明确当前版本的冲突资料。
- [ ] 无法判断版本的冲突资料。
- [ ] 全部命中、部分命中、全部无依据的多子问题。
- [ ] 员工只说“不对”和员工提供详细正确答案。
- [ ] 反馈后下一员工提问，仍只依据 RAGFlow。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/result-policy.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/knowledge-edge-cases.test.ts
```

**真实环境验证：**使用真实冲突资料、部分命中问题和一次真实员工负反馈，由用户/RAGFlow 管理人员人工判断。

---

## T32：实现 delivered 后正式 Memory 提交与恢复

**说明：**把 T12 验证过的 delayed-memory 合同接入任务发送状态，并对提交中断进行幂等恢复。

**前置依赖：**T12、T20、T21、T26、T28、T29。

**修改文件（5）：**

- `apps/kairo/src/modules/agent-runtime/memory-commit-service.ts`
- `apps/kairo/src/mastra/delayed-memory.ts`
- `apps/kairo/src/modules/task-lifecycle/recovery.ts`
- `apps/kairo/tests/unit/memory-commit.test.ts`
- `apps/kairo/tests/integration/memory-commit-recovery.test.ts`

**用户可见结果：**已确认送达的问答可以延续上下文；失败、取消、超时、证据失败或发送不明的草稿不会影响下一轮。

**验收条件：**

- [ ] 仅 SendStatus=delivered 且 task/context 仍有效时创建 pending commit。
- [ ] 正式 user/assistant 消息使用由 taskId、role、input version 确定的稳定 ID。
- [ ] 先 `saveMessages()`，成功后显式 `observe()`，再标记 observed。
- [ ] save 前崩溃、save 后崩溃、observe 后崩溃均可重复恢复且不重复正式消息。
- [ ] failed、cancelled、timed_out、validation failed、send_unconfirmed 不提交模型文本。
- [ ] 确定性失败/取消说明只有确认送达后才能作为正式 assistant 消息提交。
- [ ] 员工原问题只在对应正式轮次满足提交规则时进入 thread。
- [ ] `/new` 或 2 小时超时后的新 thread 不读取旧 thread observation。
- [ ] shutdown 前等待 `memory.settled()`，启动时扫描未完成 commit。
- [ ] Observational Memory 只用于当前 thread 连贯性，不能作为企业事实或身份来源。

**测试场景：**

- [ ] delivered 与所有非 delivered 终态。
- [ ] 三个崩溃点和重复恢复。
- [ ] 两个员工相同问题、不同 resource。
- [ ] 同员工 `/new` 前后两个 thread。
- [ ] send unknown 后稍晚实际送达但系统未确认。
- [ ] observation 不能替代下一轮企业检索。

**执行命令：**

```bash
pnpm --filter @kairo/app test -- tests/unit/memory-commit.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/memory-commit-recovery.test.ts
```

**真实环境验证：**真实 PostgreSQL 与批准模型；在 save 前、save 后和 observe 后分别强制终止进程并重启核对。

---

# Checkpoint D：知识回答与正式 Memory

- [ ] 正式代码只有“定制 Skill + 专用 `knowledge-search` Tool + 固定 Python 脚本 + HTTP Retrieval API”一条链路，没有 MCP、备用 endpoint 或 TypeScript 平行 HTTP 实现。
- [ ] Mastra 可加载定制 Skill；Tool 只能接收最小 `query`，固定 ERP Dataset、凭证、程序、脚本和命令不能由模型覆盖。
- [ ] 企业、无资料、通用知识、冲突、部分回答和服务错误测试通过。
- [ ] RAGFlow 格式错误不被当作无资料。
- [ ] Prompt Injection 资料不能改变系统规则或 Tool 权限。
- [ ] 员工答案不含来源列表、链接、内部 ID 或相似度。
- [ ] 只有 delivered 的正式内容进入 Mastra thread 和 Observational Memory。
- [ ] 两个员工与 `/new` 前后 thread 的 Memory 隔离通过。
- [ ] 执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过。



---

# 阶段 E：单进程装配、跨进程测试与真实放行

## T33：完成 Composition Root 与依赖状态管理

**说明：**在一个 Node.js 进程内按安全顺序装配配置、PostgreSQL、Mastra、Driver、恢复器、scheduler 和健康状态。

**前置依赖：**T17、T22、T25、T26、T27、T28、T32。

**修改文件（5）：**

- `apps/kairo/src/app.ts`
- `apps/kairo/src/index.ts`
- `apps/kairo/src/modules/operability/dependency-monitor.ts`
- `apps/kairo/src/modules/operability/health.ts`
- `apps/kairo/tests/integration/app-startup.test.ts`

**用户可见结果：**依赖正常时 Bot 可用；RAGFlow 或模型故障时给出明确降级行为；关键依赖缺失时不接收业务任务。

**验收条件：**

- [ ] 启动顺序为：加载/校验配置 → PostgreSQL → Mastra → 恢复持久状态 → Driver → 订阅消息 → ready。
- [ ] 配置无效、PostgreSQL不可用、Mastra 初始化失败或 Driver 未连接时不进入 ready。
- [ ] PostgreSQL 不可用但 Driver 收到新消息时，不创建 context/task/Agent；固定提示走 T21 的尽力发送例外。
- [ ] RAGFlow 已明确离线但模型可用时，新问题不进入执行队列；告知知识服务不可用并允许当前问题选择通用知识。
- [ ] 主模型已明确离线时，新问题不进入执行队列，提示服务暂时不可用。
- [ ] 故障前 queued task 仍受原 10 分钟截止时间；依赖恢复后只有未终结且未超时任务可继续。
- [ ] 已报告失败的 task 不因依赖恢复自动重跑。
- [ ] 依赖恢复后状态从 degraded 自动回到 normal。
- [ ] 模型恢复 probe 不包含员工问题、历史或知识片段；无独立健康 API 时仅依据明确失败证据降级。
- [ ] 生产不启用 Studio，不注册 Mastra 原生执行路由。
- [ ] 安全关闭顺序为：停止 intake → 取消/失效任务 → 等待 Memory settled → 关闭 Mastra/数据库/Driver。

**测试场景：**

- [ ] 正常启动和正常关闭。
- [ ] 配置、PostgreSQL、Mastra、Driver 分别在启动阶段失败。
- [ ] RAGFlow 离线、模型在线。
- [ ] 模型离线。
- [ ] 依赖故障与恢复，已失败 task 不重跑。
- [ ] shutdown 时仍有 running、sending 和 memory pending。
- [ ] 健康状态与技术日志一致。

**执行命令：**

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/app-startup.test.ts
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app dev
```

**真实环境验证：**依次断开/恢复真实 RAGFlow、模型连接和 Driver；检查 localhost 健康状态、日志和员工提示。

---

## T34：执行跨进程恢复与故障矩阵 E2E

**说明：**通过真实子进程退出和重新启动，证明持久任务、发送状态和 Memory commit 不依赖原进程内存。

**前置依赖：**T26、T32、T33。

**修改文件（4）：**

- `apps/kairo/tests/e2e/helpers/kairo-child.ts`
- `apps/kairo/tests/e2e/process-restart.test.ts`
- `apps/kairo/tests/e2e/failure-matrix.test.ts`
- `apps/kairo/package.json`

**用户可见结果：**服务重启后不会重复发送最终回答，也不会把旧草稿写入新上下文。

**验收条件：**

- [ ] 子进程 A 和 B 使用同一测试 PostgreSQL，但创建新的 Driver、Mastra 和进程内 scheduler 实例。
- [ ] 覆盖 collecting、queued、running、waiting_for_user、ready_to_send、sending、memory pending/saved。
- [ ] running 恢复仍使用原 4 分钟截止时间，且最多新增一个 attempt。
- [ ] sending 恢复先以同一 operationId 查询状态，不直接重新生成或重发。
- [ ] delivered 后、Memory save 前退出可在 B 中补交 Memory。
- [ ] `/new` 后旧进程迟到结果不进入新 context。
- [ ] 覆盖 PostgreSQL、RAGFlow、模型、Driver 的离线和恢复矩阵。
- [ ] PostgreSQL 完全不可用固定提示不在恢复后补发。
- [ ] 每个用例清理自己的测试 task/context/send operation，不删除其他测试数据。

**测试场景：**

- [ ] 每个可恢复状态分别 kill 子进程。
- [ ] sending 查询 delivered、failed、unknown。
- [ ] save/observe 三个崩溃点。
- [ ] 两个员工并行时只重启其中一个运行任务的执行进程。
- [ ] Driver generation 失效。
- [ ] 依赖在 10 分钟内恢复和超时后恢复。

**执行命令：**

```bash
pnpm --filter @kairo/app e2e:process
pnpm --filter @kairo/app e2e:failures
```

**真实环境验证：**必须使用真实 PostgreSQL；涉及 native operation 查询的用例还必须连接真实 KK9/CDP。纯 FakeDriver 只能覆盖离线分支，不能完成本任务全部验收。

---

## T35：执行双员工真实 IM 与知识回归放行

**说明：**使用一个真实 Bot、两个真实员工、真实非敏感 Dataset、真实问题和用户 Skill 完成阶段一最终验收。

**前置依赖：**T09、T29、T30、T31、T32、T33、T34。

**修改文件（5）：**

- `apps/kairo/tests/e2e/stage1-real-im.ts`
- `apps/kairo/tests/e2e/fixtures/knowledge-regression.yaml`
- `apps/kairo/package.json`
- `docs/DEVELOPMENT.md`
- `docs/KK9-STARTUP.md`

**用户可见结果：**至少两名 allowlist 员工可以在真实 KK9 私聊中持续使用企业知识问答，且互不串用上下文。

**验收条件：**

- [ ] E2E 要求显式确认 Bot UID、两个员工 UID、三个会话身份、Dataset、模型和副作用范围。
- [ ] `getEmployeeBySession()` 返回两名员工各自稳定 UID，并与 `0-<uid>` 一致。
- [ ] 客户端重启后 UID 稳定，消息 sessionId 与会话列表 ID 一致。
- [ ] 两员工同时提问可以并行，context、task、evidence、reply 和 Memory 不串用。
- [ ] 同一员工分三条消息提出一个问题，短静默后只创建一次输入。
- [ ] Agent 运行中补充消息进入下一轮，回复顺序正确。
- [ ] `/new` 取消旧 context 未完成内容并立即开始新 thread。
- [ ] Bot 回显不触发 Agent；跨 EventBridge/轮询重复消息只处理一次。
- [ ] 企业答案、无资料、通用知识确认、资料冲突、部分回答均通过真实问题。
- [ ] 员工 IM 中不出现来源列表、链接、RAGFlow ID、片段 ID 或相似度。
- [ ] 用户真实 Skill 被自然语言触发，未启用 Skill 不可调用。
- [ ] RAGFlow 不可用和模型不可用显示不同结果；依赖恢复不自动重跑已失败 task。
- [ ] 文本最终答案只发送一条，不做 Token 流式或人为分段。
- [ ] delivered、failed、unknown 和 30 秒查询通过真实发送验证。
- [ ] Kairo 重启与 Driver 断线/重连不重复发送、不补做旧消息。
- [ ] 知识回归问题至少包含：明确答案、无企业答案、企业/通用歧义、资料冲突、部分命中。
- [ ] 每次回归保存问题、答案和内部证据，最终正确性由用户人工判断。

**测试场景：**

- [ ] 员工 A/B 同时提问不同企业问题。
- [ ] 员工 A 分三段发送，员工 B 在其间提问。
- [ ] 员工 A 提供上下文后，员工 B 询问相似问题。
- [ ] 运行中补充、队列满、慢查询进度、排队/执行超时。
- [ ] `/new` 在 collecting、queued、running、waiting_for_user 时触发。
- [ ] 有资料、无资料、通用同意/拒绝、冲突、部分命中、负反馈。
- [ ] RAGFlow 断开/恢复、模型故障、Driver 断开/恢复、Kairo 进程重启。
- [ ] 真实 Skill 应触发/不应触发各一次。

**执行命令：**

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm --filter @kairo/driver e2e:stage1
pnpm --filter @kairo/app e2e
```

**真实环境验证：**本任务本身就是最终真实验证。必须使用 1 个 Bot、2 名 allowlist 员工、真实非敏感 Dataset、真实问题、最终模型和用户提供的真实 Skill。是否进入阶段二由用户根据实际使用直接决定。

---

# 最终 Checkpoint：阶段一放行

## 代码与范围

- [ ] 只实现阶段一企业知识问答。
- [ ] 没有文件处理、审批、群聊、长期个人记忆、知识 ACL、管理后台或多 Bot 功能。
- [ ] 没有 Redis、NATS、消息中间件、Sandbox、第二套业务数据库、MCP、备用 RAGFlow endpoint、TypeScript 平行 HTTP 检索或通用 shell/任意脚本执行工具。
- [ ] 各任务实际改动保持完成合同所需的最小范围，并与对应 Issue 一致；T27 不预先固定未经核对的文件数量，也不为凑分层增加 connector 抽象。

## Driver 与发送

- [ ] direction、operationId、三态和 `getSendStatus()` 通过单元与真机验证。
- [ ] legacy Driver 字段和既有调用方保持兼容。
- [ ] Bot 回显不会递归。
- [ ] unknown 不盲目重发，30 秒查询后会释放会话。
- [ ] 跨 Kairo/Driver 重启可以查询同一 operationId。

## 数据与 Mastra

- [ ] `kairo`、`mastra` schema 由迁移账号显式建立。
- [ ] 运行账号无 DDL 权限且服务可正常运行。
- [ ] 原始消息、任务、attempt、发送、证据、反馈、配置摘要和 Memory commit 可追踪。
- [ ] Observational Memory 只使用 thread scope 和批准主模型。
- [ ] 只有确认 delivered 的正式消息进入 thread/OM。

## 私聊与任务

- [ ] 身份只来自可信会话和员工档案；两个员工隔离。
- [ ] 持久去重、5秒/60秒聚合、10条/30000字、附件拒绝通过。
- [ ] `/new`、2小时 context、队列3、并发3、10分钟排队、4分钟执行、10秒进度通过。
- [ ] collecting、queued、running、sending、Memory commit 的重启行为通过。
- [ ] Driver 断线取消旧 generation，恢复后只处理新消息。

## 知识回答

- [ ] 定制 RAGFlow Skill → 专用 `knowledge-search` → 固定 Python 脚本 → HTTP Retrieval API 的正式链路通过，且没有第二知识连接通道。
- [ ] 企业答案有当前 task 证据，员工看不到来源或内部 ID。
- [ ] 无资料、通用知识一次性确认、冲突、部分回答和反馈行为正确。
- [ ] RAGFlow 返回格式错误、服务故障和无资料被准确区分。
- [ ] RAGFlow 文档中的指令不能改变系统规则。

## 测试与真实使用

- [ ] `pnpm build`、`pnpm typecheck`、`pnpm test`、`pnpm lint` 全部通过。
- [ ] PostgreSQL 与 Mastra 集成测试使用真实测试库通过。
- [ ] Driver 真机合同 E2E 通过。
- [ ] 跨进程恢复和故障矩阵 E2E 通过。
- [ ] 两名员工真实 IM 与知识回归通过。
- [ ] 用户已根据真实使用决定是否进入阶段二。

---

# 需求到任务映射

| 需求 | 任务 |
|---|---|
| Driver direction、回显 | T04、T08、T09 |
| operationId、三态、状态查询 | T05–T07、T10、T21、T34 |
| `apps/kairo` 与命令 | T01–T03、T33 |
| PostgreSQL `kairo` / `mastra` schema | T10–T12、T18–T20 |
| Bot 配置、SOUL、AGENTS、真实 Skill | T15、T16、T28、T35 |
| 私聊身份、allowlist、去重 | T18、T22、T35 |
| 消息合并、输入限制、附件拒绝 | T23、T35 |
| context 与 `/new` | T24、T26、T32、T35 |
| 排队、并发、超时、进度 | T19、T21、T25、T26、T34、T35 |
| 重启与 Driver 重连 | T26、T32–T35 |
| RAGFlow Skill 复用验证与正式 Python 检索链路 | T14、T27 |
| 企业答案与内部资料检查 | T20、T28、T29 |
| 无资料与通用知识确认 | T30 |
| 冲突、部分回答、反馈 | T31、T35 |
| 日志与运行状态 | T08、T17、T33 |
| delivered-only thread/OM | T12、T32、T34 |
| 双员工真实 IM | T35 |

# 可并行实施与冲突约束

- T01–T03 可与 T04 并行。
- T05 完成后，可并行推进 Driver T06–T09、数据库/Mastra T10–T13、RAGFlow T14。
- Checkpoint A 后，T15 与 T17 可并行；T16 等用户文件到位。
- 数据库迁移编号按 T18 → T19 → T20 串行，不允许两个任务同时新增同一序号。
- Checkpoint B 后，T21 与 T23 的纯规则部分可并行；T22 完成前不接真实消息。
- Checkpoint C 后，T27 与 T31 的纯规则测试可并行；T28 等最终 Tool 合同。
- `apps/kairo/package.json`、`pnpm-lock.yaml`、`apps/kairo/src/modules/task-lifecycle/recovery.ts`、`apps/kairo/src/mastra/delayed-memory.ts` 同一时间只由一个任务修改。
