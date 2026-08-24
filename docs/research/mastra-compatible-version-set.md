# Mastra 兼容版本组研究

> **状态：候选 A/B 已完成隔离验证；当前无可锁定兼容版本组。**
>
> 本文区分两类证据：
>
> - **静态证据**：npm 官方元数据、已安装包的 `package.json`/类型声明、Mastra 公开源码与官方文档；用于证明版本、依赖和公开 API 形状。
> - **运行证据**：固定 lockfile、Node.js `22.13.1`/`24.14.0`、临时 LibSQL 文件、受控假模型/工具与独立进程实验；只证明本文记录的精确候选与动作。
>
> 总规格要求 Node.js `>=22.13`，并把 Tool Approval 的 suspended discovery、权威终态、条件决议和重复/相反/deadline 竞态列为独立能力门。任一门失败即不得锁版。[S30][S31]

## 0. 结论摘要

1. **候选 A**：`@mastra/core@1.60.0`、`@mastra/memory@1.27.0`、`@mastra/libsql@1.21.0`、`@mastra/observability@1.17.1`、`@mastra/mcp@1.17.1`、`zod@4.4.3`、`@modelcontextprotocol/sdk@1.30.0`。[S1][S2][S3][S4][S10][S11]
2. **候选 B**：`@mastra/core@1.61.0`、`@mastra/memory@1.27.0`、`@mastra/libsql@1.21.1`，其余版本与候选 A 相同。[S6][S7][S8][S9][S10][S11]
3. 两组 Core 内部均精确声明 AI SDK provider alias `2.0.3/3.0.14/4.0.4` 与 provider-utils alias `3.0.30/4.0.40/5.0.13`；外部 `ai`/Provider 不是 Core、Memory、LibSQL 的 runtime dependency，不能凭 registry latest 擅自加入兼容组。[S5][S12][S33]
4. 两组都在 Node.js `22.13.1` 与 `24.14.0` 完成冻结安装、TypeScript `5.9.3` 类型检查与最小构建；动态 model fallback、Memory `readOnly`/同 ID 重放、Storage `init/close`、跨进程 suspended discovery、跨进程 Workflow snapshot/resume、Schedule 持久化、Observability `flush/shutdown`、基础 Processors、MCP stdio discovery/disconnect 均得到通过观察。
5. **兼容门失败**：公开 Agent API 没有按 `runId + toolCallId` 读取 approved/declined/deadline 权威终态的入口；`approveToolCall`/`declineToolCall` 没有 expected state、version、deadline、CAS token 或幂等键；并发批准/拒绝实测一方成功、一方失败，且 Core `1.61.0` 直接警告 running snapshot 不持久化、并发 `resume()` 不能去重、下游步骤可能重复执行。Schedule 的同一 fire 跨实例唯一消费也未被公开手动 `run()` 竞争证明。
6. 因此 **候选 A、候选 B 都不能锁定为兼容版本组**。最小重裁点是：按 #117 决定是否把高危 Tool/HITL 及依赖其 exactly-once 的主动 Schedule 从当前交付范围移出；若这些能力继续保留，则必须更换能原生满足权威终态与条件决议的运行时/版本，不能在 KKBot 内补 Projection CAS、Outbox 或本地 Approval Runtime。

## 1. 范围、判定规则与证据限制

### 1.1 范围

本研究覆盖：

- `@mastra/core`、`@mastra/memory`、`@mastra/libsql`；
- Zod 与 Core 内部实际声明的 AI SDK provider/provider-utils 版本；
- 为 Observability 与 MCP 实验可能需要的 `@mastra/observability`、`@mastra/mcp`；
- 动态 model retries、Memory `readOnly`/稳定消息 ID、Storage 初始化/关闭、Tool Approval、Workflow snapshot/resume、Schedule、Observability flush/shutdown、Processors、MCP。

本文不研究业务 Store schema、KK Delivery 投影、Provider 账号可用性、真实模型质量或生产压力容量；这些只能作为实验夹具或外部前置条件。

### 1.2 兼容判定规则

候选组只有同时满足以下条件，才可被主代理改写为“兼容”：

1. 所需原生 API 在**同一组精确版本**的受支持公开入口中存在；
2. 所有包的 `engines`、peer 和关键运行依赖覆盖 Node.js `>=22.13`；
3. 类型/源码与官方文档没有冲突；
4. 第 4 节实验在隔离临时目录、固定依赖、持久 LibSQL 文件、多进程/重启场景下全部达到观察标准；
5. Tool Approval 的任一门槛失败时，不得用 KKBot Projection CAS、Outbox 重放或本地 Approval Runtime 补齐缺口。

### 1.3 公开源码版本限制

npm 1.60.0/1.21.0/1.27.0 包的官方 registry 元数据可精确确认版本、导出入口、engines、peer 和 dependencies。尝试以 `v1.60.0` 或 `v1.17.1` 作为 GitHub 版本 tag 读取对应源码时返回 HTTP 404；因此本文的源码链接使用 Mastra 公开仓库当前 `main` 路径，**不能把 `main` 的当前内容当成 npm 1.60.0 的逐行版本证明**。精确版本证据以对应 npm registry JSON 与工作区 lockfile 为准；源码链接只用于确认公开 API/实现形状。[S1][S2][S3][S10][S11]

