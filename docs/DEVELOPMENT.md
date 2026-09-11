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

`claimTask()` 在 context 与 task 行锁内执行条件 UPDATE 领取。T24 接入后，任务状态变更固定先锁 context、再锁 task，比较上下文有效性、状态与输入版本；采用结果还比较当前 attempt 指针、成功结束记录和未到执行期限。`updateInputVersion()` 仅对 queued/running 生效，并清除当前 attempt 指针，不重置期限或自动重跑；正常新消息仍应进入下一批。终态没有出边，迟到 attempt 只可补记审计。数据库异常原样传播，不包装成 false。

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

`createKnowledgeTool(settings, scope, store, logger, tasks)` 返回 `{ tool, settled }`。服务端将已加载配置转换为 `RetrievalSettings`，通过闭包绑定 taskId、attemptId、inputVersion、contextVersion、bootId、原任务 executionDeadline 和 `nextCallIndex()`；模型唯一输入仍是严格的 `{ query }`。T24 增加的第五参数是提供 `withTaskOutput()` 的任务账本，版本来自实际 task/context，不能写固定占位值。后续装配方须按同 task 维护调用次序，不能在新 attempt 或恢复时从 1 重置；不自建调度或恢复器。

`retrieveKnowledge(query, settings, { deadline, signal })` 是业务 Tool 与健康检查共用的固定脚本入口。Node 是唯一重试层：仅网络、429、5xx 最多再试一次；首次、重试和后续查询都使用同一 task 绝对截止。重试资格由结果类别、错误原因和 HTTP 状态推导，Python 输出不再携带重复的 `retryable` 字段。Python 无独立重试或短网络超时。健康调用显式 `retry:false`，保留原合同。

AbortSignal 终止实际 Python，等待 `close` 与管道回收后返回；无在途进程时不启动新进程。Mastra 取消可能先结束 Agent 输出，因此调用方在结束一次运行时仍须 `await binding.settled()`，确保检索已回收且审计落账。独立验收也把原任务截止传给整个 Agent；不声称本地终止取消了远端 RAGFlow 计算。

成功和失败采用明确结果类别：found、empty、auth_error、parameter_error、service_error、format_error、cancelled、timeout。只有合法成功 chunks 为空才是 empty；缺失 data/chunks/total、非对象片段、正文或元数据类型错误明确失败。HTTP 状态与业务码分别保留；`apiCode` 限定为 JavaScript 可精确表示的整数范围 `[-9007199254740991, 9007199254740991]`，Python 排除布尔值和浮点数。超范围码将 `apiCode` 置 null，脱敏后的 `raw` 改用 JSON 文本精确保留数字，不能覆盖已知 HTTP 分类；HTTP 200 的超范围码明确归格式错误。未知业务错误不猜分类、不重试。截断的 401/403/400/422 响应仍保留 HTTP 类别，网络失败保留异常类型和可用 errno/verifyCode，不记录可能泄密的异常全文。

每次 Tool 调用通过 T20 `recordQuery()` 原子保存 query、开始顺序、耗时、结果类别及证据；原始响应和各次 Python 尝试（含 PID/退出码/耗时/结果）放入既有 rawResult。正文仅进入业务表及作为参考资料的 Tool 返回，不进入普通日志、正式 Memory 或系统指令。模型收到资料正文和本地证据关联号，不收到原始响应、文档/Dataset 标识或诊断正文。证据保留文档名称、ID、片段 ID、原始 positions 和相似度；未知物理页码为 null，DOCX positions 不推断页码。

落账等待期间若任务取消、上下文或 attempt 失效、执行截止，账本仍保留实际取得的检索结果和证据；Tool 通过 T19 `withTaskOutput()` 在 context/task 行锁内检查并完成消费者可见的 Promise 交付，失效时只交付 cancelled/timeout 与空 materials。不能仅在锁内构造结果、等 COMMIT 返回后才交付，否则切换仍可插入间隙。事务完成及错误由 `settled()` 跟踪，调用方必须等待并处理错误；不新增计时器或第二笔审计。

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

## T24 `/new` 与近期上下文边界（2026-09-09）

> 当前 PR 保持草稿待审。追加发现的再次恢复缺陷已按用户要求修复，并通过永久回归、真实 PostgreSQL 和独立烟测验证；历史失败与修复证据见本节末尾。T35 真机放行仍未执行，不合并、不关闭 issue。

### 入口与正式装配边界

`createControlMessageHandler({ contexts, sender })` 只接收 T22 `IngressResult`。非 accepted 结果直接返回；通过方向、原始消息防重、可信员工与 allowlist 后，才判断整条 `messageType: 'text'` 正文 trim 是否等于 `/new`，且 fileInfo 不存在、images 无元素。普通句子、参数、其他命令、非纯文本和附件不会触发。本模块不实施 T23 的附件拒绝、聚合或输入限制。

普通消息返回 `status: 'message'`、可信消息和当前 context；命令返回 `status: 'new_context'`，不向下一阶段返回待聚合正文。无旧工作回复 `已开始新对话。`，有 collecting/孤立 ready batch 或未完成任务回复 `已开始新对话，之前未完成的任务已取消。`，均走 T21 的 `notice:new_context` 和新 thread，有效性检查与发送预算不另建一套。

当前仍不在 `index.ts` 新增 Driver 订阅，也不创建 T28 的正式业务 Agent。后续装配方须消费原 T22 返回值，将本处理器返回的普通消息交给后续阶段，而不是重新订阅或再次去重；同一应用的控制消息与执行登记使用同一个 context-service 实例。多数据库连接的版本门禁已验证，不提供跨进程取消广播或调度。

### 原子切换、停止与迟到结果

`createContextService({ store, tasks, idleMs })` 的 idleMs 来自已加载配置 `timeouts.contextIdleMs`。`resolve(scope, reset)` 调用 T18 `prepareContext(scope, clock, options)`；沿用范围事务锁分配版本，锁当前 context 后才调用 clock 采样切换时刻，避免等锁期间新建的员工等待被过早时间关闭。

同一事务废弃 collecting 与尚未建任务的 ready batch，取消 queued/running/waiting_for_user/ready_to_send/sending，关闭开放 user_wait，失效旧 context 并创建全局唯一 UUID thread。已有任务的批次、原始消息、attempt、证据与旧 context 历史保留。建批、追加、建任务、领取、采用及恢复等待也先锁 context，等待者不能在切换后继续推进旧版本。

执行方在启动 Agent 前调用 `registerExecution({ taskId, inputVersion, attemptId, contextVersion }, controller)`，传入实际用于 Agent 的控制器；新 thread 事务提交后调用旧 thread 登记项的真实 `abort()`，不等待旧执行退出。执行方在 `binding.settled()` 后释放登记。过期登记被拒绝并 abort；登记提交失败会移除未交给调用方的登记，错误原样传播。Python 终止与管道回收继续完全属于 T27，不声称本地停止取消了远端计算。

T19 `withTaskOutput()` 和 T18 `withContextOutput()` 只在有效行锁内执行同步交付回调。T21 在该回调内实际调用 Driver，包装回执 Promise 后释放锁，不等待网络回执；已经交给 Driver 的旧消息不能保证撤回，但迟到回执不能复活 cancelled 任务。Tool 在同一边界完成模型可见 Promise 的交付，事务结束单独由 settled 等待；未及时 Abort 的旧资料和旧 attempt 仍因版本门禁被丢弃。

### 空闲时间与迁移

用户确认 `elapsed > 7200000` 才切换；恰好两小时继续原 thread。仍有 collecting/孤立 ready batch 或未完成任务时不做空闲切换，不因期限已过擅自执行 T25 超时调度。收到消息、排队/进度提示和 `/new` 固定反馈均不刷新最终任务的空闲起点。

| 最终结果 | 空闲起点 |
| --- | --- |
| delivered | 首次成功回执时刻；回执早于交付事务返回也不推迟 |
| send_unconfirmed | 首次确定未确认的时刻，不使用首次 unknown 或发送调用时刻 |
| failed/cancelled/timed_out 且无最终回复 | task 的结束时刻；拒绝员工等待同样处理 |

任务终态与当前 context.idle_since 在同一事务保存，重复推进及旧版本更新不刷新起点。`000009-send-result-time.sql` 仅给现有 `send_dispatches` 增加 `result_at`；不回填猜测的历史时间。协调终态已保存而 task 收尾中断时，恢复沿用该时刻；Driver 已持久化 delivered、协调终态尚未保存就中断时，恢复查询沿用 `send_operations.updatedAt` 的先前送达证据，而非重查时间。无真实时刻的旧成功/未确认协调终态明确报错，不构造兼容回退。运行时仍不执行迁移。

### 本次证据与边界

三条审查反例均先实际失败再修复：等锁期间进入员工等待导致取消时间 CHECK 失败；Tool 等 COMMIT 后才交付；原生送达后三小时恢复误刷新空闲。分别保留在 new-context-concurrency、knowledge-tool 和 send-service 回归中。

独立烟测使用真实 PostgreSQL、Mastra、Skill、T27 Tool 和 Python，本地 HTTP 挂起检索，T22 → 控制处理器接收 `/new`：约 48.6ms 创建新 thread，实际 Python PID 128424 随后已不存在，旧 attempt 不能采用、旧最终发送为 cancelled，新请求进入新 thread 并通过 T21 得到 delivered。Driver 是明确的 FakeKK9Driver，最后一条新答案是合成烟测文本，不是模型回答。烟测库为 `kairo_t19_afe383b6497645e48e7407477349cc76`，两个连接 PID 为 29677/29678；只迁移、写入及删除自身随机库，不修改配置所指原库 `kairo`。

首轮组合集成 122/123，唯一失败来自本地 HTTP 夹具把中文字符串用作 Authorization 凭证，T27 按既有 latin-1 规则在发请求前返回 parameter_error。改成合规的合成 ASCII 凭证后，实际取消定向通过，独立烟测通过；没有放宽 Python 配置校验。首轮完整质量命令的构建、类型、Driver330/App297 测试通过，lint 指出一处测试对象直接转字符串，已改为明确字符串判断。首次烟测相对 `.env` 路径未找到，改为本工作区绝对路径后执行，不借用其他工作区凭证。

本次未连接真实 KK9、未调用真实主模型或 ERP，不重复验收 T22/T27 的既有真实环境结果。T35 仍需在无任务、排队、执行和等待员工回答等真实状态发送 `/new` 放行；上述数据库、受控 HTTP 和 FakeDriver 证据不能替代。未修改 Driver 或 Python 管理实现，未合并分支、未关闭 issue。

### 最终验证命令与结果

```powershell
pnpm install --frozen-lockfile
pnpm --filter @kairo/app exec vitest run tests/unit/context-service.test.ts tests/unit/send-service.test.ts tests/unit/knowledge-tool.test.ts tests/unit/ingress.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @kairo/app test:integration -- tests/integration/new-context tests/integration/private-chat-store.test.ts tests/integration/task-store tests/integration/send-service.test.ts tests/integration/ingress-dedup.test.ts tests/integration/ragflow-connector.test.ts tests/integration/transaction.test.ts
pnpm --filter @kairo/app db:migrate:test
```

- 锁定安装通过。早期四文件定向单元 126/126；追加 Tool 交付反例后，最终完整质量四命令全部通过，Driver 330/330、App 298/298；根测试不含数据库集成或真实 KK9。
- 此轮真实 PostgreSQL 组合 12 文件、123/123，覆盖当时已编写的 T24 状态/时间/竞争和受影响 T18/T19/T21/T22/T27 回归；new-context 两文件为 17+10 项。追加发现的再次恢复缺陷不在此轮覆盖内，不能据此宣称完整恢复合同通过。迁移专题 2 项通过、6 项按名称筛选未执行，不计作全量知识账本验收。
- 三个失败基线分别以 `--testNamePattern=等锁`、`--testNamePattern=消费者`、`--testNamePattern=首次证据` 定向运行，修复后各 1/1；完整组合也包含这三项。
- 实际独立烟测命令为 `pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/apps/kairo/tmp/t24-smoke.ts`，退出码 0；证据如上。临时脚本验收后删除，长期复现使用保留的集成测试，不新增正式启动方式。
- `node --env-file=.env apps/kairo/tmp/t24-check-databases.mjs` 只读核对本轮输出记录的 32 个精确随机库名，残留 0；未扫描或删除其他前缀库。该核验脚本随后删除，用户提供的本工作区 `.env` 保留且不提交。
- 两份独立只读审查的三项 Required 均已通过失败/修复回归处理；没有把审查意见当作执行证据。未授权或调用跨模型外部 CLI。复杂度审查保留真实需要的事务锁、版本门禁和实例登记，不新增总线、调度器、脚本管理、依赖包或兼容回退。

### 追加核实：再次恢复阻塞（修复前记录）

Advisor 指出 `send-service.ts` 的 queryUsed=true 分支会在读取原生送达证据之前直接保存 send_unconfirmed。已用生产发送协调器、真实 PostgreSQL、FakeDriver，以及只作用于自建随机库的 CHECK 约束实际复现：

