# KKBot Driver 开发与验证

本仓库只维护 `@kkbot/driver`：一个面向 KK9 Windows 客户端的事件驱动 CDP Driver。

## 环境

- Node.js `>=22.13.0`
- pnpm
- 真实 KK9 验证需要 Windows 与可登录的 KK9 客户端

## 安装

```bash
pnpm install
```

## 常用命令

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
pnpm format
```

Driver 真机辅助命令：

```bash
pnpm verify
pnpm diagnose
pnpm e2e
```

运行真机命令前，先按 `KK9-STARTUP.md` 启动 KK9 与 CDP，并检查测试账号、会话和发送目标。`pnpm e2e` 还要求显式设置与实际用户、私聊 ID、群聊 ID 完全一致的 `KK9_REAL_TEST_CONFIRM`；离线测试不得替代真机验收。

## 代码入口

| 任务 | 位置 |
| --- | --- |
| Driver 公开 API 与生命周期 | `packages/driver/src/index.ts`, `packages/driver/src/driver.ts` |
| CDP 连接与调用 | `packages/driver/src/cdp/client.ts` |
| EventBridge 与消息转换 | `packages/driver/src/bridge/` |
| 会话、消息、发送与组织读取 | `packages/driver/src/dom/` |
| 卡片渲染 | `packages/driver/src/canvas/` |
| 离线测试 | `packages/driver/tests/` |
| 真机脚本 | `packages/driver/examples/` |

## 边界

- Driver 只负责 KK9 的 CDP、运行时桥接、消息规范化和 I/O。
- Driver 不持有数据库、Agent、Memory、知识库、审批或业务工作流。
- DOM、Vue 运行时对象和原始事件必须先规范化，再进入公开类型。
- 发送结果必须保留“触发前失败”和“触发后结果未知”的区别。
- 离线测试不得依赖 KK9、网络或真实账号。