## 2. 精确候选版本与依赖约束

### 2.1 候选 A：工作区可复现实验基线

以下版本来自仓库 `pnpm-lock.yaml` 的 importer/解析结果；候选 A 是主代理最容易重建的第一组实验输入。[S5]

| 包 | 精确版本 | `engines` | peer 约束 | 关键运行依赖/声明 | 静态状态 |
|---|---:|---|---|---|---|
| `@mastra/core` | `1.60.0` | `node >=22.13.0` | `zod ^3.25.0 || ^4.0.0` | 内置三代 AI SDK provider/provider-utils 别名；`@mastra/schema-compat 1.3.7`；`@modelcontextprotocol/server 2.0.0` | 已实验，不兼容 |
| `@mastra/memory` | `1.27.0` | `node >=22.13.0` | `@mastra/core >=1.4.1-0 <2.0.0-0` | `zod ^4.4.3`、`@mastra/schema-compat 1.3.7`、`diff ^8.0.3`、`tokenx ^1.3.0` 等 | 已实验 |
| `@mastra/libsql` | `1.21.0` | `node >=22.13.0` | `@mastra/core >=1.51.0-0 <2.0.0-0` | `@libsql/client ^0.17.4` | 已实验 |
| `zod` | `4.4.3` | 元数据未声明 `engines` | 无需 peer | 提供 v3/v4 导出；Memory 运行依赖要求 `^4.4.3` | 已实验 |
| `@ai-sdk/provider`（Core alias v5/v6/v7） | `2.0.3 / 3.0.14 / 4.0.4` | lockfile 分别记录 `>=18 / >=18 / >=22` | 以各包 metadata 为准 | 由 Core alias 引用，不应被业务代码任意替换 | 依赖事实 |
| `@ai-sdk/provider-utils`（Core alias v5/v6/v7） | `3.0.30 / 4.0.40 / 5.0.13` | lockfile 分别记录 `>=18 / >=18 / >=22` | `3.0.30` 的 npm metadata 为 `zod ^3.25.76 || ^4.1.8` | 分别绑定 provider `2.0.3 / 3.0.14 / 4.0.4` | 依赖事实 |

Core 的 package declaration 将上述 alias 固定为：`@ai-sdk/provider-v5: npm:@ai-sdk/provider@2.0.3`、`provider-v6: 3.0.14`、`provider-v7: 4.0.4`；provider-utils 对应 `3.0.30/4.0.40/5.0.13`。其中 `@ai-sdk/provider-utils@3.0.30` 的 peer Zod 范围包含工作区的 `4.4.3`。[S5][S12]

**外部 `ai` 包不是 Core/Memory/LibSQL 的 runtime dependency 或 peer。** `ai@7.0.77` 是当前 registry latest，但不能仅凭 latest 标签把它加入候选组；如果实验夹具选择直接调用 Vercel AI SDK，必须在实验记录中另行锁定精确 `ai`/Provider 版本并核对其 peer，本文不预先承诺。[S27]

### 2.2 候选 B：当前 npm registry 候选

| 包 | registry 当前精确版本 | `engines`/peer 观察 | 与候选 A 的关系 |
|---|---:|---|---|
| `@mastra/core` | `1.61.0` | `node >=22.13.0`；peer Zod `^3.25.0 || ^4.0.0` | 已实验，不兼容 |
| `@mastra/memory` | `1.27.0` | `node >=22.13.0`；peer Core `>=1.4.1-0 <2.0.0-0` | 与候选 A 相同，已实验 |
| `@mastra/libsql` | `1.21.1` | `node >=22.13.0`；peer Core `>=1.51.0-0 <2.0.0-0`；`@libsql/client ^0.17.4` | 已实验 |
| `zod` | `4.4.3` | npm latest 仍为 `4.4.3` | 与候选 A 相同，已实验 |
| `@mastra/observability` | `1.17.1` | `node >=22.13.0`；peer Core `>=1.16.0-0 <2.0.0-0`、Zod `^3.25.0 || ^4.0.0` | 已纳入两组实验 |
| `@mastra/mcp` | `1.17.1` | `node >=22.13.0`；peer Core `>=1.0.0-0 <2.0.0-0`；runtime 依赖含 MCP SDK 1.x/2.x 组件 | 已纳入两组实验 |

候选 B 不是因为 registry latest 而获得优先权；它与候选 A 在双 Node 运行矩阵中出现相同 Approval 门失败，不能称为兼容。

### 2.3 Observability 与 MCP 的包边界

