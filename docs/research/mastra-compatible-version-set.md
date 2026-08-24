# Mastra 兼容版本组最终核查（#131）

> **核查日期：2026-08-24；最终结果：B——不存在满足当前有效规格的稳定精确版本组，不能锁版。**
>
> 唯一最小失败合同是：**必须能按 `runId + toolCallId` 读取 Tool Approval 的原生权威终态。** 已发布稳定版本没有该公开能力；其余 Approval 门也因此无法得到所需的条件仲裁与并发唯一性保证。按 #117，必须返回 Wayfinder 由人类重裁，不能以 KKBot Projection CAS、Outbox、恢复循环或本地 Approval Runtime 回补。

本文只采纳已发布稳定 npm 包、官方 Mastra 文档/仓库发布物和既有 A/B 隔离基线。`main`、alpha/beta/canary、内部 API 及未发布修复均不作为原生满足证据。

## 1. 当前有效判定范围

### 1.1 #125 后的 Schedule 边界

#125 已移除用户可见的主动 Schedule。当前只保留**内部维护**用途：可创建、重启后可读取，并允许重复触发；业务合同保证这种重复 run **不创建 Delivery、不调用高危 Tool、也不产生第三方写副作用**。因此同一 fire 的跨实例唯一消费、崩溃恢复 exactly-once 不是本次锁版门槛，也不再是结果 B 的原因。[S1][S2]

Mastra 官方文档确认 Schedule 自 Core `1.50.0` 起提供、需要 schedules storage domain、可持久化并通过 `mastra.schedules` 完成 create/get/list/update/delete/pause/resume/run；其仍为 Beta。这足以覆盖上述内部维护入口，但本文不把它扩张为 Delivery 或高危副作用的 exactly-once 保证。[S2]

### 1.2 不可替代的 Approval 六项硬门

下列六项仍全部是锁版硬门；任一项没有稳定、公开、原生的证明，即不能锁版：

1. 跨重启从持久 Storage 发现 suspended run；
2. 按 `runId + toolCallId` 读取 `pending`、`approved`、`declined`、`deadline-declined` 等**权威终态**；
3. 带前置条件的批准、人工拒绝、deadline 拒绝；
4. 判定既有终态与新决议是否冲突；
5. 重复和相反决议安全；
6. 批准、拒绝、deadline 并发时唯一终态，且原 Tool 最多执行一次。

## 2. npm 官方 registry：稳定搜索空间与精确候选

### 2.1 截止日的 dist-tag 与稳定版本范围

下表来自各包 npm 官方完整文档的 `dist-tags`、`versions` 与发布时间：只保留 `2026-08-24T23:59:59.999Z` 前且不含 prerelease 标识的版本。除 `latest` 外的 beta/alpha/canary/分支 tag 都不是稳定候选；Core 的大量 `0.0.0-<branch>` tag 同理排除。[N1][N2][N3][N4][N5][N6]

| 包 | 稳定版本数与范围 | 截止日最高稳定版（发布时间） | 相关非稳定 tag（排除） |
|---|---|---|---|
| `@mastra/core` | 182；`0.1.0`–`1.61.0` | `1.61.0`（2026-08-21） | `alpha=1.62.0-alpha.4`、`beta=1.1.0-alpha.2` |
| `@mastra/memory` | 117；`0.0.1`–`1.27.0` | `1.27.0`（2026-08-19） | `alpha=1.27.0-alpha.3`、`beta=1.0.1-alpha.1` |
| `@mastra/libsql` | 75；`0.0.1`–`1.21.1` | `1.21.1`（2026-08-21） | `alpha=1.21.1-alpha.1`、`beta=1.1.0-alpha.2` |
| `@mastra/observability` | 45；`0.0.2`–`1.17.1` | `1.17.1`（2026-08-19） | `alpha=1.17.2-alpha.0`、`beta=1.1.0-alpha.1` |
| `@mastra/mcp` | 90；`0.1.0`–`1.17.1` | `1.17.1`（2026-08-21） | `alpha=1.17.1-alpha.1`、`beta=1.0.0` |
| `zod` | 290；`1.0.0`–`4.4.3` | `4.4.3`（2026-05-04） | `canary=4.5.0-canary.20260820T155656`、`beta=4.1.13-beta.0` |

