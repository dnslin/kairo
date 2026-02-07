# KKBOT Architecture Overview

**Generated:** 2026-02-07  
**Purpose:** Complete architectural understanding for Feature 4 (Polling Watcher) implementation

---

## 1. MAIN ENTRY POINT & APPLICATION FLOW

### Entry Point: `src/index.ts`

```
main()
  ├─ Load config via getConfig()
  ├─ Create CdpConnector instance
  ├─ Wire event listeners:
  │  ├─ 'connected' → log connection established
  │  ├─ 'disconnected' → log with reason
  │  ├─ 'heartbeat' → log uptime metrics
  │  └─ 'error' → fatal error handling
  ├─ Call connector.connect()
  │  └─ Returns CdpConnection { ws, pageUrl, targetId }
  ├─ Register SIGINT/SIGTERM handlers → shutdown()
  └─ Keep process alive (event loop)
```

**Flow Characteristics:**
- Async/await pattern throughout
- Event-driven architecture (EventEmitter)
- Graceful shutdown on signals
- Error propagates to process.exit(1)

---

## 2. MODULE STRUCTURE

### 2.1 CDP Module (`src/cdp/`)

**Purpose:** Chrome DevTools Protocol connection management

**Files:**
- `connector.ts` (360 lines) - Main CdpConnector class
- `index.ts` (3 lines) - Re-exports

**Key Classes:**
```typescript
class CdpConnector extends EventEmitter<CdpConnectorEvents> {
  // Connection state
  private ws: WebSocket | null
  private status: ConnectionStatus
  private isConnected: boolean
  
  // Timers
  private heartbeatInterval: ReturnType<typeof setInterval> | null
  private reconnectTimer: ReturnType<typeof setTimeout> | null
  
  // Methods
  async connect(): Promise<CdpConnection>
  async sendCommand(method: string, params?): Promise<CdpResponse>
  async evaluate(expression: string): Promise<unknown>
  disconnect(): void
  getStatus(): ConnectionStatus
  isActive(): boolean
  getUptime(): number
}
```

**Events Emitted:**
| Event | Payload | When |
|-------|---------|------|
| `connected` | - | WebSocket open, ready |
| `disconnected` | `reason: string` | Connection lost |
| `reconnecting` | `attempt, maxRetries` | Retry scheduled |
| `heartbeat` | `uptimeMs: number` | Every 10s when connected |
| `error` | `Error` | Max retries exceeded |
| `status_change` | `status, previousStatus` | Any state transition |

**State Machine:**
```
disconnected → connecting → connected
                    ↓            ↓
              (error)    → reconnecting → connected
                              ↓
                    (max retries) → disconnected
```

**Reconnect Logic:**
- Exponential backoff: `delay = min(baseDelay * 2^attempt, maxDelay)`
- Default: baseDelay=1000ms, maxDelay=30000ms, maxRetries=5
- Alert triggered at 5+ attempts (line 298)

---

### 2.2 DOM Module (`src/dom/`)

**Purpose:** DOM element extraction via CDP evaluate

**Files:**
- `locator.ts` (403 lines) - Main DomLocator class
- `index.ts` (12 lines) - Re-exports

**Key Class:**
```typescript
class DomLocator {
  constructor(
    private readonly connector: CdpConnector,
    private selectors: SelectorsConfig
  ) {}
  
  // Session queries
  async getSessions(): Promise<SessionInfo[]>
  async getCurrentSession(): Promise<SessionInfo | null>
  async selectSession(sessionId: string): Promise<boolean>
  
  // Message queries
  async getMessages(limit = 20): Promise<MessageInfo[]>
  async getMessageNodes(): Promise<MessageNodesInfo>
  async getMessageList(): Promise<MessageListInfo>
  
  // Input/Send operations
  async getInputBox(): Promise<{ found: boolean; editable: boolean }>
  async setInputText(text: string): Promise<boolean>
  async getSendButton(): Promise<SendButtonInfo>
  async clickSendButton(): Promise<boolean>
  
  // Config updates
  updateSelectors(selectors: SelectorsConfig): void
}
```

**Data Types:**
```typescript
interface SessionInfo {
  id: string
  name: string
  type: 'private' | 'group'
  lastMessage: string
  time: string
  unread: boolean
  isSelected: boolean
}

interface MessageInfo {
  id: string
  sender: string
  content: string
  time: string
  isMe: boolean
}
```