- Core 的 `Config.observability` 类型要求传入 `ObservabilityEntrypoint`；官方 Core 源码示例明确从 `@mastra/observability` 导入 `Observability`/exporter。Core 本身提供接口和 no-op 实现，不等于已安装真实 exporter。[S18][S26]
- MCP Client/Server 的官方安装入口是独立 `@mastra/mcp`，而不是仅安装 Core；`@mastra/mcp@1.17.1` 的 runtime dependency 包括 `@modelcontextprotocol/sdk ^1.29.0`、`@modelcontextprotocol/core 2.0.0`、`@modelcontextprotocol/node 2.0.0`、`@modelcontextprotocol/client 2.0.0`、`@modelcontextprotocol/server 2.0.0`、`@modelcontextprotocol/ext-apps ^1.7.1` 等。当前工作区的 `@modelcontextprotocol/sdk 1.30.0` 不能替代这些包的完整依赖组。[S11][S21]
- `@mastra/mcp` 的 `ai ^5.0.221` 出现在其 devDependencies，不是该包声明给消费者的 runtime dependency；不能据此把 `ai@5.0.221` 当成 KKBot 的固定运行依赖。[S11]

## 3. 各核心契约的静态证据与未知项

### 3.1 动态 model retries / fallback

**静态证据**

- Core 类型导出 `ModelWithRetries`：`id?`、`model`、`maxRetries?`、`enabled?`、`modelSettings?`、`providerOptions?`、`headers?`。[S13]
- `AgentConfig.model` 的类型是 `DynamicArgument<MastraModelConfig | ModelWithRetries[], TRequestContext>`；公开类型示例包含从 `RequestContext` 读取 tier 并返回 fallback 数组的写法。[S13]
- Core Agent 实现有模型选择解析、fallback 数组归一化和 `maxRetries` 字段；这证明公开实现表面存在，不证明实际错误分类、计数和跨模型切换顺序。[S14]

**不能静态承诺**

- 每个候选模型的 retry 次数是否严格按该 entry 的 `maxRetries` 执行；
- retry 与 fallback 的先后、可重试错误分类、abort 传播；
- 动态 resolver 在一次 run 中的调用次数，以及模型失败后是否重新读取/改变 tier；
- fallback 后的 Trace/Usage 是否能准确归因到实际模型。

**最小实验见 M-01。**

### 3.2 Memory `readOnly`、`saveMessages` 与稳定 ID

**静态证据**

- Memory `options.readOnly` 的官方定义是：读取 Memory 但不保存新消息，并以只读形式提供 working memory，不注册更新 working memory 的工具。[S15]
- `Memory.saveMessages({ messages, memoryConfig?, observabilityContext? })` 是公开方法；公开源码先过滤 system/transient 消息，再将消息交给 storage `saveMessages`。MessageList 转换过程中会保留输入消息的 ID，缺失 ID 才由 Memory 自己的生成器补齐。[S16]
- Core Agent 的收尾路径在 `readOnlyMemory` 时跳过新线程写回和消息保存；因此本项目的“本轮 Agent 只读、调用前显式保存 user message、sent 后显式保存 assistant message”可以用公开接口表达，但交付协议本身不是 Mastra 的自动保证。[S14][S16]
- Storage 官方 schema 将 message `id` 定义为主键；Memory 官方文档说明 `readOnly` 是“不保存新消息”的表面。[S17][S15]

**不能静态承诺**

- 同一稳定 ID 重复 `saveMessages` 是幂等 upsert、冲突报错还是产生其他结果；
- 同一 ID 的串行、并发、跨进程、重启重放语义；
- save queue、向量 embedding、Observational Memory 后台工作完成前关闭 Storage 是否会丢写；`Memory.settled()` 只声明为后台工作 join 点，具体组合仍需实验；
- `readOnly` 是否覆盖所有本轮 Processor、tool result、working-memory、Observational Memory 写路径。

**最小实验见 M-02。**

### 3.3 Storage init / close

**静态证据**

- `MastraCompositeStore` 公开 `getStore()`、`init(): Promise<void>`、`close(): Promise<void>`；`disableInit` 为 true 时必须显式调用 `storage.init()`。[S18]
- LibSQL 官方源码创建一个 `@libsql/client` Client，为多个 domain 建立 Store；公开配置含 `maxRetries`、`initialBackoffMs`、本地 WAL/busy timeout 选项，并由 `init()` 初始化 domain、`close()` 关闭底层 Client。[S19]
- LibSQL 官方文档说明：Storage 传给 `new Mastra()` 时会自动 init；直接使用 Storage 时必须显式 `await storage.init()`。[S20]
- 当前公开 Core `Mastra.shutdown()` 的源码顺序为：停止 workers/后台任务并等待 durable 执行，关闭 Storage，然后调用 `observability.shutdown()`；这是当前 `main` 的实现观察，不是候选 1.60.0 的版本承诺。[S18][S24]

**不能静态承诺**

- 候选 A 的 `init()` 并发调用是否完全合并、重复 init 是否无副作用；
- 两个 Client 共享同一 SQLite 文件时 WAL、busy timeout、事务创建新连接及 `SQLITE_BUSY` 的实际行为；
- `close()` 是否等待 Memory/Observation/Vector 后台任务；
- exporter 需要 Storage 时，`Mastra.shutdown()` 的 Storage-close/Observability-shutdown 顺序是否满足本项目；
- 初始化失败后的部分 domain、重试与诊断状态。

**最小实验见 S-01。**

### 3.4 Tool Approval：suspended discovery、权威状态、条件决议、重复竞态

**静态证据**

