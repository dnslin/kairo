# Product Requirements Document: KKBot 自动回复机器人

**Version**: 1.0  
**Date**: 2026-02-05  
**Author**: Sarah (Product Owner)  
**Quality Score**: 91/100

---

## Executive Summary

KKBot 是一个基于 CDP（Chrome DevTools Protocol）的外挂式自动回复机器人，用于在不修改 Windows Electron 客户端（KK9.exe）的情况下，实现聊天消息的监控、LLM 智能回复生成和自动/半自动发送。

本项目面向技术人员自用场景，核心目标是**减少 50% 以上的人工回复工作量**。通过 Playwright 连接 CDP 端口，提取 DOM 中的消息内容，调用 LLM 生成回复草稿，经人工确认后自动发送，并提供 Web 控制台进行状态监控和日志查看。

---

## Problem Statement

**Current Situation**:

- KK9 客户端无公开 API，客户端源码丢失，无法从内部埋点
- 人工逐条回复消息耗时耗力，尤其在消息量大时效率低下
- 需要长时间保持客户端运行并手动监控

**Proposed Solution**:  
通过 CDP 远程调试协议连接 Electron 客户端，监控聊天消息变化，调用 LLM 生成智能回复，支持半自动（人工确认）和全自动两种模式，并提供 Web 控制台进行运维管理。

**Business Impact**:

- 减少 50%+ 人工回复工作量
- 7x24 小时稳定运行，无需持续人工盯守
- 可审计的操作日志，便于问题追溯

---

## Success Metrics

**Primary KPIs:**

| 指标             | 目标值      | 测量方法                       |
| ---------------- | ----------- | ------------------------------ |
| 人力成本节省     | ≥ 50%       | 对比使用前后每日人工回复时间   |
| 系统稳定运行时长 | ≥ 8 小时/次 | 监控日志中无异常退出           |
| 草稿采纳率       | ≥ 80%       | (直接发送数 / 总草稿数) × 100% |

**Validation**: 上线 1 周后统计日志数据，对比人工操作时间

---

## User Personas

### Primary: 技术运维人员

- **Role**: 内部技术人员 / 开发者
- **Goals**: 减少重复性消息回复工作，提高效率
- **Pain Points**: 需要长时间盯着客户端，手动逐条回复
- **Technical Level**: Advanced（熟悉命令行、配置文件、日志分析）

---

## User Stories & Acceptance Criteria

### Story 1: 监控新消息并生成回复草稿

**As a** 技术运维人员  
**I want to** 系统自动监控聊天窗口的新消息并调用 LLM 生成回复草稿  
**So that** 我不需要手动阅读和思考回复内容

**Acceptance Criteria:**

- [ ] 系统通过 CDP 连接到 KK9 客户端 (port 9222)
- [ ] 检测到新消息后 10 秒内生成回复草稿
- [ ] 草稿内容展示在控制台，等待人工确认
- [ ] 相同消息不重复处理（基于消息指纹去重）

### Story 2: 人工确认后发送回复

**As a** 技术运维人员  
**I want to** 在 Web 控制台查看草稿并一键确认发送  
**So that** 我可以在发送前审核内容，避免误发

**Acceptance Criteria:**

- [ ] 控制台显示待确认草稿列表（会话、原消息、草稿内容）
- [ ] 支持「发送」「编辑后发送」「丢弃」三种操作
- [ ] 发送成功后 DOM 中出现「已发送」消息节点
- [ ] 发送失败时记录日志并提示重试

### Story 3: 白名单/黑名单过滤

**As a** 技术运维人员  
**I want to** 配置哪些会话需要自动回复、哪些忽略  
**So that** 只处理需要关注的会话，避免打扰

**Acceptance Criteria:**

- [ ] 支持通过配置文件设置 whitelist / blacklist
- [ ] 黑名单会话的消息不触发 LLM 调用
- [ ] 白名单优先级高于黑名单
- [ ] 支持按会话名称、关键词匹配

### Story 4: 工作时间控制

**As a** 技术运维人员  
**I want to** 配置机器人的工作时间段  
**So that** 非工作时间不自动回复

**Acceptance Criteria:**

- [ ] 支持配置 workingHours（如 09:00-18:00）
- [ ] 非工作时间收到的消息暂存，不触发回复
- [ ] 控制台显示当前是否在工作时间内

### Story 5: Web 控制台状态监控

**As a** 技术运维人员  
**I want to** 通过 Web 控制台查看系统运行状态和日志  
**So that** 我可以远程监控和排查问题

