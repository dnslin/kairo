# KKBOT KNOWLEDGE BASE

**Generated:** 2026-02-28  
**Commit:** 6bb9408  
**Branch:** master

## OVERVIEW

CDP-based auto-reply bot for KK9 Electron client. Connects via Chrome DevTools Protocol to poll DOM for messages, generate LLM replies, and send responses. Stack: TypeScript ESM + Node 20+ + pino + better-sqlite3 + OpenAI SDK.

**语言要求：你必须使用中文进行交流，所有日志和代码注释都必须使用中文。**

## STRUCTURE

```
kkbot/
├── src/
│   ├── index.ts          # Entry point - main() with shutdown handlers
│   ├── cdp/              # CDP connection + WebSocket + auto-reconnect
│   ├── config/           # YAML loader + hot-reload watcher + type definitions
│   ├── dom/              # DOM queries via CDP Runtime.evaluate (637 lines)
│   ├── extract/          # Message extraction + SHA-256 fingerprint dedup
│   ├── watch/            # Polling watcher - triggers on new messages
│   ├── policy/           # Whitelist/blacklist + session type + working hours filter
│   ├── llm/              # OpenAI-compatible client with sensitive word filter
│   ├── send/             # Text + image sender via DOM manipulation + clipboard
│   ├── store/            # SQLite persistence (better-sqlite3, WAL mode)
│   ├── ops/              # Web console - Express API + React SPA dashboard
│   ├── types/            # (empty - types inline per module)
│   └── utils/            # pino logger factory
├── tests/                # Vitest unit tests (mirrors src/ structure)
├── scripts/              # Manual verification & diagnostic scripts (17 files)
├── docs/                 # PRD + development standards + KK9 startup guide
└── .sisyphus/            # Draft issues and plans
```

## WHERE TO LOOK


| Task               | Location                   | Notes                                                                        |
| ------------------ | -------------------------- | ---------------------------------------------------------------------------- |
| CDP connection     | `src/cdp/connector.ts`     | WebSocket, reconnect, heartbeat, evaluate()                                  |
| DOM queries        | `src/dom/locator.ts`       | getSessions(), getMessages(), clickSendButton(), setInputText()              |
| Config schema      | `src/config/schema.ts`     | Plain TS interfaces (NOT Zod) - AppConfig is root type                       |
| Config loading     | `src/config/loader.ts`     | YAML parse, env var resolution `${VAR}`, singleton getConfig()               |
| Config hot-reload  | `src/config/watcher.ts`    | chokidar file watcher for selector changes                                   |
| Message extraction | `src/extract/extractor.ts` | MessageExtractor wraps DomLocator, adds fingerprint                          |
| Polling loop       | `src/watch/watcher.ts`     | MessageWatcher polls at configurable interval                                |
| Policy decisions   | `src/policy/engine.ts`     | PolicyEngine.shouldProcess() - whitelist &gt; blacklist &gt; type &gt; hours |
| LLM integration    | `src/llm/client.ts`        | OpenAI SDK, strips `<think>` tags, sensitive word filter                     |
| Send messages      | `src/send/sender.ts`       | Text via setInputText(), images via clipboard paste                          |
| SQLite storage     | `src/store/store.ts`       | Fingerprint dedup, session history, event log                                |
| Web console        | `src/ops/server.ts`        | Express API + React SPA dashboard (127.0.0.1:3000)                           |
| Entry point        | `src/index.ts`             | CdpConnector init, event wiring, graceful shutdown                           |
| Verify CDP         | `scripts/phase0-verify.ts` | Manual verification script                                                   |
| Dev standards      | `docs/DEVELOPMENT.md`      | Code conventions, git workflow, test standards                               |
| KK9 startup        | `docs/KK9-STARTUP.md`      | CDP launch flags, troubleshooting                                            |


## CODE MAP