- 官方 HITL 文档支持工具级 `requireApproval: true` 和请求级 `requireToolApproval: true`；stream 会发出 `tool-call-approval`，包含 `toolCallId`、工具名和参数。[S21]
- Core Agent 提供 `listSuspendedRuns(options?)`，返回 `runId`、`status: 'suspended'`、线程/资源和 `toolCalls`；公开文档明确它从持久 workflow snapshot storage 发现，可跨进程重启和多实例使用。[S14][S21]
- `approveToolCall({ runId, toolCallId? })` 与 `declineToolCall({ runId, toolCallId?, reason? })` 是公开入口；当前实现将批准/拒绝转为 `resumeStream({ approved: true/false })`。[S14]
- `toolCallId` 可选；官方文档要求存在多个挂起调用时传入它。官方示例还展示了基于工具名/参数的条件 `requireToolApproval`，以及把工具名、参数做 fingerprint 的应用层绑定。[S21]
- Agent snapshot 是等待输入时的最小恢复材料，终态完成后会删除；对话历史和 Trace 分别由 Memory/Observability 持有。[S21]

**静态未知/失败项（不能写成兼容）**

- 没有发现公开的 `getApprovalState(runId, toolCallId)` 权威读取 API；`listSuspendedRuns` 只给 suspended run/toolCalls，不给 approved/declined/deadline 的持久终态。
- `approveToolCall`/`declineToolCall` 的公开签名没有 `expectedState`、版本号、deadline、CAS token 或条件决议参数；不能静态证明“仅当 pending 才接受”或“已终态与新决议冲突时拒绝”。
- 没有发现公开契约保证相同批准、相反决议、批准/拒绝/deadline 并发时只形成一个终态，也没有发现原 Tool 最多执行一次的跨进程保证。
- 官方文档中的参数 fingerprint 是应用层示例，不是 Mastra 持久 Approval 状态机或原子条件决议合同；不能把它当作 KKBot 的权威状态源。

**最小实验见 A-01 至 A-06。任一门槛失败都应保持“未知/失败”，不得自行补 Runtime。**

### 3.5 Workflow snapshot / resume

**静态证据**

- `WorkflowsStorage` 公开 `persistWorkflowSnapshot`、`loadWorkflowSnapshot`、`updateWorkflowState`、`listWorkflowRuns`、`getWorkflowRunById`、`deleteWorkflowRunById`；另有 `supportsConcurrentUpdates()` 能力声明。[S22]
- 官方文档说明 `suspend()` 会保存 snapshot，`resume()` 会按 workflow/run/step 读取 snapshot 并继续；快照跨部署/重启持久化，恢复数据按 `resumeSchema` 校验。[S23]
- LibSQL Store 导出 workflows domain，官方 storage schema 将 workflow snapshot 作为序列化状态保存。[S19][S18]

**不能静态承诺**

- 跨进程并发 resume 的唯一赢家、重复 resume 是否幂等；
- snapshot 中 request context、工具参数、外部句柄的可序列化边界；
- Storage 关闭/重启窗口内 snapshot 是否完整落盘；
- 业务 Tool side effect 与 Workflow resume 的 exactly-once 关系。

**最小实验见 W-01。**

### 3.6 Schedule

**静态证据**

- 官方文档标记 Agent/Workflow Schedule 自 `@mastra/core@1.50.0` 添加，且仍标为 Beta；Schedule 需要实现 `schedules` domain 的 Storage，并持久化以跨重启/重新部署。[S24]
- `mastra.schedules` 是 canonical CRUD 表面，公开 `create/get/list/update/delete/pause/resume/run`；Schedule 类型区分 agent 与 workflow target，并支持 JSON-safe 的 threaded signal 选项。[S25]
- threaded agent schedule 要求 `threadId` 与 `resourceId` 一起存在；无 thread 时是独立 `agent.generate()` 运行。[S24]

**不能静态承诺**

- 多 worker/多进程在同一 fire 上是否严格只触发一次；
- 重启时 nextFireAt、claim、时区边界、手动 `run()` 与 cron fire 的重复关系；
- `onFinish/onError/onAbort` 与 Agent/Delivery 结果的顺序和失败补偿；
- schedule fired 的 Tool Approval/unknown Delivery 是否会自动重发。

**最小实验见 C-01。**

### 3.7 Observability flush / shutdown

**静态证据**

- Core `ObservabilityEventBus` 公开 `flush()`（清空缓冲事件）和 `shutdown()`（关闭 bus/释放资源）；`ObservabilityInstance` 同样公开 `flush()` 与 `shutdown()`，并明确 flush 不释放资源、不阻止后续 tracing。[S26]
- `@mastra/observability@1.17.1` 的 npm metadata 要求 Node `>=22.13.0`，peer Core `>=1.16.0-0 <2.0.0-0`、Zod `^3.25.0 || ^4.0.0`。[S10]
- 当前 Core `Mastra.shutdown()` 源码在关闭 Storage 后调用 observability shutdown；候选组必须验证 exporter 真实实现，而不能只依据 no-op 接口。[S18][S26]

**不能静态承诺**

- `flush()` resolve 是否意味着所有 exporter 都已持久化；
- 某 exporter 失败时 flush/shutdown 的聚合错误、重试、超时和可诊断日志；
- MastraStorageExporter 在 Storage close 前后的写入顺序；
- 同一 Observability 实例重复 flush/shutdown、shutdown 后继续 emit 的行为。