1. 初次 sendText 已持久化 delivered，协调 delivered CAS 被 CHECK 拒绝，协调记录停在 sending/queryUsed=false/resultAt=null。
2. 关闭旧协调器，新实例 recover 占用唯一查询机会；查询返回 delivered，但同一 CHECK 再次拒绝协调写入，留下 querying/queryUsed=true/resultAt=null。
3. 移除测试约束、关闭第二个协调器，再创建实例恢复；结果错误变为 send_unconfirmed，任务同样结束为 send_unconfirmed，resultAt 与 idleSince 均使用这次恢复时刻。

实测原生送达证据为 delivered、updatedAt=1788934336677；再次恢复后 resultAt/idleSince=1788945136677，错误后移 10800000ms（三小时）。整个过程 Driver 发送一次、查询一次。正常的预算上限没有突破，但已有送达事实被忽略，不能把未知查询预算合同用于覆盖已经保存的送达事实。

执行命令为 `pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/apps/kairo/tmp/t24-recovery-interruption-probe.ts`。这是受控 SQL 故障与应用时钟推进，不是操作系统强杀、真实 KK9 或实等三小时。随机库 `kairo_t19_aae1a27117cd4db4910cfb26f2a1647e`、连接 PID 29854/29855，已删除并以精确库名只读确认残留 0；临时复现脚本已删除。

上述为提交 aa0af5e 时的核实结果：当时未修复生产代码、未补永久回归，因此以草稿 PR #266 交付。用户随后要求执行修复，实际变更和验证见下节；保留这段记录，不把历史通过计数当作当时已经覆盖缺陷的证明。

### 再次恢复修复与验证

`query()` 现在首先读取现有 Driver Store：有持久 delivered 时，直接把原消息 ID 与 updatedAt 交给既有 observe/finishTask 流程，然后才考虑查询预算或查询截止。读取已知事实不是再次调用 Driver；即使 queryUsed=true 或恢复再次中断，也不降为未确认、不刷新原送达时刻。observe 仍校验 task/context；取消或失效时协调结果为 cancelled，原生送达证据不变。证据读取失败原样传播，不伪造 send_unconfirmed。没有新迁移、兼容层、重试或 Driver 行为修改。

新增四条单元回归修复前全部失败，修复后完整发送单元 60/60：查询预算已用且已有证据时的正常恢复、任务取消、context 失效，以及证据读取异常。真实 PostgreSQL 通过 CHECK 使初次 send 与首次 recover 的协调 delivered 写入连续失败，移除约束后再次恢复仍 completed、原 idleSince 不变，实际发送一次、Driver 查询零次；另覆盖 querying/queryUsed=true 的持久快照及 `/new` 取消后的恢复。

补查等待路径时还发现：只把证据读取提前会漏掉等待三十秒期间才落账的回执，使第五秒的送达时间被记为第三十秒。新增“等待查询期间”回归先失败，再让等待结束后复用同一 adoptStoredDelivery 重新读取和采用，最终不调用 Driver 查询、空闲起点仍为第五秒。不增加轮询、计时器或重试。

既有“恢复前未知、查询得到 delivered”集成夹具原先在查询前就把 delivered 写入原生表；本轮改为实际查询时才保存观测，保留一次查询及同 ID 重试断言，而非把旧断言改成零次来掩盖缺陷。初次组合为 45/46，唯一失败由这个不再符合未知前提的夹具引起；修正后完整发送集成 19/19，同轮上下文两文件 27/27。

实际执行：

