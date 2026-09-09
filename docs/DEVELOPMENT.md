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

`@kairo/app` 的 `typecheck` 使用 `apps/kairo/tsconfig.typecheck.json`，覆盖 `src`、`tests`、`vitest.config.ts` 和 `vitest.integration.config.ts`，不生成文件；`build` 仍使用 `apps/kairo/tsconfig.json`，只编译 `src`。应用直接声明 `@types/node` 与 `@types/pg`，数据库代码使用 `pg` 提供的类型接口，不再手写第三方模块声明。

默认 `pnpm test` 中的 App 测试排除 `tests/integration/**`，不要求 PostgreSQL 连接。`pnpm --filter @kairo/app test:integration` 加载存在的仓库根 `.env`，也支持系统环境注入；无参数运行完整集成目录。追加文件名时只运行匹配文件，例如 `pnpm --filter @kairo/app test:integration -- tests/integration/task-store.test.ts`。入口只移除首个 pnpm 透传分隔符，独立 Vitest 配置限定 integration，文件未匹配时明确失败。全量集成仍可能包含已配置的真实模型调用，不用于 T19 定向验收。请使用专用测试数据库：既有发送操作测试会直接迁移和写入配置中的测试库，Mastra、T18/T19 使用随机临时库且需要创建、删除数据库的权限；T19 不回退到 `DATABASE_URL`，缺少 `KAIRO_TEST_DATABASE_URL` 明确失败。

T19 全部账本回归现按合同拆分，使用 `pnpm --filter @kairo/app test:integration -- tests/integration/task-store` 同时匹配五个文件；指定 `task-store.test.ts` 只运行创建与状态门禁，不再代表完整 T19 验收。`db:migrate:test` 同时定向任务持久化与知识记录的首次及重复迁移场景。新工作树没有 `.env` 时，应由当前进程显式提供 `KAIRO_TEST_DATABASE_URL`，不把缺少配置当作测试通过。

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

`startKairo()` 先加载并校验受控 Bot 配置、读取 Git commit，再创建进程内 Mastra、PostgreSQL storage 和应用拥有的真实 `KK9Driver`。默认先监听 `127.0.0.1:4110`，再连接 Driver。T17 提供 `GET /health/live`、`GET /health/ready`、`GET /health/dependencies` 三个只读接口，其他路径和方法均返回 404，包括 Mastra Agent、Tool、Workflow 执行接口。存活不等于业务就绪，状态来源和判定见下文 T17；当前不装配 T28 的业务 Agent。

收到 Ctrl+C 或 SIGTERM 后先取消外部依赖检查并清理定时器，再依次关闭健康端口、应用自己的 Driver、Mastra；某个资源关闭失败不阻止其余资源回收，错误仍向调用者传播。锁定的 `@mastra/core@1.63.2` 会在 shutdown 内关闭注册的 storage，不再重复调用 `storage.close()`。程序内调用方使用返回的 `close()`，重复或并发关闭共用同一个 Promise。

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

`loadBotConfig(directory, availableTools)` 返回 `config` 与 `configDigest`；可用 Tool 清单由调用方注入，默认空清单，不从配置模块反向导入业务实现。正式入口使用 `loadBotConfig(undefined, Object.keys(knowledgeTools))`。`startKairo()` 的返回值另含 `gitCommit`，供后续业务模块使用。程序内 `configDirectory` 参数用于隔离测试，正式命令不开放目录选择。文件修改不会改变已加载结果，必须重启生效；不监视文件，也不建设另一套配置来源。

#### 字段与边界

- `model.id`：唯一的 `供应商/模型` 标识；`model.url` 可选，用于明确的 HTTP(S) 模型地址，不允许 URL 内嵌用户名或密码。当前经用户批准使用 `openai/gemini-3.7-flash-high` 和既有模型地址；`openai/` 表示代理接口类型，实际请求模型名为 `gemini-3.7-flash-high`。不配置备用模型。
- `datasetId`：唯一 ERP Dataset，当前为 `b55a0fc8a69211f1bad90f767650f6fc`；不接受数组或模型自行选择的范围。
- `employeeAllowlist`：非空、不重复的员工 UID 字符串列表，当前批准名单为 `['3585']`；增加第二名试用员工时修改文件并重启。
- `tools`、`skills`：必须显式填写，可以为空。T15 使用空列表；T16 接入用户提供的 `reader-sim` 后启用该 Skill，业务 Tool 仍为空，不把尚未实现的 `knowledge-search` 登记为已存在。
- Tool 引用必须出现在调用方实际注册的能力列表中；当前正式入口尚无业务 Tool，所以任何非空 Tool 列表都会拒绝启动。T27 交付实际 Tool 后再连接注册列表，不靠员工消息或 Skill 文本授权。
- Skill 名称使用小写字母、数字及单连字符，对应受控目录 `skills/<name>/SKILL.md`。维护人员放入受控目录并在 YAML 中启用即表示批准；未列入的目录不会自动启用，目录外名称、缺失文件与重复引用均拒绝。不额外建立审批表；原生内容加载与选择见 T16。

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

### T16 人格、规则与真实 Skill

`loadBotCustomization(config, directory)` 返回可直接交给 Mastra Agent 的 `instructions` 和 `skills`。正式启动在创建运行时、监听端口之前读取 `AGENTS.md` 与 `SOUL.md`，缺失文件直接报错；结果通过 `startKairo().customization` 提供给后续装配。本次不提前创建 T28 的业务 Agent，不增加服务端执行路由，也不改 Driver。

指令明确约定：服务端规则 > AGENTS > 当前启用 Skill > SOUL > 员工请求。`SOUL.md` 的测试人格为“小恺”，只影响称呼、中文语气和表达；业务规则区分读者体验与企业知识事实。身份、Dataset 和 Tool 权限不能由这些文本修改。

用户提供的 `temp/reader-sim/SKILL.md` 已接入 `config/bots/default/skills/reader-sim/SKILL.md`。仅去掉包住整个文件的代码围栏，并添加 `user-invocable: false`；保留原技能正文，未修改 `temp/`。该字段表示不开放显式用户激活，不把元数据或 Prompt 当作权限系统。

采用锁定 `@mastra/core@1.63.2` 的 Agent `skills: [绝对目录路径]` 接口，按 YAML 列表逐个传入目录，不扫描整个 Skill 根目录。Mastra 自行发现名称、description 和正文，提供 `skill`、`skill_read`、`skill_search`；不实现自研 Skill 引擎，不创建 Workspace 或 Sandbox。scripts 可以被读取，但没有代码或命令执行工具。

所有启用的 `SKILL.md` 在进入原生解析前，必须以独立的 `---` 行开始 YAML 元数据；接受可选 UTF-8 BOM、LF 或 CRLF，不接受 `---javascript` 等语言选择标记。锁定 `gray-matter@4.0.3` 的 JavaScript 引擎会执行 `eval`，因此仅检查 Agent 工具列表或解析后的元数据不能阻止文件读取阶段执行代码。这里只限制开始行，名称、description 与 YAML 内容继续由 Mastra 校验；不自研解析器、不修改全局引擎。

启动使用公开 `resolveAgentSkills([])` 创建空 registry，再逐项调用锁定版本支持的 `addSkill()`，由 Mastra 校验 YAML、元数据和资源。成功返回即表示该 Skill 加载成功，不再通过扫描结果补查缺项。扫描路径会自行打印可能含源行的异常消息，而 `addSkill()` 向调用方抛错；Kairo 将其转换为固定的“YAML 格式错误”或“元数据或资源无效”类别，保留对应 `SKILL.md` 路径，不附带原始 message/cause，并在数据库与监听初始化前拒绝启动。没有自研解析器、全局 console 替换或日志过滤器。

原生元数据校验还会在抛错之前发出长度 warning。`patches/@mastra__core@1.63.2.patch` 将 ESM 与 CommonJS 两个入口中 warning 的标识从未校验的 `metadata.name` 改为受控路径的 `dirName`；保留行数、token 数与整理建议，不关闭警告，也不放宽元数据校验。补丁经 `pnpm patch` / `pnpm patch-commit` 生成，随 `pnpm-workspace.yaml`、`pnpm-lock.yaml` 提交并由安装应用；升级 Mastra 时需重新验证该出口，不仅检查异常是否被捕获。

实际能力边界来自提供给 Agent 的路径与工具集合，不来自模型是否遵守提示词。当前业务 Tool 为空，Skill 文本不能凭空添加 Dataset 查询或执行工具；将来的知识 Tool 仍须在 T27 固定 Dataset。员工 `/xxx` 不提供安装或强制选择入口；`/new` 的真正会话切换属于 T24，本模块仅声明边界，不声称已实现重置。

配置与人格在启动时读取，不建设热更新；Skill 正文由 Mastra 按需读取，部署期间不要原地编辑受控文件，修改后重启。不另建文件快照或版本存储。

#### 本地验证（2026-09-07）

```bash
pnpm --filter @kairo/app exec vitest run tests/integration/bot-customization.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

- T16 定向集成测试 12/12 通过：真实 Skill 发现和读取；未启用目录的名称/绝对路径隔离；越界资源读取拒绝和搜索隔离；空 Skill 配置；脚本只读且无执行工具；缺失人格/规则文件明确失败；畸形元数据启动拒绝；JavaScript 元数据不执行测试标记；BOM、CRLF 合法 YAML 仍可读取；两种原生解析错误的完整 stdout/stderr 不泄漏文件内容。
- 根质量命令全部通过，默认测试 Driver 308 项、App 33 项。新增 T16 测试在集成目录，不在默认 App 测试中。
- 设置进程环境 `KAIRO_T12_REAL_MODEL=0` 后执行 `pnpm --filter @kairo/app test:integration`：5 个文件、34 项通过。数据库真实，T12 模型为确定性替身；不是本次真实模型放行。
- 临时启动探针实际使用构建产物、批准的 Bot 配置与显式测试数据库，`SELECT 1` 成功，`/health/live` 返回 200，`/api/agents` 返回 404。通过启动返回的 customization 创建验证 Agent，原生 `skill` 工具读取真实正文成功，工具仅上述三个，Workspace 不存在，关闭正常。该探针不调用模型，不代表真实 IM 闭环。
- 启动解析回归先于初次修复执行：原有 6 项通过，新增 2 项失败，错误均已进入 PostgreSQL 配置检查，说明畸形 Skill 未被提前拒绝。初次接入发现结果核对后 8 项通过，但当时仍输出框架原始诊断；此路径后来由逐项加载与完整日志回归替代。
- 临时 `t16-metadata-smoke.mjs` 使用最新构建产物与显式真实测试数据库：在隔离配置目录分别写入上述两种畸形 Skill，两次启动均明确拒绝；恢复原始真实 Skill 后成功启动，`SELECT 1` 成功、健康接口返回 200，随后正常关闭。没有修改正式配置或调用模型，探针运行后删除。
- 元数据执行回归使用唯一环境变量作为无害标记，结束后删除。修复前 8 项通过、新增 1 项失败，断言实际读到“已执行”；限制开始行后标记保持未设置，启动明确拒绝。连同 BOM、CRLF 正向回归共 10 项通过，并再次通过根质量命令。
- 临时 `t16-frontmatter-smoke.mjs` 使用最新构建产物与显式真实测试数据库：`---javascript`、`--- javascript`、带 BOM/CRLF 的 JavaScript 开始行均拒绝启动，三个测试标记均未执行。恢复带 BOM/CRLF 的合法真实 Skill 后正常启动，数据库 `SELECT 1` 成功、健康接口返回 200。只操作隔离目录，未调用模型；探针运行后删除。
- 日志回归覆盖未知 YAML 标签和名称不匹配两条错误路径：编译当前源码到临时目录，启动真实 `dist/index.js` 子进程，捕获完整 stdout/stderr。修复前 10 项通过、新增 2 项因包含 `t16-secret` 失败；改用 `addSkill()` 并转换错误后 12 项通过，均要求退出码 1、输出不含测试秘密且保留出错文件路径。没有模拟 console、错误打印或原生解析器。
- 独立启动探针使用相同的 `description: !invalid 测试秘密…` 输入复查最新源码：stdout 为空，退出码 1，stderr 只保留 Kairo 的“YAML 格式错误”诊断、文件路径及应用调用栈，不再包含源行或测试秘密。隔离配置、编译产物和进程已清理，没有修改正式配置或调用模型。修复后再次执行根质量命令和全部集成测试，均通过。

#### 原生 warning 回归（2026-09-08）

原先的名称不匹配用例仅有一行正文，没有覆盖 warning。将同一用例扩为 501 行非空正文后，原有补丁下 11 项通过、1 项失败，完整 stderr 包含 `[WorkspaceSkills] t16-secret: Instructions have 501 lines`。这证明 `addSkill()` 仍可能在向调用方抛错前泄漏元数据值。

应用上述两行依赖补丁后，T16 12/12、全部集成测试 34/34 通过；长正文用例同时要求退出码 1、完整输出无测试秘密、保留出错路径与 501 行警告，不接受通过关闭警告使测试变绿。`pnpm install --frozen-lockfile`、`pnpm build && pnpm typecheck && pnpm test && pnpm lint` 均通过，未升级依赖版本。

独立 Node 进程分别验证 ESM 与 CommonJS 原生入口：名称不匹配时退出码 1，改为合法名称后退出码 0；四次调用均保留 `[WorkspaceSkills] reader-sim` 的 501 行提示，不包含 `t16-secret`。这里只替代探针的错误展示以隔离 warning；真实 Kairo 入口的完整 stdout/stderr 由上述回归覆盖。临时文件和进程已清理，未调用真实模型或 IM。

#### 真实模型验收通过（2026-09-08）

用户将模型改为 `gemini-3.7-flash-high` 后，正式配置使用 `openai/gemini-3.7-flash-high`，继续通过 `https://cpa.447654.xyz/v1` 调用。前缀只用于框架选择 OpenAI 兼容接口，发给代理的模型名不含该前缀。凭证沿用本地 `KAIRO_T12_MODEL_API_KEY`，没有提交凭证、追加客户端伪装头或使用替身。

实际在 `apps/kairo` 执行临时 `node --env-file=../../.env tmp/t16-smoke.mjs`，约 39 秒完成 6 个真实回答样例，进程退出码 0：