**最小实验见 O-01。**

### 3.8 Processors

**静态证据**

- 官方 Processor 接口允许 `processInput`、`processInputStep`、`processLLMRequest`、`processLLMResponse`、`processAPIError`、`processOutputStream`、`processOutputStep`、`processToolResult`、`processOutputResult` 等阶段方法。[S27]
- 官方文档给出顺序：输入一次、每个 agentic step 的 input step、LLM request、LLM response、output step、tool result、最终 output result；`processOutputStream` 逐 chunk 运行。[S27]
- Core Agent 配置有 `maxProcessorRetries`；Processor context 有 `retryCount`；`processAPIError` 返回 `{ retry: boolean }`，`abort({ retry: true })` 可要求带反馈重试。[S28]

**不能静态承诺**

- Memory 自动 Processor、Agent 级 Processor、per-call Processor、Processor Workflow 的最终合并顺序；
- 输入/输出 retry 与模型 retry 的计数边界；
- Processor 修改后的 messageList 是否按项目要求保存、readOnly 时是否完全不写；
- stream chunk 被过滤、abort 或 retry 时的 Trace/Usage/工具执行状态。

**最小实验见 P-01。**

### 3.9 MCP

**静态证据**

- `@mastra/mcp` 官方文档提供 `MCPClient({ id?, servers, timeout? })`，支持 stdio、Streamable HTTP/SSE，`listTools()`、`listToolsets()`、`listToolsWithErrors()`、`disconnect()`；工具名按 server 命名空间化，工具发现可返回 per-server errors/durations。[S11][S21]
- MCP Client 支持 `requireToolApproval` 布尔或函数，函数可读取工具名、参数、request context 和 annotations；官方安全说明把第三方 annotations 标为不可信提示。[S21]
- Core 的 `MCPServerBase` 公开 `startStdio`、`startSSE`、`startHonoSSE`、`startHTTP`、`close`、工具列表与工具执行抽象；Core `Mastra` 可注册/列出 MCP Server。[S29]

**不能静态承诺**

- MCP Client 是由唯一 Composition Root 长期持有还是每请求创建；
- disconnect 与 in-flight tool call、reconnect、tool list changed 的竞态；
- 一个 MCP server 发现失败时是否阻断 Agent、是否只保留其他 server 工具；
- MCP Tool Approval 与普通 Tool Approval 的 suspended discovery、终态和重复竞态是否完全相同；
- 外部 server instruction、tool result、annotations 经 Processors 后的最终安全边界。

**最小实验见 X-01。**

## 4. 隔离实验、精确命令与结果

### 4.1 隔离环境

| 项目 | 精确值 |
|---|---|
| 工作目录 | `C:/Users/dongshilin/AppData/Local/Temp/kkbot-mastra-131.0YtWNn` |
| 包管理器 | `pnpm@10.30.0`，通过仓库已安装 CLI 执行 |
| 最低 Node | 本地隔离包 `node@22.13.1`，二进制 `node_modules/node/bin/node.exe` |
| 生产 LTS | 系统只读调用 `C:/Program Files/nodejs/node.exe`，版本 `24.14.0` |
| TypeScript | `5.9.3`；`@types/node@22.19.8` |
| 测试壳 | `vitest@3.2.7`；只因 Mastra 公开 mock 入口运行时依赖 Vitest worker context |
| 共同依赖 | `@mastra/memory@1.27.0`、`@mastra/observability@1.17.1`、`@mastra/mcp@1.17.1`、`@modelcontextprotocol/sdk@1.30.0`、`zod@4.4.3` |
| 候选 A 差异 | `@mastra/core@1.60.0`、`@mastra/libsql@1.21.0` |
| 候选 B 差异 | `@mastra/core@1.61.0`、`@mastra/libsql@1.21.1` |

临时夹具仅写入上述临时目录，没有修改仓库 package/lock/source。每个 Node 版本使用带版本后缀的独立 LibSQL 文件；跨进程 Approval/Workflow 实验由第一进程持久化并退出，再由第二进程打开同一文件。

### 4.2 精确命令

候选切换后均先执行：

```bash
node tools/node_modules/pnpm/bin/pnpm.cjs install --lockfile-only
node tools/node_modules/pnpm/bin/pnpm.cjs install --frozen-lockfile
```

Node `24.14.0` 类型、构建与合同：

```bash
"C:/Program Files/nodejs/node.exe" node_modules/typescript/bin/tsc --noEmit
"C:/Program Files/nodejs/node.exe" node_modules/typescript/bin/tsc -p tsconfig.build.json
"C:/Program Files/nodejs/node.exe" node_modules/vitest/vitest.mjs run src/contracts.test.ts --reporter=verbose
"C:/Program Files/nodejs/node.exe" node_modules/vitest/vitest.mjs run src/approval-stage1.test.ts --reporter=verbose
"C:/Program Files/nodejs/node.exe" dist/approval-stage2.js
"C:/Program Files/nodejs/node.exe" dist/workflow-stage1.js
"C:/Program Files/nodejs/node.exe" dist/workflow-stage2.js
```