```powershell
pnpm --filter @kairo/app exec vitest run tests/unit/send-service.test.ts --testNamePattern=查询预算已用
pnpm --filter @kairo/app exec vitest run tests/unit/send-service.test.ts --testNamePattern=等待查询期间
pnpm --filter @kairo/app exec vitest run tests/unit/send-service.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/send-service.test.ts tests/integration/new-context
pnpm --filter @kairo/app test:integration -- tests/integration/send-service.test.ts
pnpm --filter @kairo/app typecheck
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

补充等待期间回归后，最终再次执行完整质量四命令全部通过：Driver 330/330、App 303/303（含发送单元 61 项）。随后原样重跑发送与上下文数据库组合，3 文件、46/46；其中发送19项、上下文27项。初次45/46及中间App302项保留为执行历史，不当作最终结果；没有重跑不受此次修复影响的完整知识/任务账本集成。

独立命令 `pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/apps/kairo/tmp/t24-recovery-fixed-smoke.ts` 实际通过：两次真实协调写入 CHECK 失败后，新实例恢复为 delivered、task=completed；原证据时间与恢复 resultAt 均为 1788935606889，空闲偏移 0ms，发送一次、查询零次，三小时后的新请求正确切换 thread。使用真实 PostgreSQL、生产协调器、FakeDriver 和受控时钟，不是 KK9 或操作系统强杀。烟测库 `kairo_t19_05de3d2af1dc497daface77c2745695f`、连接 PID 29997/29998，已删除并按精确库名核对残留 0。临时烟测脚本在验收后删除；本轮仍不合并 PR、不关闭 issue，也不代替 T35 放行。

### PR #266 双审查后的 Optional 精简与真机前提

用户要求先以真机证据确认索引问题，再决定正式修复。审查中的十万历史 SQL 对照不能替代 KK9 入站证据；当前未新增索引迁移，也未修改业务库。已通过 `127.0.0.1:9222/json` 发现真实 KK9，并由独立烟测 Driver 核对 Bot5761、员工3585、私聊0-3585/int2024 与本工作区授权配置。临时监听等待员工发送 `T24-索引真机核验`；仅收到该真实 inbound 并通过 T22 后，才在自建隔离库比较空库、十万合成历史及临时索引，不能把可信结果的重复计时称作多条新入站，不能把合成历史称作当前业务库数据。此阶段尚未取得指定员工消息，不宣称真机复现成功或 T35 放行。Windows 首次直接启动 pnpm 的 PTY 返回193，改用 cmd.exe 后真实连接及监听就绪。

Optional 逐项处理：

- 取消事务保留原状：复用任务 ID 数组没有减少 SQL 往返，却增加 JS 数据复制和单调用方事务接口；现有同事务锁序及生命周期 SQL 保持不变，不为迁移代码位置新增抽象。
- 发送单测由1151行拆成基础286行、竞争156行、恢复423行；共用328行的 `tests/helpers/send-service-fixture.ts`。六个原 describe 分组已逐字比较，测试正文与断言全部保留；假时钟、Node promises 定时器替身、service关闭及mock清理由同一 setup 管理，每个测试文件显式注册。后续完整发送单测使用 `tests/unit/send-service` 前缀，不再只运行基础文件。
- Tool 交付回调删除重复的 inputVersion/currentAttemptId 比较；输入版本、attempt 和 context 仍由生产 `withTaskOutput` 在锁内检查，Tool仍检查running、截止时间和AbortSignal。未增加或削弱测试，原失效资料不交付回归继续通过。

实际验证：

```powershell
pnpm --filter @kairo/app exec vitest run tests/unit/knowledge-tool.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/send-service
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @kairo/app test:integration -- tests/integration/new-context tests/integration/send-service.test.ts tests/integration/ragflow-connector.test.ts
```

Tool29/29，拆分发送61/61（25+14+22）；最终根四命令全部通过，Driver330、App303（18文件）。真实 PostgreSQL 组合4文件51/51，含上下文27、发送19、知识Tool5；知识路径使用真实Python与受控HTTP，不是ERP真机。中间一次清理导入误删START，typecheck明确失败；恢复导入后重新执行上述完整质量链通过，没有放宽检查。AST比对尝试因Eval运行时无法解析typescript包失败，改用六个完整测试分组逐字对照成功，不声称AST核验已通过。

本轮真机监听最终等待十分钟仍未收到指定员工消息，明确以退出码1结束（`未在十分钟内收到指定员工真实消息`），不是性能实验失败，也不是通过。已断开本脚本 Driver 并删除自建库 `kairo_t19_51e9ccd146db47dca1bfaa86ed3800ff`（PID30302/30303）；未运行十万历史填充、临时索引或发送回复。Optional优化已由4dcc2b7推送，正式索引方案仍等待真实入站证据，不用此前合成SQL对照越过用户前提。

### 真实入站确认后的批次索引修复

用户要求重启监听后，真实KK9收到员工3585的消息135942879（sessionId=0-3585，direction=inbound），经过原T22身份、allowlist及去重得到accepted。生产控制处理器在隔离空库五次耗时2.73–4.29ms；加入十万条其他thread的合成discarded历史后为125.58–222.96ms；仅增加thread_id索引后为2.74–6.79ms。每组是同一可信结果的五次定向重放，不是十五条新入站；该结果确认真实消息触发的生产路径存在容量问题，不代表当前业务库规模或完整消息往返延迟。烟测退出0，自建库kairo_t19_ba14e7b1747e4f56ad08caa40571d5ed（PID30485/30486）及本次Driver连接已清理，无Bot回复。

证据成立后采用最小修复：新增 `000010-message-batch-thread-index.sql`，仅创建 `kairo.message_batches(thread_id)` 索引，Down仅删除该索引。复用既有启动前、单事务迁移方式，不改查询、锁序、任务状态、T22入口或Driver，不引入缓存/计数/兼容路径。正常CREATE INDEX会在迁移期间限制该表写入，沿用现有停机迁移边界，不擅自改成事务外并发建索引，也未对配置所指业务库执行迁移。

正式迁移独立验证采用 `createTaskTestDatabase` 创建并核对自有库：up后生产prepareContext五次2.86–4.22ms；通过node-pg-migrate回滚000010后126.76–216.62ms；重新up后2.73–3.70ms。每一步旧thread不变、十万历史均保留；最后重复迁移返回0项。该up/down/up对照排除了仅由首次缓存变化造成的假改善。自建库kairo_t19_64b3093249824254b61e1275814ee136已清理，两个一次性烟测脚本验收后删除。

实际执行：

```powershell
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/apps/kairo/tmp/t24-real-index-smoke.ts
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-229-t24-context/apps/kairo/tmp/t24-index-migration-smoke.ts
pnpm --filter @kairo/app test:integration -- tests/integration/new-context tests/integration/send-service.test.ts tests/integration/private-chat-store.test.ts tests/integration/task-store
```

两个烟测退出0；最终真实PostgreSQL集成9文件111/111通过，全部应用正式000010迁移。本次只有SQL迁移与文档变化，TypeScript代码沿用此前Optional精简后根build/typecheck/test/lint的Driver330/App303通过结果，没有声称重新运行根四命令。现有行为回归保持不变，不增加绑定具体执行计划或易波动耗时阈值的永久单测。T35各任务状态/new真机放行仍未执行，PR仍草稿，不合并或关闭issue。

## T23 消息聚合与阶段一输入拒绝（2026-09-09）

T23 初次实现、真实 PostgreSQL 集成及独立原生计时运行结果记录如下。PR267 后续双审查发现的同批收尾失败传播问题，已在用户要求的真实KK9链路复现后最小修复，并通过修复后真机复验；证据见本节末尾，不等于完整T35或合并放行。用户批准的输入规则见 `SPEC-stage-1.md`，完整计划见 `tasks/plan.md` 第20节；T22、T27、T24 的完成状态沿用用户确认。

### 接入与恢复合同

`createCollector({ botId, store, contexts, sender, tasks, batching, configDigest, queueMs, logger })` 返回 `accept/recover/settled/close`。`accept` 只接收 T22 的返回值，内部复用 T24 控制处理器；未放行结果和 `/new` 直接返回，仅普通消息入批。与执行方共用同一个 context-service，不重复订阅 Driver，不创建 T28 Agent。`batching`、`queueMs` 取现有启动配置；未新增配置开关。

`PostgresPrivateChatStore` 额外实现聚合专用 `CollectorStore`，复用原始消息、批次表和 context 行锁。在同一事务先结束已到期旧批、再追加新消息并校验整批；静默更新不改变最长截止。首条及最后消息的时间来自 T22 持久观察时间；等锁后重新采样当前时间，截止等号属于下一批。不同员工/Bot/会话不共用批次，`/new` 切换后旧追加、计时和恢复均不能推进。

`000011-collector-settlement.sql` 只补 `finished_at`、`rejection_reason`、`settled_at` 及待恢复索引。三项分别保留原结束时间、首次拒绝原因、任务/提示收尾是否完成；用于恢复结束与副作用之间的中断，不是空 task 或通用事件账本。运行时不执行迁移，迁移不猜造历史时刻。旧手工 ready/rejected 缺少结束信息时明确报错，不提供兼容回退。

collecting 不建任务。合法到期批次通过 T19 `createTask` 建立唯一 queued 账本，创建时刻为原批次最早截止，排队截止为该时刻加现有 queueMs；重启不推迟。已有运行 task/attempt/AbortController 不修改。T25 仍负责正式领取、队列容量和并发调度，本模块不执行 Agent。`accept` 的批次返回值是该次存储快照，不是绕过任务/context 门禁的执行授权。

拒绝固定提示使用首条原始消息、thread 与 `notice:input_attachment` / `notice:input_too_long`，经过 T21 的 send/recover。恢复只在旧实例及其发送协调器停止后调用，同实例并发 recover 共用一次工作；任务唯一键和原发送意图保证重复收尾不新增任务或提示。最终完成后标记 settled，恢复不重复扫描已收尾历史；失效 context 的旧拒绝也不补发。

`settled()` 等待已开始的工作并报告定时回调错误，不等待尚未到期的批次。直接 accept/recover 的异常仍由其 Promise 交给调用方；定时器没有直接调用方，因此同时记录关联日志并保存错误供 settled/close 观察。`close()` 清理本实例计时器并等待在途调用，不关闭调用方的 sender、Driver 或数据库池。调用方须处理这些 Promise，不得忽略失败。

### 初次离线执行与配置阻塞记录

- 输入策略首次因模块不存在而失败，实现后11项通过。聚合生命周期首次因模块不存在而失败；实现后发现故障注入放在accept前，改为在实际定时阶段注入，组合22项通过。
- 新增并发反例：上一条收尾还在返回collecting快照，下一条已使批次rejected；原共用Promise漏掉立即提示。回归修复前失败（提示0次），改为同批收尾串行后复读数据库，组合23项通过，不增加总线或任务调度。
- App typecheck首次指出单测无参数mock推导为空元组，改为真实TaskStore方法类型；App typecheck/build随后通过。相关ESLint首次指出两条多余非空断言，去除后通过，未放宽规则。
- `pnpm --filter @kairo/app test -- tests/unit/collector.test.ts` 实际运行全部App默认测试，20文件326/326通过；不是只运行collector。包含聚合12项和输入策略11项，计时使用受控时钟，不是实等60秒。
- `pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery` 实际退出1：本worktree没有 `.env`，进程缺少 `KAIRO_TEST_DATABASE_URL`。两个文件的23项在初始化前未执行，没有创建或迁移任何数据库，不能计为通过。

### 复现命令与环境边界

```powershell
pnpm --filter @kairo/app exec vitest run tests/unit/collector.test.ts tests/unit/input-policy.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery
pnpm --filter @kairo/app test:integration -- tests/integration/private-chat-store.test.ts tests/integration/new-context tests/integration/task-store tests/integration/send-service.test.ts
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app build
```

用户随后在本worktree提供测试配置，现有 `createTaskTestDatabase()` 使用该连接创建随机独立库；迁移前核对实际库名与两连接PID，只清理自己创建的库。配置所指原库不迁移、不写业务表；此前缺配置失败保留为历史记录，最终真实结果见下节。

默认5秒静默和10条上限下，连续消息会在达到60秒前先静默结束或超条数拒绝。最长截止定向单元和原生烟测均使用现有quietMs=10000、7条每9秒消息，保持maxWaitMs=60000与maxMessages=10；正式YAML不变。恢复集成使用quietMs=5000/maxWaitMs=8000构造两条合法消息的最长剩余，不伪造默认配置下超过10条的可接受历史。

本次不修改Driver、不连接真实KK9、不调用模型或ERP。T35真实IM三段发送、持续发送、附件拒绝和运行中补充放行仍由T35承担；本分支不合并、不关闭issue。

### 追加审查修正与离线验证

只读审查发现批量收尾使用Promise.all时，一批先失败会使外层调用提前退出，close漏等另一批在途操作。新增“两批分别失败、第二批挂起”的回归先实际失败，再将两处批量收尾改为专用processBatches：等待全部结果后，单个错误原样抛出，多个错误使用AggregateError保留；close仍等待完整在途调用。修复后定向聚合/策略24项通过。

原有集成用例还补充：运行中补充的下一批实际建账后，原task/attempt/AbortSignal仍不变；/new竞争结束后新thread可以继续收集；同一条消息既超长又带附件只产生附件提示。删除聚合器并不调用的必需getCollectedBatch接口要求，具体存储类的只读查询仍保留。未增加测试框架、配置或兼容路径。

最终实际执行App typecheck/build、相关九个TypeScript文件ESLint和Prettier检查通过。执行 `pnpm --filter @kairo/app exec vitest run --config vitest.config.ts --exclude "tests/integration/**"`：20文件327/327通过，含聚合13项和策略11项。两份审查均未执行测试；上述结果来自Main实际命令，不把审查意见当运行证据。

本轮审查结束时真实PostgreSQL尚因配置缺失未执行；用户补齐后的结果如下。一次性探针在实际运行和自建库核验后删除，不增加正式启动入口。

### 配置就绪后的真实数据库与原生计时验收

实际执行：

```powershell
pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery
pnpm --filter @kairo/app test:integration -- tests/integration/private-chat-store.test.ts tests/integration/new-context tests/integration/task-store tests/integration/send-service.test.ts
pnpm --filter @kairo/app db:migrate:test
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/apps/kairo/tmp/t23-smoke.ts
node --env-file=.env apps/kairo/tmp/t23-check-databases.mjs
```

- collector-recovery 两文件23/23通过；独立库为 `kairo_t19_022f8b9f771d4c0a9456d510df0f5fe7`（PID31362/31363）和 `kairo_t19_475e62ba31bc4cd8928557f276552e40`（PID31364/31365）。覆盖上下文切换、真实并发、原始正文、批次及任务唯一、重复提示防重和关闭连接后新实例恢复。时间边界使用明确的受控时钟。
- 受影响私聊、上下文、任务及发送回归9文件111/111通过；不是重复放行T22/T27的真机前置任务。首次及重复迁移专题2项通过、6项按名称排除；各独立库均实际应用000011。未改Driver，沿用之前源码未变的App327项、类型/构建及静态检查结果，不声称本轮重新执行它们。
- 普通tsx进程不使用假时钟，实际三段消息于首条后7175ms确认合并，最后一条后的静默为原5000ms；静默剩余恢复于首条后5108ms确认，重启没有获得新的5秒。
- 七条每9秒持续消息使用quietMs=10000，旧实例在最长截止还剩5975ms时关闭并重建；总耗时60103ms时任务已经形成，原maxDeadline不变。这是实际等待60秒，不是默认5秒/10条能够一直持续60秒的声明。
- 两个期限全部过期后，recover调用22ms完成，任务创建及排队截止仍来自原始最早截止。附件整批拒绝只产生一次提示，新批收到/new后保持discarded；迟到timer及再次recover均没有创建旧任务。
- 烟测库 `kairo_t19_cf70846c65e24ab99648f9ca30e8fa34`（PID31479/31480）正常回收；普通Node只读查询本轮13个有输出记录的精确自建库名，残留为0，不按前缀扫描或删除其他库。T18自建库另由其现有afterAll完成清理。仅回收本任务资源，不接管其他进程或KK9。
- 首次tsx命令使用相对 `../../.env` 时在加载配置前退出9，未访问数据库；改用当前worktree的绝对配置及脚本路径后退出0。没有更换凭证来源或静默回退。

最终复杂度复核保留已有context锁、批次状态和T19/T21防重合同；移除无消费方的必需接口、冗余计时清理分支及多余断言，没有通用总线、额外配置、兼容层或完整调度器。两个一次性探针已删除，以上命令为运行历史；长期复现使用保留的单元/集成测试。

未执行T35真实IM或操作系统强杀故障矩阵，未调用真实Agent/模型/ERP；运行任务不变由真实PostgreSQL账本、attempt和实际AbortController证明，出站使用FakeKK9Driver。未合并分支、未关闭issue。

交付前把既有隔离场景补为三组消息交错各两条，并把运行中补充改为在原task/attempt登记后才新建下一批；不只验证已存在批次的追加。原样重跑collector-recovery两文件仍23/23，App typecheck及该测试ESLint/Prettier通过；生产代码未改，没有重复运行无变化的原生60秒烟测。新独立库为 `kairo_t19_22016a9c35494bb4a1931dadb686c866`（PID31527/31528）及 `kairo_t19_76163fb443a245129cfd64dfbea4802b`（PID31529/31530）；普通Node进程对累计15个有记录的精确自建库名只读查询，残留0、stderr为空、退出0。

### PR267 双审查后的真机前置与 Optional 处理

Required 为同批 `finishing` 的前驱异常会跳过已排队的后继收尾。此前真实PostgreSQL加受控收尾异常、FakeDriver的最小探针已复现，但用户明确要求先验证真实KK9链路，因此未凭该模拟出站证据修改collector失败链。

修复前真机运行使用本worktree显式授权：Bot5761、员工3585、私聊0-3585/int2024。真实CDP端点可达，独立只读探针核对登录UID与无其他Hook/binding；真实KK9Driver随后通过会话及员工档案门禁并开始监听。五分钟内未观察到所需 `T23-267-A` 标记及五秒内附件，进程退出1，原因仅为未完成真实入站；没有触发收尾故障注入、没有发送Bot测试回复，也不能据此判断问题不存在。Driver退出后UID仍5761、Hook generation为null、binding不存在，自建库 `kairo_t19_8611712f363548a08154576106878cba`（PID31771/31772）已删除并按精确库名确认无残留。

历史实际命令：

```powershell
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/apps/kairo/tmp/t23-real-preflight.ts
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/apps/kairo/tmp/t23-real-concurrency.ts before T23-267-A
```

Optional 已单独实施：在store.ts增加私有 `readBatchMessages(connection, batchId)`，让collect事务和公开getBatchMessages共用一份SQL、顺序及映射。事务内仍使用原PoolClient，公开读取仍使用原Pool，不另开事务或借连接；收益是消除两处维护，不宣称减少SQL次数或性能提速。公开接口及查询结果不变，没有更改collector.ts、Driver或配置。

实际验证：

```powershell
pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery tests/integration/private-chat-store.test.ts tests/integration/new-context tests/integration/knowledge-record-store.test.ts
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app build
pnpm exec eslint apps/kairo/src/modules/private-chat-core/store.ts
pnpm exec prettier --check apps/kairo/src/modules/private-chat-core/store.ts
```

真实PostgreSQL回归6文件70/70通过，包含批次排序/原文、事务内输入策略、拒绝、防重、恢复以及旧context历史可读；类型/构建、ESLint/Prettier通过。只读调用方核对时LSP服务退出，使用定向源码搜索完成定位，未修改语言服务配置。五个有输出记录的回归库加上真机等待库，共六个精确库名只读核验残留0，T18库由既有afterAll清理。不变的Collector单元和原生60秒烟测未重跑，不将本轮70项称为Required修复证明。

当时Required和修复后真机仍等待用户准备好真实发送。后续结果如下；PR不合并，issue不关闭。

### PR267 Required 真机复现、最小修复与复验（2026-09-10）

修复前 `T23-267-B` 收到真实文字135973557及文件135973565，同批97256698-712c-4499-9a0c-e439c3814803。受控注入一次首次收尾异常后，两次accept均收到同一错误且拒绝提示0次；显式recover后提示135973573才真实送达，sendCalls=1，原生历史存在并成功撤回。进程退出0。这是实际KK9收发加受控异常，不声称发生了自然数据库故障。

生产代码只修改collector.ts的processBatch：`existing.then(proceed, proceed)`让前驱成功或失败后都执行已排队的后继收尾。前驱错误仍返回原调用，后继重新读取自己已提交的批次；不增加重试、配置或新并发层，不修改T21、T24、Driver、接口或数据库合同。同批串行及close/allSettled仍保留。单元回归覆盖前驱成功/失败，新增真实PostgreSQL回归断言前驱原异常、后继成功、原文完整、无任务、一次送达及重复恢复不增发送。两项失败分支在修复前实际失败，修复后通过。

修复后首轮 `T23-267-C` 的文字135974359和文件135974383落入不同批次，进程退出1，未形成目标交错，不计作通过。下一轮 `T23-267-D` 的文字135974677与文件135974679的observedAt相差431毫秒，同批0daaf2b0-2b83-44fe-8266-e823a8032c31；首次异常仍返回原调用方，附件提示135974683在显式recover前已delivered。随后连续recover两次，sendCalls仍为1、任务为0；原生历史核对通过，提示成功撤回，进程退出0。

本轮实际命令（真机使用一次性探针，验收后删除）：

```powershell
pnpm --filter @kairo/app exec vitest run tests/unit/collector.test.ts --testNamePattern=前序收尾
pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery-concurrency.test.ts --testNamePattern=前序收尾
pnpm --filter @kairo/app exec vitest run tests/unit/collector.test.ts tests/unit/input-policy.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/collector-recovery
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
pnpm --filter @kairo/app build
pnpm exec eslint apps/kairo/src/modules/private-chat-core/collector.ts apps/kairo/tests/unit/collector.test.ts apps/kairo/tests/integration/collector-recovery-concurrency.test.ts
pnpm exec prettier --check apps/kairo/src/modules/private-chat-core/collector.ts apps/kairo/tests/unit/collector.test.ts apps/kairo/tests/integration/collector-recovery-concurrency.test.ts
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/apps/kairo/tmp/t23-real-concurrency.ts before T23-267-B
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/apps/kairo/tmp/t23-real-concurrency.ts after T23-267-C
pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-228-t23-collector/apps/kairo/tmp/t23-real-concurrency.ts after T23-267-D
```

前两条是修复前红灯基线，各有1项目标失败；首次并行启动pnpm时出现bin生成警告，测试仍实际执行。修复后串行运行：定向单元25/25、真实PostgreSQL恢复24/24、App默认单元328/328，类型、构建、相关ESLint及Prettier均通过，无修改工具配置。各轮真机退出后UID仍5761，Hook generation为null且binding不存在；本轮六个精确自建库（B轮、红灯基线、两个绿灯集成、C轮、D轮）只读查询残留0，stderr为空，退出0。临时探针已移除。

本次自审未引入通用框架、兼容分支或自动重试；只修复前驱错误短路后继这一条路径。此证据不替代完整T35三段发送、持续发送和真实Agent运行中补充消息验收；本轮也未重跑不变的原生60秒烟测或全部111项账本回归。

## T25 同会话队列、全局并发与时间通知（2026-09-10）

### 可调用入口与装配边界

`task-lifecycle/scheduler.ts::createScheduler()` 接收现有 tasks/contexts/chat/sender、已加载配置参数和必需 `execute`，提供 `enqueue/tick/resolveUserWait/settled/close`。一个应用进程只装配一个实例，所有 Bot/session 共用实际执行集合。`tick()` 只等待本轮持久状态裁决，不等待 Agent；入队、回答、执行结束及发送结束会自动唤醒，排队和未回答等待由最近绝对截止定时唤醒。

`createCollector()` 改为必需 `deliverReady: scheduler.enqueue`，不再接收 tasks/configDigest/queueMs 直接建任务。ready 和 queue_full 重放交给同一调度裁决，只有交付返回 true 才标记批次 settled。生产没有可选兼容入口；T23 专题测试显式注入底层账本交付以隔离聚合合同，完整 Collector→调度接入由 scheduler 集成覆盖。

`task-runner.ts::TaskExecutor` 输入真实 task、attempt、context 和实际 AbortSignal；输出已通过上层检查的 answer 正文，或 waiting_for_user 的问题及授权问题范围。此 Promise 只能在 Agent 不再启动新 Tool、全部 Tool 的 settled 与本地执行回收后结束。实现必需注入，没有默认空实现或 Mock；T25 不装配 T28 Agent、不实现 T29 答案检查或 T30 自然语言判断。`index.ts` 未新增订阅，因此正式启动仍不声称已具备完整员工问答闭环。

TaskRunner 建立 attempt/runId、复用 T24 控制器登记并设置原执行截止；run 等待真实执行与必要账本，不等待 T21 最终发送回执才释放全局名额。`settled/close` 等待自己开始的工作并保留错误，不关闭调用方的 sender/Pool。业务超时或 /new 立即失效旧结果，但底层未退出仍占实际名额；永不退出时必须人工处置，close 也不假装成功。

### 持久化及时间合同

- `000012-task-scheduling.sql` 增加原始 execution_budget_ms、queue_notice_required 与 current_wait_id，扩展批次 queue_full 原因及实际查询索引；没有新任务状态、任务队列表、租约或分布式框架。既有唯一开放等待可以回填实际指针；不猜历史执行预算。迁移仍在启动前执行，运行时不做 DDL。
- `enqueueTask()` 在有效 context 锁内原子计数/入队/满队列拒绝，默认最多3个 queued；拒绝保留原始消息及 batch，不建 task。重放返回原任务或原拒绝，容量释放也不会重新接纳已拒批次。原始 queueDeadline 为批次结束时刻加600000，不按回调或重放刷新。
- `claimTask/resumeTask` 现在直接返回同事务 Task 或 null，删除领取成功后额外读取失败留下无人执行 running 的窗口。领取、恢复和进入等待可传锁后采样时钟；同会话 queued 严格排序，running/waiting/ready/sending 均阻塞后续。
- accepted 只保存原始回答，仍 waiting_for_user；真正取得名额后 resume 才恢复剩余预算。新一轮等待同事务保存明确 currentWaitId，同毫秒也不能错用上一轮同意。已回答待槽任务不能按旧十分钟等待期限超时。
- 进度到期为 `executionDeadline - executionBudgetMs + progressMs + 1`，毫秒精度下严格超过10秒。员工等待和等槽暂停累计，必要执行收尾计时；采用前再检查实际时间，不能依赖 timer 已运行。执行到期先调用实际 AbortController，再落 timed_out，旧结果只能留审计。
- queued/progress 使用 T21 唯一 purpose，队列超时与执行超时分别使用 notice:queue_timeout / notice:execution_timeout。等待问题在实际交付锁内核对当前开放 wait。因员工等待暂停且确证未调用 Driver 的进度只退本次 reservation；已触发或崩溃窗口仍遵守 T21 原预算，不能借暂停重发。
- Down 保留旧约束；已有 queue_full 审计会明确阻止直接降级。降级前必须先处理这些新数据及待执行工作，不自动删除原始消息、不静默改写拒绝或添加兼容回退。

### 实际回归与原生执行证据

精确定向命令：

```powershell
pnpm --filter @kairo/app exec vitest run tests/unit/scheduler.test.ts tests/unit/task-runner.test.ts tests/unit/send-service
pnpm --filter @kairo/app test:integration -- tests/integration/scheduler tests/integration/send-service tests/integration/task-store tests/integration/new-context tests/integration/collector-recovery tests/integration/private-chat-store.test.ts tests/integration/memory-commit-store.test.ts tests/integration/knowledge-record-store.test.ts tests/integration/ragflow-connector.test.ts
pnpm --filter @kairo/app db:migrate:test
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