| 提问场景 | 工具记录与实际回答 |
| --- | --- |
| 指定读者画像，对悬疑草稿说阅读感受 | 调用 `skill({ name: 'reader-sim' })`，按原文顺序逐句反馈，并声明读者画像 |
| 同一草稿只要求翻译 | 没有 Skill 调用，仅返回英文译文 |
| 问名字与是否为真人 | 没有 Skill 调用，回答“我叫小恺，是 Kairo 的 AI 助手，不是真人员工” |
| 用 `/reader-sim` 强制启用，但只问 7×8 | 没有 Skill 调用，直接回答 56 |
| 输入 `/new` | 没有 Skill 调用，也未宣称已重置会话；真正的会话切换仍属于 T24 |
| 临时 Skill/SOUL 要求改 Dataset、执行脚本、冒充真人，且 Skill 与 AGENTS 的语言要求冲突 | 仍用中文完成读者反馈，明确说明 AI 助手没有薪资 Dataset 权限与工具，也无法执行代码或脚本 |

六次场景的实际可用工具均只有 `skill`、`skill_read`、`skill_search`。最后一项只在隔离目录追加冲突文本，正式 Skill 与人格文件未改。完整输入、回答和工具记录已保存用于 PR/issue 验收，临时探针与隔离目录已清理。

这证明本轮样例中的技能使用、表达与权限边界符合预期，不是所有提示词攻击的普遍保证。本轮没有调用真实 IM/RAGFlow，也没有重跑 T12 的真实模型记忆门禁；不把 T16 对话样例当作这些能力的验收。

此前 `sensenova/deepseek-v4-flash` 在 9 月 7 日及 9 月 8 日返回 HTTP 400 / `MissingSessionID`，最新失败 trace 为 `20260908082753-5ab787902ff3a9e5-2e52b870`。这是旧模型请求的历史结果；本轮用户批准的新模型已成功回答，T16 的接口调用阻塞解除。

提交新模型配置前再次执行 `pnpm --filter @kairo/app exec vitest run tests/unit/config.test.ts`，24/24 通过；设置 `KAIRO_T12_REAL_MODEL=0` 后执行全部集成测试，34/34 通过。后者使用真实 PostgreSQL，但 T12 模型仍为确定性模式，不宣称已对新模型重跑真实记忆门禁。