| Symbol              | Type      | Location                      | Role                                          |
| ------------------- | --------- | ----------------------------- | --------------------------------------------- |
| `CdpConnector`      | class     | `src/cdp/connector.ts:51`     | CDP connection + reconnect + evaluate         |
| `DomLocator`        | class     | `src/dom/locator.ts:66`       | All DOM queries via CDP Runtime.evaluate      |
| `MessageExtractor`  | class     | `src/extract/extractor.ts:56` | Wraps DomLocator, adds fingerprint dedup      |
| `MessageWatcher`    | class     | `src/watch/watcher.ts:17`     | Polling loop, calls extractor on interval     |
| `PolicyEngine`      | class     | `src/policy/engine.ts:21`     | Whitelist/blacklist/type/hours filter         |
| `LlmClient`         | class     | `src/llm/client.ts:23`        | OpenAI chat completion + summary + validation |
| `Sender`            | class     | `src/send/sender.ts:24`       | Text + image send via DOM                     |
| `Store`             | class     | `src/store/store.ts:111`      | SQLite storage layer (905 lines)              |
| `OpsServer`         | class     | `src/ops/server.ts:52`        | Express web console + REST API                |
| `AppConfig`         | interface | `src/config/schema.ts:102`    | Root config type (12 sub-configs)             |
| `SessionInfo`       | interface | `src/dom/locator.ts:9`        | Chat session metadata                         |
| `MessageInfo`       | interface | `src/dom/locator.ts:19`       | Single message data                           |
| `Message`           | interface | `src/extract/extractor.ts:24` | Extracted message with fingerprint            |
| `ProcessDecision`   | interface | `src/policy/engine.ts:10`     | Policy allow/deny result                      |
| `OpsContext`        | interface | `src/ops/server.ts:27`        | Runtime dependencies for web console          |
| `getConfig`         | function  | `src/config/loader.ts:53`     | Singleton config accessor                     |
| `reloadConfig`      | function  | `src/config/loader.ts:60`     | Force config reload                           |
| `watchSelectors`    | function  | `src/config/watcher.ts:8`     | Hot-reload selectors on file change           |
| `createChildLogger` | function  | `src/utils/logger.ts:21`      | pino child logger factory                     |


## CONVENTIONS

**TypeScript:**

- Strict mode ALL checks enabled (see tsconfig.json - 15 strict flags)
- NO `any` - eslint `@typescript-eslint/no-explicit-any: error`
- `.js` extension required in imports (ESM NodeNext)
- `export type` for type-only exports (eslint `consistent-type-imports`)
- `import type` for type-only imports

**Module Pattern (every module follows this):**

- `index.ts` re-exports public API
- Custom `XxxError extends Error` with `originalCause: Error | undefined`
- `const log = createChildLogger('module-name')` at top
- Chinese log messages and JSDoc comments

**Naming:**

- Files: kebab-case (`cdp-connector.ts`)
- Classes: PascalCase (`CdpConnector`)
- Functions/vars: camelCase (`getMessage`)
- Constants: UPPER_SNAKE (`MAX_RETRY`)

## ANTI-PATTERNS (THIS PROJECT)

