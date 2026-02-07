# KKBOT KNOWLEDGE BASE

**Generated:** 2026-02-07  
**Commit:** 16638b9  
**Branch:** feat/dom-locator

## OVERVIEW

CDP-based auto-reply bot for KK9 Electron client. Connects via Chrome DevTools Protocol to monitor messages, generate LLM replies, and send responses.

**语言要求：你必须使用中文进行交流，所有日志和代码注释都必须使用中文。**

## STRUCTURE

```
kkbot/
├── src/
│   ├── index.ts          # Entry point - main() with shutdown handlers
│   ├── cdp/              # CDP connection + WebSocket management
│   ├── config/           # YAML config loader + Zod schema
│   ├── dom/              # DOM selectors for message/session extraction
│   ├── types/            # (empty - types inline)
│   └── utils/            # pino logger factory
├── scripts/              # Verification & test scripts
├── docs/                 # PRD + development standards
└── .sisyphus/            # Draft issues and plans
```

## WHERE TO LOOK

| Task                  | Location                   | Notes                                                |
| --------------------- | -------------------------- | ---------------------------------------------------- |
| CDP connection logic  | `src/cdp/connector.ts`     | WebSocket, reconnect, heartbeat                      |
| DOM element selectors | `src/dom/locator.ts`       | Session/message extraction via CDP evaluate          |
| Config schema         | `src/config/schema.ts`     | Zod validation, CdpConfig/PageConfig/SelectorsConfig |
| Config loading        | `src/config/loader.ts`     | YAML parsing, singleton pattern                      |
| Entry point           | `src/index.ts`             | Event wiring, graceful shutdown                      |
| Verify CDP works      | `scripts/phase0-verify.ts` | Manual verification script                           |

## CODE MAP

| Symbol               | Type      | Location                  | Role                         |
| -------------------- | --------- | ------------------------- | ---------------------------- |
| `CdpConnector`       | class     | `src/cdp/connector.ts:51` | Main CDP connection manager  |
| `CdpConnection`      | interface | `src/cdp/connector.ts:26` | WebSocket + page info        |
| `CdpConnectionError` | class     | `src/cdp/connector.ts:41` | Custom error with cause      |
| `DomLocator`         | class     | `src/dom/locator.ts:37`   | DOM queries via CDP evaluate |
| `SessionInfo`        | interface | `src/dom/locator.ts:9`    | Chat session metadata        |
| `MessageInfo`        | interface | `src/dom/locator.ts:19`   | Single message data          |
| `getConfig`          | function  | `src/config/loader.ts:42` | Singleton config accessor    |
| `KKBotConfig`        | type      | `src/config/schema.ts:56` | Root config type             |

## CONVENTIONS

**TypeScript:**

- Strict mode ALL checks enabled (see tsconfig.json)
- NO `any` - use `unknown` or specific types
- `.js` extension required in imports (ESM)
- `export type` for type-only exports

**Modules:**

- Each module has `index.ts` re-exporting public API
- Custom error classes extend Error with `originalCause`
- pino logger via `createChildLogger('module-name')`

**Naming:**

- Files: kebab-case (`cdp-connector.ts`)
- Classes: PascalCase (`CdpConnector`)
- Functions/vars: camelCase (`getMessage`)
- Constants: UPPER_SNAKE (`MAX_RETRY`)

## ANTI-PATTERNS (THIS PROJECT)

- **NO `as any`** - strict types enforced
- **NO floating promises** - eslint catches
- **NO console.log in src/** - use pino logger
- **NO HTTP for messages** - KK9 uses TCP, only DOM polling works

## NOT YET IMPLEMENTED (per PRD)

| Module         | Purpose                      | PRD Section |
| -------------- | ---------------------------- | ----------- |
| `src/extract/` | Message extraction           | Feature 3   |
| `src/watch/`   | Polling watcher              | Feature 4   |
| `src/policy/`  | Whitelist/blacklist/throttle | Feature 5   |
| `src/llm/`     | LLM client                   | Feature 6   |
| `src/send/`    | Message sender               | Feature 7   |
| `src/store/`   | SQLite persistence           | Feature 8   |
| `src/ops/`     | Web console                  | Feature 9   |

## COMMANDS

```bash
pnpm dev          # Watch mode (tsx)
pnpm build        # TypeScript compile
pnpm test         # Vitest watch
pnpm test:run     # Single run
pnpm lint:fix     # ESLint autofix
pnpm format       # Prettier
pnpm typecheck    # tsc --noEmit
```

## NOTES

- **KK9 requires** `--remote-debugging-port=9222` on startup
- **Window must NOT be minimized** - DOM unreliable when hidden
- **Messages via TCP** not HTTP - Network tab won't show them
- **Tests in scripts/** not tests/ - vitest.config expects tests/ but actual tests are in scripts/
- **config.yaml** required at project root (see config.example.yaml pattern in PRD)
