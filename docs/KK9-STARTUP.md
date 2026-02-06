# KK9 客户端 CDP 启动指南

## 概述

KKBot 通过 Chrome DevTools Protocol (CDP) 连接到 KK9 Electron 客户端。要启用此功能，需要使用特定参数启动 KK9。

## 启动命令

### Windows

```powershell
# 方式一：命令行启动
"C:\Path\To\KK9.exe" --remote-debugging-port=9222

# 方式二：创建快捷方式
# 1. 右键 KK9.exe -> 创建快捷方式
# 2. 右键快捷方式 -> 属性
# 3. 在「目标」末尾添加参数：--remote-debugging-port=9222
# 4. 完整示例："C:\Program Files\KK9\KK9.exe" --remote-debugging-port=9222
```

## 验证连接

启动后，在浏览器访问以下地址验证 CDP 是否可用：

```
http://127.0.0.1:9222/json
```

成功响应示例：
```json
[
  {
    "description": "",
    "devtoolsFrontendUrl": "...",
    "id": "...",
    "title": "KK9",
    "type": "page",
    "url": "file:///...renderer.html",
    "webSocketDebuggerUrl": "ws://127.0.0.1:9222/devtools/page/..."
  }
]
```

## 运行 KKBot

```bash
# 开发模式
pnpm dev

# 运行稳定性测试（10分钟）
pnpm tsx scripts/stability-test.ts
```

## 注意事项

1. **窗口状态**：KK9 客户端窗口必须保持非最小化状态，否则 DOM 可能不可靠
2. **安全性**：CDP 端口仅监听 127.0.0.1，仅本机可访问
3. **端口冲突**：确保 9222 端口未被其他程序占用
4. **单实例**：同一时间只能运行一个带 CDP 参数的 KK9 实例

## 故障排查

| 问题 | 原因 | 解决方案 |
|------|------|----------|
| 无法连接 127.0.0.1:9222 | KK9 未启动或未带参数 | 确认使用 --remote-debugging-port=9222 启动 |
| 连接超时 | 端口被防火墙阻止 | 检查 Windows 防火墙设置 |
| 找不到 renderer.html 页面 | KK9 尚未完全加载 | 等待 KK9 完全启动后再运行 KKBot |
| 连接不稳定 | 窗口被最小化 | 使用 Win+Tab 将 KK9 放到独立虚拟桌面 |