- **NO `as any`** - strict types enforced via eslint error
- **NO floating promises** - `@typescript-eslint/no-floating-promises: error`
- **NO console.log in src/** - use pino logger (eslint no-console off but convention enforced)
- **NO HTTP for messages** - KK9 uses TCP internally, only DOM polling works
- **NO Zod** - config uses plain TS interfaces (despite old notes mentioning Zod)
- **NO relative imports without `.js`** - TypeScript ESM NodeNext requirement

## COMMANDS

```bash
pnpm dev          # Watch mode (tsx)
pnpm build        # TypeScript compile
pnpm test         # Vitest watch
pnpm test:run     # Single run
pnpm test:coverage # Coverage report (v8)
pnpm lint:fix     # ESLint autofix
pnpm format       # Prettier
pnpm typecheck    # tsc --noEmit
```

## NOTES

- **KK9 requires** `--remote-debugging-port=9222` on startup (see `docs/KK9-STARTUP.md`)
- **Window must NOT be minimized** - DOM unreliable when hidden (use virtual desktop)
- **Messages via TCP** not HTTP - Network tab won't show them, only DOM polling works
- **Tests in `tests/`** directory - vitest.config.ts includes `tests/**/*.test.ts`
- **Scripts in `scripts/`** are manual verification/diagnostic tools, NOT unit tests
- **config.yaml** required at project root - supports `${ENV_VAR}` substitution
- **Web console** at `127.0.0.1:3000` - React SPA via CDN (no build step), Express backend
- **SQLite WAL mode** enabled for concurrent read performance
- **LLM strips `<think>` tags** from responses before sending
- **Image send** uses clipboard API (base64 → blob → navigator.clipboard.write → paste)

---

## INITIALIZATION &amp; RUNTIME FLOW

### 初始化顺序 (src/index.ts:79-361)

系统启动时按以下顺序初始化各模块：

```
Phase 1: 配置加载 (Line 83)
  └─ getConfig() → 读取 config.yaml + 环境变量替换

Phase 2: 数据存储初始化 (Line 86)
  └─ new Store(config.store)
     ├─ 创建/打开 SQLite 数据库
     ├─ 启用 WAL 模式 (pragma journal_mode = WAL)
     ├─ 初始化 6 个表 (processed_messages, sessions, session_messages, events, drafts, session_summaries)
     ├─ 预编译 22 个 SQL 语句
     └─ store.logEvent('system_start')

Phase 3: CDP 连接器初始化 (Line 90)
  └─ new CdpConnector(config.cdp, config.page)
     ├─ 初始化 WebSocket 为 null
     ├─ 初始化状态为 'disconnected'
     └─ 继承 EventEmitter<CdpConnectorEvents>

Phase 4: CDP 事件监听器注册 (Line 92-111)
  ├─ connector.on('connected') → store.logEvent('cdp_connected')
  ├─ connector.on('disconnected', reason) → store.logEvent('cdp_disconnected')
  ├─ connector.on('heartbeat', uptimeMs) → 日志输出
  └─ connector.on('error', error) → store.logEvent('cdp_error')

Phase 5-10: 其他模块初始化
  ├─ new DomLocator(connector, config.selectors)
  ├─ new MessageExtractor(locator)
  ├─ new PolicyEngine(config.policy)
  ├─ new LlmClient(config.llm, config.validation)
  ├─ new Sender(locator, config.sender)
  └─ new MessageWatcher(extractor, config.watcher)

Phase 11: 消息处理回调定义 (Line 132-289)
  └─ processMessage(msg: Message) → 核心业务逻辑

Phase 12: Web 控制台初始化 (Line 292-318)
  └─ new OpsServer(config.ops, {...})

Phase 13: 连接 CDP (Line 333)
  └─ await connector.connect()
     ├─ 发现目标 (discoverTarget)
     ├─ 连接 WebSocket (connectWebSocket)
     ├─ 启动心跳 (startHeartbeat - 每 10 秒)
     └─ 发出 'connected' 事件

Phase 14-15: 启动服务
  ├─ await opsServer.start() → 监听 127.0.0.1:3000
  └─ watcher.start(processMessage) → 启动轮询循环

Phase 16: 注册关闭信号
  ├─ process.on('SIGINT')
  └─ process.on('SIGTERM')
```

### 模块间的完整连接 (Wiring)

```
CdpConnector (WebSocket 连接)
    ↓
    ├─→ DomLocator (使用 connector.evaluate 执行 JS)
    │       ↓
    │       ├─→ MessageExtractor (包装 DomLocator, 添加指纹)
    │       │       ↓
    │       │       └─→ MessageWatcher (轮询调用 extractor)
    │       │
    │       └─→ Sender (使用 locator 操作 DOM 发送)
    │
    ├─→ Store (记录事件, 保存消息)
    │
    ├─→ PolicyEngine (检查会话是否应处理)
    │
    ├─→ LlmClient (生成回复)
    │
    └─→ OpsServer (Web 控制台, 访问所有模块)
