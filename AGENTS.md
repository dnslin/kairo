# KKBOT KNOWLEDGE BASE

**Generated:** 2026-08-19  
**Branch:** master  
**Architecture:** v2 Monorepo (pnpm workspace)

## OVERVIEW

面向 KK9 Electron 客户端的企业级 IM 机器人与现代 Agent 认知网关系统。采用 **Greenfield Monorepo (Driver First)** 架构，通过纯净独立的 CDP 驱动层（`@kkbot/driver`）与基于 Mastra 的认知微内核（`@kkbot/agent`）实现高可靠通信与智能化协同。

**技术栈**: TypeScript 5.7+ (NodeNext ESM) + Node 20+ LTS + pino + better-sqlite3 + Mastra + Vite/React 19 + Vitest 3.

**语言要求：你必须使用中文进行交流，所有日志和代码注释都必须使用中文。**

---

## STRUCTURE

```
kkbot/
├── packages/
│   ├── driver/                   # @kkbot/driver: 纯净事件驱动 CDP 底层 (0 数据库依赖)
│   │   ├── src/
│   │   │   ├── cdp/              # WebSocket 连接与 CDP 客户端
│   │   │   ├── dom/              # 会话穿透、消息解析、富文本渲染、发送操作
│   │   │   ├── types/            # 强类型定义 (KK9Message, KK9Session, KK9Employee 等)
│   │   │   ├── utils/            # 子日志器与错误类
│   │   │   ├── driver.ts         # KK9Driver 主类
│   │   │   └── index.ts          # 统一公开 API 导出
│   │   ├── tests/                # 离线 Vitest 单元测试
│   │   └── package.json
│   ├── agent/                    # @kkbot/agent: Mastra 认知微内核 (规划落地中)
│   ├── gateway/                  # @kkbot/gateway: 调度中枢与 SQLite 状态机 (规划落地中)
│   └── web/                      # @kkbot/web: Vite + React 19 + shadcn/ui 控制台 (规划落地中)
├── legacy/                       # v1 单体架构代码完整归档 (供参考)
│   ├── src/
│   └── tests/
├── scripts/                      # 真机 E2E 验证、基准压测与交互脚本
├── docs/                         # PRD, 开发规范, ADR (0001, 0002), 探索研究报告
│   ├── adr/                      # ADR 架构决策记录
│   └── agents/                   # 领域模型与工单跟踪规范
├── .omp/                         # 团队共享 Agent Skills 与 MCP 扩展配置
├── package.json                  # 根工作区配置
├── pnpm-workspace.yaml           # pnpm workspace 定义
├── tsconfig.json                 # 根 TypeScript 配置
├── vitest.config.ts              # 根 Vitest 配置
└── eslint.config.js              # ESLint 9 Flat 配置
```

---

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Driver 核心入口 | `packages/driver/src/driver.ts` | `KK9Driver` 主类，集成 CDP、DOM 模块与事件系统 |
| CDP 通信客户端 | `packages/driver/src/cdp/client.ts` | 原生 WebSocket 封装、自动重连与心跳管理 |
| 会话操作与穿透 | `packages/driver/src/dom/session-ops.ts` | 会话列表读取、未读会话过滤、会话切换 |
| 消息解析与指纹 | `packages/driver/src/dom/message-ops.ts` | 消息历史提取、SHA-256 去重指纹、@提及与引用提取 |
| 发送与富文本 | `packages/driver/src/dom/send-ops.ts`, `rich-text.ts` | 文本、格式化富文本片段、文件卡片、图片发送 |
| 选择器与配置 | `packages/driver/src/dom/selectors.ts` | DOM 选择器配置与默认值解析 |
| 类型定义 | `packages/driver/src/types/index.ts` | 核心强类型定义（消息、会话、配置、员工档案等） |
| 架构决策 (ADR) | `docs/adr/` | 0001 (Agent 架构与安全防护), 0002 (soul.md 人设与私聊边界) |
| 领域术语表 | `CONTEXT.md` | 项目通用领域术语定义 |
| 归档代码 (v1) | `legacy/` | 旧版单体 store、ops、policy 等实现参考 |