**排除其它稳定组合的充分理由。** 当前有效规格需要 Schedule，官方文档将其引入版本固定为 Core `>=1.50.0`。[S2] 因而仅 `@mastra/core@1.50.0`–`1.61.0` 的 14 个稳定发布物可能进入本题。逐包解开这些发布 tarball 的公开 `.d.ts` 并检索 Approval 的读状态、条件决议、CAS/version/deadline/idempotency 形状；全部只暴露 suspended discovery 与直接恢复/approve/decline，不存在第 3 节所需 API。`1.61.0` 又是这个范围和 registry `latest` 的上界，故不存在 A/B 之外“更高稳定 Core 修复了 Approval”的第三候选。[N1][N7][R1]

Core `1.61.0` 的官方发布记录确认它是已发布 release；仓库当前 CHANGELOG 顶部的 `1.62.0-alpha.*` 仅是未稳定工作线，不得用于锁版结论。[R1][R2]

### 2.2 A/B 精确组与安装约束

| 组 | `@mastra/core` | `@mastra/memory` | `@mastra/libsql` | `@mastra/observability` | `@mastra/mcp` | `zod` | 结论 |
|---|---:|---:|---:|---:|---:|---:|---|
| A（已验证基线） | `1.60.0` | `1.27.0` | `1.21.0` | `1.17.1` | `1.17.1` | `4.4.3` | 不可锁定 |
| B（全部 stable latest） | `1.61.0` | `1.27.0` | `1.21.1` | `1.17.1` | `1.17.1` | `4.4.3` | 不可锁定；无第三稳定组 |

两组夹具还直接锁定 `@modelcontextprotocol/sdk@1.30.0`；它不是对 `@mastra/mcp` 完整 runtime 依赖树的替代品，而是夹具自己的精确依赖。[F1][F2]

### 2.3 最终稳定包的 engines、peer 与 runtime dependencies

表中列出影响组合兼容性的完整关键约束；每行 npm 元数据仍是 `dependencies`、`peerDependencies` 与 `engines` 的第一方全文，不把 `devDependencies` 当运行依赖。[N7][N8][N9][N10][N11][N12]

| 包与最终版本 | `engines` / peer | runtime dependencies（与本组相关的完整关键项） |
|---|---|---|
| `@mastra/core@1.61.0` | Node `>=22.13.0`；peer `zod ^3.25.0 || ^4.0.0` | 三代 AI SDK provider/provider-utils alias（见 §2.4）、`@mastra/schema-compat@1.3.7`、`@modelcontextprotocol/server@2.0.0`，以及 registry 列出的其他运行库 |
| `@mastra/memory@1.27.0` | Node `>=22.13.0`；peer Core `>=1.4.1-0 <2.0.0-0` | `zod ^4.4.3`、`diff ^8.0.3`、`tokenx ^1.3.0`、`lru-cache ^11.2.7`、`async-mutex ^0.5.0`、`json-schema ^0.4.0`、`xxhash-wasm ^1.0.0`、`probe-image-size ^7.2.3`、`@mastra/schema-compat@1.3.7` |
| `@mastra/libsql@1.21.1` | Node `>=22.13.0`；peer Core `>=1.51.0-0 <2.0.0-0` | `@libsql/client ^0.17.4` |
| `@mastra/observability@1.17.1` | Node `>=22.13.0`；peer Core `>=1.16.0-0 <2.0.0-0`、Zod `^3.25.0 || ^4.0.0` | 无声明 runtime dependency |
| `@mastra/mcp@1.17.1` | Node `>=22.13.0`；peer Core `>=1.0.0-0 <2.0.0-0` | `@modelcontextprotocol/sdk ^1.29.0`、`core/node/client/server/server-legacy@2.0.0`、`ext-apps ^1.7.1`、`exit-hook ^5.1.0`、`fast-deep-equal ^3.1.3` |
| `zod@4.4.3` | 未声明 `engines`/peer | 无声明 runtime dependency；提供主入口、`./v3` 与 `./v4` exports |

所有上述 peer 范围接受 B 的精确 Core/Zod；最严格的 Core provider alias 只要求 Node `>=22`，故 `>=22.13.0` 覆盖完整组。[N7][N8][N9][N10][N11][N12][N13]

### 2.4 实际解析的 AI SDK、Zod 与 `ai`

Core 的已发布 manifest 把 alias 固定为下表；B 的冻结 lockfile 逐项解析为同一映射，并把三套 utils 都接到 `zod@4.4.3`。A 使用同一 Core alias 组。[N7][F3]