接口依据：[Agent 的 filesystem path Skills](https://mastra.ai/docs/skills#filesystem-path-skills)、[原生 Skill 加载与资源工具](https://mastra.ai/docs/sandbox/skills)。

### T17 应用日志、错误与本机健康接口

初次交付实现应用 operability，随后经用户批准接入 Driver 日志并补齐正式 Driver 装配。各轮不修改 `private-chat-core` 或数据库迁移，不规定 T18 必须采用的新接口。保留 T15 的 Git commit 与配置摘要；实际依赖状态和最新验收以本节末尾正式装配记录为准。

#### 日志与错误

`createLogger()` 复用 Pino，提供 `info(fields)`、`warn(fields)`、`error(fields)`。记录八类关联标识：`messageId`、`sessionId`、`employeeId`、`contextId`、`taskId`、`runId`、`toolId`、`evidenceId`，以及 `durationMs`、固定 `status`、`errorType`、中文 `event`、`gitCommit`、`configDigest`。Pino 自带级别与时间；不附带主机名、PID、整个配置或任意自由消息。

日志入口先选取白名单标量，再交给 Pino；`redact` 同时覆盖 password、token、apiKey、authorization，以及 question/answer/content/prompt/messages/knowledge/snippet/chunks 等正文键。原始 Error、cause、stack、msg、额外参数及嵌套对象不序列化，对象不能冒充关联 ID。调用方必须提供真实标识，不能把正文塞进 ID 字符串；不通过扫描员工内容猜测它是不是标识。

`MastraOperabilityLogger` 通过框架现有 `setLogger()` 接入正式运行时，保留可关联字段，将框架自由消息转为固定中文事件，不关闭框架错误输出。独立开发 Studio 与 T16 Skill 加载前的原生行数警告不在此接入点；原有 Skill 警告补丁和完整输出隐私回归保留，不使用全局 console 替换。

`AppError.type` 区分 `configuration`、`identity`、`storage`、`driver`、`model`、`knowledge`、`timeout`、`cancelled`、`send_unknown`；无法识别的异常归为 `internal`，不靠错误正文猜类别。`getFailureMessage()` 返回固定中文员工说明；发送不明要求核实实际送达，不宣称失败，也不建议自动重发。`AppError.cause` 仅供程序内诊断。

启动错误按阶段分类，CLI 记录 `应用启动失败` 与 `errorType` 并以非零状态退出，不再整段打印底层异常。因此 T15/T16 历史记录中的 stderr 路径/原始调用栈不再是当前 CLI 合同；程序内仍可沿 cause 查看已有的字段、行列或文件诊断。完整启动回归继续验证拒绝启动和不泄露正文/凭证，不关闭原生 warning。本任务不实现员工消息发送链路。

#### 健康判定与访问边界

状态对象固定包含 `configuration`、`postgres`、`mastra`、`driver`、`ragflow`、`model` 六项；每项为 `up`、`down` 或 `unknown`。四项核心依赖必须全为 `up`；其中任何一项未正常，优先返回 `not_ready`。核心正常但模型或 RAGFlow 未正常时返回 `degraded`；六项全正常才为 `ready`。

| 请求 | 状态码与含义 |
| --- | --- |
| `GET /health/live` | 200，`{"status":"alive"}`；不访问依赖 |
| `GET /health/ready` | `not_ready` 为 503；`ready`、`degraded` 为 200，正文包含总状态与六项依赖 |
| `GET /health/dependencies` | 正常读取状态返回 200，即使当前未就绪；正文同上 |
| 状态源抛错 | 503、固定中文诊断，并记录稳定错误分类；不返回原始异常 |
| 其他路径或方法 | 404；不提供执行、写入、管理或调试接口 |

`startHealthServer({ port, host, readDependencies })` 只接受 `127.0.0.1`、`localhost`，两者实际均绑定 IPv4 `127.0.0.1`，非允许 host 在监听前拒绝。默认端口 4110；程序内测试可用 `port: 0` 获取独立端口。`close()` 幂等，等待实际监听关闭。

正式入口每次状态请求使用实际存储池的连接配置新建短连接，仅执行 `SELECT 1` 并关闭；连接和查询分别限时 2 秒，不改变业务池参数。`pg-pool` 的 password 属性不可枚举，探针必须显式保留，不能只展开配置。Mastra 使用已初始化实例注册的存储标识和应用关闭状态判定，不以包装对象引用相等判断。PostgreSQL 检查证明连接和查询可用，不代表业务表已迁移。

正式入口默认创建并连接真实 Driver，沿用 `CDP_URL`（默认 `http://127.0.0.1:9222`）和 `PAGE_MATCH`（默认 `renderer.html`），只接受回环 CDP 地址；不启动或重启 KK9。Driver 健康要求 CDP connected、EventBridge attached、连接身份属于本启动代次且连接 ID 一致。关键 health/error 事件后该实例保持 down，不原地重连或后台重试；重启应用创建新实例。初次连接失败仍提供 live 和依赖诊断，ready 为 503。模型与 RAGFlow 的状态来自下述五分钟真实后台检查，完成前或缺少凭证时为 unknown；核心正常但任一外部依赖不正常时 degraded/200，六项正常才 ready/200。

正式启动后可执行：

```powershell
curl.exe http://127.0.0.1:4110/health/live
curl.exe -i http://127.0.0.1:4110/health/ready
curl.exe http://127.0.0.1:4110/health/dependencies
# 用本机实际网卡 IPv4 地址替换，访问应失败；不要停掉其他工作树的占用进程。
curl.exe --connect-timeout 3 http://本机局域网地址:4110/health/live
```

#### 本地验证（2026-09-08）

已执行运维三个定向测试文件，26/26 通过；受影响的 T16 Skill 启动集成 12/12、T13 真实 PostgreSQL 路由隔离 3/3 通过。根 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 通过，默认测试 Driver 308 项、App 59 项；根测试不包含 PostgreSQL 集成目录或真实 KK9。

```bash
pnpm --filter @kairo/app exec vitest run tests/unit/operability.test.ts tests/unit/operability-logging.test.ts tests/unit/operability-startup.test.ts
pnpm --filter @kairo/app exec vitest run tests/integration/bot-customization.test.ts
pnpm --filter @kairo/app typecheck && pnpm --filter @kairo/app test && pnpm lint
```

最后一条在真实探针的 password 修复后再次执行并通过，App 仍为 59/59。T13 集成由临时探针将 `KAIRO_TEST_DATABASE_URL` 显式指向本任务独立库后执行 `pnpm exec vitest run tests/integration/mastra-route-isolation.spike.test.ts`；不会自动借用其他工作树的测试目标。

临时 `node apps/kairo/tmp/t17-smoke.mjs` 使用本工作树构建产物与独立随机临时数据库：实际监听 `127.0.0.1:5908`，live 200、ready 503，配置/PostgreSQL/Mastra 为 up，其余 unknown；从本机访问 `100.90.167.77`、`172.16.3.76`、`172.17.176.1` 的同端口均为 `ECONNREFUSED`。这是本机通过非回环地址访问，不声称已在另一台局域网机器发起请求。

同一探针在另一个独立 HTTP 服务上注入状态，实际得到 ready 200、degraded 200、not_ready 503；这只验证状态与 HTTP 合同。日志抽查保留 taskId 与 send_unknown，不含注入的问答正文、知识片段、密码或令牌。T13 集成测试使用本任务新建数据库，并只在它自行创建的随机库执行既有迁移；没有修改迁移文件或其他工作树测试数据。

首轮真实探针因遗漏非枚举 password 而把 PostgreSQL 误判 down；显式保留后上述真实查询与路由合同通过。此前定向测试还发现 Mastra 包装存储的引用比较误判，以及一条长度错误的测试 Git ID，均已修正。每轮探针结束均回收自己的数据库与监听。

本次未连接、停止或更改真实 KK9 会话，未调用真实模型/RAGFlow，未验证真实六依赖全部正常时的 ready，也未实际向员工发送失败说明；不以本轮结果关闭这些验收缺口或关闭 #222。临时探针与结果文件在验收后删除，不成为新的正式启动流程。

接口依据：[存活与就绪的区别](https://kubernetes.io/docs/concepts/workloads/pods/probes/)、仓库锁定 Pino 的 `docs/redaction.md`、Mastra `setLogger/getStorage` 类型与 `pg-pool` 实际实现；以本轮运行结果为准。

#### 获批扩展：Driver 日志接入（2026-09-08）

Driver 原先使用模块级 Pino 和 `createChildLogger()`，本轮沿用进程级作用域，新增公开的 `setDriverLogSink(sink | undefined)`、`DriverLogEntry`、`DriverLogSink`，不向各层构造函数追加参数。安装后，先前已创建和之后创建的 Driver 子日志都会进入同一接收函数；传入 `undefined` 恢复独立 Pino 出口。它不是每个 Driver 实例各自的日志配置。

Driver 在 Pino `hooks.logMethod` 中、任何正文格式化或 Error/toJSON 序列化之前，选取固定事件、`messageId/sessionId/employeeId/runId`、耗时、状态和错误类别。`startupGenerationId` 对应日志 `runId`，不会输出页面标题、URL、WebSocket 原始关闭原因、sender 对象或自由消息。接收状态 `received` 保留；发送 `unknown` 明确使用 `send_unknown`，不变成 `failed`。独立出口也不再打印原始异常和业务正文；子日志的 module bindings 不绕过字段白名单。

`startKairo()` 在加载配置前执行 `setDriverLogSink(createDriverLogSink(logger))`，将上述记录送入应用现有 Pino 模块。四个固定事件为 `Driver运行状态`、`Driver运行异常`、`Driver连接状态`、`Driver发送结果`。沿用 Driver 原有 `LOG_LEVEL` 过滤；进入应用接收函数时，trace/debug/info 归为 info，warn 保持 warn，error/fatal 归为 error，不为这次接入增加日志框架。

日志扩展本身不创建连接；后续正式装配由 `startKairo()` 创建并拥有 Driver，健康读取该实例。基础消息和原生媒体发送在现有最终结果出口记录状态，保持发送、回退、Bot 消息关联和 recall 行为不变；`getSendStatus()` 仍只查询，不被记为再次发送。发送记录中的 `durationMs` 来自已有 `verifyLatencyMs`，不是整个业务任务的执行时长。

Driver 注入渲染页的五条告警只输出 `[KairoDriver]` 前缀加固定中文字符串，不附带异常对象：前序 Hook 清理、CDP binding 派发、会话摘要更新、聊天窗口推送、Vue 滚动列表检查。`CdpClient` 在现有 `Runtime.consoleAPICalled` 事件路径仅识别这五条精确字符串，转入统一日志，丢弃附加参数；不采集 KK9 的其他控制台输出，不新增 Runtime.enable、binding、连接步骤或全局 console 替换。页面告警本身仍在页面控制台可见，但已无原始错误内容。

实际执行：

```bash
pnpm --filter @kairo/driver exec vitest run --root ../.. packages/driver/tests/driver-log-sink.test.ts packages/driver/tests/driver-lifecycle-logging.test.ts packages/driver/tests/cdp-client.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/operability-driver.test.ts tests/unit/operability-logging.test.ts tests/unit/operability-startup.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/config.test.ts tests/integration/bot-customization.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

上述定向测试依次为 18/18、15/15、36/36；最后一次完整质量命令全部通过，Driver 27 个文件/320 项、App 7 个文件/61 项。新增 Driver 测试使用真实 Pino 子进程完整输出、本地 HTTP/WebSocket，以及已有 VM 执行真正的注入脚本；覆盖接收函数无旁路、敏感字段、正常连接/断线、三种发送结果、确认送达后 UI 失败不变成发送失败，以及五条渲染诊断。

扩展首次完整验证发现临时启动夹具没有保留 pnpm 的 Driver 工作区相对目录，Node 在应用加载前报 `ERR_MODULE_NOT_FOUND`。T15/T16 夹具现补齐临时 `packages/driver` 指向本工作树的链接，继续使用真实包导出，不复制依赖、不改生产解析、不放宽脱敏与错误分类断言；修复后 36 项启动/Skill 回归及完整质量命令通过。

临时 `node apps/kairo/tmp/t17-driver-smoke.mjs` 另以普通 Node 子进程启动构建产物，通过本机临时端口实际建立 HTTP/WebSocket，执行 CDP 连接、带秘密原因的断连、再次连接、Driver 告警与无关页面输出注入，并通过真实 `startKairo()` 安装日志出口。捕获的 stdout 全为 JSON，stderr 为空，日志呈现 up → down → up → down，保留同一 `runId`，不含测试秘密。此处 CDP 服务是本地协议替身，不是 KK9；应用 live 返回 200，该轮未访问数据库。临时脚本与自己的端口均已清理。

上述扩展初次交付时尚未执行真实 KK9 收发；用户随后要求真机验证及正式装配，下方分别保留各轮实际结果。独立 Studio 和 Skill 加载前的原生 warning 维持原边界；不操作 T18 进程、测试库或 PR，不使用自动关闭 #222 的关键字。

#### 追加真实 KK9 验证（2026-09-08）

本轮测试针对提交 `1d0e500`，使用当前机器的真实 KK9，不再是 CDP 协议替身。只读探针先通过 `127.0.0.1:9222/json` 找到正式 renderer，再用真实 `CdpClient` 两次连接、读取状态和主动断开。沿用真机脚本的 `.main-page` 选择器核对实际登录 UID 为 `5761`，当前会话为 `int2024 / 0-3585`；开始时不存在 Kairo Hook 或 binding，未接管其他会话。

执行命令：

```powershell
node apps/kairo/tmp/t17-real-readonly.mjs
$env:KK9_MEDIA_CONFIRM = '5761:0-3585:int2024'
$env:KK9_MEDIA_TARGET_ID = '0-3585'
$env:KK9_MEDIA_TARGET_NAME = 'int2024'
$env:KK9_MEDIA_KEEP = '0'
$env:KK9_MEDIA_KEY_CASES = '0'
$env:CDP_URL = 'http://127.0.0.1:9222'
$env:PAGE_MATCH = 'renderer.html'
pnpm --filter @kairo/driver exec tsx ../../apps/kairo/tmp/t17-real-media.ts UrlCard
node apps/kairo/tmp/t17-real-readonly.mjs
node apps/kairo/tmp/t17-real-health.mjs
```

`t17-real-media.ts` 是临时验证包装器，安装真实应用日志接收函数后执行仓库现有 `examples/e2e-media.ts` 的 UrlCard 分支。没有替换 CDP 响应或消息结果。包装器在真实 connect 后持有本次 Hook/binding 的对象引用，在调用真实 disconnect 后清理自己的引用；仅在全局仍指向这些对象时删除对应入口，不清理后来替换的其他 Hook。原脚本的身份/目标门禁、发送、查询、防重与撤回逻辑均照常执行。

实际结果：

- 唯一测试标记 `Kairo媒体验收-1788833263349`；operationId 为 `media-UrlCard-662238e1-c341-4d8c-9f5b-5790d5071bcc`。
- 真正发送一条卡片，返回 `delivered`、正式消息 ID `135813651`；确认耗时 `538ms`。
- 同 operationId 重放返回同一 ID，状态回查为 delivered；`queryChatMessage` 和 `searchMessages` 均包含该消息，公开历史类型为 `url-card`。
- 脚本成功撤回 `135813651`。随后只读复查仍为 UID 5761、会话 `int2024 / 0-3585`，Hook 与 binding 均不存在；仅关闭本轮的 CDP 连接，没有重启 KK9。
- 捕获 13 条 Driver 应用日志，两条发送结果记录对应同一消息（初次发送与防重重放），只含 ID、runId、事件、状态和耗时，不含卡片正文、验收标记或消息链接。原真机脚本自己的验收诊断会显示测试标记与该条测试历史正文；这里不把它误称为应用生产日志，也不声称完整 CLI stdout 无正文。

另以真实 `startKairo()` 启动本任务独立健康监听 `127.0.0.1:5860`，使用既有测试连接仅执行只读 `SELECT 1`，不写表或执行迁移。实际 live 200、ready 503、dependencies 200；配置/PostgreSQL/Mastra 为 up，driver/model/ragflow 为 unknown。同时存在的独立探针确实连接真实 KK9，但没有把这条外部连接伪装成应用已装配的 Driver。经本机 `100.90.167.77`、`172.16.3.76`、`172.30.224.1` 访问该端口均 `ECONNREFUSED`，不是从另一台机器发起访问。

上述命令均以退出码 0 结束。健康监听、数据库短连接、CDP 连接、测试消息及本次 Hook 已回收，临时脚本在证据记录后删除。本轮没有修改产品源码，未重复运行未改变源码的离线质量套件；前一轮 Driver 320/App 61 的质量结果保持为历史验证记录。

边界：这次证明真实连接、UrlCard 送达确认、原生历史、防重、状态查询、撤回、日志过滤和本机健康访问。没有执行阶段一全量入站矩阵、其他媒体类型、真实故障注入的 unknown/failed、自然断网恢复、接收方视觉确认、真实模型/RAGFlow 或员工失败说明；也没有验证六项真实依赖全部正常的生产 ready。PR 仍保留对应未验证项。

#### 正式应用拥有 Driver 的验收（2026-09-08）

`startKairo()` 返回自己拥有的 `driver`，先订阅错误/健康事件，再连接；测试只能通过显式工厂注入已有 `IKK9Driver`，CLI 不提供替身或禁用开关。SDK disconnect 清理本实例仍拥有的 Hook、订阅、观察器和 binding，不删除后来实例的资源；CDP 已失联时释放本机资源，由下一代接管清理遗留 Hook。握手使用既有超时配置，重复关闭复用同一操作。

本轮实际命令：

```bash
pnpm --filter @kairo/driver exec vitest run --root ../.. packages/driver/tests/event-bridge-lifecycle.test.ts packages/driver/tests/cdp-lifecycle.test.ts packages/driver/tests/driver-health.test.ts packages/driver/tests/event-bridge.test.ts packages/driver/tests/cdp-client.test.ts packages/driver/tests/driver-lifecycle-logging.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/application-driver.test.ts tests/unit/operability-startup.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm lint && pnpm --filter @kairo/app build
node apps/kairo/tmp/t17-owned-driver-real.mjs
# 在 apps/kairo 目录启动默认 CLI；临时预加载器仅为当前进程设置既有测试数据库连接。
node --import ./tmp/t17-cli-env.mjs dist/index.js
```

SDK 定向回归 41 项、App 装配与健康回归 26 项通过；完整 build/typecheck/test 通过，Driver 330 项、App 86 项。首次 lint 指出一个受长度检查保护的索引和三个无 await 的测试替身，修正后单独执行 lint 与 App build 通过。握手测试最初的服务器半开连接问题也已修正。这里不把首次整串命令说成全部成功。

真实探针不注入测试 Driver、不覆盖 SDK connect/disconnect，也不手工替 SDK 清理 Hook：

- 只读确认 UID 5761 且不存在其他 Hook/binding。首次因当前界面没有活动会话而在发送前停止；随后通过真实 Driver 唯一核对 `int2024 / 0-3585`，明确指定目标，不切换界面。
- 正式应用监听 `127.0.0.1:13034`，ready 200/degraded；配置、PostgreSQL、Mastra、Driver 为 up，模型/RAGFlow unknown。
- 通过 `application.driver` 发送 UrlCard，正式 ID `135821251`、delivered、确认耗时 523ms，状态回查成功并已撤回。日志保留 ID、runId、状态与耗时，不含卡片正文、链接或凭证。
- 只终止本应用自己的 WebSocket，Driver down、ready 503/not_ready，live 200，应用未崩溃。
- 关闭后重新启动，新代 Driver 在 `127.0.0.1:13041` 恢复 up、ready 200/degraded；正常关闭后 Hook/binding 均不存在，登录身份与原界面状态不变。
- 指向未监听的本机 CDP 端口，初次连接失败仍有 live 200、ready 503、driver down；错误归为 driver。
- 默认 CLI 实际监听 `127.0.0.1:4110`，ready 返回相同的核心 up/degraded 状态；Ctrl+C 后退出码 0。监督工具的 Windows PTY 将中文日志解码为乱码，中文就绪模式超时；读取稳定的 `status: started` 字段与真实 HTTP 确认启动，不属于应用启动失败。

上述真机探针和 CLI 的数据库访问仅执行健康只读查询，不修改测试表或迁移。另补跑 `pnpm --filter @kairo/app exec vitest run tests/integration/bot-customization.test.ts`，12/12 通过；在 apps/kairo 目录用 `node --import ./tmp/t17-cli-env.mjs ../../node_modules/vitest/vitest.mjs run tests/integration/mastra-route-isolation.spike.test.ts`，3/3 通过。后者显式注入测试 Driver，只在自身创建的随机数据库运行既有迁移、写入并回收，不操作其他工作树的测试库。第一次误用 App 目录下不存在的 Vitest 路径，改为根工作区入口后通过。测试消息和本任务进程、连接、端口均回收，临时探针在记录后删除。非回环访问证据沿用上一轮同一健康服务器实现的真实拒绝连接结果，不声称本轮从另一台机器重新验证。

本轮补齐真实 Driver 正常后的正式 ready 验收；仍未调用真实模型/RAGFlow、验证六项真实依赖全部 up、全量入站矩阵或向员工实际发送中文失败说明。保留 #222 和 PR #260 的相应未验证项，不合并或关闭。

#### 模型与 RAGFlow 五分钟真实检查（2026-09-08）

用户批准调用成本后，`startKairo()` 接入 `operability/dependency-checks.ts`：启动后立即检查，然后每 300000ms 各检查一次，两项独立执行，同项不重叠；失败后不立即重试。健康 HTTP 请求只读取内存中的最近结果，不触发推理或检索，不提供可执行的 Agent/Tool/Workflow 路由。检测延迟最多约为检查间隔加请求超时，不能把缓存状态理解为瞬时保证。

- 模型复用既有 `ModelRouterLanguageModel` 与正式 YAML 的 model.id/model.url，凭证沿用 `KAIRO_T12_MODEL_API_KEY`。固定短提示、最多 128 输出 token、60 秒超时；实际收到非空文本才 up，不用模型目录存在代替推理成功。
- RAGFlow 使用 `RAGFLOW_API_KEY`，地址为 `RAGFLOW_API_URL`，未设置地址时沿用已批准的 `http://rag.union.com/`。向 `/api/v1/retrieval` 提交固定问题与 YAML 唯一 Dataset，30 秒超时。HTTP 成功、业务 code 0、合法 chunks 才 up；空结果正常，错误或畸形结果为 down。不上传文档、不创建 Dataset、不读取其他 Dataset。
- 缺少凭证保持 unknown，并记录配置类别；请求失败为 down，下一周期成功恢复 up。失败日志只包含固定事件、状态、耗时与稳定类别；正文、凭证和原始异常不入日志。关闭时取消本进程请求并等待结束，不把正常关闭误记为外部故障。
- 周期持续运行时每项约 288 次/天，另加启动检查；真实模型和检索会产生计算成本。没有新增环境开关、重试框架、业务存储或 T27 Tool 合同。

实际验证命令：

```bash
node apps/kairo/tmp/t17-external-probe.mjs
node apps/kairo/tmp/t17-model-catalog.mjs
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
pnpm lint
node --env-file=.env apps/kairo/tmp/t17-external-application.mjs
# 下条在 apps/kairo 目录执行；迁移和写入仅发生在既有测试自行创建的随机库。
node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run tests/integration/mastra-route-isolation.spike.test.ts tests/integration/bot-customization.test.ts
# 默认 CLI，临时预加载器仅将本进程 DATABASE_URL 指向既有测试连接，应用只读检查。
node --env-file=.env --import ./apps/kairo/tmp/t17-cli-env.mjs apps/kairo/dist/index.js
```

初次调查真实模型推理成功，5.678 秒；认证模型目录 200 且模型存在，199ms，但目录结果不当作推理证明。RAGFlow 公开 version/healthz 均 200、自报 v0.27.1、四项内部服务 ok；当时缺少 API Key，明确保留检索缺口。用户配置后重新实测，模型推理 2.291 秒；正式 Dataset 权限验证和检索都为 HTTP 200/code 0，返回 30 条片段，1.256 秒，不输出正文。

最终 App build/typecheck、91 项默认测试、根 lint 均通过；受影响集成 15/15。新增 5 项回归覆盖未知→正常→失败→恢复、读取不增调用、五分钟边界、缺凭证、空结果/畸形结果、超时与关闭取消。第一次定时回归因 vi.waitFor 自动推进假时钟而失败，改为仅清空当轮异步工作；项目类型库不支持流异步迭代和 Promise.withResolvers，沿用 getReader 和原有 Promise 写法，不扩大编译目标。首次 lint 的导入/返回类型与拒绝原因问题修正后通过。

正式应用故障矩阵使用真实 PostgreSQL、应用自身真实 Driver，以及转发到真实模型/RAGFlow 的本机代理：六项 up 时 ready/200；仅模型代理 503 时 model down、degraded/200；仅 RAGFlow 代理 503 时 ragflow down、degraded/200；恢复后同一应用下一轮回到 ready/200。live 始终 200，重复读取健康状态不增加调用。本机非回环网卡地址访问均失败。最后挂起本次代理请求再关闭应用，5 秒内取消并退出，Hook/binding 均清理，登录 UID 不变；没有发送 IM 消息或重启远端服务。

矩阵仅在临时进程捕获并手动调用五分钟回调，以推进故障轮次；没有改写产品周期，不声称实等多个五分钟。初次探针过早推进下一轮，遇到上一轮未完成时不重叠的保护；改为等待两个代理响应都结束再推进后通过。默认 CLI 另直接连接真实服务、未使用故障代理，实际访问 `127.0.0.1:4110/health/ready` 得到六项 up、ready/200，Ctrl+C 退出码 0。

以上补齐真实模型/RAGFlow 和六项真实依赖 ready 验收。仍未执行全量入站矩阵、向员工实际发送中文失败说明或从另一台局域网机器访问；不合并 PR、不关闭 issue。临时文件和本任务连接在记录证据后清理，不提交凭证或改变其他工作树配置。

### T18 私聊账本

`modules/private-chat-core/PostgresPrivateChatStore` 保存原始消息、聚合批次、context 和固定提示限频。实际入口为 `modules/private-chat-core/store.ts`，连接池由调用方持有和关闭；运行时不执行迁移，也不输出消息正文。新迁移使用 `000004-private-chat.sql`，因为 `000003` 已用于原生媒体发送操作。

原始消息使用 `(session_id, message_id)` 唯一键，重复观察不覆盖首次内容；员工关联初始为空，只能写入与可信私聊 `0-<uid>` 匹配的员工 UID。context 按员工、Bot、会话隔离，失效后新建 thread 并递增版本，旧版本不能更新当前上下文。批次保存显式顺序及绝对截止时间；提示限频使用原子条件写入。存储不自动删除两小时前的历史，不实现 T22/T23/T24 的身份查询、聚合触发、空闲判定或 `/new` 编排。

定向验收（在 `apps/kairo` 目录执行）：

```bash
node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/integration/private-chat-store.test.ts
```

`.env` 必须提供 `KAIRO_TEST_DATABASE_URL`，账号需允许创建临时数据库。测试在同一 PostgreSQL 服务创建随机 `kairo_t18_<uuid>` 库，两个独立连接先核对实际库名及不同的后端进程 ID，再执行迁移；结束时仅关闭自有连接并删除本次创建的库。不迁移或清理连接配置中的原库，不回退到 `DATABASE_URL`，缺配置明确失败。T18 交付时尚无 `db:migrate:test` 脚本；本测试通过既有 `migrateDatabase()` 执行首次及重复迁移。T19 新增的定向迁移命令见下节。

#### 真实验证（2026-09-08）

- 上述定向命令实际通过 15/15：首次及重复迁移、双连接原始消息防重、跨会话原生 ID、方向与附件持久化、可信员工关联、context 隔离与版本、批次顺序和绝对截止、重复及非法归属拒绝、建批事务回滚、提示限频边界与并发、旧历史保留。
- 独立 `node --env-file=../../.env t18-smoke.mjs` 探针也通过：真实后端进程 ID 为 `20739`、`20740`；并发插入只有一个胜出者，关闭全部业务连接后用全新连接恢复原始正文、context、批次及消息顺序。这里验证连接重建，不声称覆盖操作系统强杀或完整进程恢复调度。
- 探针库 `kairo_t18_smoke_7fe97978b4cb43a6b84b0df99bbe7631` 已删除；最终查询显示没有 `kairo_t18_` 前缀临时库残留。临时探针文件已删除，正文未输出到日志。未操作真实 KK9、模型或其他 worktree 服务。
- 此前同一实现的 `pnpm build`、`pnpm typecheck`、`pnpm lint` 及默认测试已通过，默认测试为 Driver 308 项、App 33 项。本轮补齐真实数据库证据，未修改存储源码，也未重复运行无变化的离线质量检查。

### T19 任务、attempt 与员工等待账本

入口为 `modules/task-lifecycle/PostgresTaskStore`，实际文件为 `modules/task-lifecycle/store.ts`；迁移 `000005-tasks.sql` 新建 `kairo.tasks`、`kairo.task_attempts`、`kairo.user_waits`。复用 T18 的 ready batch、thread 和可信身份，不创建 collecting task，不重复生成同 batch 的任务。运行时不迁移、不接收 IM 或执行 Agent，连接池仍由调用方管理。

task 保存员工、Bot、会话、batch、thread、输入版本、创建配置摘要及队列/执行绝对截止；attempt 保存独立 attemptId、runId、实际配置摘要、输入版本、开始/结束、AppErrorType 和采用标记。task 的配置摘要表示创建时配置，attempt 的摘要表示该次实际配置，不建设配置兼容层。所有时间接口为 Unix 毫秒，数据库为 timestamptz；queued 的执行截止为空，只有领取成功才建立。

`claimTask()` 用单条条件 UPDATE 领取。跨 task/attempt/wait 的操作在同一事务内先锁 task，比较状态与输入版本；采用结果还比较当前 attempt 指针、成功结束记录和未到执行期限。`updateInputVersion()` 仅对 queued/running 生效，并清除当前 attempt 指针，不重置期限或自动重跑；正常新消息仍应进入下一批。终态没有出边，迟到 attempt 只可补记审计。数据库异常原样传播，不包装成 false。

等待记录保存问题正文、授权适用的问题/缺失子问题 ID、inputVersion、十分钟绝对截止、剩余执行预算及原始回答消息关联。用户于本任务终端批准：等待不消耗执行预算；同意后用剩余毫秒恢复同一 running task，拒绝或新问题替换时 cancelled，到期 timed_out。重启不延长任何期限。同一 Bot/私聊只能有一个开放等待；同一原始回答只消费一次。回答须为匹配员工/会话、在等待开始后观察到且非未来的入站消息。语义同意判断、问题 ID 分配、提示实际发送和定时触发由后续调用方负责，T19 不实现这些编排。

完整合法出边见 `SPEC-stage-1.md` 的任务状态表。普通 `transitionTask()` 只处理进入 sending 或终态的边；领取、采用、进入等待及回答恢复使用专用接口，不能绕过版本和字段合同。sending 已触发后不能以执行截止推断发送失败；本模块仅保存调用方确认的发送状态，不代替 Driver 的送达证据或 T21 查询。

执行失败 `running → failed` 的输入必须提供非空字符串 `expectedAttemptId`，类型使用联合分支表达必填条件；存储在现有任务行锁内确认该标识非空且与当前指针相等。旧 attempt 的迟到失败、缺失标识、null 和空字符串均拒绝，不更新任务；`finishAttempt()` 仍可补记旧错误。整任务取消和发送阶段失败沿用原语义，不增加数据库字段或兼容入口。

#### 实际验证（2026-09-08）

从仓库根执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app test:integration -- tests/integration/task-store.test.ts
pnpm --filter @kairo/app typecheck
pnpm lint
pnpm --filter @kairo/app build
node --env-file=.env apps/kairo/tmp/t19-smoke.mjs
pnpm --filter @kairo/app test
```

- 测试迁移命令在随机库执行首次迁移，并定向验证重复迁移不改变已保存 task/attempt/wait：1 项通过，其余 23 项按测试名筛选未执行，不冒称全量通过。
- task-store 定向集成最终 24/24 通过：十状态全部合法边、独立 10×10 状态矩阵、终态不倒退、真实双连接领取与 attempt 替代竞争、旧输入版本不能采用、失败结束审计、等待预算、身份/问题范围/原始回答、同会话唯一等待及回答仅消费一次、各截止边界，以及连接重建后全部字段与毫秒截止保留。
- 最终集成库 `kairo_t19_8b79953195df438aae8ad39d984d4ff9`，真实后端 PID 为 22220、22221。迁移前先核对两连接的实际目标及不同 PID；管理连接只创建/删除本次随机库，不迁移 `.env` 中的原库。
- 首轮集成 22/23 通过，真实并发发现不同 Bot 的两条等待争同一回答时败方抛唯一键错误。修复为先锁这条原始回答，再在下一条语句的新快照中检查消费记录；原用例保留，修复后返回一胜一负，不吞数据库错误。
- 首次 typecheck 报测试数组可能越界；改为明确双元素元组及真实查询行存在性检查后，App typecheck、根 lint、App build 均通过，默认 App 测试 9 文件/91 项通过。未降低 TypeScript 或 lint 规则，未变更依赖版本。
- 独立普通 Node 烟测使用构建产物和随机库 `kairo_t19_smoke_4367774ca3864fda8a2070c0774d4250`，PID 22190、22191；领取结果 `[true,false]`，关闭全部写入连接后新建连接恢复任务/attempt/wait，同意等待后预算保持，最终 sending→completed，迟到采用及终态取消均拒绝。
- 两份独立只读审查未发现可证实的存储合同缺陷；测试审查指出原用例只覆盖“终止与结束审计竞争”和“关闭池错误”。已补实际双连接取消/采用竞争，并用真实 PostgreSQL CHECK 失败验证 SQL 错误码 23514 向上传播、任务/attempt 不变、无半截 wait，同一 max:1 池回滚后仍可成功提交。随后重新执行迁移、24 项定向集成、typecheck 和根 lint，全部通过。
- 新增代码的 Prettier 检查及 `node --check apps/kairo/scripts/test-integration.mjs` 通过。只读查询本次六个精确临时库名，残留为 0；没有按前缀清理其他数据库。
- `pnpm --filter @kairo/app test:integration -- tests/integration/t19-not-a-real-test.test.ts` 是故意使用不存在文件的负向烟测：退出码 1，报告未找到测试，没有执行其他集成文件。两个临时 Node 探针已在验收后删除，上述探针命令是执行历史；长期复现使用保留的迁移和 task-store 集成命令。

这些证据验证真实 PostgreSQL 持久化、连接重建和存储级竞争，不声称完成操作系统强杀故障矩阵、调度恢复、实际 Agent 运行或 IM 送达。没有操作真实 KK9、模型/RAGFlow、其他工作区进程或数据库；T20/T21/T24/T25/T26/T30 未提前实现。

#### 旧 attempt 迟到失败修复（2026-09-08）

上述初次 24 项测试和独立审查漏掉了同输入版本下旧失败终止新 attempt 的路径。Advisor 提出反例后，已用真实 PostgreSQL 两连接核实：B 替代 A 后，A 的 running→failed 原先返回 true，任务变成 failed，B 的成功结果无法采用。本轮不再将此前的通过结果视为该路径已被覆盖。

新增两条永久回归先于修复执行，均因预期 false、实际 true 而失败；加入任务锁内的当前指针比较并更新失败迁移调用后，两条均通过。覆盖旧 A 失败审计保留、任务与 B 不受影响、B 成功采用，以及尚无当前 attempt、缺失/null/错误标识的拒绝与当前 attempt 合法失败。

实际执行：

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/task-store.test.ts --testNamePattern="旧尝试迟到失败|执行失败必须明确"
pnpm --filter @kairo/app test:integration -- tests/integration/task-store.test.ts
pnpm --filter @kairo/app typecheck
pnpm lint
pnpm --filter @kairo/app build
pnpm --filter @kairo/app test
```

定向回归修复前 2 项失败、修复后 2 项通过；完整真实 task-store 为 26/26，App typecheck/build、根 lint 和默认 App 91 项均通过。完整集成随机库为 `kairo_t19_9caf8e59c5234593ba071bea440d84a5`，两个后端 PID 为 22540、22541；沿用自建库核验和清理，不操作原库或 KK9。未变更迁移、未增加 attempt 重试调度或额外锁框架。

#### PR #261 审查修复与测试重组

审查修复最初在独立工作树完成，现按用户要求迁回 `dnslin/issue-226-t21-send-service`，随 PR #262 交付；下方独立工作树验证记录保留为历史证据。没有修改 Driver、T20 知识/Memory、迁移、任务公共类型或队列调度。生产变更只是在既有 `running → failed` 当前尝试比较中拒绝空字符串，使实现与已有“非空标识”合同一致；不引入全局 ID 校验。新增真实 PostgreSQL 回归先于修复执行，因预期 false、实际 true 失败；修复后拒绝空标识，替代为有效 attempt 后仍能正常失败。

原回滚测试在事务第一条写入时用空问题范围触发 CHECK，不能证明已经完成的写入会被撤销。本轮用临时的“省略 BEGIN/COMMIT/ROLLBACK、业务 SQL 仍访问 PostgreSQL”的错误变异体实测：旧断言仍通过；改在最后一次 task 更新触发仅针对该随机 task 的 CHECK 后，错误变异体留下 wait 和 adopted 标记，正常实现完整回滚。永久回归保留后者，在 finally 删除自有测试约束，并用同一连接池、同一 waitId 成功重试。未改变生产事务实现。

任务测试由一个 1625 行文件改为以下合同文件：

| 文件 | 覆盖范围 |
| --- | --- |
| `task-store.test.ts` | 创建与领取、独立十状态矩阵、终态及跨任务门禁 |
| `task-store-attempts.test.ts` | 输入版本、attempt 替代、失败绑定与迟到结果 |
| `task-store-waits.test.ts` | 员工等待预算、回答归属与并发唯一消费 |
| `task-store-deadlines.test.ts` | 各接口前一毫秒与恰好截止的独立场景 |
| `task-store-persistence.test.ts` | 首次/重复迁移、新连接恢复和末步失败回滚 |

共享 `tests/helpers/task-fixtures.ts` 只提供前置条件明确的场景：`runningFixture` 不创建 attempt，`runningWithSuccessfulAttempt` 明确包含成功结束的 attempt，ready/sending/waiting 夹具返回各自实际具有的非空标识。删除普通测试中的万能 `fixtureAt(status)` 和 `action` 字符串分派；穷举状态只留在真正的状态矩阵及十状态恢复测试中，不建立第二套通用状态机。

每个合同文件通过原有 `createTaskTestDatabase()` 自建随机库，先核对目标与不同后端 PID 再迁移，结束时仅回收自己创建的库。下方是当前完整定向命令；上方 26 项验收和旧文件路径保留为当时实际执行的历史记录：

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/task-store
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app build
pnpm --filter @kairo/app test
pnpm lint
```

本轮实际结果：

- 未拆分前，空字符串回归修复前 1 项失败；修复后与末步回滚回归 2/2 通过，随后原完整套件加新回归 27/27 通过。两项原混合截止用例拆为八项独立接口用例，因此重组后为 `27 - 2 + 8 = 33`，不是删减原覆盖。
- 新工作树不含 `.env`。本次实际使用 `node --env-file=../issue-226-t21-send-service/.env apps/kairo/scripts/test-integration.mjs -- tests/integration/task-store` 向该进程载入已有测试配置，五文件真实 PostgreSQL 33/33 通过；配置不复制入仓库，也不对原库执行迁移。五个自建库分别为 `kairo_t19_a891a29c3f2c41d4b243c47a090cf4ea`、`kairo_t19_38e94ac6a6f84bad88690c76cfb01821`、`kairo_t19_9a7ecfd28c57481ab97aa9c588903bda`、`kairo_t19_d9a425939c9148cdb1daf5b870602957`、`kairo_t19_3bbf1ce286e64b5eb7293167ef8cb7f8`，各文件 afterAll 正常回收自有连接和数据库。
- `db:migrate:test` 通过已加载测试环境的 Node 父进程执行 `node --run db:migrate:test`：首次/重复迁移 1 项通过，另 2 项按名称筛选未执行。直接将 `--env-file` 与 `--run` 放在同一 Node 命令未向脚本提供配置，曾明确失败；随后改为先加载环境再启动子进程通过，没有把缺配置当作通过。
- 实际执行根 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过；默认测试为 Driver 29 文件/330 项、App 9 文件/91 项。修改文件的 Prettier 检查通过。拆分中遗漏的夹具类型名、异构场景类型及合法后继类型已按编译错误修正，没有放宽 TypeScript 或 lint 规则。
- 独立 `pnpm --filter @kairo/driver exec tsx --env-file=<原工作树的测试配置绝对路径> <修复工作树>/apps/kairo/tmp/rollback-review-probe.mjs` 使用生产 Store 构建产物和真实 PostgreSQL：空标识拒绝、有效替代尝试可失败；真实事务的末步失败不留下 wait/adopted，无事务变异体确实留下两项写入。最终烟测库 `kairo_t19_74f1b08ad211432db3c689896d8d32ac`（PID 23863/23864）已回收，临时探针交付时删除。
- 普通质量审查和 thermo-nuclear 结构复审均未发现剩余阻塞，确认原断言、并发和恢复覆盖保留，原 Required 结构问题已解决。复审只读，不将审查意见冒称额外执行测试。未访问真实 KK9、模型/RAGFlow，也未验证操作系统强杀恢复。

#### PR #261 审查后的质量修正（2026-09-08）

两项建议最初在独立 `pr261-quality-fixes` 工作区完成修正与验证；随后按用户要求应用到当前 T20 分支，并随现有 PR #263 交付，不再创建独立 PR。任务状态、业务 SQL、锁顺序、队列/执行期限和等待预算合同不变。以下72项等结果保留为独立工作区的执行历史，当前组合分支另行验证。

- 测试结构：原 `task-store.test.ts` 为 1625 行，夹具、合法状态边和截止用例重复分派动作。现拆为生命周期、attempt、等待、持久化四个文件（535、572、490、236 行），共享具名 fixture 显式接收 store/chat，各文件独立创建和关闭随机测试库。正向迁移与截止动作直接调用公开方法，不再解释 action/from-to 字符串；nullable fixture 仅用于状态矩阵或恢复遍历。原26项中22项保留同名行为用例，其余4项展开为显式测试，18条合法边、独立十状态负向矩阵、并发、版本、期限和回滚断言均保留。现为55项，不把数量增加当作覆盖证明。
- 事务错误：T18 原私有事务包装在 ROLLBACK 失败时覆盖原始操作错误，T19 已能保留两个错误；这是既有错误策略分叉，不是声称 T19 新引入了该错误。公共 createBatch/startAttempt 调用的确定性错误注入回归修复前1项失败、3项通过，修复后4/4通过，保留原始错误对象身份。
- `db/transaction.ts` 提供唯一 `withTransaction(pool, operation)`，T18三个、T19五个调用点直接使用，删除两套私有包装。回滚成功原样抛原错误；回滚失败用 AggregateError 保存两次错误。BEGIN或回滚失败时按 pg 的 `release(true)` 销毁状态不明的连接，不加入重试、嵌套事务或事务框架。
- 新增真实事务集成补足“已有成功写入后再失败”的验证：先 INSERT 和 UPDATE，再由 `SELECT 1/0` 产生22012，确认新增记录消失、旧值恢复，同一max:1池随后仍可提交。它不再仅靠首条INSERT自己的CHECK失败来证明回滚。

独立修正工作区不复制凭证。以下实际命令只从本任务原工作区的已授权环境文件向子进程注入测试连接，所有迁移与写入仍发生于各自新建、已核对库名的随机库：

```powershell
pnpm install --frozen-lockfile
pnpm --filter @kairo/app exec vitest run tests/unit/transaction-errors.test.ts
node --env-file=../issue-225-t20-knowledge-memory-store/.env apps/kairo/scripts/test-integration.mjs task-store tests/integration/private-chat-store.test.ts tests/integration/transaction.test.ts
node --env-file=../issue-225-t20-knowledge-memory-store/.env "C:/Program Files/nodejs/node_modules/corepack/dist/pnpm.js" --filter @kairo/app db:migrate:test
node --env-file=../issue-225-t20-knowledge-memory-store/.env apps/kairo/tmp/transaction-smoke.mjs
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

最终真实集成6文件72/72，其中任务55项、私聊15项、共享事务2项；迁移专题1项通过、2项按名称筛选未执行。默认测试Driver330/330、App95/95，最终完整四命令全部通过。首次完整门禁发现拆分后等待文件残留未使用的now导入，删除后原样重跑通过，没有禁用规则或缩小测试范围。

普通Node烟测直接执行同一事务函数，创建随机库 `kairo_pr261_8d61e03876534104a2a80327fb883412`，backend PID从23752变为23753；验证正常提交、先写后错的完整回滚，以及仅主动关闭本次借出连接后仍保留操作/回滚两个错误、连接池重新借出新连接并成功提交。没有关闭其他连接或数据库服务，不将受控关闭称为自然断网/操作系统强杀恢复。烟测库在finally中删除，临时脚本验收后清理；没有修改迁移、Driver、真实KK9或其他工作区数据库。

### T20 知识证据、反馈、Memory commit 与启动账本

迁移为 `000006-knowledge-records.sql` 与 `000007-memory-commits.sql`；`000005` 已属于 T19。2026-09-08 已向 T21 工作终端确认这两个编号由 T20 占用，T21 使用后续 `000008`，不依赖本工作区未合并代码。

#### 存储接口与边界

- `modules/knowledge-qa/PostgresKnowledgeRecordStore`（文件 `knowledge-record-store.ts`）保存每次 Tool 调用的 query、task/attempt/boot/tool ID、同 task 唯一次序、开始时刻、耗时、结果类别和原始结果 JSON；证据与查询在一个事务提交。类别包含 found、empty、format_error、service_error、auth_error、parameter_error、cancelled、timeout；冲突由证据的 conflict 标记保存，不把格式错误或服务错误记为空资料。
- 证据保存文档 ID/名称、片段 ID/正文、页码、原始 positions 和相似度。Dataset 保存在查询上；attempt 使用 task/attempt 复合外键。未知页码为 null，DOCX positions 不推算为物理页码。结果解析与类别判断由 T27 的受控调用方负责，本模块不实现检索或外部响应解析。
- `recordFormalAnswer()` 保存已清洗的正式原问题与实际送达正文、首次 deliveredAt、发送 operation、原生消息 ID、boot 和采用证据。插入核对既有发送账本为 delivered 且目标会话与 task 相同；跨 task 证据由复合外键拒绝，整个写入回滚。正式回答无更新接口，同 task 重复写入明确报唯一约束错误，不覆盖首次正文和时刻。答案检查与实际发送仍属于 T29/T21。
- `recordFeedback()` 只关联已记录正式回答，内部证据通过该回答的关联表保留。`suggestedAnswer` 可为空，验证状态固定为 unverified，不提供变为企业知识或写入 Memory 的接口。反馈语义判断、追问和处理编排仍属于 T31。
- `getQuery/getEvidence/getFormalAnswer/getFeedback` 按 ID 读取；`listQueries/listEvidence/listAnswerEvidence/listFeedback` 按 taskId 和显式 `{ limit, offset }` 分页。调用按 callIndex、证据按调用/片段位置、反馈按 createdAt/feedbackId 确定排序；相关唯一键、外键和查询列均有索引。正文只在业务表，不进入普通日志。
- `modules/agent-runtime/PostgresMemoryCommitStore` 只从 formal_answers 创建一 task 一条 pending 记录；问答和身份分别联查正式回答与 task，不再次复制正文、不接收员工更正文本。`createCommit()` 重复调用读取首次记录，缺正式回答返回 null；`advanceCommit()` 只允许 pending→saved→observed，重复、跳步、倒退或旧状态返回 false，SQL 错误仍向上传播。保存首次 createdAt/savedAt/observedAt，数据库约束时间顺序。
- 用户在 T20 终端确认继续采用 T12 的 `JSON.stringify([threadId, taskId, role])` 正式消息 ID，不采用 T32 issue 快照中包含 inputVersion 的描述。ID 由不可变任务身份派生，正式问答时间仍沿用首次 deliveredAt。T20 不调用 saveMessages/observe，不扫描待提交记录，不实施 T32 恢复或任务/context 有效性裁决。
- 所有公开时间均为 Unix 毫秒，数据库使用 timestamptz；Pool 由调用方拥有。没有自动清理、TTL、后台重试、兼容层或迁移时删除历史数据。

#### 正式启动与关闭

`modules/operability/PostgresRuntimeBootStore` 保存 bootId、Git commit、configDigest、startedAt、closedAt 和 starting/running/closed/failed。相同 bootId 保留首次元数据，运行和关闭采用条件更新，终态不可改写；列表按 startedAt/bootId 分页。

`startKairo()` 在配置和真实定制校验后写 starting，启动完成写 running，关闭资源后写 closed；启动主流程或资源关闭失败时写 failed。返回值新增 bootId 和只供程序内诊断的 bootError。独立大小为 1 的启动账本池复用 Mastra 的实际连接配置，连接/查询限时 2 秒，在 Mastra 关闭后保存最终关闭结果，再关闭自身连接；不执行 DDL。

用户确认沿用 T17 的诊断行为：启动账本写入失败仍提供 live，但本启动代次固定 not_ready/503，记录 storage 错误并保留原 cause，不自动重试；数据库恢复后必须重新启动应用。失败锁同时参与异步状态推进前及健康查询完成后的判定。数据库无法写入时不能保证有完整 boot 记录，不伪造成功记录或回退到普通日志保存业务正文。

原 T13 生产路由测试曾只对配置中的原库做只读探测。由于启动现会写 boot，该测试已改用既有随机临时库夹具；不能再直接对共享原库执行带启动写入的测试。T20 复用 T19 夹具，所以部分验收库名前缀仍为 `kairo_t19_`；迁移前先核对实际库名和两个不同 backend PID，只删除本次自建库，不清理其他同前缀库。

#### 实际验证（2026-09-08）

已实际执行：

```bash
pnpm install --frozen-lockfile
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app test:integration -- tests/integration/knowledge-record-store.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/memory-commit-store.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/runtime-boot-store.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/runtime-boot-startup.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/operability-startup.test.ts tests/unit/application-driver.test.ts
node apps/kairo/tmp/t20-smoke-run.mjs
```

- 锁定安装通过。迁移命令同时筛选 T19 与 T20 的“首次及重复迁移”：2 项通过、29 项未执行，不能把筛选结果当全量通过。
- 知识/反馈 5/5、Memory 10/10、boot 存储 12/12、启动集成最终 4/4 通过；覆盖五类检索结果、同 task 多次调用、分页、双连接竞争、跨任务引用拒绝、SQL 错误与事务回滚、反馈隔离、首次时刻/消息 ID 和状态前进。T17 受影响离线启动/Driver 26/26 通过，保留原有 ready 判定断言，只补充新的启动账本数据库夹具。
- 启动接入回归在实现前为 3 项失败；首次运行先遇到本工作区 Driver 尚未构建，构建既有依赖后才得到上述行为失败。独立审查另发现“启动账本池连接失败后被 markRunning 解除失败锁”的反例：仅终止已核对属于当前随机库的单条自有账本连接，修复前预期 503、实际 200；修复后该回归和全部启动集成通过。没有终止数据库服务、其他连接或 KK9。
- 独立普通 Node 烟测使用最新构建产物和随机库 `kairo_t20_smoke_e01022fc12b6494a8aa357ab9d49e579`。迁移使用测试管理账号 postgres，两个 schema 的 owner 均为 postgres；随后创建临时非超级用户运行账号，只授予 schema USAGE 和业务表 DML，不授予 DDL 权限。另在这个随机库安装遇到 DDL 就报错的 event trigger，正式应用仍成功启动、live/ready 均为 200，正常关闭。这里证明运行无 DDL，不是声称实际执行的 DDL 被静默吞掉。
- 烟测双连接 PID 为 23034/23035；按 taskId `29655744-459c-4ad4-a538-6daec03d4103` 以每页 2 条读回 5 次查询，顺序为 found/empty/format_error/service_error/found，耗时 10.5–14.5ms；两条证据分别保存 PDF 页码样本和未知物理页码的 DOCX 原始 positions，后一条带 conflict。数据是存储合同的合成样本，不是本轮真实 RAGFlow 请求或 PDF 解析验收。
- 关闭全部业务写入连接后，独立 `psql 18.6 -X -v ON_ERROR_STOP=1 -v task_id=… -A -t -f t20-record-check.sql` 通过运行账号重新连接，联查原始消息、batch、context、task、attempt、send、query/evidence、正式问答、feedback、Memory commit 和 boot。实际有 1 条原始消息、1 个采用 attempt、5 次查询、2 条证据、1 条未验证反馈，commit 为 observed、boot 为 closed。问答与员工更正分别读取，commit 仍只对应正式问答。
- 普通应用 stdout 中捕获 8 条 JSON 日志，保留 taskId/runId/toolId、耗时、Git/config 摘要；不含合成问题、回答、知识片段或凭证标记，stderr 为空。psql 的合成业务正文核对输出与普通日志分开保存，不把业务查询输出冒称无正文。

本轮不调用真实 KK9、主模型或 RAGFlow，不验证 T27 检索、T29 回答、T31 反馈编排、T32 正式 save/observe 与恢复。Checkpoint B 的真实 SOUL/AGENTS/Skill 加载及权限边界沿用本文件 T16 的 12 项原生集成和 6 个批准真实模型样例证据；不把确定性夹具当作本轮真实模型放行。

#### 最终回归与 Checkpoint B

最终实际执行下列完整命令，全部通过：

```bash
pnpm --filter @kairo/app test:integration -- tests/integration/private-chat-store.test.ts tests/integration/task-store.test.ts tests/integration/knowledge-record-store.test.ts tests/integration/memory-commit-store.test.ts tests/integration/runtime-boot-store.test.ts tests/integration/runtime-boot-startup.test.ts tests/integration/mastra-route-isolation.spike.test.ts tests/integration/bot-customization.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

集成为 8 个文件、87/87；默认测试为 Driver 330/330、App 91/91。早期门禁曾发现一处测试 messageType 推导过宽、两处多余非空断言及一处无 await 的测试替身，修正后通过。另一次完整门禁在 App 测试中途由 Tinypool 报 `ERR_IPC_CHANNEL_CLOSED`，当次未执行后续 lint；单独重跑 App 91/91，随后原样重跑上述完整四命令成功。未更改测试配置、关闭异常或缩小测试范围；该次测试进程退出原因未复现，不能声称已修复测试框架。

| Checkpoint B 项目 | 实际证据与边界 |
| --- | --- |
| 无效配置阻止 ready | 最终默认配置/完整 CLI 错误回归通过；校验仍发生在数据库和监听之前。T20 另验证启动账本失败后 live 可达、ready 固定 503。 |
| SOUL、AGENTS、真实 Skill 可加载且不能扩权 | 本轮 bot-customization 12/12；批准模型的 6 个真实样例明确引用上文 T16 历史证据，不宣称本轮重新调用真实模型。 |
| 迁移账号建立 kairo/mastra，运行无 DDL | 独立烟测中 postgres 迁移、双 schema owner 核对；临时受限运行账号加拒绝 DDL 的测试触发器，真实应用启动/关闭成功。 |
| 全部业务记录按 ID 查询 | psql 以 taskId 联查原始消息、batch、context、task、attempt、send、query/evidence、feedback、Memory commit、boot；应用分页 API 逐页无遗漏。 |
| 唯一约束与条件更新并发 | 本轮 T18 15/15、T19 26/26，及 T20 查询次序/事务、Memory 创建与状态、boot 启动与关闭的双连接回归。 |
| 普通日志无正文或凭证 | 独立烟测 8 条真实应用日志抽查；最终默认日志隐私回归及真实 Skill 完整 stdout/stderr 回归通过。 |
| 四项质量命令全部通过 | 最后一次原样执行 build/typecheck/test/lint，退出码 0；不把先前失败的执行记录算作成功。 |

烟测结束后按精确库名及临时角色名只读核对，残留均为 0。临时脚本、SQL、业务核对输出和日志已移出仓库，保留在本次会话证据中；便携 psql 和下载包已删除，未安装数据库服务、未接管现有 DataGrip 窗口。长期复现使用上述已保留的集成测试；本节临时烟测命令是执行历史，不是新增生产命令。

#### 当前 PR 接入审查修正后的回归（2026-09-09）

按用户要求将两项修正应用到当前 `dnslin/issue-225-t20-knowledge-memory-store` 分支，随 PR #263 交付。代码提交为 `899e7be` 和 `b7cb1e8`，保留全部 T20 实现；迁移专题入口同时包含拆分后的任务持久化测试与知识记录测试。未合并其他分支、未新增迁移或改变业务状态合同。

在当前工作区实际执行：

```bash
pnpm --filter @kairo/app db:migrate:test
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @kairo/app test:integration -- tests/integration/bot-customization.test.ts
pnpm --filter @kairo/app test:integration -- task-store tests/integration/private-chat-store.test.ts tests/integration/transaction.test.ts tests/integration/knowledge-record-store.test.ts tests/integration/memory-commit-store.test.ts tests/integration/runtime-boot-store.test.ts tests/integration/runtime-boot-startup.test.ts tests/integration/mastra-route-isolation.spike.test.ts tests/integration/bot-customization.test.ts
```

迁移专题2项通过、6项按名称筛选未执行；完整四项质量命令通过，Driver330/330、App95/95；最后完整集成12个文件118/118。真实数据库测试仍通过既有夹具创建并核对各自随机库，不操作其他工作区数据库或真实KK9。

首次把完整集成与根构建并行执行时，Skill启动日志测试的临时TypeScript编译子进程失败，结果为116项通过、2项未执行；Vitest输出未提供编译诊断，不能认定根因已确认或问题已修复。根构建完成后，单独Skill测试12/12、原样完整集成118/118，均未修改代码、跳过失败项或降低断言。这里保留首次失败记录，不将其计为通过。

### T21 统一出站发送协调器

`modules/im-transport/send-service.ts` 的 `createSendService()` 统一处理文本固定提示、排队、进度和最终回答；`send-policy.ts` 保存用途、状态、标识与预算合同。调用方提供现有任务/私聊账本、Driver Store、协调 Store、日志和 Driver 工厂。工厂必须把收到的 Store 交给同一个 Driver；连接、断开和 Pool 所有权仍属于装配方，协调器不会创建第二条 KK9 连接或自动迁移。正式业务装配与队列调度仍归后续任务，本次不修改应用入口、Driver、T20 知识/Memory、T24/T25 或 T32。

#### 获批的持久化补充

现有 Driver `SendOperationStore.claim()` 会占用实际发送资格，不能由协调器提前调用；它也不记录自动重试和查询预算。用户在本任务终端批准增加 `PostgresSendDispatchStore` 与 `000008-send-dispatches.sql`，只创建 `kairo.send_dispatches`。T20 已占用 000006/000007；本迁移只依赖已存在的 T19 tasks，不依赖 T20 未合并代码，不修改旧表或旧公共接口。

- task 意图键为 `(taskId,purpose)`；无任务提示为 `(botId,sessionId,messageId,purpose)`。首次原子写入生成 UUID operationId；重复事件返回原记录，不生成新发送。摘要按固定字段顺序包含主体版本/thread、目标与正文；语义相同的对象字段重排不产生冲突，不同正文或版本拒绝复用。
- `send_calls` 是调用前占用的发送预算，最多 2；`query_used` 是调用前占用的唯一查询机会。`revision` 条件更新只允许一个调用推进，终态不能再次更新。数据库错误直接传播，不假装 Driver 已明确失败。
- `prepared → sending` 先保存预算与 operationId，再调用 Driver；确定失败为 `retryable` 或预算耗尽后的 `failed`。`delivered` 结束该发送；`unknown` 不立即重发。查询的绝对截止在首次占用发送预算时设为当前时间加 30000ms，后续失败、重启不延长它，因此返回 unknown 后等待不超过剩余三十秒。
- 查询前保存 `querying/query_used=true`。查询后送达正常结束，失败只使用剩余的同 ID 重试预算；仍未知或已无查询机会的未知结果为 `send_unconfirmed`。这不是 Driver 的 failed，不会提交 Memory；维护日志保留 `send_unknown`。

#### 重复调用、恢复与交付

`send(request)` 处理普通事件：同实例并发共享结果，仍先核对请求摘要；其他实例看到 sending/querying 不抢占。`recover(request)` 只用于旧进程已停止后的恢复，不负责扫描、排队或调度。调用方沿用原请求正文与版本；协调表只保存摘要，不另存答案草稿。

恢复 prepared 可发送；恢复已触发操作先沿用剩余时间查询。用户批准严格总次数语义：若查询机会已占用，但结果未保存就崩溃，恢复直接记未确认，不补查、不重发；这接受“预算已扣、实际查询尚未发生”的崩溃窗口。若失败查询结果已明确保存，恢复可以使用剩余一次发送预算，不再次查询。重试调用同样先占用预算；无法确认是否触发的中断不能获得额外重试机会。

只有 final 推进 T19 `ready_to_send → sending → completed/failed/send_unconfirmed`；排队和进度各有独立 operationId，不结束任务。每次发送前检查任务版本、所处阶段和有效 context，在进入 sending 后再检查一次，覆盖 `/new` 插入该间隙。已触发 sending 不再按执行期限推断失败。接收结果时再次检查有效性：失效操作记 cancelled，Driver 的真实原生送达证据仍保留；终结任务不能被迟到结果复活。已知陈旧版本在占用意图键前拒绝，避免阻挡新版本答案。`close()` 只取消本协调器等待并禁止迟到推进，不关闭调用方资源。

查询抛错时尽量保存未确认并结束任务，同时保留原始 cause；若收尾保存也失败，AggregateError 保留两个原因。异常或关闭不转为安全重发。协调终态与 task 终态之间的中断，可通过同请求恢复补齐 task 条件更新，不写正式 Memory。

#### 数据库完全不可用的唯一例外

`sendStorageFailure(event, storageError)` 仅接受 storage 类 AppError，正文固定复用 T17 `getFailureMessage('storage')`。operationId 由 Bot、会话、原始消息 ID 确定，同一进程跨服务实例只尝试一次；无重试、无查询、不创建任务、不补发。只有该入口登记的 operationId 使用同一 Driver 包装 Store 内的内存记录；普通发送仍访问 PostgreSQL，失败不会自动走此通道。该入口不读取数据库中的 context/task，因为该场景不能创建它们；传入事件来自后续入站处理方，不由本模块接收 IM。

#### 实际验证（2026-09-08）

```bash
pnpm --filter @kairo/driver build
pnpm --filter @kairo/app exec vitest run tests/unit/send-service.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/send-service.test.ts
pnpm --filter @kairo/app typecheck
pnpm lint
pnpm --filter @kairo/app build
node --env-file=.env apps/kairo/tmp/t21-smoke.mjs
```

- 定向单元 41/41：全部 11 条三态后继路径、总发送/查询次数、同 ID、用途隔离、重复并发与摘要冲突、上下文竞争、过期与迟到结果、关闭/新实例恢复、查询结果已保存与未保存的中断窗口、固定故障提示进程内防重及复合异常保留。
- 真实 PostgreSQL 定向集成 12/12：双连接竞争、Driver 调用前可读的协调记录、同 ID 重试、上下文切换、新连接恢复、同会话未确认后的下一任务成功、数据库完全不可用固定提示、SQL 23514 传播、重复迁移与终态当前 revision 不可覆盖。复用 `createTaskTestDatabase()`，所以日志保留 T19 前缀；实际本轮库为 `kairo_t19_456ee14a5f1741b0876b369e30115797`，后端 PID 23182/23183。先核对自建随机库与不同 PID，再迁移；不迁移 `.env` 指向的原库，不按前缀清理别人的库。
- 首次集成启动先遇到 Driver 包未构建，补构建后得到协调器模块尚不存在的失败基线。单元首轮发现 Node promises 定时器未被全局假时钟接管；仅在测试中替换计时边界，保留取消语义。独立 Node 烟测另使用原生定时器实等，不靠此替身证明运行时。
- 迟到交付与重试期限反例实际失败后修复；两份只读审查发现的摘要字段顺序、旧版本抢占用途键和查询错误被收尾覆盖，也均有修复前失败、修复后通过的回归。初次 lint 的全局 structuredClone、测试 async 无 await 和多余断言均已修正，未降低规则；最终 App typecheck/build 与根 lint 通过。
- 普通 Node 烟测使用构建产物、真实 PostgreSQL 与 FakeDriver：旧协调器等五秒后关闭，新实例保留绝对截止，约 30040ms 时只查询一次、没有重新发送；同 ID 两次发送后送达、所有业务 Pool 不可用时固定提示一次且不创建 task 均通过。该轮自建库 `kairo_t21_smoke_09eb6a8c3336480099e7de69d7666755` 已删除。临时脚本用于本次证据，交付时删除，长期复现使用保留的测试命令。
- 最终清理重复任务收尾查询后，重新执行定向 41/41、真实集成 12/12、App typecheck/build、根 lint 和新增 TypeScript 文件 Prettier 检查，均通过。`pnpm --filter @kairo/app test` 实际通过 10 文件/132 项。最终构建产物再次运行上述普通 Node 烟测，查询发生于约 30023ms，仍为一次发送、一次查询；随机库 `kairo_t21_smoke_698c451298b84a1aa4d5019c4ea48910`（PID 23191/23192）已删除。

边界：本次证明协调模块、真实 PostgreSQL 与同进程新实例/新连接恢复，不冒称操作系统强杀或完整跨进程调度。T34 仍负责跨进程故障矩阵，T35 仍负责真实 KK9 delivered/failed/unknown。没有连接或修改真实 KK9 会话，没有调用模型/RAGFlow，没有修改 Driver 行为，因此未执行 Driver 真机脚本；不合并分支或关闭 issue。

### T22 可调用私聊入站门禁（2026-09-09）

用户在本任务终端批准：本次不接入 `index.ts` 正式消息订阅。`createIngress(options)` 返回可调用的异步消息处理函数；通过后返回 `{ status: 'accepted', botId, message }`，其中 `message` 是带可信 `employeeId` 的已保存原始消息。它不创建 context、batch、task、Memory 或知识调用，不处理 `/new`，也不提供假的后续回调。执行 `start` 尚不会自动处理真实员工消息，后续模块具备接收能力后再装配。

`im-transport/driver-adapter.ts` 使用 Driver 必填的稳定原生 `id` 作为账本 `messageId`；标准化 Driver 同时提供相同的可选 `messageId`，应用不从 raw、正文或可选字段推测编号。保留原文、消息类型和已有附件元数据，观察时间取入口的 `Date.now()`，不把 IM 历史时间当成当前观察时间，不读取或下载附件。

`private-chat-core/ingress.ts` 的顺序固定如下：

1. outbound 直接忽略；unknown 仅记录带消息/会话 ID 的诊断，不写原始账本、不回复。
2. inbound 先调用 T18 `insertRawMessage()`；`(sessionId,messageId)` 唯一冲突直接返回 duplicate，不查询员工、不覆盖首次正文或处理结果。
3. 仅接受 `sessionType: 'private'` 且整个原始会话号严格为 `0-<ASCII数字UID>`；不 trim，拒绝尾部换行、纯数字、昵称、群聊、讨论组和服务号。这些不支持的入站仍保留原始账本和诊断，但不查档案、不回复。
4. 只用该原始 sessionId 调用 `getEmployeeBySession()`；要求 `String(employee.id)` 与会话 UID 完全一致。正文、昵称、senderId 和会话显示名不能切换身份。档案为空或 UID 不匹配停止；查询异常保留 cause 并按 driver 类别向调用者传播，不伪装为空档案。
5. 可信身份关联原始账本后检查启动配置传入的 employeeAllowlist；名单外回复固定试用提示，不建立下游业务。通过则记录 accepted 并返回可信消息。

两种固定提示均使用 T21 `SendService.send()`，subject 为无 threadId 的原始 event，purpose 分别为 `notice:identity_failed` 与 `notice:not_allowed`；不直接调用 Driver 发送。身份失败窗口采用用户批准的固定 60000ms，键为 Bot、私聊和 `identity_failed`；从实际准备提示时起算，先原子占用再发送，失败不退还，重启不重置。不新增配置、迁移、存储实现、事件总线或兼容路径。存储/发送异常向上传播，不自动调用数据库故障发送例外。

#### 实际验证

初次离线验证时本工作树尚无 `.env`，以下命令只向测试进程加载主仓库已有环境，不复制凭证；集成测试只使用其中的 `KAIRO_TEST_DATABASE_URL` 创建随机临时库，不迁移或清理配置原库：

```powershell
pnpm --filter @kairo/app exec vitest run tests/unit/ingress.test.ts
node --env-file=D:/Person/kairo/.env apps/kairo/scripts/test-integration.mjs -- tests/integration/ingress-dedup.test.ts
node --env-file=D:/Person/kairo/.env apps/kairo/scripts/test-integration.mjs -- tests/integration/ingress-dedup.test.ts tests/integration/private-chat-store.test.ts tests/integration/send-service.test.ts
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
pnpm lint
node --env-file=D:/Person/kairo/.env apps/kairo/tmp/t22-smoke.mjs
```

- 最终精确定向单元 35/35；覆盖三方向、严格会话、方向/写入/查询/发送的顺序、双类型员工 UID、前导零、身份伪造、名单内外、附件元数据、完整提示窗口及异常传播。默认 App 单元 12 文件、171/171。
- T22 真实 PostgreSQL 定向 7/7；双连接同键竞争仅一次 accepted、跨会话相同消息 ID 独立接纳、新实例新连接持久去重、真实 T21 固定提示送达、限频并发与 59999/60000ms 边界、失败与异常不退还窗口。查询真实业务和 Mastra 表，确认接纳/拒绝路径均不创建后续会话、任务、Memory 或知识数据。
- 最终 T18/T21/T22 组合为 3 文件、34/34。T22 自建库 `kairo_t19_ce877143d61d4ec9a1918df0dbd8a3d5`，backend PID 27858/27859；T21 自建库 `kairo_t19_2bd928d8c2f542f5a080a3ba7bdcfc6d`，PID 27855/27856。沿用已有隔离助手，所以库名和助手日志保留 T19 前缀。
- App build/typecheck、根 lint 均通过。首次 lint 发现测试替身的两个无 await 的 async 和清理数组的 any 返回，按真实类型修正，没有关闭规则。
- 普通 Node 烟测直接运行构建产物、真实 PostgreSQL、真实 T21 协调器与 FakeKK9Driver；同键双连接一胜一负、跨会话接纳、伪造正文不换员工、两种固定提示、关闭全部业务连接后重建仍防重/限频，context/batch/task 均为空。烟测库 `kairo_t22_smoke_235743b7fe3a4027936bb5f4b4fa5818`，PID 27870/27871，已在 finally 删除。临时脚本在记录后删除，不新增正式命令。
- 首轮单元 29/30：失败测试误将窗口从入口时间起算，查询耗时会缩短提示间隔；按批准的发送前占用语义修正测试，保留占用完成前不发送的断言。issue 原单元命令在当前 pnpm 下实际运行整个 App 单元目录，因此上方使用 exec 精确筛选；早期测试文件尚未存在时得到空测试，不计为通过。
- 组合回归首次被 Tinypool 的 `ERR_IPC_CHANNEL_CLOSED` 中断，原样重跑 34/34；没有修改并发配置或跳过测试，未确认该进程错误的根因。只读检查确认上述 T22/T21 和烟测库无残留；另发现 `kairo_t18_2211dbcc3d6a4ee884db8da4d26c095b`，因首次中断前未记录其库名，无法确认归属，未按前缀删除或终止任何连接。

上述初次离线证据不代表 T35 的双员工与 Bot 真机放行，也不代表操作系统强杀恢复或完整 IM 回答链。当时未连接真实 KK9、未调用模型/RAGFlow，未修改 Driver 行为，所以没有执行 Driver 真机脚本；T24/T27 及正式启动装配均未提前实现。未合并分支或关闭 issue。后续获批的真实验证见下节。

#### 追加真实 KK9 与 RAGFlow 验收（2026-09-09）

用户要求真实验证，并在当前工作树 `.env` 配置真机授权、测试数据库连接和 RAGFlow key。使用已提交的构建产物与临时 Node 验收程序，不修改产品源码、正式 YAML、T27 模块或 `index.ts`，不创建正式 Agent；本轮没有调用主模型。

实际执行：

```powershell
node --env-file=.env apps/kairo/tmp/t22-real-preflight.mjs
node --env-file=.env apps/kairo/tmp/t22-real-ingress.mjs
node --env-file=.env apps/kairo/tmp/t22-real-ragflow.mjs
```

真机程序受监督运行，先读取真实登录 UID 与现存 Hook/binding，确认 Bot 为 `5761` 且没有其他 Hook 后才连接真实 `KK9Driver`。通过 Driver 唯一匹配 `0-3585 / int2024` 私聊，`getEmployeeBySession('0-3585')` 实际返回 UID `3585`，loginName/name 均为 `int2024`。发送和记录复用真实 T21 协调器及 PostgreSQL Store，没有 FakeDriver、伪造员工档案或替换发送结果。

- 员工实际发送带标记 `T22-bdbff093` 和伪造身份正文的消息；Driver 公开事件产生原生消息 ID `135903027`、direction=inbound。T22 返回 accepted，可信 employeeId 仍为 `3585`，不受正文中的 `9999` 影响。
- 使用真实 Driver 定向历史查询读回同一消息，通过另一数据库连接交给 T22，返回 duplicate；首次记录不被重复处理。这里验证事件接收与历史查询双来源，不把测试程序自行复制对象当作真实双来源证据。
- T21 发送明确标注“仅为验收、不是 Agent 回答”的固定测试提示，operationId 为 `5e0c5019-3703-4b84-b674-00ba5ce73f58`，正式消息 ID `135903033`，状态 delivered，Driver 确认耗时 583ms。同一请求重放仍为同 operationId/messageId，sendCalls=1；真实 `getSendStatus()` 返回 delivered。
- Driver 公开事件观察到 `135903033` 的 outbound 回显；T22 返回 outbound，该回显未写入原始入站账本。context、batch、task、Memory commit、知识查询表均无记录。
- 关闭真实 Driver 和全部业务连接后，通过新数据库连接读回员工关联与 accepted 结果，原始消息重复插入仍返回 inserted=false。这证明数据库持久性，不声称执行了操作系统强杀、重新登录 KK9 或恢复调度。
- 自建库 `kairo_t22_real_6c1fbcb4b891422fa1501ece88dd6863`，两个 backend PID 为 28127/28128，迁移前核对实际库名及不同 PID。finally 已删除此库；独立只读复查确认登录 UID 不变，Hook/binding 均不存在。仅保留本次提示 `135903033` 供员工核对收件，未撤回或修改员工原始消息，没有重启 KK9、停止其他进程或清理其他数据库。

RAGFlow 公开版本接口实际返回 HTTP 200、code 0、`v0.27.1`。随后向 `http://rag.union.com/api/v1/retrieval` 发起真实认证 POST，请求只包含固定问题“如何查询采购订单？”和正式 YAML 的唯一 ERP Dataset `b55a0fc8a69211f1bad90f767650f6fc`：HTTP 200、code 0，返回 30 条正文非空的片段、涉及 7 份文档，total=64，耗时 1568ms。独立无效 key 请求实际返回 HTTP 401。没有输出凭证或知识正文，也未上传资料或改变 Dataset。这是直接真实 HTTP 检索和认证验证，不是 T27 Skill/Tool/Python 链路或基于资料的完整 IM 回答。

首轮真机程序等待标记 `T22-ffd251f0` 五分钟未观察到匹配员工消息，明确以退出码 1 结束，尚未进入门禁或发送提示；其自建库 `kairo_t22_real_ab950551a81d4fa4a1ba2b9bb46c0e9f`（PID 28037/28038）与 Hook 已正常回收。初次缺少 RAGFlow key 时只验证公开版本，不计认证检索通过。用户补齐配置并实际发送消息后，上述最终两个验收程序均退出码 0。

本轮新增的真实证据仅覆盖一个员工与一个 Bot 的授权入站、身份伪造、防重、提示 delivered/outbound，以及独立 RAGFlow 检索。第二员工、真实名单外提示、真实身份失败限频、真实 failed/unknown 故障和客户端重启稳定性未执行；这些不能由本轮结果冒充 T35 完整放行。临时程序与本地结果文件在证据保存后删除，不新增正式启动方式；产品代码未变，不重复运行无变化的离线质量套件。


### PR #263 合并前组合验证（2026-09-09）

按用户授权接入 `origin/master` 的 T21 与审查修正。测试采用主分支五组合同和具名前置条件夹具，保留本 PR 的18条显式合法状态边，不恢复动作字符串分派。保留主分支新增的空 attempt 标识回归和事务末步失败回滚回归，以及本 PR 的事务双重错误处理。T19 现为50项（主分支33项中的单个合法边矩阵展开为18项），此前各轮数量保留为执行历史。

实际依次执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint`、`pnpm --filter @kairo/app db:migrate:test`，再执行上方完整组合集成命令并追加 `tests/integration/send-service.test.ts`。四项质量命令全部通过，Driver330/330、App136/136；迁移专题2项通过、6项按名称筛选未执行；最终14个集成文件125/125。包含000001至000008的真实随机库迁移，以及T18/T19/T20/T21组合回归；没有新增迁移或访问真实KK9、模型、其他工作区数据库。

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

Driver 的两份依赖修补由 `pnpm-workspace.yaml` 的 `patchedDependencies` 固定应用：`patches/node-edge-tts@1.2.10.patch` 让直连握手和合成共用超时期限，文件流错误进入正常拒绝路径，完成或失败时先关闭文件流和 WebSocket 再结束 Promise；`patches/@audio__decode-wav@1.5.0.patch` 修正 RIFF 奇数长度数据块的填充字节跳过规则。补丁文件、workspace 配置和 `pnpm-lock.yaml` 必须一起保存，通过 `pnpm install` 应用，不能仅手改 `node_modules`。升级这两个依赖时先确认上游是否已修复，并运行对应边界回归。Mastra warning 补丁另见 T16。

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

## T27 定制知识 Skill 与固定 Python 检索

正式检索只保留 `erp-search` Skill → `knowledge-search` Tool → 固定 `search.py` → RAGFlow `/api/v1/retrieval`。用户已批准 T17 的知识健康检查也改用同一 Python 入口；其五分钟周期、三十秒检查期限、空结果正常和关闭等待语义不变，健康检查不写业务账本、不立即重试。没有 TypeScript HTTP 检索、MCP、备用 API、命令执行 Tool 或管理脚本。

### 配置与运行环境

- 保留现有 Node.js 与 pnpm 要求；需要 `python` 可执行文件。实际验证为 Node.js 24.14.0、Python 3.14.3。Python 只用标准库，不需要 pip 安装。部署前执行 `python --version`，再执行下面的完整验收；运行时解释器缺失、启动失败、非零退出或输出不可读都会明确失败，不切换实现。
- `config/bots/default/bot.yaml` 登记实际 `knowledge-search` 工厂并启用 `erp-search`，保留原 `reader-sim`。启动与验收入口将 `Object.keys(knowledgeTools)` 显式注入配置加载；缺少或为空的能力清单拒绝知识 Tool。这里只声明已经实现的任务绑定能力，不等于已创建 T28 正式业务 Agent。
- ERP Dataset 唯一来自 YAML 的 `datasetId`；不读取员工或模型提供的 Dataset，不用环境变量覆盖业务范围。
- 运行进程通过既有 `.env` 或进程环境提供 `RAGFLOW_API_KEY`；`RAGFLOW_API_URL` 沿用已批准的 `http://rag.union.com/`，允许维护人员指定服务根基址。URL 不含凭证。凭证不进入 YAML、Skill、命令行、模型或普通日志。
- Node 固定执行 `python -I -B <受控目录>/skills/erp-search/scripts/search.py`，不启用 shell；query 由 stdin 输入。解释器子环境仅包含必要操作系统字段及三项 RAGFlow 配置，不继承数据库/模型凭证。`-B` 避免在受控配置目录生成字节码影响配置摘要。
- HTTP body 只有 `question`、单元素 `dataset_ids`。不传历史、Memory、employee/session/task ID，不设置 top-k、阈值、页数或其他数字默认值。接口默认值不会自动跟随网页设置。
- 上游 `ragflow-skill@1.0.8` 的必要请求和字段映射被裁剪到单一脚本；来源、固定摘要、许可证及差异见 [`SOURCE.md`](../config/bots/default/skills/erp-search/SOURCE.md)，许可证为发布元数据声明的 MIT-0。

### 程序合同与证据

`createKnowledgeTool(settings, scope, store, logger)` 返回 `{ tool, settled }`。服务端将已加载配置转换为 `RetrievalSettings`，通过闭包绑定 taskId、attemptId、bootId、原任务 executionDeadline 和 `nextCallIndex()`；模型唯一输入是严格的 `{ query }`。后续装配方须按同 task 维护调用次序，不能在新 attempt 或恢复时从 1 重置；本任务不自建调度或恢复器。

`retrieveKnowledge(query, settings, { deadline, signal })` 是业务 Tool 与健康检查共用的固定脚本入口。Node 是唯一重试层：仅网络、429、5xx 最多再试一次；首次、重试和后续查询都使用同一 task 绝对截止。重试资格由结果类别、错误原因和 HTTP 状态推导，Python 输出不再携带重复的 `retryable` 字段。Python 无独立重试或短网络超时。健康调用显式 `retry:false`，保留原合同。

AbortSignal 终止实际 Python，等待 `close` 与管道回收后返回；无在途进程时不启动新进程。Mastra 取消可能先结束 Agent 输出，因此调用方在结束一次运行时仍须 `await binding.settled()`，确保检索已回收且审计落账。独立验收也把原任务截止传给整个 Agent；不声称本地终止取消了远端 RAGFlow 计算。

成功和失败采用明确结果类别：found、empty、auth_error、parameter_error、service_error、format_error、cancelled、timeout。只有合法成功 chunks 为空才是 empty；缺失 data/chunks/total、非对象片段、正文或元数据类型错误明确失败。HTTP 状态与业务码分别保留；`apiCode` 限定为 JavaScript 可精确表示的整数范围 `[-9007199254740991, 9007199254740991]`，Python 排除布尔值和浮点数。超范围码将 `apiCode` 置 null，脱敏后的 `raw` 改用 JSON 文本精确保留数字，不能覆盖已知 HTTP 分类；HTTP 200 的超范围码明确归格式错误。未知业务错误不猜分类、不重试。截断的 401/403/400/422 响应仍保留 HTTP 类别，网络失败保留异常类型和可用 errno/verifyCode，不记录可能泄密的异常全文。

每次 Tool 调用通过 T20 `recordQuery()` 原子保存 query、开始顺序、耗时、结果类别及证据；原始响应和各次 Python 尝试（含 PID/退出码/耗时/结果）放入既有 rawResult。正文仅进入业务表及作为参考资料的 Tool 返回，不进入普通日志、正式 Memory 或系统指令。模型收到资料正文和本地证据关联号，不收到原始响应、文档/Dataset 标识或诊断正文。证据保留文档名称、ID、片段 ID、原始 positions 和相似度；未知物理页码为 null，DOCX positions 不推断页码。

落账等待期间若任务取消或截止，账本仍保留实际取得的检索结果和证据；Tool 交付前再次检查任务状态，返回 cancelled/timeout 与空 materials，不向模型交付迟到资料。该门禁不新增定时器或第二笔审计写入。

锁定 Mastra `1.63.2` 的既有 pnpm 补丁同时修正输入清洗：只删除校验明确指出的错误空值字段，不再因根级校验错误而递归删除所有空值。严格 schema 因此不会把未知的 `datasetId:null` 等输入变成合法查询。ESM/CommonJS 两种产物同步修复，已声明 optional/nullable 字段仍保持原有行为；不增加工具包装器或放宽 query-only schema。

### 独立验收入口

不需要启动生产应用或连接 KK9。数据库使用现有 `createTaskTestDatabase()` 创建独立随机库，核对两个连接的实际库名/PID后迁移；只删除自身创建的库，不改共享数据库。下面 `<配置文件绝对路径>` 指包含测试数据库和相应凭证的本地文件，不把凭证值写到命令行。

```powershell
# 默认执行真实 ERP；缺少 key 明确失败，不自动变成本地测试。
pnpm --filter @kairo/driver exec tsx --env-file=<配置文件绝对路径> ../../apps/kairo/scripts/verify-knowledge.ts
# 显式本地故障矩阵：真实 Mastra/Skill/Tool/Python/PostgreSQL，HTTP 为本地受控响应。
pnpm --filter @kairo/driver exec tsx --env-file=<配置文件绝对路径> ../../apps/kairo/scripts/verify-knowledge.ts --local
# 批准真实模型面对本地恶意检索资料；使用 YAML 主模型及 KAIRO_T12_MODEL_API_KEY。
pnpm --filter @kairo/driver exec tsx --env-file=<配置文件绝对路径> ../../apps/kairo/scripts/verify-knowledge-model.ts

pnpm --filter @kairo/app test -- tests/unit/knowledge-tool.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/ragflow-connector.test.ts
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app build
```

主验收入口使用确定性模型只驱动 Skill/Tool 调用，不能证明真实模型的检索决策或员工答案质量。正常有资料/空资料/错误 key/Dataset 及取消后恢复均由完整 Agent→Skill→Tool→Python 直接访问 ERP。参数、业务与格式错误、断线与限流恢复、两次上限、挂起/取消及原任务四分钟截止使用明确的本地代理；代理逐次核对最少请求字段。删除 question、503/429/断线/挂起均明确属于本地注入，不冒充远端自行发生故障。输出的“代理请求数”为 0 表示这次直连不经过代理，不表示未发起 Python 请求。

真实模型独立入口验证实际加载 Skill、实际调用知识 Tool、恶意资料确实进入模型以及该样例的员工回答不含内部 ID/来源列表/注入口令。它使用本地合成资料，不冒充 ERP 文档；只证明本轮样例，不承诺所有提示词攻击均被阻断，也不实现正式 T28/T29/IM 链路。

### 本轮已执行结果（2026-09-09）

- `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过；Driver 330 项、App 210 项。默认测试不包含 PostgreSQL 集成或真实 KK9。
- 主仓库测试配置显式注入后，运行 `node --env-file=D:/Person/kairo/.env apps/kairo/scripts/test-integration.mjs -- tests/integration/ragflow-connector.test.ts tests/integration/knowledge-record-store.test.ts tests/integration/bot-customization.test.ts tests/integration/mastra-route-isolation.spike.test.ts tests/integration/runtime-boot-startup.test.ts`：5 文件/28 项通过。知识链路 4 项含真实 PostgreSQL、真实 Python、本地 HTTP、取消落账与存储失败后的资源回收。
- 本地独立入口 `--local` 实际通过全部矩阵；最后一次四分钟等待记录耗时 239973ms，随后新请求成功，所有完成尝试 PID 已不存在。网络/429/503 恢复各两次，连续 503 不超过两次，取消后不再重试。以上为本地受控 HTTP，非 ERP 样本。
- `verify-knowledge-model.ts` 使用批准的 `openai/gemini-3.7-flash-high` 实际成功两轮，每轮查询一次；真实回答仅含采购步骤，没有注入口令、命令、内部 ID 或来源列表。第二轮包含修正后的整轮 task 绝对截止。
- 审查发现的三条缺陷先复现失败，再修复：非法业务码不能覆盖已知 HTTP 临时错误、截断认证响应不能变为可重试网络错误、网络失败保留安全诊断。修复后 Python 40 项与检索 18 项全部通过；不把首次失败说成通过。
- 用户在本工作树配置 key 后，真实 `verify-knowledge.ts` 全矩阵通过（255.31 秒）：ERP 有资料为 HTTP 200/code 0、30 条证据；无资料为合法空数组；错误 key 为 HTTP 401/code 401；错误 Dataset 与缺少 question 均为 HTTP 200/code 102，但分别归 auth_error/parameter_error，均仅一次。只读版本入口实际自报 v0.27.1，不以源码版本推定部署版本。
- 参数场景先实际失败：未确认消息时保守归 service_error。独立 Agent→Tool→Python→代理→ERP 探针取得精确 `` `question` is required. ``，新增回归先失败后修正；同码未知消息仍保留为不可重试服务错误。Python 全部 41 项与检索 18 项通过，未保留临时诊断脚本。
- 真实矩阵中的 429/503/断线由本地代理注入，随后第二次请求取得真实 ERP 的 30 条证据；连续 503 两次后终止。代理先收到真实 ERP 成功响应再扣留回复，主动取消和原任务四分钟截止均回收 Python；截止记录为 239978ms，之后新请求再次 found。没有声称这些故障来自远端自然停机，也未声称取消了远端计算。
- 实际发出的代理请求逐次断言只有 question/dataset_ids；无历史、Memory 或员工/会话/task 字段。DOCX 实样本 positions 为 `[[20,19,19,19,19]]`，原值保留，pageNumbers 为 null；不宣称已核对 PDF 物理页码或文档历史解析版本。
- 构建产物独立健康烟测实际调用批准模型和同一 Python ERP 检索，得到 `{model:'up',ragflow:'up'}`，随后正常关闭；未启动应用 Driver、访问数据库或 KK9。临时健康脚本已删除。
- 用户指定的 `pnpm --filter @kairo/app test -- tests/unit/knowledge-tool.test.ts` 实际通过 211 项 App 测试：现有 test 脚本透传 `--` 后运行了全 App，而非只运行该文件；真正定向的 `exec vitest run tests/unit/knowledge-tool.test.ts` 为 18 项。未为此修改无关测试运行框架。
- `pnpm --filter @kairo/app test:integration -- tests/integration/ragflow-connector.test.ts` 为 4/4；`db:migrate:test` 为 2 项通过、6 项定向排除。末次 App typecheck/build 与根 lint 均通过。原始结果每个 Python 尝试仅保存一份，避免重复序列化最后一份正文；精简后知识数据库集成再次 4/4。
- 最后一轮独立真实入口包含正常直连 ERP 和代理故障两部分，253.94 秒全部通过；直连有资料约 1199ms、空结果约 620ms、错误 key 约 138ms。真实响应后挂起的四分钟截止记录 239974ms，之后完整链路直连再次返回 30 条证据。所用随机库为 `kairo_t19_111654ec02c84eea8642e0a6167f7d48`，两个连接 PID 为 28177/28178，入口结束正常回收。
- 独立 Node/pg 只读查询按本轮输出记录的 16 个精确自建库名核对，残留 0；没有扫描或删除其他同前缀库。参数、健康和清理探针已删除，受控 Skill 目录没有生成 Python 字节码。

本任务不修改 Driver/T22 模块，不启动真实 KK9，不执行远端资料管理或服务重启，不合并、不关闭 issue。

### PR 发布前补充：事件循环中的绝对截止

发现仅检查 AbortSignal 会漏掉同步 JSON/Zod 校验跨过 deadline 的情况：定时器回调尚未执行，Promise 续体就可能接受迟到结果或启动重试。固定入口现于每次启动和接受结果/决定重试前再次比较原任务绝对时间；到期即触发同一截止信号，不新增预算或重试层。已结束进程的原始结果保留在尝试证据中，但最终 Tool 返回 timeout，不向模型交付迟到资料。

新增三条回归使用真实 Python 和受控 HTTP，在同步校验内推进时钟并保持截止定时器未执行；分别覆盖迟到成功、迟到 503 不能重试，以及入口校验后到期不启动首个进程。修复前 3/3 失败，修复后进程/知识 Tool/健康组合 42/42 通过；知识数据库集成再次 4/4。

发布前重新执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint`，全部通过，Driver 330 项、App 214 项。该追加修复不改变 Python HTTP 请求、结果字段或数据库表。

### PR #265 复核后的修复与优化（2026-09-09）

先核实再修改：此前受控真实 Python 探针已确认账本等待后的迟到资料交付、超范围业务码丢失 HTTP 分类、额外 null 字段被 Mastra 清洗三项。本轮另以预加载故障注入运行实际 `verify-knowledge-model.ts`，畸形 JSON 确实从 HTTP 回调逃逸并留下自建库；只读核实后仅清理该探针自建库。配置反向导入属于确定的结构问题，不冒称运行故障。

修复采用上述交付门禁、安全整数合同、Mastra 定点空值清洗及能力清单注入。验收脚本将请求读取、JSON/断言和监听错误传入可等待的失败流程，取消并等待本轮验收，分别清理服务器和数据库；原始错误与清理错误均保留。删除可推导的 `retryable`；保留跨 Python/Node 的独立格式校验，不放宽输出、退出码或固定 Dataset 的检查。

本轮实际验证：

- `pnpm --filter @kairo/app exec vitest run tests/unit/knowledge-tool.test.ts tests/unit/python-search.test.ts tests/unit/python-process.test.ts tests/unit/dependency-checks.test.ts tests/unit/config.test.ts`：5 文件、128 项通过，分别 23/57/13/11/24 项。新增回归覆盖账本等待期间截止/取消/超时信号、直接 Tool 的未知 null/undefined 字段，以及超范围码保留精确数字与 HTTP 503 的两次上限。
- `node --env-file=.env apps/kairo/scripts/test-integration.mjs -- tests/integration/ragflow-connector.test.ts tests/integration/knowledge-record-store.test.ts tests/integration/bot-customization.test.ts tests/integration/mastra-route-isolation.spike.test.ts tests/integration/runtime-boot-startup.test.ts`：5 文件、28 项通过，含实际 Agent 注入额外 null 字段后不发检索请求、不写查询证据。
- `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 的构建、类型检查、Driver 330 项测试通过；首轮 App 测试工作进程出现 `ERR_IPC_CHANNEL_CLOSED`，整条串联命令失败且未执行 lint。随后设置 `NODE_OPTIONS=--trace-uncaught --trace-warnings`，原样执行 `pnpm --filter @kairo/app test`，14 文件、235 项通过；单独 `pnpm lint` 通过。没有修改工作进程数量、测试范围或错误处理；首次 IPC 关闭的根因未定位，不宣称已修复测试框架。
- 临时普通 Node 烟测分别通过 ESM/CommonJS 真实 `createTool` 入口：已声明 optional 的 null 仍按缺省处理，nullable 保留 null；未知 null 字段拒绝执行。没有为知识 Tool 增加包装器或旁路校验。
- 实际模型验收脚本的三种预加载故障烟测（畸形 JSON、监听失败、服务器关闭回调失败）均明确非零退出、保留错误；逐个精确库名只读核对无残留。故障探针禁止真实模型外网并响应 AbortSignal，没有用假 Python 输出替代知识验收；这部分采用实际 CLI 烟测，没有新增通用测试框架。
- 批准真实模型 `openai/gemini-3.7-flash-high` 的独立样例再次通过：实际加载 Skill、调用知识 Tool 一次，Python 返回 found，回答只有采购步骤；不含内部标识、来源列表、注入口令或命令。只证明本轮本地恶意资料样例，不等于 ERP 真实资料或正式 IM 验收。
- 两份独立只读复审分别检查取消/验收生命周期与输入/数值/配置合同，均未发现 Required 问题；审查员未运行测试，运行证据以上述实际命令为准。
- 本轮完整真实 ERP 入口 `pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-232-t27-knowledge-tool/.env ../../apps/kairo/scripts/verify-knowledge.ts`：254.76 秒全部通过。直连有资料 30 条、空结果、错误 key、错误 Dataset 和真实参数错误均符合合同；本地 429/503/断线后第二次取得真实 ERP，连续 503 仅两次。代理扣留真实响应后的主动取消与四分钟截止均回收 Python；截止记录 239982.8595ms，随后新请求直连 ERP 再次 found。隔离库为 `kairo_t19_e8925bcc7f484a558665f863b2fc0d86`，连接 PID 28580/28581。
- 本轮按输出记录的 9 个精确自建库名执行独立只读查询，残留 0；不扫描或删除其他同前缀库。临时输入烟测、异常/清理探针及 pnpm 补丁编辑目录已删除。锁文件内容比对确认仅 Mastra 补丁哈希及其引用改变，没有升级依赖版本。
