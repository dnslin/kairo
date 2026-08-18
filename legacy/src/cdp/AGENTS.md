# CDP MODULE

## OVERVIEW

CDP (Chrome DevTools Protocol) 连接管理器，提供 WebSocket 连接、自动重连、心跳监控和类型化事件发射。

## KEY FILES

| File           | Lines | Purpose         |
| -------------- | ----- | --------------- |
| `connector.ts` | 359   | CdpConnector 类 |
| `index.ts`     | 3     | Re-export       |

## WHERE TO LOOK

| Task           | Location                                   |
| -------------- | ------------------------------------------ |
| 连接 CDP       | `connector.ts:89` - `connect()`            |
| 目标发现       | `connector.ts:127` - `discoverTarget()`    |
| WebSocket 建立 | `connector.ts:151` - `connectWebSocket()`  |
| 发送 CDP 命令  | `connector.ts:183` - `sendCommand()`       |
| 执行 JS        | `connector.ts:212` - `evaluate()`          |
| 心跳检测       | `connector.ts:225` - `startHeartbeat()`    |
| 断连处理       | `connector.ts:257` - `handleDisconnect()`  |
| 重连逻辑       | `connector.ts:269` - `scheduleReconnect()` |

## STATE MACHINE

```
disconnected → connecting → connected
                    ↓            ↓
              (error)    → reconnecting → connected
                              ↓
                    (max retries) → disconnected
```

## EVENTS

| Event           | Payload                  | When                     |
| --------------- | ------------------------ | ------------------------ |
| `connected`     | -                        | WebSocket open, ready    |
| `disconnected`  | `reason: string`         | Connection lost          |
| `reconnecting`  | `attempt, maxRetries`    | Retry scheduled          |
| `heartbeat`     | `uptimeMs`               | Every 10s when connected |
| `error`         | `Error`                  | Max retries exceeded     |
| `status_change` | `status, previousStatus` | Any state transition     |

## RECONNECT CONFIG

从 `CdpConfig.reconnect` 读取：

- `maxRetries`: 默认 5
- `baseDelayMs`: 指数退避基数
- `maxDelayMs`: 延迟上限

公式：`delay = min(baseDelay * 2^attempt, maxDelay)`

## ANTI-PATTERNS

- **不要未检查连接状态就调用 `sendCommand()`** - 抛出 CdpConnectionError
- **不要忽略 `error` 事件** - 表示永久失败
- **5+ 次重连尝试会触发告警** - 见 connector.ts:298
