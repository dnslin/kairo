# KKBot Driver Agent Guide

所有交流、日志和代码注释使用中文。

## 范围

本仓库只保留 `@kkbot/driver`。修改前读取：

- 开发与验证：`docs/DEVELOPMENT.md`
- 真实 KK9 启动：`docs/KK9-STARTUP.md`
- 私有接口与 EventBridge 证据：`docs/KK9-LOWLEVEL-RESEARCH.md`

## 边界

- Driver 只负责 KK9 的 CDP 连接、运行时桥接、消息规范化和 I/O。
- 不引入 Agent、Memory、数据库、知识库、审批或业务编排职责。
- 行为变化必须同步更新 `packages/driver/tests`。
- 涉及真实 KK9 的修改必须通过对应真机脚本验证。