```

**关键连接点：**

- `CdpConnector.evaluate(script)` 是所有 DOM 操作的基础
- `DomLocator` 包装 CDP 调用，提供高级 API
- `MessageExtractor` 在 DomLocator 基础上添加指纹去重
- `MessageWatcher` 定期调用 `extractor` 获取新消息
- `processMessage` 回调是消息处理的入口点

### 事件流: poll → extract → policy → llm → send

#### 轮询循环 (MessageWatcher.poll - src/watch/watcher.ts:60-101)

```
1. 获取全部会话 (extractor.getAllSessions)
   └─ DomLocator.getAllSessions() 
      └─ connector.evaluate(script) 
         └─ 从 Vue 实例或 DOM 读取会话列表

2. 过滤未读会话 (sessions.filter(s => s.unread))

3. 如果无未读会话 → 回退到轮询当前会话 (pollCurrentSession)
   └─ extractor.getRecentMessages(maxMessages)
      └─ DomLocator.getMessages(n)
         └─ connector.evaluate(script)

4. 如果有未读会话 → 依次处理 (最多 maxSessionsPerCycle 个)
   ├─ 切换到会话 (extractor.getMessagesFromSession)
   │  ├─ locator.selectSession(sessionId)
   │  ├─ 等待 switchDelayMs (默认 500ms)
   │  └─ locator.getMessages(n)
   │
   └─ 对每条消息:
      ├─ 检查指纹是否已知 (knownFingerprints.has)
      ├─ 如果新消息 → 添加到已知集合
      └─ 调用 onNewMessage(msg) 回调
         └─ processMessage(msg)
```

#### 消息处理流程 (processMessage - src/index.ts:132-289)

```
1. 检查暂停状态 → if (paused) return

2. 检查去重 (持久化) → if (store.isProcessed(msg.fingerprint)) return

3. 获取当前会话 → locator.getCurrentSession()

4. 策略检查 → policy.shouldProcess(currentSession)
   ├─ 白名单检查 (isWhitelisted)
   ├─ 黑名单检查 (isBlacklisted)
   ├─ 工作时间检查 (isWithinWorkingHours)
   └─ 会话类型检查 (checkSessionType)

5. 标记已处理 → store.markProcessed(msg.fingerprint)

6. 读取上下文
   ├─ store.getSessionHistory(sessionId, contextMessages)
   └─ store.getLatestSummary(sessionId)

7. 保存接收消息 → store.saveMessage(sessionId, {...}, sessionName)

8. 调用 LLM → llmClient.generateReply(currentMsg, history, summaryContext)
   ├─ 构建消息列表 (system + history + current)
   ├─ 调用 OpenAI API
   ├─ 移除 <think> 标签
   ├─ 检查敏感词
   └─ 截断到 maxReplyLength

9. 根据模式处理回复
   ├─ draft_only: store.saveDraft(...) + store.saveMessage(...)
   └─ auto_send: sender.send(reply) + store.saveMessage(...)

10. 异步生成摘要 (不阻塞)
    └─ tryGenerateSummary(sessionId, store, llmClient, summaryIntervalMessages)