| Core alias | 实际包 | Node / Zod 约束 | 锁定关系 |
|---|---|---|---|
| `@ai-sdk/provider-v5` | `@ai-sdk/provider@2.0.3` | Node `>=18`；无 peer | 被 utils `3.0.30` 使用 |
| `@ai-sdk/provider-v6` | `@ai-sdk/provider@3.0.14` | Node `>=18`；无 peer | 被 utils `4.0.40` 使用 |
| `@ai-sdk/provider-v7` | `@ai-sdk/provider@4.0.4` | Node `>=22`；无 peer | 被 utils `5.0.13` 使用 |
| `@ai-sdk/provider-utils-v5` | `@ai-sdk/provider-utils@3.0.30` | Node `>=18`；peer Zod `^3.25.76 || ^4.1.8` | 精确依赖 provider `2.0.3` |
| `@ai-sdk/provider-utils-v6` | `@ai-sdk/provider-utils@4.0.40` | Node `>=18`；同上 | 精确依赖 provider `3.0.14` |
| `@ai-sdk/provider-utils-v7` | `@ai-sdk/provider-utils@5.0.13` | Node `>=22`；同上 | 精确依赖 provider `4.0.4` |

候选 A/B **没有解析 `ai` 包**。npm registry 的独立 `ai@7.0.77`（Node `>=22`、peer Zod `^3.25.76 || ^4.1.8`、依赖 provider `4.0.7` / utils `5.0.29`）与 Core alias 不同；`@mastra/mcp@1.17.1` 将 `ai ^5.0.221` 放在 `devDependencies` 而不是 runtime dependency。不得把任一 `ai` latest 擅自添入兼容组。[N10][N13][F3]

## 3. 已发布 Tool Approval 能力核查

### 3.1 已发布 API 实际提供什么

官方 HITL 文档支持工具级 `requireApproval: true`、请求级 `requireToolApproval`（可为基于工具名/参数的函数），并在挂起时输出 `tool-call-approval` chunk；`toolCallId` 用于多挂起调用消歧。这是**挂起前的策略选择**，不是决议时的原子状态前置条件。[S3]

`@mastra/core@1.61.0` 已发布 tarball 的 `dist/agent/agent.d.ts` 明确声明：

- `listSuspendedRuns()` 返回的 status 只有 `'suspended'`；注释明确终态后删除 snapshot；
- `approveToolCall({ runId, toolCallId?, model? })` 与 `declineToolCall({ runId, toolCallId?, reason?, model? })` 是直接继续执行的入口；
- **`sendToolApproval` 确实存在**，其特有字段为 `threadId`、`resourceId`、`toolCallId?`、`approved`、`resumeData?`、`declineContext?`、`messages?`、`streamOptions?`，返回仅为 `Promise<{ accepted: true; runId; toolCallId? }>`；没有 `expectedState`、version、deadline、CAS token 或 idempotency key。[N7][T1]

已发布的编译产物显示 `sendToolApproval` 会先以 thread/resource 查内存 active run，缺失时调用 `listSuspendedRuns` 从 storage 选取 suspended run，然后直接 `resumeStream`。若找不到，它只报“run 可能已完成或已恢复”；从 storage 恢复的分支仍返回 `{ accepted: true, runId, toolCallId }`。因此该回执表示“请求被接受并尝试恢复”，**不是**按 `runId + toolCallId` 的权威终态读取，也无法在响应丢失后确认批准、拒绝或 Tool 实际执行结果。[T1][T2]

官方当前文档与 Context7 的官方 Mastra 索引也只记录 `listSuspendedRuns` 的 storage-backed 发现及随后 `approveToolCall`/`declineToolCall` 的继续执行；没有发布终态读取、条件 approve/decline 或 Approval CAS 的 API 契约。[S3][S4]

### 3.2 六项门的逐项结论