**Error Handling:**
- Custom `DomLocatorError` extends Error with `originalCause`
- All methods catch errors and log via pino
- Failed operations return empty results or throw

---

### 2.3 Config Module (`src/config/`)

**Purpose:** YAML configuration loading and validation

**Files:**
- `schema.ts` (97 lines) - Zod schema definitions
- `loader.ts` (64 lines) - YAML parsing + singleton
- `watcher.ts` (35 lines) - File watcher for hot reload
- `index.ts` (18 lines) - Re-exports

**Key Functions:**
```typescript
function loadConfig(configPath?: string): AppConfig
function getConfig(): AppConfig  // Singleton
function reloadConfig(): AppConfig
function watchSelectors(
  configPath: string,
  callback: (selectors: SelectorsConfig) => void
): () => void  // Returns cleanup function
```

**Config Structure:**
```typescript
interface AppConfig {
  cdp: CdpConfig
  page: PageConfig
  selectors: SelectorsConfig
  watcher: WatcherConfig
  policy: PolicyConfig
  llm: LlmConfig
  validation: ValidationConfig
  mode: 'draft_only' | 'auto_send'
  ops: OpsConfig
  logging: LoggingConfig
}

interface WatcherConfig {
  intervalMs: number      // Polling interval
  maxMessages: number     // Max messages per poll
}
```

**Features:**
- Environment variable substitution: `${ENV_VAR}`
- Singleton pattern with caching
- Hot reload via chokidar file watcher
- Zod validation (strict types)

---

### 2.4 Utils Module (`src/utils/`)

**Purpose:** Shared utilities (logging)

**Files:**
- `logger.ts` (24 lines) - pino logger factory
- `index.ts` (2 lines) - Re-exports

**Logger Setup:**
```typescript
const logger = isDev
  ? pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:standard' }
      }
    })
  : pino({ level: process.env['LOG_LEVEL'] ?? 'info' })

function createChildLogger(name: string): pino.Logger {
  return logger.child({ module: name })
}
```

**Usage Pattern:**
```typescript
const log = createChildLogger('module-name')
log.info({ key: value }, 'message')
log.error({ err: error }, 'error message')
log.debug({ data }, 'debug info')
```

---

## 3. EXISTING WATCH/POLLING MECHANISMS

### 3.1 CDP Heartbeat (Built-in)

**Location:** `src/cdp/connector.ts:225-255`

```typescript
private startHeartbeat(): void {
  const intervalMs = 10000  // 10 seconds
  this.heartbeatInterval = setInterval(() => {
    void this.checkConnection()
  }, intervalMs)
}

private async checkConnection(): Promise<void> {
  if (!this.isConnected || !this.ws) return
  
  try {
    await this.sendCommand('Runtime.evaluate', {
      expression: '1',
      returnByValue: true
    })
    const uptimeMs = this.connectedAt ? Date.now() - this.connectedAt : 0
    this.emit('heartbeat', uptimeMs)
  } catch (error) {
    this.handleDisconnect('Heartbeat check failed')
  }
}
```

**Characteristics:**
- Fixed 10-second interval
- Detects connection loss
- Emits `heartbeat` event with uptime
- Triggers reconnect on failure

---

### 3.2 Config File Watcher (Existing)

**Location:** `src/config/watcher.ts`

```typescript
export function watchSelectors(
  configPath: string,
  callback: (selectors: SelectorsConfig) => void
): () => void {
  const watcher: FSWatcher = watch(configPath, {
    persistent: true,
    ignoreInitial: true
  })
  
  watcher.on('change', () => {
    try {
      const config = loadConfig(configPath)
      callback(config.selectors)
    } catch (error) {
      log.error({ err: error }, 'Failed to reload config')
    }
  })
  
  return () => void watcher.close()
}
```

**Characteristics:**
- Uses chokidar for file watching
- Event-driven (not polling)
- Returns cleanup function
- Error handling with logging

---

### 3.3 Reconnect Scheduling (Existing)

**Location:** `src/cdp/connector.ts:269-311`

```typescript
private scheduleReconnect(): void {
  const maxRetries = this.cdpConfig.reconnect.maxRetries
  const baseDelay = this.cdpConfig.reconnect.baseDelayMs
  const maxDelay = this.cdpConfig.reconnect.maxDelayMs
  
  if (this.reconnectAttempts >= maxRetries) {
    this.emit('error', new CdpConnectionError(...))
    return
  }
  
  const delay = Math.min