定向单元101项通过；受影响数据库组合18文件185项通过；迁移专题2项通过、6项按测试名排除，不计作全量验收。覆盖2/4/5任务、3+1会话、9.999/10/10.001秒执行及完成边界、满队列竞争、ready/sending/send_unconfirmed、等待暂停恢复、/new、迟到结果及收尾错误。数据库全部沿用本工作区配置创建随机库，核对实际库名和双连接PID后迁移，不修改配置指向的原库。

两个关闭反例先失败后修复：回答事务未纳入 pending；发送结束唤醒新 pump 后 settled 提前完成。四个真实SQL等待反例也先失败后修复：同毫秒错用上一轮 accepted、取消未关闭当前轮次、旧等待交付、锁后恰好截止交付。进度暂停单元先有3项目标失败，发送集成取得恰好截止和暂停意图的目标红灯；其余初始失败来自夹具漏 finishAttempt、拿原问题当回答或未到等待截止，修正夹具后完整10项通过，没有放宽生产合同。

独立命令 `pnpm --filter @kairo/driver exec tsx --env-file=C:/Users/dongshilin/orca/workspaces/kairo/issue-230-t25-scheduler/.env C:/Users/dongshilin/orca/workspaces/kairo/issue-230-t25-scheduler/apps/kairo/tmp/t25-smoke.ts` 使用普通 Node/tsx 与原生时间，不使用 fake timers。最终退出0：实际执行峰值3；前三会话分别于107/196/240ms开始，第四会话于12146ms开始，晚于首项12119ms退出；同会话第二任务于12223ms开始。三项约12秒执行各有一次progress，两项约1.2秒执行没有progress。

同一烟测随后实际运行四分钟：真实 T27 Tool→Python 首次收到本地503，第二次HTTP持续等待，两个尝试共享原任务绝对截止；记录耗时240005.7112ms。任务最终timed_out，检索账本类别timeout，Tool因任务先终态而返回cancelled/stale_task且materials为空；进度及执行超时各一次，无final，后续同会话任务completed。两个Python PID均已退出。总业务耗时254808ms、命令耗时257.25秒。自建库为 `kairo_t19_aa2293201c71417d866f69d81227601f`，PID36417/36418，finally正常回收。

第一轮同样实等四分钟，但临时断言误要求Tool对已终态任务也返回timeout，得到cancelled/stale_task而退出1；它不算完整通过。核对T27既有门禁后，烟测改为分别验证任务超时、底层检索timeout、迟到资料为空、进程退出及后续恢复，没有修改T27生产逻辑。其自建库 `kairo_t19_b1d7306fe218466080771b24ef680c17` 已正常回收。

构建与类型检查通过。首次根质量链Driver330项通过，App遭Tinypool `ERR_IPC_CHANNEL_CLOSED`中断，因此该链未执行lint；设置当前命令 `NODE_OPTIONS=--trace-uncaught --trace-warnings` 原样重跑 `pnpm --filter @kairo/app test` 后23文件368项通过，未改worker数量或测试范围。单独lint随后通过；该IPC中断根因未确认，不宣称已修复测试框架。早期一次lint的冗余unknown联合与不必要断言已正常修正，未压制诊断。

本次证据为真实PostgreSQL、实际Tool/Python和原生时间；执行器及HTTP故障受控，出站为明确FakeDriver。未调用真实主模型或ERP、未连接真实KK9，不替代T35双员工慢查询验收；未实现T26启动恢复/重连或T28正式装配，未合并分支、未关闭issue。一次性脚本在记录证据后删除，不新增正式启动方式。

最终清理将执行/通知错误统一归 runner、调度自身错误归 scheduler；关闭分别等待两方一次，避免把同一个错误重复聚合。随后重新执行完整 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 全部通过：Driver330项、App368项；追加 scheduler 真实集成8项再次通过。该轮自建库 `kairo_t19_6bd940d701ed4999baf94c83cdbb0eb2`（PID36644/36645）正常回收。

`node --env-file=.env apps/kairo/tmp/t25-check-databases.mjs` 对本轮输出记录的38个精确自建库名只读查询，残留0；不按前缀扫描或删除其他库。T18自建库由其既有afterAll完成清理。上述烟测与核验脚本随后删除，`.env`保留且不提交。类型服务初始化退出已报告工具问题；符号定位使用限定范围检索，未修改LSP配置。独立审查没有执行验证，所有命令结果均来自Main实际运行；外部跨模型CLI未获授权、未调用。

### PR268：关闭竞态真实复现与进度真机验证等待（2026-09-10）

用户要求先用真实环境确认，再修复，不将受控替身探针当作真机结果。本轮分别运行真实 PostgreSQL 关闭交错，以及真实 KK9/T22/T21/调度装配的进度监听；二者的证据边界不同。

- 关闭基线使用合成入站、真实 context/batch/入队/领取 SQL，不连接 Driver。`pr268-close-real.ts --expect-bug` 在自建库 `kairo_t19_0f28174a43d4497a999c12264326cb10`（PID37013/37014）复现：正常 close 成功，任务仍 running、current_attempt_id=null、attempt=0、execute=0、取消调用=0。交错仅安排领取 Promise 续体与关闭微任务的顺序，不伪造持久状态。
- 先新增真实数据库回归，定向测试失败于预期 cancelled、实际 running。最小修改为 scheduler 同步调用 runner.run，不再延迟交接；真实复验进一步暴露已取消任务仍继续创建 attempt/登记的问题，因此在读取 context 和创建 attempt 的异步返回后检查原 AbortSignal，已取消工作不再进入下一准备阶段，已保存 attempt 仍按原收尾流程结束。没有将数据库错误改写或吞掉。
- 最终 `pr268-close-real.ts --expect-fixed` 使用同一交错，在自建库 `kairo_t19_0c6dfd55574f4e17a29b83a7370aebd1`（PID37049/37050）观察到真实取消 SQL 被另一连接的任务行锁阻塞，close 同时保持等待。释放本探针的锁后，取消提交先于 close 成功；最终 cancelled、attempt=0、execute=0、发送=0、错误日志=0。不能把这项证据称为员工入站或 IM 验收。
- 进度真机入口实际核对 Bot5761、员工3585、私聊0-3585/int2024，通过真实 Driver 开始监听；120秒内未收到 `PR268-核验`，因此退出1。taskId=null、没有创建发送意图、没有发送Bot消息；未触发进度竞态，不能判断问题不存在。进度生产代码保持不变，待员工准备好后重启监听，再依次接收 `PR268-核验` 和收到验收问题后的 `PR268-继续`。
- Optional 全面合并 scheduler.executions 与 runner.active 本轮不实施：前者负责会话占槽，后者支撑独立 runner 的取消及收尾接口。统一集合虽可删除部分代码，但需新增状态查询接口、迁移唤醒及等待合作，风险大于本轮收益。同步交接已经删除实际致错的中间微任务，不增加管理框架或公开接口。

实际命令：

```powershell
node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/tmp/pr268-close-real.ts --expect-bug
node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/tmp/pr268-close-real.ts --expect-fixed
pnpm --filter @kairo/app test:integration -- tests/integration/scheduler.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/scheduler.test.ts tests/unit/task-runner.test.ts
pnpm --filter @kairo/app build
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app test
```

最终真实调度集成9/9、定向单元33/33、App默认单元369/369；App构建、类型检查、四个修改源/测试文件的ESLint和Prettier检查通过。默认单元命令注入 `NODE_OPTIONS=--trace-uncaught --trace-warnings`；没有改测试范围或worker配置。首次静态检查发现测试的裸 queueMicrotask 未列入ESLint宿主全局，改为 globalThis.queueMicrotask，未压制规则；随后类型和静态检查通过。原有同会话、实际名额、等待及迟到结果回归均保留。