| 门 | 结论 | 第一方证据与理由 |
|---|---|---|
| 1. 跨重启 suspended discovery | **通过** | `listSuspendedRuns` 由 workflow snapshot storage 支撑，可在重启和多实例后发现 suspended run；A/B 双进程基线也观察到第一进程挂起、第二进程以相同 LibSQL 文件发现 `runId`/`toolCallId`。[S4][E1] |
| 2. `runId + toolCallId` 权威终态读取 | **失败；唯一最小失败合同** | 发布类型只可列出 `'suspended'`，终态 snapshot 被删除；没有 `getApprovalState` 或等价读取。`approve/decline` 和 `sendToolApproval` 都是写/恢复调用，后者只回 `{ accepted: true }`。[T1][T2] |
| 3. 条件批准、人工拒绝、deadline 拒绝 | **失败** | 函数式 `requireToolApproval` 与 `declineToolCall({ reason })` 分别支持“挂起条件”和普通人工拒绝，但已发布决议参数没有 expected state/version/deadline/CAS/idempotency。故不能原生表达“仅 pending 时批准/拒绝”或 deadline 与人工决议的原子竞争。[S3][T1] |
| 4. 终态冲突判定 | **失败** | 没有权威终态读取，也没有返回既有终态或 conflict 结果的 Approval API；`sendToolApproval` 找不到 run 时只给“可能已完成或已恢复”的非判定性错误。[T1][T2] |
| 5. 重复/相反决议安全 | **失败** | 没有幂等键、决议版本或“同值重放成功”的公开合同；在支持 CAS 的 adapter 上，相反决议至多得到冲突错误而非幂等成功，不能替代跨重启、响应丢失后的权威重读与幂等保证。[E1][R3][T1] |
| 6. 并发唯一终态与 Tool 至多一次 | **失败** | Core `1.61.0` 的 #21725 只在 Storage 声明 `supportsConcurrentUpdates=true` 时，为 **workflow resume** 提供 suspended→running 原子 claim，输家得到 409；不支持该能力的 Store 不走此保障。它是部分 resume 竞争改善，并未提供 Approval 终态读取、deadline/expected-state 条件决议、响应丢失后的仲裁，亦非 Tool Approval 的公开唯一执行合同。[R1][R3][T1] |

### 3.3 为什么缺口不能由薄集成层补齐

状态事实必须由能决定 Tool 是否执行的运行时原子持有。外层先写 Projection CAS、指纹或 Outbox，再调用 `approveToolCall`/`sendToolApproval`，会留下至少一个不可消除的间隙：外层状态已改变而恢复请求未到达，或恢复/Tool 已发生而外层未得到响应。由于 Mastra 没有提供按键读取最终状态和带前置条件的决议，外层无法将自己的状态与 Mastra snapshot 消费及原 Tool 执行绑定为同一原子转换。[T1][T2]

官方 HITL 文档的 fingerprint 示例也明确将 fingerprint 放进应用方的 `Set`，并建议生产环境自行保存到 durable storage；它只是工具参数绑定示例，不是 Mastra 的持久 Approval 状态机。把它升级成决定终态、重放或 Tool 执行的组件，正是规格禁止的本地 Approval Runtime。[S3]

## 4. A/B 既有隔离基线与复现

### 4.1 固定夹具与 Node 覆盖

夹具已随仓库保存，不再依赖临时目录：

- A：`docs/research/fixtures/mastra-compatible-version-set/candidate-a`；
- B：`docs/research/fixtures/mastra-compatible-version-set/candidate-b`。[F1][F2]

夹具落地后，本会话使用 `corepack pnpm@10.30.0` 在当前 Node `24.14.0` 环境对 A/B 分别重新执行 frozen install、TypeScript typecheck 和最小 build，均通过；没有重跑 A/B 的完整双 Node 行为合同矩阵。

| 夹具 | `package.json` SHA-256 | `pnpm-lock.yaml` SHA-256 |
|---|---|---|
| A | `9aec4c4edcb89f4247d157cec233c95ef1333462ef2700d4a47b70147e63468f` | `424502d3d11d145423ae320b20a1424bb03c85ce711049640e8c9861a0deaa7c` |
| B | `25b4932cca2c7092e623d200086ac913ab53fb9713dbaa7bf595aa84f9c4fbd4` | `b25bc9ea14c5c1f680ae980eabba84606cf9ed385127b69e02902684db3c1e3d` |

既有基线在 Node `22.13.1`（最低基线）及 Node `24.14.0`（截至核查日仍处于官方 Active LTS 阶段的 v24）完成冻结安装、类型检查、最小构建、跨进程 suspended discovery 和基础运行面验证。Node 官方 release schedule 显示 v22 支持至 2027-04-30，v24 自 2025-10-28 为 LTS、于 2026-10-20 才进入 Maintenance，因此两者都覆盖本次生产 LTS 验证要求。[E1][L1]

夹具位于主 pnpm workspace 内，复现时必须禁用向上 workspace 发现：