---

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `KK9Driver` | class | `packages/driver/src/driver.ts:33` | 统一事件驱动入口，暴露收发、轮询、事件监听等接口 |
| `CdpClient` | class | `packages/driver/src/cdp/client.ts:37` | 底层 WebSocket CDP 通信客户端 |
| `SessionOps` | class | `packages/driver/src/dom/session-ops.ts:24` | 会话列表获取与切换逻辑 |
| `MessageOps` | class | `packages/driver/src/dom/message-ops.ts:24` | 消息提取、去重指纹计算、结构化解析 |
| `SendOps` | class | `packages/driver/src/dom/send-ops.ts:34` | 纯文本、富文本、文件与图片发送操作 |
| `KK9Session` | interface | `packages/driver/src/types/index.ts:113` | 聊天会话元数据 |
| `KK9Message` | interface | `packages/driver/src/types/index.ts:126` | 结构化消息实体（含指纹、@信息、引用信息、多模态附件） |
| `KK9Employee` | interface | `packages/driver/src/types/index.ts` | 员工档案与组织架构类型 |
| `SendResult` | interface | `packages/driver/src/types/index.ts:195` | 发送操作结果与快捷撤回方法 |
| `createChildLogger` | function | `packages/driver/src/utils/logger.ts:21` | pino 子日志器工厂函数 |

---

## CONVENTIONS

**TypeScript:**
- Strict mode ALL checks enabled（严格类型检查）
- 严禁 `any` 或 `as any`（ESLint 强制报错）
- ESM NodeNext 规范：所有相对路径导入必须携带 `.js` 扩展名
- 类型导入导出统一使用 `import type` 与 `export type`

**模块规范:**
- 子包 `src/index.ts` 集中导出公开 API
- 自定义错误继承 `Error` 并保留 `originalCause`
- 模块顶部统一声明 `const log = createChildLogger('module-name')`
- 日志与代码注释一律使用**中文**

**命名规范:**
- 文件名：kebab-case (`cdp-client.ts`, `session-ops.ts`)
- 类名：PascalCase (`KK9Driver`, `CdpClient`)
- 函数与变量：camelCase (`getRecentMessages`, `sendText`)
- 常量：UPPER_SNAKE (`DEFAULT_SELECTORS`)

---

## ANTI-PATTERNS (THIS PROJECT)

- **严禁使用 `as any`** - 必须书写严谨的类型定义与类型守卫
- **严禁未捕获的 Floating Promise** - 必须 `await` 或显式处理异常
- **严禁在源码中使用 `console.log`** - 必须使用 pino 子日志器
- **严禁在 `@kkbot/driver` 中引入数据库或写文件依赖** - 保持纯净 0 数据库依赖
- **严禁后台静默清除未读红点** - 视觉红点守卫原则，避免人工客服漏单
- **严禁相对导入遗漏 `.js` 后缀** - NodeNext ESM 强制要求

---

## COMMANDS

```bash
# 工作区基础指令
pnpm build              # 递归编译所有子包 (tsc -b)
pnpm typecheck          # 全局 TypeScript 静态检查
pnpm test               # 运行所有单元测试 (Vitest)
pnpm test:watch         # 监听模式运行单元测试
pnpm lint               # ESLint 检查
pnpm format             # Prettier 代码格式化

# 单包指定操作
pnpm --filter @kkbot/driver test      # 仅测试 driver 包
pnpm --filter @kkbot/driver build     # 仅编译 driver 包

# 真机诊断与验证
pnpm tsx scripts/e2e-live-verification.ts    # 真机 E2E 链路验证
```

---

## INITIALIZATION & RUNTIME FLOW

### 1. 核心架构分层

```
Electron (KK9.exe: 9222)
    ↑ (CDP WebSocket)
@kkbot/driver (纯净 I/O 驱动)
    ├─ 事件派发: status, message, at, recalled, heartbeat
    └─ 指令调用: sendText, sendRichText, sendFile, recallMessage, getOrgEmployees
    ↑
@kkbot/gateway (调度中枢)
    ├─ 会话生命周期与排队锁
    ├─ SQLite 持久化 (WAL 模式)
    ├─ 组织架构定时同步 (每日 03:00) & CSV 导出
    └─ 视觉红点守护
    ↑
@kkbot/agent (Mastra 认知微内核)
    ├─ 3-Tier 记忆 (L1 滑动窗口, L2 增量滚动摘要, L3 实体画像)
    ├─ 1v1 私聊物理隔离 (threadId / resourceId)
    ├─ 工具调用 (Zod Tool) + 外部 MCP 动态桥接
    ├─ 公共知识库 RAG + 严格防幻觉兜底
    ├─ 生产级防护 (Snooze 15min 人工静默, AbortSignal 打断, 2~3s 防抖, HITL 审批)
    └─ 声明式 soul.md 人设动态加载
```

### 2. 消息处理与事件流