```

### 关闭/清理序列 (Shutdown - src/index.ts:321-329)

```
shutdown() 函数:
  1. 日志: '正在关闭...'
  
  2. 停止消息监听
     └─ watcher.stop()
        ├─ 设置 running = false
        ├─ 清除待处理的 sleep 超时
        └─ 日志: '停止消息监听'
  
  3. 停止 Web 控制台
     └─ await opsServer.stop()
        ├─ 关闭 HTTP 服务器
        └─ 日志: 'Web 控制台已停止'
  
  4. 断开 CDP 连接
     └─ connector.disconnect()
        ├─ 清除重连计时器
        ├─ 停止心跳 (clearInterval)
        ├─ 关闭 WebSocket
        ├─ 拒绝所有待处理回调
        ├─ 设置状态为 'disconnected'
        └─ 日志: '已断开 CDP 连接'
  
  5. 记录系统停止事件
     └─ store.logEvent('system_stop')
  
  6. 关闭数据库
     └─ store.close()
        ├─ db.close()
        └─ 日志: '数据库连接已关闭'
  
  7. 退出进程
     └─ process.exit(0)

触发条件:
  ├─ process.on('SIGINT') - Ctrl+C
  └─ process.on('SIGTERM') - 系统信号
```

### 关键数据流

**消息指纹去重：**

```
Message 唯一性 = SHA-256(sessionId + sender + time + content)
  ↓
store.isProcessed(fingerprint) 检查
  ↓
store.markProcessed(fingerprint) 标记
```

**会话历史上下文：**

```
store.getSessionHistory(sessionId, n)
  ├─ 从 SQLite 读取最近 n 条消息 (按时间倒序)
  ├─ 反转为正序 (最旧在前)
  └─ 返回 SessionMessage[] {sender, content, isFromSelf, createdAt}
```

**会话摘要上下文：**

```
store.getLatestSummary(sessionId)
  ├─ 从 SQLite 读取最新摘要
  └─ LLM 使用摘要作为系统消息补充
```

### 错误处理和恢复

**CDP 连接失败：**

```
connector.connect() 失败
  ├─ 抛出 CdpConnectionError
  ├─ 设置状态为 'disconnected'
  ├─ 发出 'error' 事件
  └─ main() 捕获 → 记录事件 → 关闭数据库 → process.exit(1)
```

**CDP 连接丢失：**

```
WebSocket 'close' 事件
  ├─ handleDisconnect(reason)
  ├─ 停止心跳
  ├─ 发出 'disconnected' 事件
  └─ scheduleReconnect()
     ├─ 指数退避: delay = min(baseDelay * 2^attempt, maxDelay)
     ├─ 最多重试 maxRetries 次 (默认 5)
     ├─ 5+ 次尝试后发出 'error' 事件
     └─ 自动重连 (不阻塞主线程)
```

**消息处理失败：**

```
processMessage() 异常
  ├─ LLM 调用失败 → 记录事件 → 返回 (不发送)
  ├─ 发送失败 → 记录事件 → 返回
  └─ 摘要生成失败 → 记录日志 → 继续 (不影响主流程)
```

### 性能优化

- **预编译 SQL 语句**：Store 初始化时预编译 22 个语句，避免每次查询时重新编译
- **SQLite WAL 模式**：允许并发读取（多个读者可同时读）
- **异步摘要生成**：tryGenerateSummary() 不阻塞消息处理，使用 summaryInProgress Set 防止并发
- **消息指纹缓存**：MessageWatcher.knownFingerprints Set 内存中缓存已处理指纹

### 配置热重载

```
src/config/watcher.ts:8 - watchSelectors()
  ├─ 监听 config.yaml 文件变化
  ├─ 文件变化时:
  │  ├─ 重新加载配置
  │  └─ 调用 locator.updateSelectors(newSelectors)
  └─ 不需要重启应用