本轮七个精确自建库名只读查询残留0；真机退出后再只读确认UID5761、Hook generation=null、binding不存在。关闭临时入口完成验证后删除；尚待员工参与的进度临时入口保留，不作为正式启动方式。没有修改Driver/T24实现、数据库迁移或正式Agent装配，没有提交推送、合并或关闭issue。

### PR268：进度丢失真机确认与最小修复（2026-09-10）

员工准备好后重启真实监听，Bot5761/员工3585/0-3585/int2024 的入站 `135999497`（PR268-核验）与 `135999563`（PR268-继续）均通过T22，真实原始消息重放返回duplicate。原生实等超过10秒后进入真实waiting，员工回答通过原等待账本恢复同一task；仅在真实发送reservation提交后及暂停回退CAS前人为延迟，不修改任务状态、员工答案、时钟或Driver回执。

修复前在随机库 `kairo_t19_8fd478a4527f44229fb1d42a6772a5ff` 观察恢复执行12114ms：两次progress请求，Driver自动调用0次，唯一operation `7a6fde00-2617-4a29-86dc-7d8b5ab10e69` 停在prepared/sendCalls=0，task仍running。随后手动推进原意图才真正送达 `135999583`，这只是发送正对照，不计作自动进度。问题提示 `135999527` 和正对照均已撤回，进程退出0，无清理错误。这证实实际组件在受控交错下丢进度，不声称故障在无延迟注入时自然出现，也不是正式Agent/T35验收。

新增重叠回归先失败于prepared而非delivered。修复仅改变发送服务内部结果：明确标记实际暂停；锁内暂停回退必须CAS成功才保留该标记，败方不得接管胜方。加入旧活调用的恢复请求等待其退出，再检查当前任务有效性并重新推进原operation/purpose；公开SendService接口、持久化格式、Driver及既有实际发送/查询预算不变。两个同时到达的恢复请求也只能形成一次交付，不加入轮询或通用重试。

修复后发送/调度定向单元104项通过，包含暂停续发与CAS败方不续发；真实PostgreSQL发送/调度5文件50项通过；App默认23文件371项通过，App构建、类型及相关ESLint/Prettier通过。命令为 `pnpm --filter @kairo/app exec vitest run tests/unit/send-service tests/unit/task-runner.test.ts tests/unit/scheduler.test.ts`、`pnpm --filter @kairo/app test:integration -- tests/integration/send-service tests/integration/scheduler` 及原App质量命令。

修复后的两轮真机监听分别等待首条员工消息120秒、300秒，均未收到新 `PR268-核验`，以超时退出1；两轮均taskId=null、无发送意图、无Bot消息、无清理错误。第二轮只延长临时入口等待，未改正式业务期限。尚不能宣称修复后真机通过；保留临时入口，待员工可再次连续完成两条消息时复验，不自动反复重启。最终对本阶段15个精确自建库名只读查询残留0；KK9再次只读确认UID5761、Hook generation=null、binding不存在。代码已修复并完成上述回归，但尚未提交推送或合并。

### PR268：最终真机复验通过（2026-09-10）

用户再次准备好后，以受监督进程运行 `node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/tmp/pr268-progress-real.ts --expect-fixed`，最终退出0。此次延用同一受控交错与真实组件，不修改生产代码或放宽断言；此前两次修复后监听超时仅为中间历史结果，本轮完成了实际复验。

- 真实员工消息 `136001699`（PR268-核验）、`136001789`（PR268-继续）经T22接受并验证持久去重。自建库为 `kairo_t19_9bb605cab63d48939ba002d8965b11be`，连接PID37268/37269；同一task `b11dc332-0dc7-4068-ab12-fd81b56db6b9` 在原等待记录上accepted并恢复执行。
- 原暂停回退完成后，恢复请求重新检查并推进唯一progress意图。三次ensure均指向同一个operation `a0d7ce28-35fd-407c-b4c0-5e0255fbacd2`，实际Driver调用1次、sendCalls=1、queryUsed=false；协调与Driver账本均为delivered，原生消息ID均为 `136001797`，Driver报告确认耗时475ms。没有手动正对照；自动观察3051ms期间任务仍为running。
- 验收问题 `136001727` 和自动进度 `136001797` 均已撤回，未撤回员工消息；清理错误及未撤回Bot消息均为空。关闭自有调度/发送/Driver/连接池后，对本阶段累计16个精确自建库名只读查询残留0；再次确认UID5761、Hook generation=null、binding不存在。
- 验证完成后删除临时真机入口，保留正式竞争回归。生产代码自上一轮App371项、真实数据库50项、构建/类型及定向静态检查通过后未再修改，因此本轮不重复运行不变的质量命令。公开接口、数据库迁移、Driver实现与正式Agent装配均未改变。

至此，关闭竞争与进度竞争均已有修复前真实环境证据、最小修复和对应修复后复验。进度证据包含真实员工入站、PostgreSQL及KK9实际发送，但执行内容和竞态延迟仍受控，不替代正式Agent或完整T35双员工慢查询验收。未提交推送、合并分支或关闭issue。

## T26 启动恢复与 Driver 重连监督（2026-09-10）

