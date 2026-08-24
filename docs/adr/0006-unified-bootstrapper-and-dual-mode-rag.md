# ADR 0006: 全局统一启动器 (Unified Bootstrapper) 与双模 RAG 架构

## Status

Superseded

- **Superseded on**: 2026-08-24
- **Superseded by**: [ADR 0010：唯一 Composition Root 与 Knowledge 生命周期](./0010-single-composition-root-and-knowledge-lifecycle.md)
- **Current specification**: [KKBot Mastra-native 重构总规格](../KKBot-Mastra-Native-Refactor-Spec.md) §2.7、§3.2、§4.18–§4.20、§4.27–§4.28、§9.6、§9.10、§12
- **Resolved by**: [#127《确定单数据库下的 Storage 连接边界》](https://github.com/dnslin/kkbot/issues/127#issuecomment-5389294656)、[#130《确定知识摄取故障与 OCR 回退语义》](https://github.com/dnslin/kkbot/issues/130#issuecomment-5391309063)、[#131《锁定 Mastra 兼容版本组》](https://github.com/dnslin/kkbot/issues/131)、[#133《确定 Node.js 运行时基线》](https://github.com/dnslin/kkbot/issues/133#issuecomment-5389347634)、[#135《确定 MCP 与 Processor 的生命周期和故障边界》](https://github.com/dnslin/kkbot/issues/135#issuecomment-5389833290)、[#136《确定 Knowledge 索引版本与原子替换协议》](https://github.com/dnslin/kkbot/issues/136)、[#137《确定资产保留的引用保护与清理恢复协议》](https://github.com/dnslin/kkbot/issues/137)、[#138《确定 Bootstrapper Preflight 与逆序回滚契约》](https://github.com/dnslin/kkbot/issues/138)
- **Open boundaries**: [#168 兼容版本研究](https://github.com/dnslin/kkbot/issues/168)、[#124 最终验收矩阵](https://github.com/dnslin/kkbot/issues/124)
- **Scope decision**: [#161 高危动作范围](https://github.com/dnslin/kkbot/issues/161)已使 Tool Approval 退出当前 Preflight 与 Ready Barrier 能力集合。
- **Historical note**: 以下 Context、Decision 与 Consequences 保留原文，仅用于说明当时的决策背景；旧四步关闭顺序、默认 Bigram 方案、固定超时和具体连接假设不再是当前依据。

## Context

KKBot v2 的底层驱动 (`@kkbot/driver`)、持久化仓储 (`@kkbot/store`)、认知微内核 (`@kkbot/agent`) 与会话协调器 (`@kkbot/gateway`) 已经分别完成并通过了单元与集成测试。
但在系统交付与应用装配层，缺少一个开箱即用的顶层启动入口（Bootstrapper），导致运行系统需要写脚本手动拼装各模块。
同时，针对企业现有的规章制度文档，需要明确兼顾成本与精度的知识库检索升级路径，并保持模块落地节奏的务实聚焦。

## Decision

### 1. 全局统一配置文件与 CLI 启动器 (`UnifiedBootstrapper`)

- **一键启动**：在项目根目录提供 `pnpm start`；
- **配置格式与路径**：核心配置收敛于 `config/config.yaml`（提供 `config.example.yaml` 供参考）；
- **环境变量插值与强校验**：启动时自动读取 `.env` 并对 `${VAR_NAME}` 进行插值替换，随后经过完整的 Zod Schema 强类型校验，100ms 内对缺漏或格式错误给出友好的中文高亮报错；
- **四步级联优雅停机 (`CascadedGracefulShutdown`)**：接收到 `SIGINT`/`SIGTERM` 时，严格按顺序释放资源：
  1. `Gateway` 停止接收新消息并排空在途请求（3s 超时保护）；
  2. `Driver` 优雅断开 CDP WebSocket；
  3. `Agent` 释放文件监听器与在途 AbortSignal；
  4. `Store` 刷新 WAL 检查点并安全关闭 LibSQL 数据库连接。

### 2. 双模知识库检索架构与无感容灾降级 (`DualModeKnowledgeEngine` & `KnowledgeFallbackPolicy`)

- **模式 1 (本地启发式切片，默认)**：0 成本、0 延迟，基于本地 Markdown 标题与段落语义切片和二元语法 (Bigram) 词频算分；
- **模式 2 (远程向量化与重排，可选)**：当在 `config.yaml` 中配置了 `rag.embedding` 与 `rag.rerank` 端点时，自动升级为基于 LibSQLVector 向量检索 + 神经重排模型的混合检索；
- **容灾无感降级**：当模式 2 遭遇网络抖动或超时（默认 3s）时，自动降级回模式 1 保证回答连续性，绝不阻断当次会话。

### 3. 落地演进节奏与范围收敛

- **第一阶段（当前优先）**：打通 `config.yaml` 统一配置解析、全系统一键 CLI 启动器与双模知识库；
- **第二阶段（后续演进）**：在业务工具稳定后，再实现目录式 `skills/` 复合包自动扫描器。

## Consequences

- **Positive**:
  - **极致开箱即用**：运维与开发者只需配置 `config.yaml` 即可 `pnpm start` 一键拉起完整机器人系统；
  - **配置与安全合规**：API Key 等敏感信息通过 `${VAR_NAME}` 与 `.env` 隔离，避免凭据硬编码进代码仓库；
  - **兼顾成本与精度**：无 API 时本地零成本运行，有 API 时无缝获得高质量向量 RAG；
  - **节奏聚焦务实**：暂缓复杂的 Skill 目录扫描器，聚焦保障主链路端到端可用。
- **Tradeoffs / Risks**:
  - 需要在配置加载器中实现严格的 Zod Schema 校验与清晰的启动错误提示。