**Acceptance Criteria:**

- [ ] 显示 CDP 连接状态（已连接/断开）
- [ ] 显示当前运行模式（草稿/自动）
- [ ] 显示最近 N 条操作日志（消息、草稿、发送结果）
- [ ] 支持一键暂停/恢复自动回复

---

## Functional Requirements

### Core Features

**Feature 1: CDP 连接管理 (cdpConnector)**

- 连接 `http://127.0.0.1:9222`，通过 Playwright `chromium.connectOverCDP()`
- 自动识别 renderer.html 页面
- 断线自动重连，超时告警

**Feature 2: DOM 定位器 (domLocator)**

- 维护 selector 配置，支持多路 fallback
- 定位：消息列表、消息节点、输入框、发送按钮、会话列表、未读标记
- Selector 热更新（配置文件修改后自动生效）

**Feature 3: 消息提取器 (messageExtractor)**

- 从 DOM 提取最近 N 条消息（发送方、时间、内容）
- **识别会话类型**：通过 DOM 中 `group` 标识区分群聊/私聊
- 规范化文本（去除空白、表情占位符）
- 生成消息指纹（会话ID + 发送方 + 时间/序号 + 文本hash）

**Feature 4: 消息监听器 (watcher)**

- 轮询模式：每 2-5 秒检查消息指纹变化
- 新消息触发 pipeline

**Feature 5: 策略引擎 (policyEngine)**

- 白名单/黑名单会话过滤
- **会话类型过滤**：支持按群聊/私聊类型过滤（DOM 中群聊带 `group` 标识）
- 工作时间段控制
- 节流：每会话最小间隔（60-180秒）、每日上限
- 模式切换：草稿模式 / 自动模式

**Feature 6: LLM 客户端 (llmClient)**

- 支持任意 OpenAI Compatible API（baseUrl + apiKey 配置）
- **会话隔离**：每个聊天会话独立维护上下文，A 的对话历史不会混入 B 的上下文
- **历史消息上下文**：可配置携带最近 N 条消息作为对话上下文（默认 5 条，0 = 不带），仅限当前会话内的消息
- Prompt 模板渲染（支持不同场景模板）
- 调用外部 LLM API（支持 timeout、retry、fallback）
- 回复校验（敏感词、长度、格式）

**Feature 7: 发送器 (sender)**

- 写入文本到输入框（处理 textarea/contenteditable）
- 触发必要事件（input/change/keydown）
- 点击发送按钮或模拟 Enter
- 发送后校验（DOM 中出现已发消息）

**Feature 8: 数据存储 (store - SQLite)**

- `processed_messages`: 已处理消息指纹
- `sessions`: 会话状态、最后回复时间、回复计数
- `session_messages`: 每个会话的历史消息（用于 LLM 上下文，按会话 ID 隔离）
- `events`: 操作日志（消息、草稿、发送结果、异常）

**Feature 9: Web 控制台 (ops)**

- Express + 简单前端页面
- 显示：CDP 状态、运行模式、待确认草稿、操作日志
- 操作：暂停/恢复、发送/丢弃草稿

### Out of Scope (MVP 不包含)

- 多客户端同时管理
- 图片/文件消息处理
- 复杂的对话上下文管理
- 移动端控制台

---

## Technical Constraints

### Performance

- 消息检测延迟 < 5 秒
- LLM 响应超时 30 秒
- 系统稳定运行 ≥ 8 小时无异常退出

### Security

- CDP 端口仅监听 127.0.0.1
- 敏感配置（API Key）不写入日志
- 控制台默认仅本地访问

### Integration

- **KK9 客户端**: 通过 `--remote-debugging-port=9222 --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding` 启动
- **LLM 服务**: 任意 OpenAI Compatible API（如 OpenAI、Azure OpenAI、Ollama、vLLM、LiteLLM 等）

### Technology Stack

- Runtime: Node.js 20+ (LTS)
- Browser Automation: Playwright
- Database: SQLite (better-sqlite3)
- Process Manager: PM2
- HTTP: undici / native fetch
- Logging: pino
- Config: YAML

### Deployment Constraints

- 客户端窗口必须保持非最小化（可使用 Win+Tab 虚拟桌面）
- 脚本与客户端在同一 Windows 用户会话中运行
- 不能以 Windows Service 方式运行（需要 UI 会话）

### Technical Notes (重要发现)

**会话类型区分：**

