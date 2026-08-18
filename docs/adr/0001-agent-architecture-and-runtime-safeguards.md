# ADR 0001: 基于 Mastra 全家桶的 Agent 架构与生产级运行时防护机制

## Status
Accepted

## Context
KKBot v2 需要一个独立的智能认知微内核（`@kkbot/agent`），负责 IM 客服场景下的多轮对话生成、工具调用、记忆管理和安全合规。
在真实 IM 运行环境下，面临长会话 Token 膨胀、多用户记忆串线、人工客服与机器人抢答、用户连发短消息、图片识别与高危工具误操作等生产级问题。

## Decision
1. **采用 Mastra 全家桶**（`@mastra/core`, `@mastra/memory`, `@mastra/mcp`, `@mastra/rag`, `@mastra/libsql`）作为 `@kkbot/agent` 的认知基座，彻底解耦底层 CDP/IM 传输。
2. **多用户与会话严格物理隔离**：
   - 使用 `threadId`（对应 KK9 `sessionId`）作为 L1 短期滑动窗口（最近 20 条）与 L2 增量滚动摘要（Working Memory）的隔离边界；
   - 使用 `resourceId`（对应 KK9 `senderId`）作为 L3 实体画像记忆的隔离边界。
3. **消息防抖机制 (Message Debounce)**：设置 2~3 秒防抖等待窗口，将用户短时间内连发的碎片化消息合并为单次上下文输入。
4. **知识库双轨检索 (Dual-Track Public Knowledge)**：支持本地 Markdown 文件夹（`data/knowledge/`）自动分块向量化 + 外部标准 MCP 知识库桥接。
5. **多模态与 OCR 降级策略**：优先使用 Vision 模型；针对纯文本模型，支持挂载 OCR MCP 工具提取图片文字，并在无文字时提供友好保底话术。
6. **人工在环审批与超时兜底 (HITL 60s Timeout)**：高危工具触发挂起审批；若 60 秒内无人工响应，自动结束挂起并输出“业务涉及资金/敏感操作，已为您转接人工客服”话术。
7. **人工接管滚动静默期 (Snooze 15min)**：检测到人工发送消息后，进入 15 分钟静默期；期间人工再次发言重置计时器；超时后新用户消息到达时自动恢复机器人接管。

## Consequences
- **Positive**: 消除 70%+ 自研底层代码负担；杜绝跨会话记忆串线；避免人机抢答与双胞胎回复事故；提升图片解析与高危操作安全性。
- **Tradeoffs / Risks**: 依赖 Mastra 社区的长期维护；需要维护本地 LibSQL/SQLite 文件的读写并发稳定性。
