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

`startKairo()` 先加载并校验受控 Bot 配置、读取 Git commit，再创建进程内 Mastra、PostgreSQL storage 和应用拥有的真实 `KK9Driver`。默认先监听 `127.0.0.1:4110`，再连接 Driver。T17 提供 `GET /health/live`、`GET /health/ready`、`GET /health/dependencies` 三个只读接口，其他路径和方法均返回 404，包括 Mastra Agent、Tool、Workflow 执行接口。存活不等于业务就绪，状态来源和判定见下文 T17；当前不装配 T28 的业务 Agent。

收到 Ctrl+C 或 SIGTERM 后依次关闭健康端口、应用自己的 Driver、Mastra；某个资源关闭失败不阻止其余资源回收，错误仍向调用者传播。锁定的 `@mastra/core@1.63.2` 会在 shutdown 内关闭注册的 storage，不再重复调用 `storage.close()`。程序内调用方使用返回的 `close()`，重复或并发关闭共用同一个 Promise。

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

正式入口默认创建并连接真实 Driver，沿用 `CDP_URL`（默认 `http://127.0.0.1:9222`）和 `PAGE_MATCH`（默认 `renderer.html`），只接受回环 CDP 地址；不启动或重启 KK9。Driver 健康要求 CDP connected、EventBridge attached、连接身份属于本启动代次且连接 ID 一致。关键 health/error 事件后该实例保持 down，不原地重连或后台重试；重启应用创建新实例。初次连接失败仍提供 live 和依赖诊断，ready 为 503。模型和 RAGFlow 未装配时仍为 unknown；核心正常则 degraded/200，不伪报六项全部正常。

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
