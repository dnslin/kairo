# OPS MODULE

## OVERVIEW

Web 控制台服务器，提供 HTTP API 和 React SPA 前端用于系统监控和草稿管理。最高耦合度（依赖 6 个其他模块）。前端通过 CDN 加载 React 18 + TailwindCSS，无构建步骤。

## KEY FILES

| File | Lines | Purpose |
| --- | --- | --- |
| `server.ts` | 370 | OpsServer 类 + Express 路由 |
| `page.ts` | 401 | HTML 页面生成 |
| `index.ts` | 3 | Re-exports |

## WHERE TO LOOK

| Task | Location |
| --- | --- |
| 启动服务器 | `server.ts:69` - `start()` |
| 停止服务器 | `server.ts:85` - `stop()` |
| 设置中间件 | `server.ts:100` - `setupMiddleware()` |
| 设置路由 | `server.ts:120` - `setupRoutes()` |
| 生成 HTML | `page.ts:1` - `getHtmlPage()` |

## HTTP API ENDPOINTS

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | 返回 HTML 页面 |
| `/api/status` | GET | 系统状态 |
| `/api/drafts` | GET | 获取所有草稿 |
| `/api/drafts/:id` | GET | 获取单个草稿 |
| `/api/drafts/:id/send` | POST | 发送草稿 |
| `/api/drafts/:id/discard` | POST | 丢弃草稿 |
| `/api/pause` | POST | 暂停系统 |
| `/api/resume` | POST | 恢复系统 |

## CONFIGURATION

从 `OpsConfig` 读取：

```yaml
ops:
  host: 127.0.0.1        # 仅本地监听
  port: 3000             # HTTP 端口
```

## PUBLIC API

```typescript
export class OpsServer {
  start(): Promise<void>
  stop(): Promise<void>
}

export class OpsServerError extends Error {
  originalCause?: Error
}

export interface OpsContext {
  store: Store;
  connector: CdpConnector;
  sender: Sender;
  locator: DomLocator;
  mode: OperationMode;
  isPaused: () => boolean;
  setPaused: (paused: boolean) => void;
  isWithinWorkingHours: () => boolean;
}
```

## DEPENDENCIES

**External**: `express`, `node:http`  
**Internal**: `store/index.js` (Store), `cdp/index.js` (CdpConnector), `send/index.js` (Sender), `dom/index.js` (DomLocator), `config/schema.js` (OpsConfig, OperationMode), `utils/logger.js`

## ERROR HANDLING

错误包装在 `OpsServerError` 中。HTTP 错误返回 JSON 格式。

## ANTI-PATTERNS

- **不要暴露内部 API** - 仅监听 127.0.0.1
- **不要在 API 中阻塞** - 使用异步操作
- **不要信任用户输入** - 验证所有参数

## FRONTEND ARCHITECTURE

- React 18 via ESM CDN (`esm.sh`)，`React.createElement` 直接调用（无 JSX）
- TailwindCSS via CDN（运行时编译）
- 单个 `getHtmlPage()` 函数返回完整 HTML 字符串
- 所有前端代码内联在 `page.ts` 的模板字符串中
- API 通过 `fetch()` 调用 `/api/*` 端点