```





## Architecture Design  
  
- Do not add compatibility layers, fallback paths, or migrations for unconfirmed  
  compatibility requirements. If the task involves public APIs, persisted data,  
  external consumers, or rolling deployments, first identify the actual  
  compatibility constraints. If none exist, remove obsolete paths directly.  
  
- Choose the simplest implementation that fully satisfies the current  
  requirements and acceptance criteria. Avoid speculative abstractions,  
  configuration, extension points, and indirection.  
  
- Grow the system in layers. Start from the smallest version that works  
  end to end, and add each new capability on top of a product that already  
  works. Never trade a working product for unfinished complexity.  
  
- Keep components modular and concerns clearly separated.  
  
- Introduce an abstraction only when it solves a concrete problem already  
  present in the code, such as repeated behavior or multiple real  
  implementations.  
  
- Prefer established, well-maintained libraries when they reduce overall  
  complexity or improve reliability. Do not reimplement common functionality  
  without a clear reason.  
  
- Lean on dependencies already present in the project before writing a custom  
  implementation or adding new packages. Do not assume a library lacks a  
  capability without checking its documentation, types, and existing usage  
  in the codebase.  
  
- For module boundaries, data models, and dependency directions that must be  
  decided now, choose designs that can remain valid long term. Do not accept  
  stopgap implementations that are knowingly meant to be replaced later, but  
  do not build extension frameworks for hypothetical future requirements.  
  
- Before designing a new product interaction, public interface, protocol, or  
  architectural pattern, study how established products solve the same  
  problem. Prefer proven patterns and conventions over inventing an approach  
  from scratch. Do not perform unrelated research for local fixes or problems  
  already covered by clear project conventions.  
  
- Simplicity must not come at the expense of correctness, security,  
  testability, or explicitly required operational behavior.  
  
  
## Working Method  
  
- Before modifying code, read the relevant implementation, tests, type  
  definitions, configuration, and call paths. Do not start implementing based  
  only on file names, isolated snippets, or assumptions.  
  
- Follow the project's existing directory structure, naming conventions,  
  error-handling patterns, and testing conventions. Introduce a new convention  
  only when the existing ones cannot satisfy the requirement.  
  
- Change only the code required to complete the current task. Do not  
  opportunistically refactor unrelated modules, rename unrelated symbols,  
  reformat unrelated files, or solve problems outside the requested scope.  
  
- If you discover a problem outside the task scope, report the problem and its  
  impact, but do not modify it unless it blocks the requested work.  
  
- When a requirement is ambiguous, first determine whether the ambiguity affects  
  external behavior, persisted data, public interfaces, or architectural  
  boundaries. Ask the user when the decision has meaningful consequences.  
  Otherwise, use the smallest reasonable assumption and state it explicitly.  
  
  
## Verification  
  
- When behavior changes, add or update tests that verify the changed behavior.  
  Prefer testing externally observable behavior over internal implementation  
  details.  
  
- After making changes, run the tests, type checks, static analysis, and build  
  commands directly relevant to the modification.  
  
- Never claim that tests pass, the build succeeds, or an issue is fixed unless  
  the corresponding verification was actually run.  
  
- Report the commands that were actually run, their results, and anything that  
  remains unverified.  
:  
- Do not make checks pass by hardcoding test data, bypassing validation,  
  weakening assertions, suppressing errors, or deleting failing tests.  
  
- Do not swallow errors or use silent fallbacks to hide failures. Preserve  
  enough error context for the problem to be diagnosed.  
  
  
## Communication Style  
  
When explaining work to the user:  
  
- Use natural, direct Chinese by default.  
  
- Give the conclusion first, followed by the reasons and relevant details.  
  
- Do not explain one abstract concept using another abstract concept.  
  
- Keep each sentence focused on one main judgment whenever possible.  
  
- Keep each paragraph focused on one purpose.  
  
- When introducing a technical term for the first time, immediately explain it  
  in plain Chinese.  
  
- Prefer concrete examples involving files, commands, data flows, or operations  
  over purely theoretical explanations.  
  
- Do not repeat context merely for completeness.  
  
- Do not expand the user's request without a clear reason.  
  
- When a process is complex, clearly explain:  
  1. what step is currently being performed;  
  2. why this step is necessary;  
  3. what result this step will produce;  
  4. what the user needs to do next.  
  
- Unless explicitly requested, avoid stiff academic language, marketing  
  language, and unnatural translated phrasing.