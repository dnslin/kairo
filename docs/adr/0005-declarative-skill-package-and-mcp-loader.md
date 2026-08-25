# ADR 0005: 声明式 Skill 复合技能包与 MCP 自动加载器架构规范

## Status

Superseded

- **Superseded on**: 2026-08-24
- **Current replacement**: [ADR 0009：Mastra 运行时与 KKBot 业务事实边界](./0009-mastra-runtime-and-kkbot-business-fact-boundaries.md)、[KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §4.10–§4.12
- **Resolved by**: [#135 MCP 与 Processor 生命周期](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389833290)、[#161 高危动作范围](https://github.com/dnslin/kkbot/issues/161)、[#168 兼容版本锁定](https://github.com/dnslin/kkbot/issues/168#issuecomment-5403080615)、[#124 最终验收矩阵](https://github.com/dnslin/kkbot/issues/124)
- **Historical note**: 以下 `McpClientManager`、动态 Tool 热更新、`requireApproval` 和审批继承正文只保留当时背景，不再是当前产品或实施依据。

## Context

KKBot v2 的底层 `@kkbot/agent` 已经具备了 `McpClientManager` 连接能力与 `LayeredPromptCompiler` 提示词编译体系，但缺乏声明式的文件加载机制。
业务开发与运营人员需要类似于现代 Agent 工具（如 Claude Code / Oh My Pi）的低门槛扩展体验：能够通过在 `config/mcp.json` 中配置全局外部工具，或在 `skills/` 目录下放置独立业务文件夹，即可无缝让 Agent 获取新业务能力，且支持零停机热重载与安全审批隔离。

## Decision

### 1. 统一声明式 MCP 加载器 (`DeclarativeMcpLoader`)

- **配置文件路径**：默认从 `config/mcp.json` 读取全局 MCP 服务配置（格式兼容标准 `mcpServers`）；
- **参数支持**：在 `AgentRuntimeConfig` 中提供 `mcpConfigPath?: string`（默认 `config/mcp.json`）；
- **传输协议支持**：支持 `stdio` 与 `sse` 传输协议；
- **命名空间隔离 (`ToolNamespacingPolicy`)**：全局工具统一自动注入前缀 `global_${serverId}_${toolName}`，防止与内部工具冲突。

### 2. 高内聚复合技能包规范 (`SkillPackage`)

每个业务技能作为一个独立的自包含目录存放在 `skills/<name>/` 中，结构如下：

```
skills/hr-service/
├── SKILL.md             # [必需] 顶部 YAML Frontmatter + 业务 SOP 正文
├── mcp.json             # [可选] 该技能专用的局部 MCP 服务配置
└── knowledge/           # [可选] 该技能专用的 Markdown 领域知识切片
```

### 3. 严格 Frontmatter Schema 规范 (`SkillManifest`)

`SKILL.md` 顶部必须包含经过 Zod 严格校验的 YAML Frontmatter：

```yaml
---
name: hr-service # 技能唯一 ID (英文字符串)
displayName: 人事服务助手 # 友好展示名
description: 处理请假、考勤与证明开具 # 供意图路由识别的简要描述
triggers: # 意图触发关键词与规则列表
  - 请假
  - 调休
  - 年假
  - 在职证明
priority: 10 # 冲突优先级 (数字越大越优先)
readOnly: false # 是否包含写操作
requireApproval: true # 是否涉及高危/需主管审批
---
```

### 4. 两阶段动态激活与有界多意图合并 (`BoundedMultiSkillActivation`)

- **阶段 1（常驻意图注册）**：系统启动或热更新时，仅提取所有技能的 `SkillManifest` 注册到意图路由表；
- **阶段 2（动态上下文注入）**：当用户消息命中技能意图时，动态提取该技能的 `SKILL.md` 正文指令注入当前会话上下文；
- **多意图仲裁**：单轮会话允许至多激活命中度最高的 **2 个** 技能，在 Prompt 中指示大模型分段依次处理两项诉求。

### 5. 动态知识库合并检索 (`ScopedKnowledgeMerge`)

- 当某个带有 `knowledge/` 目录的 Skill 被激活时，系统动态将该技能目录下的 Markdown 文档切片合并进当前 RAG 检索空间，优先计算该技能下的高相关度切片。

### 6. 工具命名与安全审批继承 (`SkillApprovalInheritance`)

- **局部工具前缀**：Skill 内部 `mcp.json` 加载的工具自动使用前缀 `skill_${skillName}_${toolName}`；
- **权限继承**：若 Skill 声明了 `requireApproval: true`，其内部加载的所有写操作工具（`readOnly: false`）默认全部自动开启 HITL 直属主管审批拦截。

### 7. 局部故障隔离与保底容错 (`SkillFaultIsolation`)

- 单个 Skill 的 YAML 解析错误或局部 MCP 连接失败仅触发 Warning/Error 日志与局部跳过，严禁阻断主 Agent 运行；
- 遵循 Fail-Safe 原则，保障企业 IM 生产服务的可用性。

### 8. 全量双轨热重载 (`Full Lifecycle Hot-Reload`)

- 基于 `chokidar` 监听 `config/mcp.json` 与 `skills/` 目录；
- `SKILL.md` 变动 ➔ 自动重新编译提示词与路由表并派发 `skill_reloaded` 事件；
- `mcp.json` 变动 ➔ 自动断开旧连接、重连新服务并更新 `ToolRegistry`。

## Consequences

- **Positive**:
  - **业务扩展零代码侵入**：新增业务场景仅需在 `skills/` 新建目录，业务/运营人员开箱即用；
  - **环境与安全隔离**：业务生产配置与本地开发工具链彻底隔离，工具具备严格命名空间与主管审批继承；
  - **极高 Token 利用率**：采用两阶段激活与动态知识库合并，杜绝多技能全局提示词与知识库噪音爆炸；
  - **高可用与零停机维护**：具备局部故障隔离与全量文件热重载能力。
- **Tradeoffs / Risks**:
  - 需要在运行时管理文件系统监听器与子进程资源，系统关闭时必须显式调用 `close()` 释放句柄；
  - 多技能激活上限控制在 2 个，极端复杂多意图需要依赖模型拆解分步引导。
