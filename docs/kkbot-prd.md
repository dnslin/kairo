# Product Requirements Document: KKBot v2 智能企业级 IM 机器人

**Version**: 2.0  
**Date**: 2026-08-18  
**Status**: In Progress (Monorepo v2 Architecture)  
**Quality Score**: 96/100

---

## 1. Executive Summary

KKBot v2 是一个面向 Windows 企业级客户端（KK9.exe）的现代 IM 机器人与 Agent 认知网关系统。在无需修改宿主 Electron 客户端源码的前提下，通过纯净独立的 CDP 驱动层（`@kkbot/driver`）与基于 Mastra 的现代认知微内核（`@kkbot/agent`），实现深层会话穿透、原生富文本/文件收发、双轨消息撤回闭环、企业组织架构同步、3-Tier 记忆系统、MCP 工具调用以及人机混合协作守护。

本项目采用 **Driver First** 与 **Greenfield Monorepo** 架构，重构为高内聚、低耦合的模块化体系。

---

## 2. Architecture & Subpackages (架构分层)

```
kkbot/
├── packages/
│   ├── driver/           # @kkbot/driver: 纯净事件驱动 CDP 底层 (0 数据库依赖)
│   ├── agent/            # @kkbot/agent: Mastra 认知微内核 (Tool/MCP/Memory/RAG)
│   ├── gateway/          # @kkbot/gateway: 调度中枢与 SQLite 状态持久化
│   └── web/              # @kkbot/web: 独立运维前端 (Vite + React 19 + shadcn/ui)
├── docs/                 # PRD, 开发规范, ADR, 探索研究报告
├── scripts/              # 真机 E2E、压测与调试诊断脚本
└── .omp/                 # 团队共享 Agent Skills 与 MCP 扩展配置
```

### 核心分包定位

1. **`@kkbot/driver` (核心驱动)**:
   - 基于 Chrome DevTools Protocol 直连渲染进程，提供强类型、纯异步的会话和消息 I/O。
   - 提供双轨消息撤回 API (`res.recall()` 与 `driver.recallMessage()`)、`CancelMessage` 原生事件捕获。
   - 企业通讯录与员工档案抽取 (`driver.getOrgEmployees()`, `driver.getUserProfile()`)。
   - 视觉红点守护原则：默认严禁后台静默清除未读红点，仅暴露显式 `markSessionRead()` 接口。
   - 包含独立同构的原生事件桥 (`KK9EventBridge`)，支持零轮询极速事件直连。

2. **`@kkbot/agent` (智能认知微内核)**:
   - 基于 **Mastra 全家桶**（`@mastra/core` + `@mastra/memory` + `@mastra/mcp` + `@mastra/rag` + `@mastra/libsql`）。
   - 3-Tier 记忆系统：L1 短期滑动窗口 + L2 增量滚动摘要 + L3 实体画像语义检索；以 `threadId` 与 `resourceId` 实现 100% 物理级多会话隔离。
   - 人设与业务解耦：声明式 `soul.md` 独立配置文件，支持运行时热重载。
   - 会话范围：聚焦 **1v1 私聊单聊** 场景，群聊明确列为 Out of Scope。
   - 生产级防护：防人机冲突（Snooze 15 分钟静默 + AbortSignal 毫秒级打断）、消息防抖合并 (2~3s Debounce)、知识库双轨检索 + 严格防幻觉兜底、多模态 Vision/OCR 降级、高危工具人工在环审批 (HITL 60s 超时兜底)、主备模型故障转移 (Failover)。

3. **`@kkbot/gateway` (调度中枢与存储)**:
   - 基于 Ports & Adapters 架构，管理会话状态机、排队锁与消息流转。
   - 本地 SQLite 持久化 (better-sqlite3 WAL 模式)，包含消息表、会话表、事件日志表及 `org_employees` 组织架构表。
   - 定时任务调度器：每日凌晨 03:00 全量同步企业花名册并自动导出 `data/organization_roster.csv`。

4. **`@kkbot/web` (运维与监控控制台)**:
   - 基于 Vite + React 19 + TailwindCSS + shadcn/ui 构建的现代 Web SPA。
   - 提供连接状态监控、会话实时查看、HITL 人工审批流控制、提示词与知识库管理。

---

## 3. User Stories & Acceptance Criteria

### 1. 核心消息与会话穿透
- [x] 通过 WebSocket 直接与 KK9 渲染进程建立 CDP 会话，具备指数退避自动重连。
- [x] 支持 Vue 虚拟滚动列表穿透，获取真实未读会话与深层历史消息。
- [x] 支持纯文本、格式化富文本片段 (`FormattedText`)、本地文件卡片与多模态图片的发送与回读。

### 2. 消息撤回双轨 API 与事件闭环 (Issue #67)
- [ ] `sendText` / `sendRichText` / `sendFile` 返回的 `SendResult` 包含 `messageId` 与 `recall(): Promise<boolean>` 快捷撤回方法。
- [ ] `KK9Driver` 暴露全局方法 `recallMessage(messageId: string, session?: KK9Session | string): Promise<boolean>`。
- [ ] 内置发送者身份核验（仅允许撤回自己发出的消息）与客户端撤回超时拦截防护（默认 2 分钟）。
- [ ] 监听渲染进程 `CancelMessage` 原生事件并由 Driver 派发 `driver.on('recalled', { messageId, sessionId, sender, time })`。
- [ ] 存储层接收 `recalled` 事件后将本地数据库中的对应消息标记为 `isRecalled: true`。

### 3. 组织架构查询与本地持久化 (Issue #68, #69)
- [ ] 驱动层提供 `driver.getOrgEmployees(): Promise<KK9Employee[]>` 与 `driver.getUserProfile(userId): Promise<KK9Employee | null>`（0 数据库依赖）。
- [ ] 存储层在 SQLite 建立 `org_employees` 表，支持工号、真实姓名、职位等维度的毫秒级模糊检索。
- [ ] 系统启动首次同步，且每日凌晨 03:00 定时全量同步并导出 `data/organization_roster.csv`。

### 4. 智能微内核与生产级安全防护 (Issue #64, ADR 0001, ADR 0002)
- [ ] 基于 Mastra 建立独立 `@kkbot/agent`，按 `threadId`（会话级）与 `resourceId`（用户级）做 100% 物理级隔离。
- [ ] 声明式 `soul.md` 规范人设，支持口吻、禁忌词与业务规则运行时热重载。
- [ ] 2~3s 消息防抖：合并用户连发短消息后再调用 LLM。
- [ ] 知识库双轨检索 + 严格防幻觉：未检索到依据时诚实回答并引导转接人工。
- [ ] 人工接管保护：人工在客户端打字发言后自动进入 15 分钟静默期 (Snooze)，并使用 `AbortSignal` 强行打断在途推理。
- [ ] 高危工具 HITL 审批挂起机制，60s 无响应超时自动转人工。
- [ ] Reasoning 思考标签清洗：自动剔除 `<think>...</think>` 内容。

---

## 4. Technical Constraints & Non-Goals

1. **会话边界**: v2 首期严格限定为 **1v1 私聊单聊**，群聊在当前阶段明确为 Out of Scope。
2. **只读组织架构**: 仅从 KK 客户端只读抽取花名册，不支持反向向企业通讯录新增或修改员工。
3. **撤回时限**: 严格遵守客户端原生限制（默认 2 分钟），不尝试绕过服务端拦截。
4. **测试规范**: 所有单包必须具备 100% 离线 Vitest 单元测试覆盖，禁止在单测中依赖真实网络或正在运行的客户端。
