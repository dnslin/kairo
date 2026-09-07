# Kairo Driver 与应用开发和验证

本仓库维护 `@kairo/driver` 与 `@kairo/app`。Driver 是一个面向 KK9 Windows 客户端的事件驱动 CDP Driver。

## 环境

- Node.js `>=22.13.0`
- pnpm
- 真实 KK9 验证需要 Windows 与可登录的 KK9 客户端

## 安装

```bash
pnpm install
```

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
```

以上四条根质量命令同时覆盖 `@kairo/driver` 与 `@kairo/app`；`pnpm format` 当前只格式化 Driver 文件。

`@kairo/app` 的 `typecheck` 使用 `apps/kairo/tsconfig.typecheck.json`，覆盖 `src`、`tests` 和 `vitest.config.ts`，不生成文件；`build` 仍使用 `apps/kairo/tsconfig.json`，只编译 `src`。应用直接声明 `@types/node` 与 `@types/pg`，数据库代码使用 `pg` 提供的类型接口，不再手写第三方模块声明。

默认 `pnpm test` 中的 App 测试排除 `tests/integration/**`，不要求 PostgreSQL 连接。显式执行 `pnpm --filter @kairo/app test:integration` 会加载仓库根目录 `.env` 并运行完整集成目录，覆盖发送操作存储与 Mastra 存储；缺少 `KAIRO_TEST_DATABASE_URL` 时 Mastra 集成测试会明确失败。请使用专用测试数据库：发送操作测试会在该库执行迁移和读写，Mastra 测试还需要创建、删除临时数据库的权限。

Driver 真机辅助命令：

```bash
pnpm verify
pnpm diagnose
pnpm e2e
```

运行真机命令前，先按 `KK9-STARTUP.md` 启动 KK9 与 CDP，并检查测试账号、会话和发送目标。`pnpm e2e` 还要求显式设置与实际用户、私聊 ID、群聊 ID 完全一致的 `KK9_REAL_TEST_CONFIRM`；离线测试不得替代真机验收。

### T12 延迟记忆合同

`createConversationMemory(storage, model)` 使用 thread 范围的 Observational Memory，Observer 和 Reflector 显式接收主 Agent 的同一个模型。默认只读生成，关闭语义召回、working memory 和自动标题；草稿不会通过这些路径写入正式上下文。

`commitDeliveredMemory(memory, delivery)` 只在 `status: 'delivered'` 时提交。调用方必须传入已通过检查、清洗后的员工正文和实际送达正文；不传整个模型响应、Tool 结果或 recalled history。消息 ID 由 `(threadId, taskId, role)` 确定，重放必须使用同一任务的原始正文与时间。保存完成后显式执行 `omEngine.observe()`，由 Mastra 按阈值决定是否需要压缩。错误直接向调用方传播。

正式 Memory 的时间表示送达轮次，不是原始入站时间：user 使用 `deliveredAt - 1ms`，assistant 使用 `deliveredAt`。这同时避免同毫秒问答倒序，以及排队期间收到的问题晚提交时被上一轮 observation 游标跳过。原始收发时间由业务记录保留；同任务重放必须沿用第一次确认的 `deliveredAt`。

本任务不实现任务恢复调度或会话队列。同一 thread 的正式提交由后续调用方串行执行；关闭时先 `await memory.settled()`，再 `await mastra.shutdown()`，最后关闭自行持有的存储连接。

定向运行（先进入 `apps/kairo` 目录）：

```bash
node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/integration/mastra-delayed-memory.spike.test.ts
```

默认使用真实 PostgreSQL 和确定性模型，只证明存储及框架合同，不代表真实模型放行。测试创建并删除随机临时数据库，覆盖只读输入、四种非送达状态、重复提交、save 前/save 后/observe 后的异常中断与新实例恢复、双员工隔离、新 thread 隔离及同模型观察/反思。这里模拟持久化边界中断，不是操作系统强杀进程；跨进程故障矩阵属于 T34。

真实模型门禁复用同一组测试。在本地 `.env` 配置以下变量，再执行上面的定向命令：

- `KAIRO_T12_REAL_MODEL=1`：显式启用真实模型；缺配置直接失败，不回退到替身。
- `KAIRO_T12_MODEL`：用户批准的 `供应商/模型` 标识。
- `KAIRO_T12_MODEL_URL`：批准的模型 API 地址。
- `KAIRO_T12_MODEL_API_KEY`：模型凭证，不提交到 Git。
- `KAIRO_TEST_DATABASE_URL`：有临时数据库创建和删除权限的专用 PostgreSQL 连接。
- `KAIRO_T12_MODEL_INTERVAL_MS`：可选的测试请求起始间隔，默认 `0`。遇到供应商每分钟 token 限流时可设为 `65000`；仅影响真实测试请求，不改变生产限流或重试策略。真实测试单项上限为 10 分钟，包含等待时间。

真实模式会将测试对话发送至指定模型，并产生模型调用费用。未使用最终批准模型通过该门禁前，不得以默认测试结果关闭 T12。

模型请求可因 429 重试，合同测试不固定请求尝试次数；仍要求重复正式提交不产生新的模型请求、正式消息不重复，以及观察和反思结果可读。限流导致最终调用失败时，测试继续明确失败。

接口依据：[Memory 只读配置](https://mastra.ai/reference/memory/memory-class)、[Observational Memory](https://mastra.ai/docs/memory/observational-memory)，并以锁定 `@mastra/core@1.63.2`、`@mastra/memory@1.28.1`、`@mastra/pg@1.22.2` 的类型和运行结果为准。

### T13 生产路由与 Studio 隔离

正式启动：

```bash
pnpm --filter @kairo/app build
pnpm --filter @kairo/app start
```

`start` 使用 Node 直接执行 `dist/index.js`，读取根目录 `.env` 中的 `DATABASE_URL`；系统环境变量优先。`dev` 先构建再启动同一个入口，不启动 Studio。生产构建仅运行 TypeScript 编译，不执行 `mastra build --studio`，也不打包 Studio UI。

`startKairo()` 先加载并校验受控 Bot 配置、读取 Git commit，再创建进程内 Mastra 和 PostgreSQL storage，唯一监听地址为 `127.0.0.1:4110`。`GET /health/live` 返回 `200 {"status":"alive"}`；其他路径和方法均返回 404，包括 Mastra Agent、Tool、Workflow 执行接口。该接口由 `modules/operability/health-server.ts` 提供，仅表示进程存活，不表示数据库、Driver 或 Agent 已就绪；T17 再接入依赖状态和 ready。当前不装配 T28 的业务 Agent。

收到 Ctrl+C 或 SIGTERM 后先关闭健康端口，再等待 `mastra.shutdown()`。锁定的 `@mastra/core@1.63.2` 会在 shutdown 内关闭注册的 storage，不再重复调用 `storage.close()`。程序内调用方使用返回的 `close()`，重复或并发关闭共用同一个 Promise。

开发 Studio 使用根目录独立的 `.env.studio`（已被 Git 忽略），不会自动读取正式 `.env`。配置以下实际值：

```dotenv
NODE_ENV=development
DATABASE_URL=postgresql://正式账号:密码@数据库主机/正式库名
KAIRO_PRODUCTION_DATASET_ID=正式DatasetID
KAIRO_PRODUCTION_EMPLOYEE_IDS=正式员工UID1,正式员工UID2
KAIRO_STUDIO_DATABASE_URL=postgresql://开发账号:密码@数据库主机/独立开发库名
KAIRO_STUDIO_DATASET_ID=测试DatasetID
KAIRO_STUDIO_EMPLOYEE_ID=测试员工UID
```

正式字段仅用于启动前比对；维护人员必须填写真实的正式比对值，不能用虚构值替代。`createStudioMastra()` 是统一的异步校验与创建入口，前置检查和 Studio 均等待该入口。数据库检查从现有 `createMastraStorage()` 生成的实际 Pool 配置解析最终库名，再将同一个已校验的开发 storage 交给 Mastra；不再用原始 URL 单独近似解析。正式比对 storage 只用于读取连接配置，不建立数据库连接，随后关闭；开发校验失败时也关闭候选 storage。正常运行仍由 Mastra 关闭其自有连接池，不引入外部 Pool 所有权。

开发库要求使用不同库名，即使在另一台服务器也不能与正式库同名。这样既覆盖不同账号、主机别名和 URL 编码，也覆盖 `@mastra/pg` 预解析后由 pg 再解析的嵌套 `connectionString`：最终指向正式库时拒绝，最终确实指向独立开发库的合法配置仍可使用。测试员工不能出现在正式员工列表中，测试 Dataset 不能等于正式 Dataset。缺少任一值或使用非 development 模式时明确拒绝启动，不回退到正式配置。

先用现有 `migrateDatabase({ databaseUrl })` 为开发库执行仓库迁移，再启动：

```bash
pnpm --filter @kairo/app dev:studio
```

命令先构建并执行配置检查，再让 Mastra CLI 通过 `--env` 显式读取同一份 `.env.studio`，仅监听 `127.0.0.1:4111`。CLI 进程不再额外使用 Node 的 `--env-file` 预加载同一文件，避免文件字段被误当作继承的系统变量、在 CLI 重建后仍锁定旧值。真正的系统环境变量仍优先。锁定 CLI 的开发子进程会将未出现在 `--env` 文件中的 `NODE_ENV` 设为 production，因此文件本身也必须写明 development；外部 `NODE_ENV=production` 仍在前置检查时拒绝启动。不要直接用默认 `mastra dev/start` 代替上述命令。

Studio 的请求中间件固定注入测试员工、`MASTRA_RESOURCE_ID_KEY` 和测试 Dataset，客户端请求上下文不能覆盖这些值。此阶段 Studio 没有业务 Agent 或知识 Tool；测试 Dataset 的配置隔离不代表已验证 RAGFlow 数据或检索权限，真实知识连接属于 T14/T27。`.mastra/` 是 CLI 生成目录，不提交到 Git。

定向合同（在 `apps/kairo` 目录执行）：

```bash
node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/integration/mastra-route-isolation.spike.test.ts
pnpm exec vitest run tests/unit/studio-isolation.test.ts
```

集成测试要求 `KAIRO_TEST_DATABASE_URL`，创建并删除两个随机临时数据库，验证正式路由不可达、端口及数据库连接释放，以及开发和正式 thread 双向隔离；合法嵌套连接额外通过 `SELECT current_database()` 核对实际目标。离线门禁测试覆盖外层库名不同但嵌套目标指向正式库的拒绝行为。真实启动验收还需运行 `start` 与 `dev:studio`，检查实际监听地址、Studio 页面和错误配置拒绝；不能用单元测试代替。

框架依据：[CLI 命令](https://mastra.ai/reference/cli/mastra)、[Mastra 实例](https://mastra.ai/reference/core/mastra-class)、[请求上下文保留键](https://mastra.ai/docs/server/request-context#reserved-keys)，并以锁定版本的类型、实现和实际启动结果为准。

应用开发依赖直接声明与现有依赖树相同的 `hono@4.13.5`，生产源码仅导入它的类型。`@mastra/core@1.63.2` 附带的 Hono 类型缺少原包的 CommonJS 类型目录标记，NodeNext 下无法完整解析 `ContextWithMastra`；直接使用 Hono 官方 `Context` 类型，避免手写框架声明或关闭 unsafe 检查。离线测试也用真实 Hono 和 RequestContext 验证伪造请求范围被覆盖。

### T14 Skill 复用方案验证

已选定的正式方向是：Mastra 加载定制 RAGFlow Skill → 专用 `knowledge-search` Tool → 固定 Python 检索脚本 → RAGFlow HTTP Retrieval API。T14 只验证可行性；正式 Skill 裁剪、脚本接入、错误分类、四分钟任务预算、一次重试与业务证据接入由 [T27 #232](https://github.com/dnslin/kairo/issues/232) 实施。本次没有向正式 `src`、依赖或默认测试增加临时实现。

2026-09-07 的真实目标为 `http://rag.union.com/`（本机 hosts 内网域名），Dataset `ERP`，ID `b55a0fc8a69211f1bad90f767650f6fc`。只读 `/api/v1/system/version` 返回 `{"code":0,"data":"v0.27.1","message":"success"}`；这是服务自报版本，不是用官方源码版本推定部署版本。凭证仅通过本地环境变量传入，未写入源码或 Issue。

上游为 [ragflow-skill 1.0.8](https://clawhub.ai/api/v1/skills/ragflow-skill/versions/1.0.8)，发布元数据声明许可证 `MIT-0`。临时验证仅下载并复用 `scripts/common.py` 的 HTTP/错误处理与 `scripts/search.py` 的字段映射；不安装管理脚本。临时入口只发送 `question` 与固定 `dataset_ids`，不调用上游会注入 `top_k=5` 等参数的 CLI。接口默认值不会自动跟随 RAGFlow 网页设置。

验证环境为 Node.js `24.14.0`、Python `3.14.3`、仓库锁定的 `@mastra/core@1.63.2`。使用确定性模型仅驱动 `skill` 和 `knowledge-search` 两次工具调用；Mastra、Skill 读取、Node 子进程、Python 与 RAGFlow 全部真实执行。模型可见工具只有 `knowledge-search`、`skill`、`skill_read`、`skill_search`，没有通用命令执行工具。这不证明真实主模型的检索决策或最终回答质量。

| 场景 | 实际结果与证据边界 |
| --- | --- |
| ERP 采购订单查询 | 完整链路返回 30 条片段，响应 total 为 64；正文、文档 ID/名称、positions、相似度可读 |
| 无关查询 | 真实 ERP 返回成功且 chunks 为空 |
| 错误 key | 真实 HTTP 401，Python 非零退出并保留结构化错误 |
| 错误 Dataset、缺少 question | 真实 HTTP 200、业务 code 102；不能靠同一个 code 区分所有错误 |
| 模型额外字段 | 严格 query 输入合同拒绝 Dataset/命令等额外字段；正式完整攻击矩阵归 T27 |
| 缺失 chunks、非对象 chunk、正文类型错误 | 本地响应注入，返回 DataError，不能误报无资料；不是声称真实服务恰好发生过这些故障 |
| 取消与自动超时 | 本地代理先转发并收到真实 ERP 成功响应，再扣留给 Python 的回复。主动取消和 `AbortSignal.timeout(10000)` 自动截止均通过 Agent → Tool → Python，等待 close 后 PID 不存在 |
| 取消后的恢复 | 重建完整 Agent 链路，直接检索 ERP 再次成功；不代表 RAGFlow 服务端曾被重启 |

本地进程退出只能证明本地调用与网络等待终止，不能证明 RAGFlow 服务端计算被取消。未操作远端服务重启、资料上传/删除或写权限，也未把完整 T27 重试与业务状态矩阵算作通过。

当前 DOCX 样本返回 `positions=[[20,19,19,19,19]]`。官方 v0.27.1 的 [DOCX 分支](https://github.com/infiniflow/ragflow/blob/v0.27.1/rag/app/naive.py#L1063-L1103) 将合并后的 chunks 交给 [位置生成函数](https://github.com/infiniflow/ragflow/blob/v0.27.1/rag/nlp/__init__.py#L454-L479)，按序号 `ii` 生成 `[[ii]*5]`；[add_positions](https://github.com/infiniflow/ragflow/blob/v0.27.1/rag/nlp/__init__.py#L969-L981) 再将首维加一。该样本与 `ii=19` 规则吻合，但不能反推 Word 第 20 页或第 20 段，也不证明历史解析时使用的版本。保留原始 positions，物理页码保持未知；未拿 DOCX 样本替代 PDF 页码验收。

临时验证命令（从仓库根目录执行，先按 [T14 证据评论](https://github.com/dnslin/kairo/issues/219#issuecomment-5567272438) 恢复临时文件并设置环境变量）：

```powershell
$env:RAGFLOW_API_URL = 'http://rag.union.com/'
$env:RAGFLOW_DATASET_ID = 'b55a0fc8a69211f1bad90f767650f6fc'
# RAGFLOW_API_KEY 由维护人员在当前进程环境中提供，不保存到脚本。
node apps/kairo/tmp/t14/probe.mjs
node apps/kairo/tmp/t14/faults.mjs
```

两个命令均实际成功执行；最终 `faults.mjs` 还包含完整 Agent 链路恢复。临时程序及下载的上游文件已删除，可复现代码保留在 T14 证据评论，不进入正式代码或长期测试套件。Mastra 的测试 mock 聚合入口依赖 Vitest，不能在普通 Node 脚本直接导入；最终探针使用最小确定性模型对象，不修改框架依赖。

本次已执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint`，全部通过。默认测试为 Driver 25 个文件 / 308 个测试、App 2 个文件 / 9 个测试；不包含 PostgreSQL 集成测试或真实 KK9 测试。本次未修改 Driver，也未把这些默认测试算作真实 ERP 链路证据。

接口依据：[Mastra Skill 加载](https://mastra.ai/docs/sandbox/skills)、[工具执行上下文](https://mastra.ai/reference/tools/create-tool)、[RAGFlow Retrieval API](https://ragflow.io/docs/http_api_reference#retrieve-chunks)，并以锁定类型与上述实际输出为准。

### T15 受控 Bot 配置

正式业务配置唯一来自 `config/bots/default/bot.yaml`。`start` 和 `dev` 都在创建运行时、监听端口之前校验，不提供 CLI 或环境变量覆盖这份业务配置。路径按应用模块位置解析，不随启动工作目录改变；仓库启动需要 Git 和有效的 `.git`，无法读取当前 commit 时明确失败，不写虚构版本。

`loadBotConfig()` 返回 `config` 与 `configDigest`；`startKairo()` 的返回值另含 `gitCommit`，供后续业务模块使用。程序内 `configDirectory` 参数用于隔离测试，正式命令不开放目录选择。文件修改不会改变已加载结果，必须重启生效；不监视文件，也不建设另一套配置来源。

#### 字段与边界

- `model.id`：唯一的 `供应商/模型` 标识；`model.url` 可选，用于明确的 HTTP(S) 模型地址，不允许 URL 内嵌用户名或密码。当前经用户批准使用 `sensenova/deepseek-v4-flash` 和既有模型地址。不配置备用模型。
- `datasetId`：唯一 ERP Dataset，当前为 `b55a0fc8a69211f1bad90f767650f6fc`；不接受数组或模型自行选择的范围。
- `employeeAllowlist`：非空、不重复的员工 UID 字符串列表，当前批准名单为 `['3585']`；增加第二名试用员工时修改文件并重启。
- `tools`、`skills`：必须显式填写，可以为空。用户已确认 T15 暂用空列表；不会把尚未实现的 `knowledge-search` 登记为已存在，也不创建假 Skill。
- Tool 引用必须出现在调用方实际注册的能力列表中；当前正式入口尚无业务 Tool，所以任何非空 Tool 列表都会拒绝启动。T27 交付实际 Tool 后再连接注册列表，不靠员工消息或 Skill 文本授权。
- Skill 名称使用小写字母、数字及单连字符，对应受控目录 `skills/<name>/SKILL.md`。维护人员放入受控目录并在 YAML 中启用即表示批准；未列入的目录不会自动启用，目录外名称、缺失文件与重复引用均拒绝。不额外建立审批表；Mastra 的 Skill 内容加载和选择仍属于 T16。

运行参数显式写入 YAML，不在校验失败时静默补值：

| 字段 | 当前值 | 含义 |
| --- | ---: | --- |
| `agent.maxSteps` | 20 | Agent 循环上限，不是固定知识查询次数限制 |
| `batching.quietMs` / `maxWaitMs` | 5000 / 60000 | 短静默与最长合并窗口，毫秒 |
| `batching.maxMessages` / `maxChars` | 10 / 30000 | 输入上限；允许调小，不允许超过阶段一上限 |
| `concurrency.global` / `perSessionQueue` | 3 / 3 | 全局执行并发与每会话排队容量 |
| `timeouts.queueMs` / `executionMs` | 600000 / 240000 | 排队与执行期限，毫秒 |
| `timeouts.progressMs` / `sendQueryMs` | 10000 / 30000 | 进度提示与发送查询等待，毫秒 |
| `timeouts.generalKnowledgeWaitMs` / `contextIdleMs` | 600000 / 7200000 | 通用知识确认等待与上下文空闲，毫秒 |

数值必须是正整数；静默不能超过合并窗口，进度提示必须早于执行截止。这些字段由后续对应业务模块消费，T15 不声称已经实现消息合并、任务调度或 Agent 循环。

所有配置对象均拒绝未知字段，包括误写的 `password`、`apiKey`、`API_KEY`、`Authorization` 和数据库连接字段；凭证继续从环境变量提供。YAML 解析错误保留错误类别和行列，结构错误保留字段路径，不打印源文本或含原始输入的异常。重复 YAML 键和无法识别的标签同样报错，不静默忽略。

模型 URL 初检设置 `abort: true`：无效地址不会进入后续 `new URL()` 校验，避免原生异常的 `input` 字段绕过安全错误转换。YAML 解析设置 `stringKeys: true`：复杂键在解析阶段被拒绝，不进入 `toJS()` 的键字符串化过程，避免库通过进程警告输出键原文。没有全局关闭警告或吞掉异常。

启动使用现有 Pino 输出 `event: '配置已加载'`、`gitCommit`、`configDigest`，不输出配置值、员工正文或知识片段。摘要为受控目录全部文件的 SHA-256，包括存在的 SOUL、AGENTS、Skill 及其资源；未启用目录中的文件变化也会改变部署摘要。按相对路径排序并编码文件长度，不包含部署绝对路径或运行时间；文件字节、注释和换行变化都会改变摘要。启动记录入数据库由 T20 实施，本次不新建表或日志框架。

#### 初次实现验证（2026-09-07）

- 实现提交：`ee6430fc021de64c9ba0c7d47a73faf6fccfe1ce`。先建立失败测试，再实现校验；启动顺序测试在接入前因先报 PostgreSQL 配置错误而失败，接入后通过。
- 实际执行 `pnpm --filter @kairo/app exec vitest run tests/unit/config.test.ts`：22 个测试通过；`pnpm --filter @kairo/app typecheck` 和 `pnpm --filter @kairo/app build` 通过。
- 实际执行根命令 `pnpm build && pnpm typecheck && pnpm test && pnpm lint`：全部通过，默认测试为 Driver 308 个、App 31 个。
- 在 `apps/kairo` 执行 `node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/integration/mastra-route-isolation.spike.test.ts`：3 个真实 PostgreSQL 集成测试通过，原路由、关闭行为与 Studio 数据隔离不变。
- 实际以 `node --env-file-if-exists=../../.env dist/index.js` 启动正式入口；向该验证进程注入现有测试连接作为 `DATABASE_URL`，存活接口返回 200。往正式 YAML 临时加入测试 `Authorization` 字段后，入口在监听前以退出码 1 拒绝；错误输出不含测试凭证，随后已恢复原文件并成功启动。
- 临时程序 `tmp/t15-start-smoke.mjs` 用批准的真实配置和现有测试数据库执行 `SELECT 1`，确认主模型不被旧测试环境变量覆盖、原生执行路由为 404；文件中的 `maxSteps` 从 20 改成 21 时旧实例仍为 20，重启后为 21，恢复原文件后为 20。原配置摘要为 `e812947976ede2153a2711037d839a3f1c7618a4f8a2d9ebd3e4db8dec410043`，修改后的摘要不同，恢复后完全一致。该程序通过后删除，不成为正式启动命令。

#### 启动错误输出修复（2026-09-07）

初次验证未覆盖非法模型 URL 和 YAML 复杂键，不能据此得出所有错误输出均不泄露输入的结论。补充完整入口复现后确认两条独立问题：非法 URL 的 `TypeError.input` 会输出原文；复杂 YAML 键在对象转换阶段触发额外的进程警告，即使配置随后被拒绝，警告仍包含键原文。上述两个解析选项分别修复对应根因。

- `tests/unit/config.test.ts` 新增两个完整启动回归：将当前源码编译到临时目录，启动真实 `dist/index.js` 子进程并捕获完整 stdout/stderr，不使用旧构建产物、不改写正式配置、不模拟错误打印。子进程及临时文件在测试结束时回收。
- 修复前实际执行配置定向测试：22 个通过、2 个因输出包含测试凭证而失败；修复后 24 个全部通过。两条回归同时要求退出码为 1、完整输出不含测试凭证，并保留 `model.url` 或 `NON_STRING_KEY` 诊断。
- 实际执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint`：全部通过，默认测试为 Driver 308 个、App 33 个。实际重跑上述 T13 PostgreSQL 集成命令，3 个测试通过，正常配置启动、端口与连接释放、原生路由隔离保持不变。

上述验证未调用模型、RAGFlow 或真实 IM，也不代表 T16/T27/T28 业务已交付。本次没有修改 Driver。正常部署仍必须显式提供自己的 `DATABASE_URL`；代码不会把 `KAIRO_TEST_DATABASE_URL` 自动当作正式连接。

接口依据：[YAML 解析与诊断](https://eemeli.org/yaml/#parsing-documents)，并以锁定版本、TypeScript 检查及实际运行结果为准。

## 代码入口

| 任务                                                                                | 位置                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Driver 公开 API 与生命周期                                                          | `packages/driver/src/index.ts`, `packages/driver/src/driver.ts` |
| CDP 连接与底层调用                                                                  | `packages/driver/src/cdp/client.ts`                             |
| Bridge 底层 IPC 操作与原生事件直连桥（会话、消息、发送、撤回、图片/文件、组织架构） | `packages/driver/src/bridge/`                                   |
| DOM 辅助解析与兼容逻辑                                                              | `packages/driver/src/dom/`                                      |
| 离线测试                                                                            | `packages/driver/tests/`                                        |
| 真机脚本                                                                            | `packages/driver/examples/`                                     |

## 边界

- Driver 只负责 KK9 的 CDP、运行时桥接、消息规范化和 I/O。
- Driver 不持有数据库、Agent、Memory、知识库、审批或业务工作流。
- DOM、Vue 运行时对象和原始事件必须先规范化，再进入公开类型。
- 发送结果必须保留“触发前失败”和“触发后结果未知”的区别。
- 离线测试不得依赖 KK9、网络或真实账号。

### 原生发送关联键

KK9 的 `msgFlag` 上限为 64 个字符。原生 `searchMessages` 和 `queryChatMessage` 会过滤匹配 `%C%` 的消息，SQLite 的匹配也会命中小写 `c`，因此仅有发送成功或 `getRecentMessages` 回查成功不能证明原生历史可见。`createNativeMessageKey(kind, operationId)` 对超长操作 ID 使用 `k:op:` 加完整 SHA-256 摘要的 Base64URL 编码，并将 `C`、`c` 分别替换为 `.`、`~`，固定为 48 个 ASCII 字符，不截断操作 ID。两个替代字符不在 Base64URL 原字母表中，替换保持一一对应。发送、只读状态回查和 PostgreSQL 的 `native_key` 写入统一调用该函数，调用方仍保存完整 `operationId`。

五类新媒体（`url-card`、`biz-message`、`app-message`、`chat-record`、`voice`）的短操作 ID 若编码后含 `C/c`，同样使用安全摘要；其他短键保持不变。不传 `operationId` 时，完整随机键（包含类型名和 UUID）中的 `C/c` 也会替换为 `.`、`~`。因此不能只修复摘要或 UUID，而遗漏类型名里的 `c`。

原有文本、富文本、回复、图片和文件类型的短键及无操作 ID 键维持原规则，避免改变既有操作的回查身份；它们若含 `C/c`，仍可能被原生历史过滤。本次不改写已发送消息或旧存储记录，也不自动重发旧 `unknown` 操作；此前由新媒体 API 生成的旧不安全键同样不会被改写。服务端 `102` 或本地 `status: failed` 不能单独证明服务端未创建消息，仍遵守触发后结果未知的合同。

## 原生卡片与语音发送

`KK9Driver` 与 `IKK9Driver` 新增以下方法；第一个参数是消息内容，第二个参数沿用 `SendOptions`：

| 方法                               | 原生 contentType | 公开 messageType |
| ---------------------------------- | ---------------- | ---------------- |
| `sendUrlCard(card, options)`       | 10               | `url-card`       |
| `sendBizMessage(message, options)` | 17               | `biz-message`    |
| `sendAppMessage(message, options)` | 8                | `app-message`    |
| `sendChatRecord(record, options)`  | 15               | `chat-record`    |
| `sendVoice(voice, options)`        | 2                | `voice`          |

```typescript
await driver.sendUrlCard(
  { title: '部署报告', summary: '构建成功', linkUrl: 'https://example.com/report' },
  { targetSessionId: '0-3585', operationId: 'report-20260907' }
);
await driver.sendBizMessage(
  { title: '任务完成', content: '已完成部署', summary: ['负责人: 张三'] },
  { targetSessionId: '0-3585' }
);
await driver.sendAppMessage(
  { title: '应用通知', content: '<p>这是一条<b>微应用</b>通知</p>' },
  { targetSessionId: '0-3585' }
);
await driver.sendChatRecord(
  { title: '方案讨论', msgArray: [{ senderName: '张三', contentType: 0, content: '请确认方案' }] },
  { targetSessionId: '0-3585' }
);
await driver.sendVoice(
  { text: '任务已经完成', voice: 'zh-CN-XiaoxiaoNeural' },
  { targetSessionId: '0-3585', operationId: 'voice-20260907' }
);
await driver.sendVoice({ filePath: 'D:/audio/notice.wav' }, { targetSessionId: '0-3585' });
```

五类消息均复用发送操作存储：同一 `operationId` 不会重复发送；语音重放不会重复合成。准备失败为 `failed/isPreTrigger: true`，触发后不能确认送达为 `unknown`，不得据此自动重发。成功确认后返回正式消息 ID 和 `recall()`，并更新本机会话摘要及聊天窗口。五类消息均不支持 `replyTo` 或 `mentions`，显式传入会在发送前失败。

未传 `targetSessionId` 时，在开始准备消息前固定当前会话；TTS 期间切换聊天窗口不会改变接收目标，返回的 `recall()` 也绑定原会话。

直接调用公开的 `BridgeMessageOps.sendVoice()` 时也遵守上述目标绑定规则，包括不传 `operationId` 的路径。`ChatRecord` 在登记操作前取得完整 JSON 内容快照；调用方随后修改嵌套对象，不会改变本次发送正文或相同操作 ID 的重放身份。

`AppMsg.content` 原样交给 KK9 渲染 HTML，调用方应提供可信正文。`ChatRecord` 的 `contentType: 0` 纯文本记录会转换为 KK9 的原生图文节点，避免详情窗口对普通字符串执行 `JSON.parse` 而显示空白。其他记录类型按原生内容结构传入。`title` 保留在消息内容及 Driver 历史摘要中；KK9 当前客户端的可见记录标题仍由发送者和会话名称按原生模板生成。

语音输入必须二选一：`{ text, voice? }` 或 `{ filePath }`。本地文件支持 WAV、MP3；文本通过 `node-edge-tts` 使用 Microsoft Edge Read Aloud 服务，默认音色 `zh-CN-XiaoxiaoNeural`，也可指定 `zh-CN-YunxiNeural`。该服务需要网络连接，不是带可用性承诺的付费语音 API。Driver 将音频解码为单声道、重采样到 8kHz，调用当前 KK9 安装包的 `lib/amrnb` 编码；不需要 Python 或 FFmpeg。发送数据是 AMR-NB 文件字节的 Base64，`duration` 为向上取整的秒数。TTS 临时音频在读取后删除；本地输入文件不会被删除。KK9 未开放 `window.require` 或缺少内置编码器时，明确返回准备失败。

`pnpm-workspace.yaml` 的 `patchedDependencies` 固定应用两份依赖修补：`patches/node-edge-tts@1.2.10.patch` 让直连握手和合成共用超时期限，文件流错误进入正常拒绝路径，完成或失败时先关闭文件流和 WebSocket 再结束 Promise；`patches/@audio__decode-wav@1.5.0.patch` 修正 RIFF 奇数长度数据块的填充字节跳过规则。补丁文件、workspace 配置和 `pnpm-lock.yaml` 必须一起保存，通过 `pnpm install` 应用，不能仅手改 `node_modules`。升级这两个依赖时先确认上游是否已修复，并运行对应边界回归。

Driver 不提供或使用第三方 TTS 库的 HTTP 代理选项。额外探针发现，该库可选代理模式在 CONNECT 握手挂起时仍可能遗留代理 TCP 连接；这不是当前 Driver 的直连路径，本次没有扩展代理功能或其修复范围。

应用侧 PostgreSQL 发送状态表原有类型约束不接受新消息类型，因此新增 `000003-native-media-send-operations.sql`。使用 `PostgresSendOperationStore` 前需执行应用现有迁移流程；Driver 本身不持有数据库。回滚该迁移前，必须先处理表中新增类型的记录，否则旧约束会拒绝回滚，不会自动删除记录。

诊断命令（目标为真实会话，会实际发送）：

```bash
pnpm diagnose card 0-3585 url '{"title":"部署报告","summary":"构建成功","linkUrl":"https://example.com"}'
pnpm diagnose voice 0-3585 "任务已经完成"
pnpm diagnose voice-file 0-3585 D:/audio/notice.wav
```

`card` 的类型可选 `url`、`biz`、`app`、`record`；JSON 字段对应各公开 options 类型。Windows PowerShell 的引号规则可能不同，可优先使用上面的 TypeScript API。

真机验收：

```powershell
$env:KK9_MEDIA_CONFIRM = "5761:0-3585:int2024"
# 可选；设置后额外验证本地音频发送。
$env:KK9_MEDIA_AUDIO_FILE = "D:/audio/notice.wav"
pnpm --filter @kairo/driver e2e:media
# 也可以只运行指定类型，避免重复发送已验证的用例。
pnpm --filter @kairo/driver e2e:media ChatRecord VoiceFile
# 专门覆盖“不传 operationId”和“短含 c operationId”两条路径。
$env:KK9_MEDIA_KEY_CASES = "1"
pnpm --filter @kairo/driver e2e:media
```

脚本默认目标为 `int2024 / 0-3585`，通过 `KK9_MEDIA_TARGET_ID`、`KK9_MEDIA_TARGET_NAME` 可更改。确认值必须精确匹配当前登录 UID、目标 ID 和目标名称。每条消息除检查正式 ID、原生及公开类型外，还必须同时出现在 `queryChatMessage` 和 `searchMessages` 的真实 IPC 返回值中；不会再用 `getRecentMessages` 替代原生历史验收。设置 `KK9_MEDIA_KEY_CASES=1` 后，每种类型分别验证无操作 ID 和短含 c ID，有操作 ID 的路径同时检查防重和状态回查。单独运行一个类型时使用确切的 `task-complete-001`；多类型运行追加类型名以区分发送意图。默认撤回本次已知消息；设置 `KK9_MEDIA_KEEP=1` 可保留做界面检查，检查后自行撤回。脚本不把历史可见性等同于接收方界面或音频播放验收。

底层协议 spike 可执行 `pnpm --filter @kairo/driver exec tsx examples/spike-card-test.ts`。它沿用 `KK9_MEDIA_TARGET_ID`、`KK9_MEDIA_TARGET_NAME`、`KK9_MEDIA_CONFIRM` 和 `KK9_MEDIA_KEEP`，先按精确 ID 查找，再核对名称和登录 UID；缺少确认或身份冲突时不会发送。保留 UrlCard、BizMsg、AppMsg、GroupInfoShare 四类探针，只有取得正式落库 ID 才显示 `delivered`；仅收到发送 ack 而无落库证据时显示 `unknown`，以非零状态退出，不自动重发。默认撤回已知正式消息。

离线回归：`pnpm --filter @kairo/driver test`。`native-media.test.ts` 在 VM 中实际执行 renderer 发送脚本；`voice-ops.test.ts` 实际解码 WAV/MP3、重采样并执行编码调用脚本，仅替换网络 TTS 和 KK9 编码器边界。`tests/fixtures/voice.mp3` 为 Edge TTS 生成的“测试”二字，用于无网络的 MP3 回归。PostgreSQL 合同定向命令见 `apps/kairo/tests/integration/send-operation-store.test.ts`。

新增回归覆盖 ChatRecord 的嵌套内容快照、直接 Bridge 的语音目标绑定、合法 RIFF 填充以及 spike 的目标门禁和未知结果。`node-edge-tts-boundary.test.ts` 保留真实依赖与文件流，使用本地挂起的 TLS 连接或替换 WebSocket 网络边界，验证直连握手超时、合成超时、文件错误、异常关闭及正常结束后的资源释放；不访问外网。原生预插入、发送和正式 ID 确认统一由 renderer 的 `submitNativeMessage` 执行，各入口仍保留自己的内容准备、确认策略和 UI 通知。