```bash
corepack pnpm@10.30.0 --dir docs/research/fixtures/mastra-compatible-version-set/candidate-b \
  install --ignore-workspace --frozen-lockfile
corepack pnpm@10.30.0 --dir docs/research/fixtures/mastra-compatible-version-set/candidate-b exec tsc --noEmit
corepack pnpm@10.30.0 --dir docs/research/fixtures/mastra-compatible-version-set/candidate-b exec tsc -p tsconfig.build.json
corepack pnpm@10.30.0 --dir docs/research/fixtures/mastra-compatible-version-set/candidate-b exec vitest run \
  src/contracts.test.ts src/approval-stage1.test.ts --reporter=verbose
```

Node `22.13.1` 应使用 fixture 本地 `node` 包二进制执行已构建的 `approval-stage2.js`/`workflow-stage*.js`；Node `24.14.0` 使用受维护生产 Node 执行同一产物。A 只需将路径换为 `candidate-a`。这些是既有基线的复现命令，不是本次重新执行的实验。[F1][F2]

### 4.2 与最终结论相关的基线观察

| 观察 | A 与 B、Node 22.13.1/24.14.0 | 当前判定 |
|---|---|---|
| Frozen install、peer/engine、TypeScript、最小构建 | 通过 | 版本可安装、类型可用，不足以证明 Approval 兼容 |
| 跨进程 suspended discovery | 通过 | 支持硬门 1 |
| Approval 权威终态读取与条件决议 | 失败 | 发布类型/API 无所需入口，支持硬门 2/3 的失败 |
| 重复/相反/deadline 竞态与 Tool 至多一次 | 未取得原生保证 | 不得将一次进程内结果升级为硬门 5/6 通过 |
| 内部维护 Schedule：创建、重启读取、重复手动触发 | 通过 #125 所需入口 | 夹具 workflow 只作字符串转换，不创建 Delivery、不执行 Tool、不写第三方；重复 `run()` 的唯一性观察从锁版判定中移除 |

## 5. 结果 B 与 #161 人类重裁边界

**结果 B：没有可锁定版本组。** A 与 B 都满足 Node、peer、安装和类型条件，B 也是所有目标包的稳定最新组合；但两者共同缺少唯一最小失败合同——按 `runId + toolCallId` 的原生权威终态读取。既然这一事实源不存在，条件决议、终态冲突、重复/相反决议和三方竞态的原生证明也无从成立。

按 #117 的能力缺口处理原则，[#161](https://github.com/dnslin/kkbot/issues/161)只负责由人类重裁高危 Tool/HITL 的当前产品范围，互斥方向为：

1. 本期移除所有需要 Approval 的高危 Tool 自动执行，只保留低风险或只读 Tool；
2. 把原高危动作改为不产生外部副作用的建议、草稿或明确人工操作，由人类在 KKBot Agent Runtime 之外完成；
3. 保留高危 Tool Approval 作为重构完成门槛并持续阻塞，直到稳定 Mastra 版本通过 #126 的全部原生合同。

本研究不替用户选择 #161。无论后续选择哪一范围，都不存在由本项目实现 Projection CAS、Outbox、自动恢复循环或本地 Approval Runtime 的合规补救路径。

## 6. 第一方来源与可复现证据

