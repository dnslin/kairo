# KKBot Agent Guide

所有交流、日志和代码注释使用中文。

## Context pointers

- **产品范围或用户可见行为**：读取 `docs/kkbot-prd.md`；需求状态和阻塞关系以 GitHub Issues 为准。
- **修改代码、选择验证命令或查找包入口**：修改前读取 `docs/DEVELOPMENT.md`，再按其中的仓库导航进入实现、类型和测试。
- **启动真实 KK9、连接 CDP 或排查真机脚本**：读取 `docs/KK9-STARTUP.md`。
- **使用私有 IPC、运行时对象或 EventBridge 证据**：读取 `docs/KK9-LOWLEVEL-RESEARCH.md`，区分当前可复现证据、历史实机记录和静态逆向线索。
- **判断领域术语、架构边界或重构目标**：领域词汇读取 `CONTEXT.md`；架构和实施边界读取 `docs/KKBot-Mastra-Native-Refactor-Spec.md` 与状态有效的 `docs/adr/`。开放决策票的候选答案不作为已生效规则。

## Agent skills

### Issue tracker

GitHub Issues (`gh` CLI). See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context (`CONTEXT.md` + `docs/adr/`). See `docs/agents/domain.md`.