Node `22.13.1` 使用完全相同参数，只把可执行文件替换为：

```bash
"C:/Users/dongshilin/AppData/Local/Temp/kkbot-mastra-131.0YtWNn/node_modules/node/bin/node.exe"
```

本地 Node 包第一次安装被 pnpm 脚本白名单拦截；只对白名单中的 `node` 放行后执行 `pnpm rebuild node`，`esbuild` 构建脚本仍保持禁用。直接 `node dist/contracts.js` 会因为 `@mastra/core/test-utils/llm-mock` 导入 Vitest 且没有 worker context 而失败，因此合同必须在 Vitest 进程中加载；这不是 Mastra 生产运行依赖，而是公开测试工具入口的复现前提。

### 4.3 双版本、双 Node 结果矩阵

除特别注明外，四列观察一致。

| ID / 契约 | A + Node 22 | A + Node 24 | B + Node 22 | B + Node 24 | 判定与关键观察 |
|---|---|---|---|---|---|
| Frozen install / peer / engine | 通过 | 通过 | 通过 | 通过 | 精确 lockfile 冻结安装完成；所有 Mastra 包声明 `node >=22.13.0`，未出现 peer 冲突 |
| TypeScript / minimal build | 通过 | 通过 | 通过 | 通过 | `tsc --noEmit` 与 `tsc -p tsconfig.build.json` 均退出 0 |
| M-01 动态 model retries | 通过 | 通过 | 通过 | 通过 | resolver 2 次；模型 A `maxRetries:1` 调用 2 次；模型 B 调用 1 次并返回 `fallback-ok` |
| M-02 readOnly / 稳定 ID | 通过（有限） | 通过（有限） | 通过（有限） | 通过（有限） | 同一 ID 串行 2 次、并发 4 次均 fulfilled，最终仅 1 条；readOnly generate 前后 ID 列表不变。不同内容同 ID 冲突与进程重放未测 |
| S-01 Storage init / close | 通过（基础） | 通过（基础） | 通过（基础） | 通过（基础） | 显式 `init()`、Memory/Workflow/Schedule domain 操作与 `close()` 完成；双 Client WAL、migration 失败恢复未测 |
| A-01 suspended discovery | 通过 | 通过 | 通过 | 通过 | 第一进程得到 `finishReason=suspended` 后退出；第二进程发现 1 个 run，`runId=approval-process-run`、`toolCallId=approval-process-call` |
| A-02 权威终态读取 | 失败 | 失败 | 失败 | 失败 | 公开 Agent API 只有 suspended 列表与决议调用，没有 approved/declined/deadline 权威状态查询 |
| A-03 条件决议 | 失败 | 失败 | 失败 | 失败 | 批准/拒绝签名不接受 expected state、version、deadline、CAS token 或幂等键 |
| A-04/A-05/A-06 重复/相反/deadline/执行一次 | 失败 | 失败 | 失败 | 失败 | 并发批准与拒绝为 `[rejected, fulfilled]`，本次工具执行 1 次；但没有权威终态和条件原语，不能证明唯一终态/跨进程 exactly-once。Core 1.61.0 还明确警告并发 resume 不能去重、下游可能重复 |
| W-01 Workflow snapshot/resume | 通过（基础） | 通过（基础） | 通过（基础） | 通过（基础） | 第一进程持久化 `suspended` 后退出；第二进程读到 snapshot 并恢复为 `success`，结果 `payload:approved`。并发 resume 唯一副作用未单独通过 |
| C-01 Schedule | 失败（部分通过） | 失败（部分通过） | 失败（部分通过） | 失败（部分通过） | 创建后重启读取通过；两个并发 `schedules.run(id)` 都 fulfilled，不能证明同一 due fire 的跨实例唯一 claim 与崩溃恢复 |
| O-01 Observability | 通过（基础） | 通过（基础） | 通过（基础） | 通过（基础） | spy exporter 观察到 `flush=3`、`shutdown=1`；Storage exporter、失败、超时和 shutdown 后 emit 未测 |
| P-01 Processors | 通过（基础） | 通过（基础） | 通过（基础） | 通过（基础） | 执行顺序为 `input → output`；API error、retry、stream、tool result 多阶段未测 |
| X-01 MCP | 通过（stdio 基础） | 通过（stdio 基础） | 通过（stdio 基础） | 通过（stdio 基础） | 两次独立 Client 均发现 `local_echo`，`disconnect()` 后可重建；HTTP、单 server 故障与 MCP approval 未测 |

### 4.4 关键原始观察

- Core `1.61.0` 在并发批准/拒绝时输出：`shouldPersistSnapshot excludes the "running" status, so concurrent resume() calls ... cannot be de-duplicated. Concurrent resumes may execute downstream steps more than once.` 这直接否定了当前规格要求的并发唯一决议保证。
- 两组 Approval 竞态均观察到一项 rejected、一项 fulfilled，原工具计数为 1；没有权威终态读取时，单次“工具只执行一次”不能升级为跨进程 exactly-once 承诺。
- Schedule 的两个手动 run 都得到独立 claim 并 fulfilled。手动 run 不等同同一 cron due fire，因此该观察只能判“唯一竞争未证实”，不能武断宣称 cron 必然重复。
- Observability 一次显式 `flush()` 加 `shutdown()` 最终触发 exporter `flush` 3 次、`shutdown` 1 次；合同只证明生命周期会到达 exporter，不承诺 flush 恰好一次。

