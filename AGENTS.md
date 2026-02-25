# KKBOT KNOWLEDGE BASE

**Generated:** 2026-02-25  
**Commit:** 6daf82a  
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
│   ├── dom/              # DOM selectors for session/message extraction (478 lines)
│   ├── extract/          # Message extraction + SHA-256 fingerprint dedup
│   ├── watch/            # Polling watcher - triggers on new messages
│   ├── policy/           # Whitelist/blacklist + session type + working hours filter
│   ├── llm/              # OpenAI-compatible client with sensitive word filter
│   ├── send/             # Text + image sender via DOM manipulation + clipboard
│   ├── store/            # SQLite persistence (better-sqlite3, WAL mode)
│   ├── types/            # (empty - types inline per module)
│   └── utils/            # pino logger factory
├── tests/                # Vitest unit tests (mirrors src/ structure)
├── scripts/              # Manual verification & diagnostic scripts (17 files)
├── docs/                 # PRD + development standards + KK9 startup guide
└── .sisyphus/            # Draft issues and plans
```

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| CDP connection | `src/cdp/connector.ts` | WebSocket, reconnect, heartbeat, evaluate() |
| DOM queries | `src/dom/locator.ts` | getSessions(), getMessages(), clickSendButton(), setInputText() |
| Config schema | `src/config/schema.ts` | Plain TS interfaces (NOT Zod) - AppConfig is root type |
| Config loading | `src/config/loader.ts` | YAML parse, env var resolution `${VAR}`, singleton getConfig() |
| Config hot-reload | `src/config/watcher.ts` | chokidar file watcher for selector changes |
| Message extraction | `src/extract/extractor.ts` | MessageExtractor wraps DomLocator, adds fingerprint |
| Polling loop | `src/watch/watcher.ts` | MessageWatcher polls at configurable interval |
| Policy decisions | `src/policy/engine.ts` | PolicyEngine.shouldProcess() - whitelist > blacklist > type > hours |
| LLM integration | `src/llm/client.ts` | OpenAI SDK, strips `<think>` tags, sensitive word filter |
| Send messages | `src/send/sender.ts` | Text via setInputText(), images via clipboard paste |
| SQLite storage | `src/store/store.ts` | Fingerprint dedup, session history, event log |
| Entry point | `src/index.ts` | CdpConnector init, event wiring, graceful shutdown |
| Verify CDP | `scripts/phase0-verify.ts` | Manual verification script |
| Dev standards | `docs/DEVELOPMENT.md` | Code conventions, git workflow, test standards |
| KK9 startup | `docs/KK9-STARTUP.md` | CDP launch flags, troubleshooting |

## CODE MAP

| Symbol | Type | Location | Role |
| --- | --- | --- | --- |
| `CdpConnector` | class | `src/cdp/connector.ts:51` | CDP connection + reconnect + evaluate |
| `DomLocator` | class | `src/dom/locator.ts:61` | All DOM queries via CDP Runtime.evaluate |
| `MessageExtractor` | class | `src/extract/extractor.ts:54` | Wraps DomLocator, adds fingerprint dedup |
| `MessageWatcher` | class | `src/watch/watcher.ts:17` | Polling loop, calls extractor on interval |
| `PolicyEngine` | class | `src/policy/engine.ts:21` | Whitelist/blacklist/type/hours filter |
| `LlmClient` | class | `src/llm/client.ts:23` | OpenAI chat completion + validation |
| `Sender` | class | `src/send/sender.ts:24` | Text + image send via DOM |
| `Store` | class | `src/store/store.ts:111` | SQLite storage layer |
| `AppConfig` | interface | `src/config/schema.ts:95` | Root config type (13 sub-configs) |
| `SessionInfo` | interface | `src/dom/locator.ts:9` | Chat session metadata |
| `MessageInfo` | interface | `src/dom/locator.ts:19` | Single message data |
| `Message` | interface | `src/extract/extractor.ts:24` | Extracted message with fingerprint |
| `ProcessDecision` | interface | `src/policy/engine.ts:10` | Policy allow/deny result |
| `getConfig` | function | `src/config/loader.ts:53` | Singleton config accessor |
| `reloadConfig` | function | `src/config/loader.ts:60` | Force config reload |
| `watchSelectors` | function | `src/config/watcher.ts:8` | Hot-reload selectors on file change |
| `createChildLogger` | function | `src/utils/logger.ts:21` | pino child logger factory |

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

## NOT YET IMPLEMENTED

| Module | Purpose | PRD Section |
| --- | --- | --- |
| `src/ops/` | Web console (HTTP dashboard) | Feature 9 |

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
- **SQLite WAL mode** enabled for concurrent read performance
- **LLM strips `<think>` tags** from responses before sending
- **Image send** uses clipboard API (base64 → blob → navigator.clipboard.write → paste)
