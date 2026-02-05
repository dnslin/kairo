# KKBot 开发规范

## 技术栈

| 类别               | 选型                  | 版本              |
| ------------------ | --------------------- | ----------------- |
| Runtime            | Node.js               | 22+ LTS           |
| Language           | TypeScript            | 5.x (strict mode) |
| Package Manager    | pnpm                  | 8+                |
| Browser Automation | Playwright            | latest            |
| Database           | SQLite                | better-sqlite3    |
| HTTP Client        | undici / native fetch | -                 |
| Logging            | pino                  | latest            |
| Config             | YAML                  | js-yaml           |
| Test               | Vitest                | latest            |
| Lint               | ESLint                | 9.x (flat config) |
| Format             | Prettier              | 3.x               |

## 项目结构

```
kkbot/
├── src/
│   ├── index.ts          # 入口
│   ├── config/           # 配置加载
│   │   ├── index.ts
│   │   ├── schema.ts     # 配置类型定义
│   │   └── loader.ts     # YAML 加载器
│   ├── cdp/              # CDP 连接管理
│   │   ├── index.ts
│   │   └── connector.ts
│   ├── dom/              # DOM 定位器
│   │   ├── index.ts
│   │   └── locator.ts
│   ├── extract/          # 消息提取
│   │   ├── index.ts
│   │   └── extractor.ts
│   ├── watch/            # 消息监听
│   │   ├── index.ts
│   │   └── watcher.ts
│   ├── policy/           # 策略引擎
│   │   ├── index.ts
│   │   └── engine.ts
│   ├── llm/              # LLM 客户端
│   │   ├── index.ts
│   │   └── client.ts
│   ├── send/             # 发送器
│   │   ├── index.ts
│   │   └── sender.ts
│   ├── store/            # 数据存储
│   │   ├── index.ts
│   │   ├── db.ts
│   │   └── migrations/
│   ├── ops/              # Web 控制台
│   │   ├── index.ts
│   │   ├── server.ts
│   │   └── routes/
│   ├── types/            # 类型定义
│   │   └── index.ts
│   └── utils/            # 工具函数
│       ├── index.ts
│       └── logger.ts
├── tests/                # 测试文件
│   └── *.test.ts
├── config.yaml           # 主配置文件
├── config.example.yaml   # 配置示例
├── data/                 # 运行时数据（gitignore）
│   ├── kkbot.db
│   └── logs/
├── docs/                 # 文档
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── eslint.config.js
├── prettier.config.js
├── vitest.config.ts
└── .gitignore
```

## 代码规范

### TypeScript

- 使用 `strict: true`
- 禁止 `any`，必须使用具体类型或 `unknown`
- 优先使用 `interface` 定义对象类型
- 使用 `type` 定义联合类型、交叉类型
- 导出类型时使用 `export type`

```typescript
// Good
interface Message {
  id: string;
  content: string;
  sender: string;
}

type MessageStatus = 'pending' | 'sent' | 'failed';

export type { Message, MessageStatus };

// Bad
const data: any = {};
```

### 模块导入

- 使用 ES Modules (`import`/`export`)
- 相对路径使用 `.js` 扩展名（TypeScript ESM 要求）
- 导入顺序：外部模块 → 内部模块 → 类型

```typescript
// Good
import { chromium } from 'playwright';
import { config } from '../config/index.js';
import type { Message } from '../types/index.js';
```

### 命名规范

| 类型      | 规范             | 示例               |
| --------- | ---------------- | ------------------ |
| 文件名    | kebab-case       | `cdp-connector.ts` |
| 类        | PascalCase       | `CdpConnector`     |
| 函数/变量 | camelCase        | `getMessage`       |
| 常量      | UPPER_SNAKE_CASE | `MAX_RETRY_COUNT`  |
| 类型/接口 | PascalCase       | `MessagePayload`   |
| 枚举值    | PascalCase       | `Status.Pending`   |

### 错误处理

- 使用自定义错误类
- 错误必须包含上下文信息
- 异步函数使用 try-catch

```typescript
export class CdpConnectionError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'CdpConnectionError';
  }
}

async function connect(): Promise<void> {
  try {
    await browser.connect();
  } catch (error) {
    throw new CdpConnectionError('Failed to connect', error as Error);
  }
}
```

### 日志规范

- 使用 pino logger
- 日志级别：`fatal` > `error` > `warn` > `info` > `debug` > `trace`
- 结构化日志，包含上下文

```typescript
import { logger } from '../utils/logger.js';

logger.info({ sessionId, messageCount: 5 }, 'Messages extracted');
logger.error({ err, sessionId }, 'Failed to send message');
```

### 异步处理

- 优先使用 `async/await`
- 避免回调地狱
- 并行操作使用 `Promise.all` / `Promise.allSettled`

```typescript
// Good
const [messages, session] = await Promise.all([
  extractor.getMessages(),
  store.getSession(sessionId),
]);

// Bad
getMessages().then(messages => {
  getSession().then(session => {
    // ...
  });
});
```

## Git 规范

### 分支命名

- `main` - 主分支
- `feat/xxx` - 功能分支
- `fix/xxx` - 修复分支
- `docs/xxx` - 文档分支

### Commit Message

使用 Conventional Commits:

```
<type>(<scope>): <subject>

<body>
```

| Type     | 说明      |
| -------- | --------- |
| feat     | 新功能    |
| fix      | Bug 修复  |
| docs     | 文档更新  |
| refactor | 重构      |
| test     | 测试      |
| chore    | 构建/工具 |

示例：

```
feat(cdp): implement auto-reconnect with exponential backoff

- Add reconnect logic with max 5 retries
- Use exponential backoff (1s, 2s, 4s, 8s, 16s)
- Emit 'reconnecting' event for status tracking
```

## 测试规范

- 单元测试文件命名：`*.test.ts`
- 测试覆盖率目标：核心模块 > 80%
- 使用 Vitest 的 `describe`、`it`、`expect`

```typescript
import { describe, it, expect, vi } from 'vitest';
import { CdpConnector } from '../src/cdp/connector.js';

describe('CdpConnector', () => {
  it('should connect successfully', async () => {
    const connector = new CdpConnector();
    await expect(connector.connect()).resolves.not.toThrow();
  });
});
```

## 配置文件规范

- 敏感信息使用环境变量
- 提供 `config.example.yaml` 示例
- 配置变更需要更新类型定义

```yaml
# config.yaml
llm:
  baseUrl: ${LLM_BASE_URL} # 支持环境变量
  apiKey: ${LLM_API_KEY}
```

## 依赖管理

- 使用 pnpm
- 锁定版本：`pnpm add -E <package>`
- 定期更新依赖：`pnpm update`
- 安全审计：`pnpm audit`

## 开发流程

1. 从 `main` 创建功能分支
2. 开发完成后运行 lint + test
3. 提交 PR，关联 Issue
4. Code Review 通过后合并

```bash
# 开发命令
pnpm dev          # 开发模式
pnpm build        # 构建
pnpm test         # 运行测试
pnpm lint         # 代码检查
pnpm lint:fix     # 自动修复
pnpm format       # 格式化
```