```
1. CdpClient 建立 WebSocket 连接并保持心跳 (10s)
2. MessageOps / Polling / EventBridge 检测到新消息
3. 计算 SHA-256 唯一指纹进行幂等去重
4. 派发 driver.emit('message', msg) 及针对 @我/全体 的 driver.emit('at', msg)
5. Gateway 接收消息并执行防抖 (Debounce 2~3s)
6. 检查人工接管状态 (若进入 Snooze 15min 则静默)
7. 调用 Agent 认知微内核生成回复 (结合 L1/L2/L3 记忆与 RAG 知识库)
8. 执行 Tool Calling (只读工具直接执行，高危工具触发 HITL 60s 挂起审批)
9. Driver 调用底层发送 API 完成消息递送，返回包含 recall() 快捷撤回的 SendResult
```

### 3. 关闭与资源释放

```
1. 停止监听与轮询循环
2. 优雅断开 CDP WebSocket 连接并释放心跳定时器
3. 关闭 SQLite 数据库连接并刷新 WAL 检查点
4. 退出 Node.js 进程
```

---

## Architecture Design

- Do not add compatibility layers, fallback paths, or migrations for unconfirmed compatibility requirements. If the task involves public APIs, persisted data, external consumers, or rolling deployments, first identify the actual compatibility constraints. If none exist, remove obsolete paths directly.
- Choose the simplest implementation that fully satisfies the current requirements and acceptance criteria. Avoid speculative abstractions, configuration, extension points, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Introduce an abstraction only when it solves a concrete problem already present in the code, such as repeated behavior or multiple real implementations.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on dependencies already present in the project before writing a custom implementation or adding new packages. Do not assume a library lacks a capability without checking its documentation, types, and existing usage in the codebase.
- For module boundaries, data models, and dependency directions that must be decided now, choose designs that can remain valid long term. Do not accept stopgap implementations that are knowingly meant to be replaced later, but do not build extension frameworks for hypothetical future requirements.
- Before designing a new product interaction, public interface, protocol, or architectural pattern, study how established products solve the same problem. Prefer proven patterns and conventions over inventing an approach from scratch. Do not perform unrelated research for local fixes or problems already covered by clear project conventions.
- Simplicity must not come at the expense of correctness, security, testability, or explicitly required operational behavior.

## Working Method

- Before modifying code, read the relevant implementation, tests, type definitions, configuration, and call paths. Do not start implementing based only on file names, isolated snippets, or assumptions.
- Follow the project's existing directory structure, naming conventions, error-handling patterns, and testing conventions. Introduce a new convention only when the existing ones cannot satisfy the requirement.
- Change only the code required to complete the current task. Do not opportunistically refactor unrelated modules, rename unrelated symbols, reformat unrelated files, or solve problems outside the requested scope.
- If you discover a problem outside the task scope, report the problem and its impact, but do not modify it unless it blocks the requested work.
- When a requirement is ambiguous, first determine whether the ambiguity affects external behavior, persisted data, public interfaces, or architectural boundaries. Ask the user when the decision has meaningful consequences. Otherwise, use the smallest reasonable assumption and state it explicitly.

## Verification

- When behavior changes, add or update tests that verify the changed behavior. Prefer testing externally observable behavior over internal implementation details.
- After making changes, run the tests, type checks, static analysis, and build commands directly relevant to the modification.
- Never claim that tests pass, the build succeeds, or an issue is fixed unless the corresponding verification was actually run.
- Report the commands that were actually run, their results, and anything that remains unverified.
- Do not make checks pass by hardcoding test data, bypassing validation, weakening assertions, suppressing errors, or deleting failing tests.
- Do not swallow errors or use silent fallbacks to hide failures. Preserve enough error context for the problem to be diagnosed.

## Communication Style

When explaining work to the user:
- Use natural, direct Chinese by default.
- Give the conclusion first, followed by the reasons and relevant details.
- Do not explain one abstract concept using another abstract concept.
- Keep each sentence focused on one main judgment whenever possible.
- Keep each paragraph focused on one purpose.
- When introducing a technical term for the first time, immediately explain it in plain Chinese.
- Prefer concrete examples involving files, commands, data flows, or operations over purely theoretical explanations.
- Do not repeat context merely for completeness.
- Do not expand the user's request without a clear reason.
- When a process is complex, clearly explain:
  1. what step is currently being performed;
  2. why this step is necessary;
  3. what result this step will produce;
  4. what the user needs to do next.
- Unless explicitly requested, avoid stiff academic language, marketing language, and unnatural translated phrasing.