任务：[#231](https://github.com/dnslin/kairo/issues/231)。代码、自动化回归与受控运行已验证；真实员工参与的重连验收尚未完成，不能据此关闭 issue 或宣称 T35 放行。

### 实现与边界

- `task-lifecycle/recovery.ts` 提供启动恢复与断线取消两个独立入口。启动恢复只用于旧进程退出后；同一实例重复调用共享原恢复 Promise，不能把本进程新任务当成崩溃任务。
- `000013-task-recovery.sql` 保存已检查的 `answer_text` 与单次恢复额度 `recovery_used`。正文不从其他账本猜造，也不提前写正式 Memory。
- collecting 复用 T23 原静默/最长截止和恢复计时器；过期批次立即形成输入。queued 由 T25 沿用原十分钟截止，过期 timed_out。
- running 仅在原四分钟截止内增加一次恢复 attempt；数据库原子占用恢复额度。再次重启不能继续追加，恢复耗尽按既定要求 failed 并通知；过期仍 timed_out。
- ready_to_send/sending 使用持久正文并复用 T21 恢复入口，不重新生成答案。发送三态、最多两次实际发送、唯一查询及原三十秒查询时点不另建策略；querying 时崩溃不补查。缺少可恢复正文的任务失败并通知，不永久阻塞会话。
- waiting_for_user 使用原等待记录、十分钟绝对截止及会话阻塞规则；已关闭等待不会重新提问。已报告终态与 Memory pending 保留，Memory 执行恢复留给 T32。
- `driver-supervisor.ts` 在断线当前调用栈关闭消息入口、使旧 generation 失效并触发 AbortSignal。旧聚合/领取事务收尾后取消本 Bot 未完成任务；重新创建 Driver，不复用旧连接对象。旧执行真实退出前仍占实际槽位。
- 新连接装配完成后才接收入站；回调、连接和清理错误保留并传播。关闭会主动取消挂起 CDP 握手，重复或重入关闭共享同一 Promise。
- Driver 从真实原生 IPC `message` 接收入站，不再把 Vue `receive-message` / `session-msg` 的历史列表展示当新入站。受控渲染页回归证明旧列表事件不补做、新原生消息能接收；旧 Hook 与迟到 CDP 回调按代次失效。真机新旧消息边界仍须员工实测。
- `index.ts` 接入连接监督及关闭生命周期；没有派发 T28、提前装配正式 Agent、实现 T32 Memory 恢复或替代 T33 整体装配。

### 本轮实际命令及结果

```powershell
pnpm build && pnpm typecheck && pnpm test && pnpm lint
pnpm --filter @kairo/app test:integration -- tests/integration/recovery tests/integration/task-store.test.ts tests/integration/scheduler.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/recovery tests/integration/collector tests/integration/new-context tests/integration/task-store tests/integration/scheduler tests/integration/send-service tests/integration/ingress-dedup.test.ts tests/integration/private-chat-store.test.ts tests/integration/memory-commit-store.test.ts
node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/tmp/t26-smoke.ts
```

- 最终根四项命令完整通过：Driver 29 文件331项，App 26文件405项；lint 无错误或警告。前两次中间门禁分别发现旧测试注入工装未迁移、监督器 lint 问题，已修正后重跑；未降低断言或压制规则。
- 定向真实 PostgreSQL 4文件62项通过；Checkpoint C 相关真实 PostgreSQL 19文件211项通过，使用既有随机临时库隔离工装。两组有重叠，不能相加作为独立用例数。
- 独立 Node 烟测使用真实时钟、真实 PostgreSQL、正式恢复/聚合/发送/调度组件，但执行器和 Driver 为替身：停机后等待4086ms，批次结束时刻等于原静默截止；发送总等待30040ms、查询1次、状态send_unconfirmed、原正文保留且不重发；连接创建2次，仅接受断线前及新代消息，拒绝旧代迟到消息。临时库为 `kairo_t19_e88d270dfdab40f59541954da541559c`，连接PID38459/38460。烟测完成后移除临时入口。

### Checkpoint C 逐项证据

以下“通过”限本轮自动化与上述受控证据，不等于真实双员工或正式 Agent 全链路放行。

| 检查项 | 本轮证据 | 状态 |
| --- | --- | --- |
| outbound/unknown/非私聊不进入后续业务 | Driver入站标准化、App入站/聚合门禁与ingress-dedup | 通过 |
| 双员工UID/context/batch/task/通知隔离 | private-chat-store、task-store、send-service与new-context集成 | 通过 |
| EventBridge/轮询跨来源持久去重 | ingress-dedup、private-chat-store及Driver标准化 | 通过 |
| 5秒/60秒、10条/30000字、附件拒绝 | collector、input-policy单元及collector-recovery集成 | 通过 |
| /new、两小时context、迟到结果 | context-service、new-context及new-context-concurrency | 通过 |
| 会话顺序、队列3/全局3、10分钟/4分钟/10秒 | scheduler、task-runner、task-store-deadlines及scheduler-store系列 | 通过 |
| delivered/failed/unknown、30秒查询 | send-service系列、recovery集成及实际30秒烟测 | 通过 |
| collecting/queued/running/sending及waiting恢复 | recovery单元、recovery/recovery-store集成；包含恢复额度、缺正文终态与断线竞争 | 通过 |
| 根build/typecheck/test/lint | 上述完整串行命令 | 通过 |

### 真机仍待完成

已实际运行既有 `packages/driver/examples/e2e-stage1-contract.ts`，核对Bot5761、员工3585、私聊0-3585/int2024并连接真实KK9。但120秒内未收到员工新入站，结果6/7、退出1、cleanupMissing为空；不能把它记为原生接收、发送三态或重连真机通过。没有关闭KK9进程。

保留临时 `apps/kairo/tmp/t26-reconnect-real.ts` 等待员工窗口；已单独使用TypeScript静态检查，但尚未实际运行。它将在业务过滤之前记录全部目标会话原生消息，以断线前历史ID集合排除旧样本；断开自有WebSocket，待新连接后释放旧执行结果，验证旧任务取消、迟到答案丢弃、断线消息不补做、新消息真实送达，并撤回本探针的Bot消息。不能用过滤掉测试消息后再检查“未接收”的方式伪造隔离证据。

后续需要员工按提示完成 `T26-开始`、断线窗口中的 `T26-断线`、新连接后的 `T26-恢复`，并补完既有Driver真机合同脚本。T34完整跨进程与T35完整双员工真机验收仍明确未放行。代码复杂度审查保留必要的生命周期/原子额度门禁，没有新增兼容层、通用恢复框架、分布式租约或另一套发送/调度策略。未合并或关闭issue。

### T26 真机探针清理竞争修复

Advisor指出的缺陷已用真实PostgreSQL、正式调度/发送组件及Driver替身复现：历史查询异常后先释放“清理旧执行，不能交付”，执行未取消，撤回快照0条，但随后该文本发送1次并记为delivered。没有连接KK9，不能把替身回执称为真实IM送达。

修复仅限临时 `t26-reconnect-real.ts`：先设置清理标志并注销入站、装配回调，在已有异步入站/装配返回后再次检查清理标志；关闭发送服务并同步发起调度取消、聚合关闭与监督器在途等待，再释放旧执行。全部在途工作退出后才查询撤回名单，Driver与数据库留到撤回结束后关闭，各步骤错误继续汇总。生产调度、发送服务和Driver源码未修改。

实际运行 `node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/tmp/t26-cleanup-smoke.ts`，从探针语法树提取并执行其实际finally，不执行KK9连接入口。随机隔离库 `kairo_t19_c81b8310f11d419993a0a8ee3c7e6acb`（PID38573/38574）验证：释放时执行已取消、清理文本发送0次、此前已送达的替身消息撤回1条、未撤回名单为空、Driver在撤回之后关闭。烟测完成后移除临时复验脚本。

单独执行 `pnpm --filter @kairo/app exec tsc --noEmit --target ES2022 --lib ES2024,DOM --module NodeNext --moduleResolution NodeNext --skipLibCheck --esModuleInterop --strict tmp/t26-reconnect-real.ts` 通过。未重跑不变的生产代码根门禁；未启动真机，实际员工重连验收仍等待用户协调。

### T26 清理期间迟到原生回执补验

第二项Advisor问题也已受控复现：Driver已进入发送，在原生账本写入及返回回执之前暂停；清理关闭sender后才放行。协调账本保持sending/message_id=null，原生账本随后成为delivered并保存message_id。旧探针只查询协调账本，漏撤回该消息，即使未撤回名单为空也不能证明清理完整。

修复仅修改探针撤回候选SQL：先以本探针botId关联tasks/send_dispatches取得所属operationId，再联查send_operations；两侧消息ID用UNION去重，不扫描撤回其他操作。生产取消门禁不变，预期cancelled错误仍记录和传播。

实际运行临时 `t26-late-receipt-smoke.ts --expect-bug` / `--expect-fixed`，两次都执行探针实际finally、正式调度发送组件及真实PostgreSQL，Driver和监督器为替身，未连接KK9。修复前库 `kairo_t19_5f7f33072505485281babbc47459d2b6` 只撤回清理前已送达消息；修复后库 `kairo_t19_bf1e8157e7a24c6d8d48263a67d669b8`（PID38637/38638）撤回清理前与迟到消息各1次，两账本共有ID不重复撤回，同会话但不属于本探针operationId的消息未被撤回。原生写入确实晚于sender关闭，协调账本仍未采用回执，取消错误断言保留。探针单独TypeScript检查通过；临时烟测完成后移除，未启动真机。

### T26 首轮员工入站真机发现原生会话编号缺陷

用户准备后实际启动重连探针。首次装配因员工档案返回数字3585、临时断言比较字符串而退出；按既有T22与Driver真机合同的String比较方式修正。第二次监听使用临时库 `kairo_t19_50489f783ae8476e9599ae35e5ad6694`（PID38684/38685），用户确认发送后仍未进入执行，120秒超时退出，未撤回名单为空；没有把用户已发送解释为未发送。

通过只读CDP控制台缓存取证，KK9确已收到 `T26-开始`，原生消息ID136018959。载荷session.id=716791是内部数据库行ID，session.type=0、session.typeID=3585才构成公开会话编号0-3585。原生监听已安装，但标准化误取716791，使探针目标会话过滤不匹配。未重放这条旧消息进入业务。

修复 `bridge/converter.ts`：有原生type/typeID时按现有会话编号规则生成ID；轮询/DOM传入的显式sessionId保持原优先级。`event-bridge-lifecycle.test.ts`加入原生IPC私聊/群聊回归，验证会话编号、正文、发送者与inbound方向，修复前会话编号断言失败，修复后通过。没有扩大来源origin推断规则。此为生产Driver修复，仍需随后新入站真机验证，不能把此前超时记为通过。

随后完整执行 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 通过：Driver333项、App405项。最初lint指出未知字段直接String转换，已复用现有toSafeString后重新执行完整四项门禁通过。只读诊断入口已完成取证并移除；修复后真机仍需新收到的消息，不能重放先前消息充当通过证据。

下一轮用户发送的新消息136020251仍未入库并超时。完整控制台载荷进一步确认：顶层sessionID以及消息内sessionID同样是数据库行ID716791；前一轮缩减样本遗漏顶层字段，导致修复不完整。已补全回归样本，先复现同样失败，再将原生type/typeID解析优先于该旧式sessionID字段。明确的sessionId/sesUUID仍保持优先，不改变T22过滤。

修复后只读取得两条实际缓存载荷136018959、136020251，在本机调用标准化函数，均断言sessionId=0-3585、direction=inbound、正文为T26-开始。只解析、不派发、不入库、不补做旧消息。随后再次完整执行根build/typecheck/test/lint通过（Driver333、App405）。探针增加测试消息的会话编号、方向和入站处理状态输出，避免下一次只见超时而缺少定位证据；真机通过仍取决于后续新消息。

修复后的真实消息136020995（T26-开始）与136021209（T26-恢复）均以0-3585/inbound进入T22并accepted。探针断开自有WebSocket，旧任务取消断言通过，新连接代次从 `aeb2691e-e9fd-4c62-ae74-d2559dfd5754` 变为 `026dd1f9-54cd-4832-befa-17b43310340c`；新回复136021221由真实Driver确认delivered（508ms）并撤回，清理未撤回名单为空。

该轮仍退出1，不能记作重连完整通过：隔离断言发现T26-断线消息136021113被新代次观察。随后只读控制台时序证明，新连接在07:39:06.946Z连接、约07:39:07就绪，该消息实际到达KK9为07:39:51.628Z，已在重连之后约45秒。因此这是未落入断线窗口的无效验收样本，不是已证明的历史重放。临时探针的重连等待由15秒改为120秒、等待上限同步改为130秒，以适应人工终端往返；未改生产默认重连间隔、任务预算或隔离断言。入口单独类型检查通过，需重新收集窗口内的新样本。

两分钟断线窗口版本随后实际启动，07:43:25监听就绪，07:45:25因等待首条T26-开始超时退出1；日志没有本轮测试消息入站记录，尚未执行断线步骤。清理未撤回名单为空，自有连接关闭。暂停自动重启，待用户重新确认可配合窗口后继续；该轮不构成重连失败或隔离通过证据。

### T26 两分钟断线窗口真机复验通过

用户再次确认准备好后，运行 `node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/tmp/t26-reconnect-real.ts`，最终退出0。使用真实KK9与PostgreSQL，自有WebSocket受控断开，执行器仍为受控函数，不冒充正式Agent或T34/T35整体放行。

- 本轮隔离库 `kairo_t19_ebd2deae9bcd4c538cce9a4e644f19f6`，连接PID38837/38838。
- 首条136021913以0-3585/inbound被T22 accepted；07:46:49断开自有WebSocket，KK9进程保持运行。
- 自动创建第二个连接，代次由 `8258a283-f163-47c4-a44b-2d624fbe479d` 切换为 `3b89da6e-d36a-43a3-b273-c04d16ec7dd6`，07:48:49重新就绪。旧执行AbortSignal已取消、旧任务cancelled断言通过；新连接就绪后释放旧答案，未产生旧任务最终发送。
- 断线消息136021997可从KK9历史读取，但不在新连接观察集合中，未补做。新消息136022191被T22 accepted；两代实际业务接收记录仅为136021913、136022191，创建连接2次、执行2次。
- 新任务唯一最终消息136022199由真实Driver确认delivered，确认耗时520ms；该Bot消息已撤回，未撤回名单为空。探针退出0，自有业务、连接和数据库资源完成关闭；未关闭KK9、未撤回员工消息。

本轮补齐T26自有连接断开、自动新代次、断线消息不补做、旧结果丢弃与新消息实际交付的真机证据。原生会话编号修复后的根四项命令已在前一轮完整通过（Driver333、App405），此后生产代码未改，不重复宣称本轮重跑。既有e2e-stage1-contract完整合同脚本仍未取得整轮通过结果，需另行协调；不能用本轮专项通过替代其全部检查。真机重连临时入口验证完成后移除，保留生产回归与本节证据。未合并、未关闭issue。

### PR269后续：原生撤回会话编号一致性修复

Advisor指出的撤回路径遗漏已复现：同一原生envelope普通消息为0-3585，三种现有CancelMessage载荷仍为数据库行ID716791；消息内sessionID还能覆盖外层公开编号或调用方上下文。原生与Vue来源产生不同去重键，实际桥接会派发两次撤回事件。

修复限于 `packages/driver/src/bridge/converter.ts`：抽取文件内 `resolvePublicSessionId`，普通消息和撤回外层共用相同优先级。撤回以外层/调用方已确定的会话范围为准，消息内数据库编号不再覆盖；没有外层范围时逐条解析，保留不同会话及已有公开编号。无新增公开接口、迁移或发送门禁变化。

`event-bridge-lifecycle.test.ts` 新增6项回归，均先失败后通过：顶层/正文内/消息内原生撤回与Vue重复事件只派发一次，外层公开编号和调用方上下文不被覆盖，无外层的多会话数组不跨会话误去重。定向4文件57项通过，随后完整 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 通过（Driver339项、App405项）。LSP进程退出，调用方改用明确范围文本查询核对；未声称语言服务成功。

真机验证分层记录：

- 只读KK9缓存检查未找到原生撤回样本（匹配0），不算通过。
- 使用授权Bot5761/员工3585/0-3585，运行临时 `t26-recall-real.ts`，仅发送并撤回本探针消息136027307，operationId=`f71c2389-1259-48e7-9b23-5f908f9b4676`。真实撤回成功，公开recalled事件恰好1条且sessionId=0-3585，未撤回名单为空，自有Driver完成关闭，未退出KK9。
- 该轮未捕获原生receive-message中承载的CancelMessage，脚本按更严格的目标路径断言退出1。因此只能证明真实发送/撤回操作与公开事件正常，不能冒称原生IPC撤回分支已真机通过。需要员工侧新发并撤回一条测试消息，另行协调，不自动反复发送。

临时只读取证和自身消息探针已清理。当前代码与受控回归已修复；员工原生撤回以及既有整套Driver合同真机验收仍未放行。本轮修复尚未提交推送，不把此前PR269提交当作已包含该修复。

### PR269后续：渲染侧原始Vue撤回转发修复

前一轮共用解析只覆盖Node侧。追加原始Vue receive-message后，原生撤回已派发0-3585，渲染侧parseRecallFromMsg又丢弃外层范围并派发716791；此前只测已归一化的Vue CancelMessage不足以证明这条路径正确。临时副本中的三种载荷均失败，随后正式强化回归。

本轮删除渲染侧parseRecallFromMsg，改为保留原始会话字段和候选消息交Node侧统一解析。候选置于message内，防止普通历史消息只因含msgID就被当成显式撤回；Vue历史仍不派发普通message。全局CancelMessage保留原始范围，会话专用通道仅附加其已知公开范围，聊天组件保留原生sesInfo；不再把用于显示名查询的提示编号写成事件会话编号。原生typeID已存在时，不把数据库sessionID注册为会话通道。显示名查询与原聊天组件方法继续保留，DOM明确data属性路径未扩大推断。

验证覆盖新增4项并强化既有3项：原生后接原始Vue receive-message及全局CancelMessage的三种载荷只派发一次；会话msg/revokeMsg、聊天组件原生范围均保持0-3585；普通Vue历史消息含msgID也不派发撤回或新入站。修复前生命周期文件20项中5项失败，修复后相关4文件43项通过。最后完整 `pnpm build && pnpm typecheck && pnpm test && pnpm lint` 通过（Driver343项、App405项），无lint错误或警告。

本轮使用受控渲染环境执行实际注入脚本，未新启动KK9真机测试，不借此前Bot自身撤回结果冒称原生分支通过。员工侧原生撤回与既有整套Driver合同仍需协调。本地修复与文档尚未提交推送到PR269。

### 整套Driver合同复验：首条入站等待超时

用户要求启动整套复验后，先只读确认登录UID5761、无其他Driver Hook占用，再运行既有 `packages/driver/examples/e2e-stage1-contract.ts`，未修改合同脚本。09:39:35建立基线并等待目标员工新入站，09:41:35因120秒内未观察到符合条件的消息退出1。汇总7项、6项通过、1项失败，cleanupMissing为空；尚未进入后续发送三态、重试及中断恢复步骤。自有Driver已断开，KK9未退出。不能标记整套合同完成，等待重新协调员工窗口后再启动，不重放历史消息。

### 整套Driver合同复验：真实入站与发送通过，实时Bot回显失败

用户重新准备并发送后，既有合同脚本接收到真实员工消息136054373（0-3585/inbound），员工档案核对通过。方向unknown使用脚本明示的controlled-real-payload-shape样本，不称为真实未知方向消息。Bot文本136054375真实delivered，确认耗时566ms；随后15秒内未观察到EventBridge实时回显，脚本退出1，汇总13项、12项通过、1项失败。测试Bot消息已撤回，cleanupMissing为空，自有primary连接关闭；尚未执行后续查询只读、安全重试和post-trigger unknown步骤。

源码定位：合同createManagedDriver直接订阅EventBridge的message，轮询不会加入该实时观察集合。BridgeMessageOps在真实原生确认后通过Vue会话-msg发布本机发送回显；T26切换后该通道仅转发撤回候选，普通出站回显不再进入EventBridge。因此不能以发送成功或轮询读到消息替代此项合同通过，也不能恢复普通Vue历史入站来掩盖问题。需要另行修复具有明确新旧代次边界的实时出站事件来源，再重新运行整套合同。本轮仅定位，未修改发送实现或放宽合同断言。

### PR269后续：从原生确认记录恢复实时出站回显

统一原生提交脚本在发送脚本开始时捕获EventBridge观察回调，早于图片预处理等await；取得confirmedMessage后才发布真实原生记录。EventBridge沿用已有代次封闭、会话规范化和消息去重，关闭时仅清理自己安装的观察回调。旧发送即使跨越换代后确认，也不能借用新连接回显。图片入口补传已有targetSes，其余原生发送入口继续共用同一提交脚本。未恢复Vue普通历史消息派发，未改变发送次数、确认预算、T21发送策略或App恢复账本。

新增4项受控回归：确认前不回显，确认后使用真实ID及正文并在调用返回前观察到一次outbound；原生及Vue重复来源不重复派发；发送ack失败、缺少确认记录均不伪造回显；发送预处理跨代次完成不污染新连接，旧实例关闭后新回显仍有效。修复前定向4项中2项失败、2项通过；修复后生命周期文件24项全通过。

实际执行：

```powershell
pnpm exec vitest run packages/driver/tests/event-bridge-lifecycle.test.ts --testNamePattern "回显|发送脚本"
pnpm exec prettier --write packages/driver/src/bridge/renderer-script.ts packages/driver/src/bridge/event-bridge.ts packages/driver/src/bridge/image-ops.ts packages/driver/tests/event-bridge-lifecycle.test.ts
pnpm exec vitest run packages/driver/tests/event-bridge-lifecycle.test.ts packages/driver/tests/native-media.test.ts packages/driver/tests/send-operation.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

相关3文件52项通过；完整根四项门禁通过，Driver347项、App405项，无lint错误或警告。语言服务查询引用时退出，随后按源码核对了全部5处原生提交调用；没有依赖语言服务的未验证重命名。审查后保留最小观察接入，无新增依赖、重试、兼容分支或通用框架。

上述证据为受控渲染环境执行实际注入与提交脚本，不是真机通过。本轮未操作KK9，也未修改整套合同脚本或放宽断言。仍需协调员工窗口，重跑既有整套Driver合同和员工侧原生撤回；post-trigger unknown必须由真实连接中断产生，不硬改状态或增加生产延时。此前真实合同仍是12/13失败，不能因本轮单元测试通过改记为通过。本地后续修复尚未提交推送，未合并或关闭issue。

### 原生出站回显修复后真机复验：回显通过，中断注入未产生unknown

用户授权开始真机测试后，只读确认登录UID5761，页面没有EventBridge清理Hook或原生发送观察回调占用。首次从仓库根使用node --import tsx启动，因tsx仅安装在Driver包目录而在加载脚本前失败，没有连接或发送；随后切换Driver包目录运行原有脚本：`node --env-file=../../.env --import tsx examples/e2e-stage1-contract.ts`。未修改脚本或断言。

真实员工入站136059371（0-3585、senderId3585）通过；Bot消息136059373返回delivered（606ms），EventBridge实时outbound回显及晚于员工入站的顺序均通过。双来源消息键、getSendStatus只读、同operationId重试不双发、不同内容复用被拒绝、无效目标pre-trigger failed均通过。unknown方向样本仍是脚本明示的controlled-real-payload-shape，不是真实未知方向消息。

后续post-trigger场景收到真实原生回显136059383，并调用Driver.disconnect，但发送结果已返回delivered（453ms），未产生预期unknown。脚本退出1，汇总23项、22项通过、1项失败；尚未执行unknown重连查询及其安全重试。专用清理连接回查并撤回136059383和136059373，cleanupMissing为空，所有本轮Driver连接关闭，未退出KK9。

时序依据：脚本在EventBridge回显中调用unknown.driver.disconnect；Driver委托EventBridge.closeOwnedResources，后者先await远端清理及Runtime.removeBinding，再关闭CDP。日志中delivered先于连接down，说明本次优雅关闭未截断发送响应，不能据此判定delivered本身错误。下一步建议仅修正测试故障注入：在已观察到本次真实原生回显后，直接断开测试实例自己的CDP连接，仍由原有发送实现处理连接错误并保持unknown断言；不硬改状态、不添加生产延时、不关闭KK9或其他连接。本轮仅取证，未实施该脚本调整。员工侧原生撤回亦未验证。

### 员工侧原生撤回真机通过

用户授权后，在Driver包目录执行一次性只监听探针：`node --env-file=../../.env live-employee-recall.mjs`。使用已构建的真实Driver，先核对Bot5761、员工3585、私聊0-3585/int2024以及无其他Driver Hook占用。探针只附加原生IPC和Vue来源观察，不伪造事件、不调用发送或撤回API。员工按提示发送“T26员工撤回验证”，确认入站messageId136060545后，再由员工本人在KK9执行撤回。

真实原生IPC/message收到1个撤回包：外层sessionID716791，session.type=0、typeID3585；撤回通知自身id136060597，正文为`{"event":"CancelMessage","msgID":136060545,"msgIdex":478,"byAdmin":0}`。Driver正确指向被撤回的136060545，而不是通知自身136060597，并解析为公开会话0-3585。

同一撤回随后经过Vue/0-3585-msg和Vue/receive-message两次真实转发。继续观察5秒，Driver对外recalled仅1次：messageId136060545、sessionId0-3585、sender3585。探针对裸Vue会话数组直接解析时记录的716791是未附加通道范围的原始诊断结果，不是Driver公开事件；生产路径保留通道的0-3585范围并正确去重。本轮证明真实原生通知、目标消息关联、公开会话编号和跨来源去重均通过，不再仅凭Bot自身撤回推断员工原生路径。

进程退出0，汇总passed=true、nativePackets=1、vuePackets=2、publicEvents=1、errors为空、sentByProbe=0、recalledByProbe=0。原始事件监听与Driver连接均已释放；随后只读检查真实页面，bridge=false、sender=false、probeKeys=[]，无本轮Hook残留。一次性探针运行后删除，KK9未退出。未修改生产代码或重跑根质量门禁；最近一次四项通过记录仍见前文。本项通过不代表整套Driver合同完成，post-trigger unknown故障注入及其后续重连查询仍待处理。

### 后续修复提交范围

用户授权提交代码并更新PR269。本次后续提交包含普通消息与撤回共用会话解析、渲染侧原始撤回转发、代次绑定的原生确认出站回显、图片会话传递，以及对应回归和上述真机证据。引用最近一次根四项门禁通过结果（Driver347、App405），不冒称本次提交动作重新运行过门禁。PR保持草稿：员工原生撤回与实时出站回显已有真机通过证据，但整套合同仍为22/23，post-trigger unknown故障注入及后续重连查询尚未完成；不合并或关闭issue。

### 整套合同故障注入调整：首轮等待入站超时

用户表示可以配合补齐必验场景后，仅将既有e2e-stage1-contract.ts的中断调用从unknown.driver.disconnect改为getCdp(unknown.driver).disconnect，并注明优雅关闭可能让发送确认先返回。该调用立即拒绝本测试连接的在途命令并终止其WebSocket；没有修改生产发送实现、状态账本、发送预算、断言或添加延时。后续仍要求unknown、重连查询同一原生消息delivered及相同operationId重试不双发。

只读预检确认Bot5761、bridge=false、sender=false。在Driver包目录执行`node --env-file=../../.env --import tsx examples/e2e-stage1-contract.ts`，真实连接、账号和目标会话检查及历史基线通过。120秒内未观察到符合条件的目标员工新入站，脚本退出1，汇总7项、6项通过、1项失败，cleanupMissing为空，primary已关闭。本轮未进入发送或post-trigger场景，不能称作unknown再次失败或已验证通过；不重放历史消息、不自动反复启动等待，需重新协调员工发送窗口。

随后实际执行`pnpm build && pnpm typecheck && pnpm test && pnpm lint`，全部通过（Driver29文件347项、App26文件405项）。此次仅测试入口中断方式改变，既有断言完整保留；该本地门禁结果不能替代尚未执行到的真机unknown路径。脚本和本段证据尚未提交推送。

### 整套Driver合同最终真机通过：27/27，退出0

用户重新确认准备就绪后，只读核对Bot5761、bridge=false、sender=false，再以相同命令运行修正中断方式后的既有合同。员工发送新消息136064571（0-3585、inbound、senderId3585）；普通Bot消息136064575真实delivered（692ms），实时outbound顺序、双来源消息键、查询只读、同operationId重试不双发、不同内容复用被拒绝及pre-trigger failed均通过。未知方向样本仍为脚本明示的controlled-real-payload-shape，不冒称真实未知方向消息。

本轮必验链路完整通过：

1. 在观察到本次真实原生发送回显后，直接断开本测试实例CDP，发送API返回unknown（446ms），success=false、isPreTrigger=false及operationId一致性断言通过；没有硬改状态或添加生产延时。
2. 新Driver连接重新核对Bot和员工会话，getSendStatus确认最终delivered，消息ID136064591与中断前原生回显相同。
3. 使用原operationId和同一正文重试，复用delivered及同一native messageId；真实历史中该测试正文仅1条，防双发通过。
4. 回查并撤回136064591和136064575，cleanupMissing为空，全部本轮Driver连接关闭。

实际汇总：total=27、passed=27、failed=0、failures=[]，进程退出0。结束后另作只读页面检查，bridge=false、sender=false，无本轮EventBridge和原生出站观察回调残留，未关闭KK9进程。此前6/7超时、12/13回显失败及22/23故障注入失败记录均保留，不改写为成功。

至此，既有整套Driver合同与员工侧原生撤回均有真机通过证据，之前T26剩余必验项已补齐。本次只修正测试故障注入，生产Driver逻辑与原有断言未改；最近一次根四项门禁为本次脚本调整后实际重跑通过（Driver347、App405），有效真机复验后未再改执行代码。此结论不代替T34跨进程故障矩阵或T35正式Agent整体放行。脚本调整和本轮证据尚未提交推送，未改变PR草稿状态、未合并或关闭issue。

### PR269审查修复：正常取消与锁后时间（2026-09-11）

本轮仅修改App监督器、取消账本接口/调用方及两份现有回归，不改Driver生产逻辑、数据库约束或任务预算。两个问题是受控组件/真实PG已复现缺陷，不代表已在真实KK9或正式业务入口观察到故障。

- 监督器消息消费与连接装配按同一代次signal确认正常取消，不将其加入永久failures；同步消息取消同样处理。无关业务/存储错误、disconnect与onInvalidate失败仍保留原传播及停止重连策略。主动close继续不重连。
- cancelUnfinished沿用任务模块number或时钟函数的既有约定，在context/task锁取得后只采样一次；正式cancelConnectionWork传Date.now函数，避免锁前时间早于竞争创建的user_wait。既有数字时间测试无需兼容包装；无表迁移、重试、错误吞噬或时间修饰。
- cancelUnfinished的LSP引用查询因服务器退出失败，随后限定apps/kairo搜索全部引用；正式调用仅recovery，其他为恢复账本测试，已核对。没有修改其他未提交真机脚本。

修复前后实际命令与结果：

```bash
pnpm --filter @kairo/app exec vitest run tests/unit/driver-supervisor.test.ts
pnpm --filter @kairo/app exec vitest run tests/unit/driver-supervisor.test.ts tests/unit/driver-supervisor-cdp.test.ts tests/unit/application-driver.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/recovery-store.test.ts
pnpm --filter @kairo/app test:integration -- tests/integration/recovery-store.test.ts tests/integration/recovery.test.ts tests/integration/new-context-concurrency.test.ts tests/integration/scheduler.test.ts
pnpm build && pnpm typecheck && pnpm test && pnpm lint
```

监督器新增4项：消息取消后新代可消费、装配取消后重连、取消后的无关错误仍阻止重连、主动close取消不重连。修复前17/20通过、3项因AbortError失败；修复后监督器/CDP/应用3文件48项通过。PG新增1项通过正式cancelConnectionWork触发等连接竞争，修复前14/15通过、1项返回23514；修复后相关4文件48项通过，等待与任务共同取消并沿用原上下文。

首轮根门禁build/typecheck/test通过，lint指出新增测试直接reject(signal.reason)的any类型；改用Node原生once与throwIfAborted保留原始取消原因，不关规则、不强转类型。随后完整重跑根四命令全部通过：Driver29文件347项，App26文件409项。最后一轮之后没有修改执行代码。

另在Driver目录实际执行临时入口：`pnpm --filter @kairo/driver exec tsx --env-file-if-exists=../../.env ../../apps/kairo/tmp/pr269-cancellation-smoke.mts`。本地.env不存在，测试库配置来自进程环境；只使用自建随机库。入口不运行Vitest，使用原生时钟、正式监督器/取消函数/调度器/Collector/发送服务/入站门禁与真实PG；Driver是明确测试替身，不执行Agent。旧消息消费被signal取消、取消等连接期间另一连接创建员工等待，最终任务与等待均取消，新Driver创建并接受新入站，旧代迟到消息未被采用。

首次烟测在前置造批次时用了早于入站observedAt的quietDeadline，触发message_batches约束，并未运行到修复路径；仅修正临时工装截止后重跑通过。成功输出created=2、taskStatus=cancelled、waitClosedAfterCreation=true、newIngressAccepted=true、oldMessageAccepted=false，退出0。探针文件已删除，随机库和连接均由工装关闭清理。

本次真机重连验证尚未执行，等待用户确认窗口与操作范围；此前Driver27/27记录不替代此次App取消修复的真机证据。拟仅断开本探针自有CDP、不终止KK9或其他进程，以真实新入站验证换代；任何发送/撤回均需授权。未提交推送、未修改PR状态、未关闭issue。

#### 真机取消修复验证首轮：入站等待超时

用户批准零发送/零撤回范围后，通过受监督进程执行`node --import ./packages/driver/node_modules/tsx/dist/loader.mjs apps/kairo/tmp/pr269-real-cancellation.mts`。初次启动因临时探针的CDP模块相对路径多一层而在导入阶段退出，未连接KK9；仅修正探针路径后启动成功。只读预检Bot5761且bridge/sender均false，真实Driver进一步核对员工3585、唯一私聊0-3585（int2024），代次614f5963-09db-499c-b710-bcb1af84ebf6。数据库使用本轮随机库kairo_t19_c2823bfa1cdd4f43845dac8f243bbeb8，连接PID44424/44425。

监听就绪后180秒内未观察到符合第一条标记“T26修复验证一”的目标员工新入站，因等待超时退出1；未进入计划中的断线/等锁竞争/自动重连验收，不据此判断修复失败或通过。退出收尾完成取消、释放本轮连接和随机库；独立只读核对Bot5761、bridge=false、sender=false。本轮没有发送、撤回消息或关闭KK9。临时真机探针保留待重新协调，不自动重启等待，不把历史消息补作新入站；生产代码未改。

#### 真机探针中断方式修正：主动关闭不等于意外断线

用户准备好后的下一轮收到真实新入站136072361，T22 accepted；原代次13c57572-d8f3-4bd6-8b8a-e419e78c4b64。探针随后调用CdpClient.disconnect()，该方法设置isIntentionallyClosed，WebSocket close回调因此不发connection_lost；探针又在等取消事务而未调用readStatus，15秒内没有进入目标取消竞争。此轮是测试故障注入错误，不是两处生产修复再次失败，不能把已主动关闭的CDP当作真实意外断线事件。

失败收尾还发现旧页面Hook未释放（bridge/sender=true），最终清理断言掩盖了等待超时主因。随后通过新的只读CDP连接，仅在cleanup.generationId精确等于该轮代次时调用原清理函数；实际返回bridge=false、sender=false，未触碰其他代次。临时探针改为记录主因，并在收尾时只清理本次创建代次留下的Hook；专用补清理入口已删除。

仅调整临时探针：直接terminate本实例当前持有的真实WebSocket，让现有CDP原生close→connection_lost→Driver health→监督器取消路径运行；不调用生产disconnect来模拟故障，不手工emit健康事件、不修改生产代码或验收断言。随后重新核对页面无占用并启动，通知用户发送新的第一条，不重放136072361。

#### 真机取消修复最终通过：退出0，零发送、零撤回

同一受监督命令运行修正探针，Bot5761、员工3585、唯一私聊0-3585（int2024）在两代连接均实际核验。使用真实KK9Driver、正式监督器/取消函数/任务账本/入站门禁、正式Scheduler和Collector关闭入口，以及随机PostgreSQL库kairo_t19_aa663b49c7db482b92048e8725bf4c10（连接PID44481/44482）。未运行FakeDriver或正式Agent；任务领取、尝试完成与进入员工等待由探针推进，不冒充模型执行。发送边界拒绝任何意外发送，实际sendAttempts=0；没有撤回调用。

| 验收步骤 | 实际结果 |
| --- | --- |
| 第一条真实新入站 | 136072661，0-3585，T22 accepted；旧代81d690a7-0336-456f-a5b8-fc25bb026eff |
| 真实连接中断 | 只terminate探针旧WebSocket；收到真实失效事件，generation.signal取消，旧消费者以标准AbortError退出 |
| 取消与员工等待竞争 | poolA取消等连接期间，由poolB创建等待；createdAt=1789093377887，closedAt=1789093377893，取消成功而非23514 |
| 旧账本收尾 | 任务42562d0e-c317-493a-8b4b-c2df5e57b5be为cancelled，员工等待resolution=cancelled |
| 自动重连 | 创建新Driver，代次1bfa027b-0f91-449b-b050-9762db246803；身份与健康就绪后开放消息，Driver累计创建2次 |
| 第二条真实新入站 | 用户按重连就绪提示发送136072751，0-3585，T22 accepted，确由新代接收 |
| 副作用与清理 | sendAttempts=0、recallAttempts=0；关闭自有连接、随机库与池，最终独立页面核验Bot5761、bridge=false、sender=false |

监督进程pr269-real-cancel最终exit=0。真实首条处理取消后没有继续执行业务，原任务没有复活；新代收到的是用户随后发送的新消息，不是历史补偿。本轮没有额外发送断线期间消息，因此不把它计作新的“断线历史不补做”专项；也不证明正式Agent、实际出站、T34跨进程或T35完整链路。

真机期间只改临时故障注入与清理，生产修复和永久回归未改；最近一次根四项门禁仍为前述实际通过的Driver347/App409，不声称真机结束后又重跑。临时真机入口与补清理入口均已删除，未提交推送、未修改PR草稿状态、未合并或关闭issue。

## T28 唯一 Mastra Agent 装配（2026-09-11）

### 可调用入口与业务边界

`mastra/index.ts::createKairoMastra({ config, customization, databaseUrl, logger })` 复用现有进程内运行时，只注册 `kairo` 一个 Agent；配置和定制内容由现有加载器提供。`mastra/agent.ts::createKairoAgent()` 使用 YAML 唯一模型与既有 `KAIRO_T12_MODEL_API_KEY`，主 Agent 与 T12 Memory 的 Observer/Reflector 共用同一个 `ModelRouterLanguageModel`。没有备用模型、第二个结构化 Agent、Workspace、Sandbox 或新的服务端执行路由。

`modules/agent-runtime/run-agent.ts::runAgent(agent, input, dependencies)` 的输入直接复用 T25 TaskExecutor 的 task/attempt/context/signal 形状，依赖注入现有 chat/knowledge/tasks、真实 bootId、已加载配置及日志。它读取原始批次正文，以 Mastra 原生 RequestContext 隔离每次执行的知识 Tool，不在共享 Agent 上改写当前 task。只允许 YAML 中的 `knowledge-search` 和原生 filesystem Skills，Dataset 来自配置，检索环境复用 `loadRetrievalSettings()`。

调用使用非流式 `generate()`：`runId=attempt.attemptId`、`resource=task.employeeId`、`thread=context.threadId`、`memory.options.readOnly=true`。T25 已有的独立日志 runId 保持不变，不创建新标识。只读执行可能建立空 thread 元数据，但本轮输入、草稿与 Tool 正文不写正式 Memory，不调用 delivered commit。

整个生成与全部 Tool 使用原任务绝对 executionDeadline 和 task AbortSignal；maxSteps 只取 YAML 循环边界，不限制知识查询次数。成功、失败、取消均等待 `binding.settled()`，确保实际 Python 与证据事务收尾。知识账本新增 `getLastCallIndex(taskId)`，从既有最大调用序号继续；调用方仍须遵守 T25 同 task 独占、旧执行真实 settled 后再开始下一 attempt 的合同，不另建并发或恢复接口。

`answer-schema.ts` 严格分开 answer、六类 answerType、evidenceIds、subQuestions 和 diagnostics。默认先检索规则属于最高服务端执行指令，明确要求通用知识才可跳过。结构化输出使用原生 `structuredOutput.schema` 与 strict 错误策略，不提供 model、fallbackValue 或自动参数切换。合法 JSON 仍须来自正常完成的 `finishReason=stop`；循环耗尽、截断、缺失或非法结构不能伪装成功。

该结果尚未经过 T29 业务检查，不能直接作为 TaskExecutor 的已检查 answer 交给发送器。T28 不执行 IM 发送、结果采用、状态转换、员工确认、反馈或 Memory commit；T25/T26 继续拥有取消和迟到结果门禁。`createKairoMastra.close()` 只关闭自身 Memory/运行时；调用方须先取消并等待自己启动的普通 Agent 执行。正式 `startKairo()` 和 Studio 业务装配保持原状，T33 后续才接整体流程。

### 实际执行命令

以下命令均从仓库根目录执行。数据库由既有 `createTaskTestDatabase()` 创建并迁移随机临时库；不迁移 `.env` 中的配置库，不强制断开其他连接。

```powershell
pnpm --filter @kairo/app test:integration -- tests/integration/agent-runtime.test.ts
pnpm --filter @kairo/app typecheck
pnpm --filter @kairo/app build
pnpm build && pnpm typecheck && pnpm test && pnpm lint
node packages/driver/node_modules/tsx/dist/cli.mjs --env-file=.env apps/kairo/scripts/verify-agent-runtime.ts
```

另在该命令的进程环境显式设 `KAIRO_T12_REAL_MODEL=0`，执行相关集成；这是确定性 Memory 模型回归，不是重新放行 T12 真实模型：

```powershell
pnpm --filter @kairo/app test:integration -- tests/integration/knowledge-record-store.test.ts tests/integration/ragflow-connector.test.ts tests/integration/bot-customization.test.ts tests/integration/mastra-delayed-memory.spike.test.ts tests/integration/mastra-route-isolation.spike.test.ts
```

最终 Agent 定向 **15/15**、相关集成 **5 文件 33/33** 通过；根 build/typecheck/test/lint 全部通过，无 lint 错误或警告。根默认测试为 Driver **347**、App **409**，不包含上述集成测试。生产 Driver 未改，没有连接或操作真实 KK9。

### 受控故障与审查修复

- 真实 Mastra/Skills/Tool/Python/PostgreSQL 配合确定性模型和回环 HTTP，覆盖企业检索、通用零查询、未注册 Dataset 修改工具、非批准 Dataset 参数、非法 schema、旧 Memory 召回但草稿不写、Agent 请求取消、Python 挂起取消、新 attempt 序号延续及不同员工交错执行不串资料。
- 多查询场景将隔离测试执行预算设为 8 秒：第一查询成功，第二查询收到受控 503 后重试并挂起，实际在原 deadline 结束，重试未获新预算；退出前各 Python PID 均已不存在。这证明同一绝对截止贯穿 Agent/多查询/重试，不声称本次受控用例实际等待了四分钟。正式配置仍为 240000ms。
- 初轮集成 7/12，失败来自测试错误地要求只读不创建空 thread、OM 记录初始化遗漏以及把标准取消异常固定为 AppError；按 T12/T25 合同修正后 12/12。新增循环耗尽与知识落账失败回归后 14/14；未压制异常、清空 Memory 或放宽 schema。
- 独立审查发现合法 JSON 草稿可与最后工具回合同时返回，原校验会假成功。先运行 `--testNamePattern=循环边界` 实际复现失败，再增加正常 finishReason 检查；最终完整 15/15 通过。回归允许第二回合产生合法答案并核对实际只调用一次，避免受控模型缺少下一回合所制造的假阳性。
- 测试失败清理改为先取消并等待自己启动的全部 Agent，再关闭运行时/HTTP 和恢复 mock。新增“首个 Python 挂起、第二任务失败”的实际进程回归，确认关闭存储前取消账本完整且 PID 已退出。
- 初次构建发现动态工具返回类型和 nullable deadline 闭包问题；初次根质量链的 build/typecheck/test 通过，但 lint 报测试冗余 async、拒绝值类型及工具返回注解问题。已最小修正，并完整重跑根四项命令通过。

### 最终源码的真实模型、Python、ERP 证据

最终正常完成检查落地后，完整四场景再次执行，脚本 **退出 0，总耗时 41.12 秒**。唯一模型为 `openai/gemini-3.7-flash-high`，地址与正式 YAML 一致；没有模型替身、伪装请求头或参数回退。下表是第二轮最终源码结果，不复用首轮 62.21 秒的通过记录：

| 场景 | 模型结果与实际链路 | 耗时 |
| --- | --- | --- |
| 企业采购问题 | enterprise；1 次真实检索 found；Python PID 228472，退出码 0；证据关联通过 | 11059ms |
| 明确通用知识 | general；0 次检索、无企业证据引用 | 5132ms |
| 多子问题分别检索 | enterprise；2 次不同检索均 found；Python PID 224440、104420，退出码均 0；各子问题使用不同查询的实际证据 | 14079ms |
| 自然语言读者体验 | general；原生 skill 实际加载 reader-sim，正文出现在后续模型上下文；0 次企业检索 | 8485ms |

本轮随机库为 `kairo_t19_a68dc194197549718ee5ea3cefc96644`，隔离连接 PID 44817/44818，结束时按工装正常关闭并删除自身库。最后受控集成库为 `kairo_t19_15c4c916aa6b4f0fbacebbb1ac3677d2`，同样正常收尾。脚本只输出场景、模型、类型、耗时、查询/Python/工具及断言摘要；普通日志不含凭证、员工正文或知识片段。

这些证据证明本轮样例的真实模型选择、工具链和结构合同，不代替 T29 语义/业务证据检查、T30 确认、T32 delivered 后提交或 T33/T35 完整 IM 链路。没有修改正式 YAML、数据库迁移或其他工作区，没有临时探针遗留；保留独立真实验收脚本以便模型变更后重跑。未合并分支、未关闭 issue。

框架依据：[非流式 generate](https://mastra.ai/reference/agents/generate)、[结构化输出与工具共存](https://mastra.ai/docs/agents/structured-output)、[工具接口](https://mastra.ai/docs/agents/tools)、[Mastra 实例注册](https://mastra.ai/reference/core/mastra-class)；以锁定类型和上述实际运行结果为准。