### 4.5 夹具校验值与复现限制

候选 A：`package.json` SHA-256 `9aec4c4edcb89f4247d157cec233c95ef1333462ef2700d4a47b70147e63468f`，`pnpm-lock.yaml` `424502d3d11d145423ae320b20a1424bb03c85ce711049640e8c9861a0deaa7c`。候选 B：`package.json` `25b4932cca2c7092e623d200086ac913ab53fb9713dbaa7bf595aa84f9c4fbd4`，`pnpm-lock.yaml` `b25bc9ea14c5c1f680ae980eabba84606cf9ed385127b69e02902684db3c1e3d`。

共同夹具 SHA-256：`contracts.ts` `3d46b5...f7a9`、`contracts.test.ts` `7e461c...fa1`、`mcp-server.ts` `8e0789...3e75`、`approval-stage1.test.ts` `385395...cb7`、`approval-stage2.ts` `f2d98d...db`、`workflow-stage1.ts` `775f68...090`、`workflow-stage2.ts` `89facf...afe`。完整文件保留在上述临时目录，未提交到仓库；临时目录被系统清理后只能按本节矩阵重建，不能依赖绝对路径长期存在。

本研究没有运行真实 Provider、HTTP MCP、MastraStorageExporter、双 Client WAL/migration 故障、Schedule 真正 cron 多 worker 竞争、不同内容同 message ID 冲突、Processor error/retry/stream 全阶段。相关行只能写“基础通过/有限”或“未证实”，不能扩张为生产兼容承诺。

## 5. 最终决策与最小重裁点

| 项目 | 最终结论 | 后续动作 |
|---|---|---|
| 候选 A | 不可锁定 | Approval 权威终态、条件决议、竞态唯一性失败；Schedule 竞争未证实 |
| 候选 B | 不可锁定 | 与候选 A 相同；升级一个 Core minor/LibSQL patch 没有补齐合同 |
| Tool Approval suspended discovery | 通过 | 可作为恢复入口，但不能替代终态事实源 |
| Tool Approval 权威终态/条件决议 | 失败 | 按 #117 返回 Wayfinder 重裁，不建 KKBot 本地事实源 |
| Approval 重复/相反/deadline 竞态 | 失败 | 不作 exactly-once 或唯一终态承诺，不锁版 |
| Schedule 持久化 | 基础通过 | 只证明 CRUD/restart，不证明同一 fire 唯一消费 |
| Observability / MCP / Processors | 基础路径通过 | 若未来重裁后再选版本，仍需补失败注入、HTTP/MCP approval 与 Processor 全阶段 |

最小重裁不是“再找一个近似补丁版本”，因为候选 A/B 的公开 API 形状相同且关键缺口属于状态机合同：

1. 优先决定是否把**高危写工具、HITL 和依赖审批 exactly-once 的主动任务**移出当前交付范围，仅保留只读工具；这能避免引入被规格禁止的本地 Approval Runtime。
2. 若高危 Tool Approval 必须保留，则必须重新选择能原生暴露权威终态、条件决议和并发唯一性的运行时/产品边界；不得用 Projection CAS、Outbox、自动重放或包装 `approveToolCall` 补齐。
3. 若 Schedule 的同一 fire 唯一消费是上线门槛，则在 Mastra 原生合同被证明前将主动 Schedule 移出当前交付范围；单 worker 部署只能降低竞争概率，不能证明崩溃窗口 exactly-once。
4. #131 保持开放；不得发布 resolution、关闭工单或把任一候选写入 workspace catalog。

## 6. 一手来源索引

以下来源只用于本文的静态证据；`main` 源码链接是公开实现形状参考，不是 npm 候选的版本证明。

