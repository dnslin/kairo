# KKBot 开发规范 (v2 Monorepo)

## 1. 技术栈

| 类别 | 选型 | 说明 |
| --- | --- | --- |
| 运行环境 | Node.js (>=20.0.0 LTS) | 推荐 Node 22+ |
| 语言 | TypeScript 5.7+ | Strict Mode (全严格模式) + ESM NodeNext |
| 包管理器 | pnpm 9+ / 10+ | Monorepo 工作区 (`pnpm-workspace.yaml`) |
| 底层通信 | WebSocket + CDP 原生协议 | @kkbot/driver 直连 Electron 调试端口 |
| 智能引擎 | Mastra 全家桶 (@mastra/core, @mastra/memory, @mastra/mcp, @mastra/rag) | @kkbot/agent 认知内核 |
| 数据库 | SQLite (better-sqlite3) | WAL 模式，预编译 SQL 语句 |
| Web 前端 | Vite + React 19 + TailwindCSS + shadcn/ui | @kkbot/web 运维控制台 |
| 日志体系 | pino | 结构化日志，子模块专用 logger |
| 单元测试 | Vitest 3.x | 100% 离线 Mock，支持监听模式与覆盖率 |
| 代码规范 | ESLint 9 (Flat Config) + Prettier 3 | 强制 NodeNext ESM `.js` 扩展名与禁止 `any` |

---

## 2. 项目结构

```
kkbot/
├── packages/
│   ├── driver/                   # @kkbot/driver: CDP 驱动层
│   │   ├── src/
│   │   │   ├── cdp/              # WebSocket 连接与 CDP 客户端
│   │   │   ├── dom/              # 会话、消息、富文本、发送等 DOM/IPC 操作
│   │   │   ├── types/            # 强类型定义 (KK9Message, KK9Session, KK9Employee 等)
│   │   │   ├── utils/            # 日志与错误类
│   │   │   ├── driver.ts         # KK9Driver 主类
│   │   │   └── index.ts          # 公开 API 导出
│   │   ├── tests/                # 离线 Vitest 单元测试
│   │   └── package.json
│   ├── agent/                    # @kkbot/agent: Mastra 认知内核 (规划中)
│   ├── gateway/                  # @kkbot/gateway: 调度中枢与 SQLite 状态机 (规划中)
│   └── web/                      # @kkbot/web: Vite React 运维控制台 (规划中)
├── legacy/                       # v1 单体架构归档代码 (保留供参考)
│   ├── src/
│   └── tests/
├── scripts/                      # 真机 E2E 验证、基准压测与调试脚本
├── docs/                         # PRD、开发规范、ADR 架构决策、探索研究报告
│   ├── adr/                      # ADR 0001, ADR 0002 等架构决策记录
│   └── agents/                   # 领域模型与工单跟踪规范
├── .omp/                         # 共享 Agent Skills 与 MCP 工具配置
├── package.json                  # 根工作区配置
├── pnpm-workspace.yaml           # pnpm workspace 定义
├── tsconfig.json                 # 根 TypeScript 配置
├── vitest.config.ts              # 根 Vitest 配置
└── eslint.config.js              # ESLint 9 Flat 配置
```

---

## 3. 开发命令

```bash
# 全局操作
pnpm build              # 递归编译所有子包 (tsc -b)
pnpm typecheck          # 全局 TypeScript 类型检查 (tsc --noEmit)
pnpm test               # 运行所有子包的单元测试 (vitest run)
pnpm test:watch         # 监听模式运行单元测试
pnpm lint               # ESLint 检查
pnpm format             # Prettier 自动格式化

# 单包定向操作
pnpm --filter @kkbot/driver test      # 仅运行 driver 包单元测试
pnpm --filter @kkbot/driver build     # 仅编译 driver 包

# 辅助诊断脚本
pnpm tsx scripts/e2e-live-verification.ts    # 真机端到端全链路验证
```

---

## 4. 代码与架构规范

### TypeScript 与导入规则
1. **严格类型**: 开启全部 15 项严格检查。**严禁使用 `any` 或 `as any`**。
2. **ESM 模块后缀**: 遵循 NodeNext 模块规范，所有相对路径 `import` 必须携带 `.js` 后缀（如 `import { CdpClient } from './cdp/client.js'`）。
3. **类型导入**: 必须使用 `import type { ... }` 和 `export type { ... }`。

### 模块组织模式
1. 每个子包必须有 `src/index.ts` 明确导出对外公开 API，不暴露内部实现细节。
2. 自定义错误继承内置 `Error`，并保留原因链（如 `originalCause`）。
3. 统一使用 `const log = createChildLogger('module-name')` 获取子日志器。
4. **语言要求**: 所有交流、代码注释、JSDoc 及日志内容必须使用**中文**。

### 架构边界与隔离
1. **驱动层零 DB 依赖**: `@kkbot/driver` 严格作为纯 I/O 驱动，绝不引入 `better-sqlite3` 或文件系统写入。
2. **红点保护原则**: 驱动层默认严禁在后台静默清除会话未读红点，避免人工客服漏单。
3. **测试可离线化**: 单元测试必须具备 100% 离线运行能力，使用 Mock CDP 模拟各种边缘场景，不得依赖真实客户端或网络连接。
