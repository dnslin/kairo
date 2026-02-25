# CDP MODULE

## OVERVIEW

CDP (Chrome DevTools Protocol) connection manager with auto-reconnect, heartbeat monitoring, and typed event emission.

## KEY FILES

| File | Lines | Purpose |
| --- | --- | --- |
| `connector.ts` | 359 | Main CdpConnector class |
| `index.ts` | 3 | Re-export |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| Connect to CDP | `connector.ts:89` - `connect()` |
| Target discovery | `connector.ts:127` - `discoverTarget()` |
| WebSocket setup | `connector.ts:151` - `connectWebSocket()` |
| Send CDP command | `connector.ts:183` - `sendCommand()` |
| Evaluate JS | `connector.ts:212` - `evaluate()` |
| Heartbeat | `connector.ts:225` - `startHeartbeat()` |
| Handle disconnect | `connector.ts:257` - `handleDisconnect()` |
| Reconnect logic | `connector.ts:269` - `scheduleReconnect()` |

## STATE MACHINE

```
disconnected → connecting → connected
                    ↓            ↓
              (error)    → reconnecting → connected
                              ↓
                    (max retries) → disconnected
```

## EVENTS

| Event | Payload | When |
| --- | --- | --- |
| `connected` | - | WebSocket open, ready |
| `disconnected` | `reason: string` | Connection lost |
| `reconnecting` | `attempt, maxRetries` | Retry scheduled |
| `heartbeat` | `uptimeMs` | Every 10s when connected |
| `error` | `Error` | Max retries exceeded |
| `status_change` | `status, previousStatus` | Any state transition |

## RECONNECT CONFIG

From `CdpConfig.reconnect`:

- `maxRetries`: default 5
- `baseDelayMs`: exponential backoff base
- `maxDelayMs`: cap on delay

Formula: `delay = min(baseDelay * 2^attempt, maxDelay)`

## ANTI-PATTERNS

- **Don't call `sendCommand()` without connection check** - throws CdpConnectionError
- **Don't ignore `error` event** - indicates permanent failure
- **5+ reconnect attempts triggers alert** - see line 298
