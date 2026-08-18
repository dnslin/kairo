# UTILS MODULE

## OVERVIEW

共享工具库，提供 pino 日志工厂。所有模块使用 `createChildLogger(name)` 创建子日志记录器。

## KEY FILES

| File | Lines | Purpose |
| --- | --- | --- |
| `logger.ts` | 23 | pino 日志工厂 |
| `index.ts` | 2 | Re-export |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| 创建日志记录器 | `logger.ts:21` - `createChildLogger(name)` |
| 根日志记录器 | `logger.ts:1` - `logger` 实例 |

## LOGGER CONFIGURATION

从 `LoggingConfig` 读取：

```yaml
logging:
  level: info              # 日志级别
  transport:
    target: pino-pretty   # 格式化输出
    options:
      colorize: true
      translateTime: SYS:standard
      ignore: pid,hostname
```

## PUBLIC API

```typescript
export const logger: pino.Logger
export function createChildLogger(name: string): pino.Logger
```

## USAGE PATTERN

所有模块在顶部创建子日志记录器：

```typescript
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('module-name');

// 使用
log.info({ key: value }, '消息');
log.warn({ err: error }, '警告');
log.error({ err: error }, '错误');
log.debug({ data }, '调试信息');
```

## DEPENDENCIES

**External**: `pino`  
**Internal**: None

## ANTI-PATTERNS

- **不要使用 console.log** - 使用 pino logger
- **不要在日志中包含敏感信息** - 使用 maskText() 或类似方法