| ID | 一手来源 | 用途 |
|---|---|---|
| S1 | [`@mastra/core@1.60.0` npm registry JSON](https://registry.npmjs.org/@mastra%2fcore/1.60.0) | Core 版本、exports、engines、peer、dependencies |
| S2 | [`@mastra/memory@1.27.0` npm registry JSON](https://registry.npmjs.org/@mastra%2fmemory/1.27.0) | Memory 版本、engines、peer、runtime dependencies |
| S3 | [`@mastra/libsql@1.21.0` npm registry JSON](https://registry.npmjs.org/@mastra%2flibsql/1.21.0) | LibSQL 版本、engines、peer、`@libsql/client` |
| S4 | [`zod@4.4.3` npm registry JSON](https://registry.npmjs.org/zod/4.4.3) | Zod 精确版本与 exports |
| S5 | [仓库 `pnpm-lock.yaml`](../../pnpm-lock.yaml) | 候选 A importer、解析版本、AI SDK alias 锁定 |
| S6 | [`@mastra/core@1.61.0` npm latest JSON](https://registry.npmjs.org/@mastra%2fcore/latest) | 候选 B Core latest |
| S7 | [`@mastra/memory@1.27.0` npm latest JSON](https://registry.npmjs.org/@mastra%2fmemory/latest) | 候选 B Memory latest |
| S8 | [`@mastra/libsql@1.21.1` npm latest JSON](https://registry.npmjs.org/@mastra%2flibsql/latest) | 候选 B LibSQL latest |
| S9 | [`zod@4.4.3` npm latest JSON](https://registry.npmjs.org/zod/latest) | 候选 B Zod latest |
| S10 | [`@mastra/observability@1.17.1` npm registry JSON](https://registry.npmjs.org/@mastra%2fobservability/1.17.1) | Observability 候选版本、engines、peer |
| S11 | [`@mastra/mcp@1.17.1` npm registry JSON](https://registry.npmjs.org/@mastra%2fmcp/1.17.1) | MCP 候选版本、engines、peer、MCP SDK 依赖 |
| S12 | [`@ai-sdk/provider@2.0.3` npm registry JSON](https://registry.npmjs.org/@ai-sdk%2fprovider/2.0.3)；[`@ai-sdk/provider-utils@3.0.30` npm registry JSON](https://registry.npmjs.org/@ai-sdk%2fprovider-utils/3.0.30) | AI SDK engine/peer/依赖交叉核对 |
| S13 | [Core Agent types 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/types.ts) | `ModelWithRetries`、动态 model、Agent 配置类型 |
| S14 | [Core Agent 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/agent.ts) | 模型选择、Approval、suspended discovery、resume |
| S15 | [官方 Memory class 参考](https://mastra.ai/reference/memory/memory-class) | `readOnly`、Memory 配置语义 |
| S16 | [Memory 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/memory/src/index.ts) | `saveMessages`、ID、只读 working memory、后台 settled |
| S17 | [官方 Storage 参考](https://mastra.ai/reference/storage/overview) | message 主键、workflow/observability domains |
| S18 | [Storage base 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/base.ts)；[Mastra 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/mastra/index.ts) | `init`/`close`、自动 init、shutdown 顺序 |
| S19 | [LibSQL Store 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/stores/libsql/src/storage/index.ts) | Client、WAL/busy timeout、domain init/close |
| S20 | [官方 LibSQL 集成参考](https://mastra.ai/integrations/databases/libsql) | Mastra 自动 init 与直接 Storage 显式 init |
| S21 | [官方 Human-in-the-loop 文档](https://mastra.ai/docs/agents/human-in-the-loop) | Approval flags、toolCallId、条件审批、重启发现、snapshot 限制 |
| S22 | [Workflow Storage 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/storage/domains/workflows/base.ts) | snapshot/state/list/delete 接口 |
| S23 | [官方 Workflow suspend/resume 文档](https://mastra.ai/docs/workflows/suspend-and-resume) | snapshot 持久化、resumeData、跨重启恢复 |
| S24 | [官方 Schedules 文档](https://mastra.ai/docs/harness/schedules) | Schedule 引入版本、持久化、Storage、CRUD、threaded 约束 |
| S25 | [Schedules 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/schedules/schedules.ts) | `create/get/list/update/delete/pause/resume/run` 类型/实现 |
| S26 | [Observability core types 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/observability/types/core.ts) | `flush`/`shutdown` 与 event bus 语义 |
| S27 | [官方 Processor interface 参考](https://mastra.ai/reference/processors/processor-interface)；[Processor 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/processors/index.ts) | Processor 方法与执行顺序 |
| S28 | [Core Agent types 中的 Processor 配置（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/agent/types.ts) | `maxProcessorRetries`、retry 配置 |
| S29 | [MCP 类型公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/mcp/types.ts)；[Core MCP server 公开源码（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/src/mcp/index.ts) | MCP Server 配置、transport、close、tool 表面 |
| S30 | [总规格 §2.6](../KKBot-Mastra-Native-Refactor-Spec.md#26-mastra-能力基线) | 兼容版本与 Tool Approval 能力门槛 |
| S31 | [总规格 §2.7](../KKBot-Mastra-Native-Refactor-Spec.md#27-nodejs-运行时基线) | Node.js `>=22.13` 基线 |
| S32 | [官方 MCP 总览](https://mastra.ai/docs/connections/mcp)；[官方 MCP Client 参考](https://mastra.ai/reference/tools/mcp-client) | `MCPClient`、工具发现、错误、approval、disconnect、安全 |
| S33 | [`ai` npm latest JSON](https://registry.npmjs.org/ai/latest) | 说明 registry latest 不等于 Core runtime 必需版本 |

## 7. 研究状态

- 已完成：候选 A/B 官方元数据、包声明、AI SDK alias、Zod/peer/engine 约束与公开 API 证据。
- 已完成：候选 A/B 在 Node.js `22.13.1` 与 `24.14.0` 的冻结安装、类型检查、最小构建和第 4 节运行矩阵，包括真实双进程 Approval discovery 与 Workflow resume。
- 已确认阻塞：Tool Approval 权威终态、条件决议和并发唯一性不满足；Schedule 同一 fire 唯一竞争未证实。当前无可锁定兼容版本组。
- 本研究只提交本文与总规格中 #131 的兼容组/验证门更新；不修改 package、lock、实现代码、地图或其他工单状态。