- 群聊和私聊在 DOM 结构上有区别
- 群聊会话的 DOM 元素中包含 `group` 关键字标识
- 策略引擎需要支持按会话类型（群聊/私聊）过滤

**消息通讯机制：**

- KK9 客户端的消息收发**不通过 HTTP 请求**
- 底层使用 TCP 长连接通讯，Network 面板几乎看不到消息相关请求
- 只能通过 DOM 变化检测新消息，无法通过拦截网络请求
- 这意味着必须依赖 DOM 轮询或 MutationObserver 方式监控消息

---

## MVP Scope & Phasing

### Phase 0: 环境验证 (1 天)

- 确认 DevTools 能稳定访问 renderer.html
- 固化 3 个关键定位：消息节点、输入框、发送按钮
- 在 DevTools console 验证读消息、写输入、触发发送

### Phase 1: MVP - 半自动回复 (1 周)

**核心功能：** 消息监控 → 提取 → LLM 生成草稿 → Web 控制台确认 → 发送

- [x] CDP 连接 + 页面识别
- [x] 消息提取 + 去重
- [x] LLM 调用 + 草稿生成
- [x] Web 控制台（状态 + 草稿列表 + 确认发送）
- [x] 白名单/黑名单过滤
- [x] 工作时间控制
- [x] 操作日志记录

**MVP Definition**: 能够监控消息、生成草稿、通过控制台确认发送，支持基本过滤

### Phase 2: 增强 - 全自动模式 (Post-MVP)

- 自动发送（无需人工确认）
- 每会话节流 + 每日上限
- 发送前校验（会话未切换、消息未变化）

### Phase 3: 运维增强 (Future)

- 未读会话优先处理
- 多路 selector fallback
- 健康检查 + 自动重启
- Metrics 导出

---

## Risk Assessment

| Risk                            | Probability | Impact | Mitigation Strategy               |
| ------------------------------- | ----------- | ------ | --------------------------------- |
| DOM 结构变化导致 selector 失效  | High        | High   | 多路 fallback + 配置热更新 + 告警 |
| 客户端窗口最小化导致 DOM 不可靠 | Medium      | High   | 文档明确约束 + 状态检测 + 告警    |
| LLM 生成不当回复                | Medium      | Medium | 敏感词过滤 + 人工确认模式         |
| CDP 连接断开                    | Medium      | Medium | 自动重连 + 断线告警               |

---

## Dependencies & Blockers

**Dependencies:**

- KK9 客户端支持 `--remote-debugging-port` 参数
- 外部 LLM API 可用
- Windows 环境 + Node.js 20+

**Known Blockers:**

- 无（技术验证已在 Phase 0 完成）

---

## Appendix

### Glossary

- **CDP**: Chrome DevTools Protocol，Chrome 远程调试协议
- **Selector**: CSS 选择器，用于定位 DOM 元素
- **消息指纹**: 消息的唯一标识（会话+发送方+时间+内容hash）
- **群聊**: DOM 中带有 `group` 标识的会话类型
- **私聊**: 非群聊的一对一会话

### Directory Structure

```
src/
├── index.ts          # 入口
├── config/           # YAML 配置加载
├── cdp/              # CDP 连接管理
├── dom/              # selector 定位
├── extract/          # 消息提取
├── watch/            # 消息监听
├── policy/           # 策略引擎
├── llm/              # LLM 客户端
├── send/             # 发送器
├── store/            # SQLite 存储
└── ops/              # Web 控制台
config.yaml           # 主配置
data/                 # SQLite + 日志
```

### Key Configuration Items

```yaml
cdp:
  url: http://127.0.0.1:9222

page:
  match: renderer.html

selectors:
  messageList: '...'
  messageNode: '...'
  inputBox: '...'
  sendButton: '...'

policy:
  whitelist: []
  blacklist: []
  sessionTypes: ['private', 'group'] # 允许的会话类型：private=私聊, group=群聊
  workingHours: '09:00-18:00'
  throttle:
    perSessionMinIntervalSeconds: 60
    dailyMaxPerSession: 50

llm:
  baseUrl: https://api.openai.com/v1 # 或其他 OpenAI Compatible API
  apiKey: sk-xxx
  model: gpt-4o-mini
  temperature: 0.7
  timeout: 30000
  contextMessages: 5 # 携带最近 N 条历史消息作为上下文（0 = 不带）

mode: draft_only # draft_only | auto_send
```

---

_This PRD was created through interactive requirements gathering with quality scoring to ensure comprehensive coverage of business, functional, UX, and technical dimensions._