| ID | 来源 | 用途 |
|---|---|---|
| S1 | [当前总规格的内部维护 Schedule 定义](../KKBot-Mastra-Native-Refactor-Spec.md#26-mastra-能力基线) | #125 后 Schedule 业务边界 |
| S2 | [Mastra 官方 Schedules 文档](https://mastra.ai/docs/harness/schedules) | `1.50.0` 引入、Beta、持久化与 CRUD/run |
| S3 | [Mastra 官方 HITL 文档](https://mastra.ai/docs/agents/human-in-the-loop) | approval flags、普通 approve/decline、fingerprint 示例边界 |
| S4 | [官方 `listSuspendedRuns` 参考源码](https://github.com/mastra-ai/mastra/blob/main/docs/src/content/en/reference/agents/listSuspendedRuns.mdx) | storage-backed suspended discovery 的公开文档形状 |
| N1 | [Core 完整 npm registry 文档](https://registry.npmjs.org/@mastra%2fcore) | `dist-tags`、全 versions、稳定上界 |
| N2 | [Memory 完整 npm registry 文档](https://registry.npmjs.org/@mastra%2fmemory) | `dist-tags`、全 versions、稳定上界 |
| N3 | [LibSQL 完整 npm registry 文档](https://registry.npmjs.org/@mastra%2flibsql) | `dist-tags`、全 versions、稳定上界 |
| N4 | [Observability 完整 npm registry 文档](https://registry.npmjs.org/@mastra%2fobservability) | `dist-tags`、全 versions、稳定上界 |
| N5 | [MCP 完整 npm registry 文档](https://registry.npmjs.org/@mastra%2fmcp) | `dist-tags`、全 versions、稳定上界 |
| N6 | [Zod 完整 npm registry 文档](https://registry.npmjs.org/zod) | `dist-tags`、全 versions、稳定上界 |
| N7 | [Core `1.61.0` npm metadata](https://registry.npmjs.org/@mastra%2fcore/1.61.0)；[发布 tarball](https://registry.npmjs.org/@mastra/core/-/core-1.61.0.tgz) | engines、peer、aliases、已发布 `.d.ts`/实现 |
| N8 | [Memory `1.27.0` npm metadata](https://registry.npmjs.org/@mastra%2fmemory/1.27.0) | engines、peer、dependencies |
| N9 | [LibSQL `1.21.1` npm metadata](https://registry.npmjs.org/@mastra%2flibsql/1.21.1) | engines、peer、dependencies |
| N10 | [MCP `1.17.1` npm metadata](https://registry.npmjs.org/@mastra%2fmcp/1.17.1) | engines、peer、runtime 与 dev dependency 边界 |
| N11 | [Observability `1.17.1` npm metadata](https://registry.npmjs.org/@mastra%2fobservability/1.17.1) | engines、peer、无 runtime dependency |
| N12 | [Zod `4.4.3` npm metadata](https://registry.npmjs.org/zod/4.4.3) | exports 与依赖约束 |
| N13 | [provider `2.0.3`](https://registry.npmjs.org/@ai-sdk%2fprovider/2.0.3)、[`3.0.14`](https://registry.npmjs.org/@ai-sdk%2fprovider/3.0.14)、[`4.0.4`](https://registry.npmjs.org/@ai-sdk%2fprovider/4.0.4)；[utils `3.0.30`](https://registry.npmjs.org/@ai-sdk%2fprovider-utils/3.0.30)、[`4.0.40`](https://registry.npmjs.org/@ai-sdk%2fprovider-utils/4.0.40)、[`5.0.13`](https://registry.npmjs.org/@ai-sdk%2fprovider-utils/5.0.13)；[`ai` latest](https://registry.npmjs.org/ai/latest) | 实际 alias、Zod/Node 约束与独立 `ai` latest 对照 |
| R1 | [Mastra 官方 Core `1.61.0` release](https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.61.0) | 已发布稳定 release、1.61 workflow resume 改善的版本界限 |
| R2 | [Mastra 官方 Core CHANGELOG（main）](https://github.com/mastra-ai/mastra/blob/main/packages/core/CHANGELOG.md) | 明确 `1.62.0-alpha.*` 是未稳定工作线；不作为锁版证据 |
| R3 | [Mastra PR #21725](https://github.com/mastra-ai/mastra/pull/21725) | `supportsConcurrentUpdates` 条件下的 workflow resume claim/409 限制 |
| T1 | 已发布 tarball 内 `dist/agent/agent.d.ts`；本地复现路径 `node_modules/@mastra/core/dist/agent/agent.d.ts` | `listSuspendedRuns`、approve/decline/sendToolApproval 的精确声明 |
| T2 | 已发布 tarball 内 `dist/agent-D5C9QXkF.js`；本地复现路径 `node_modules/@mastra/core/dist/agent-D5C9QXkF.js` | `sendToolApproval` 的 storage discovery、直接 `resumeStream` 与非权威回执 |
| E1 | [A/B 夹具](fixtures/mastra-compatible-version-set/) | 既有双 Node、跨进程与 Schedule 基线及精确命令 |
| F1 | [候选 A manifest](fixtures/mastra-compatible-version-set/candidate-a/package.json)；[lockfile](fixtures/mastra-compatible-version-set/candidate-a/pnpm-lock.yaml) | A 精确依赖与冻结输入 |
| F2 | [候选 B manifest](fixtures/mastra-compatible-version-set/candidate-b/package.json)；[lockfile](fixtures/mastra-compatible-version-set/candidate-b/pnpm-lock.yaml) | B 精确依赖与冻结输入 |
| F3 | [候选 B lockfile 的 Core alias 解析](fixtures/mastra-compatible-version-set/candidate-b/pnpm-lock.yaml#L77) | provider/provider-utils/Zod 的实际解析 |
| L1 | [Node.js 官方发布计划](https://raw.githubusercontent.com/nodejs/release/main/schedule.json) | Node 22/24 的 LTS 支持时间 |
