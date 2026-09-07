# Kairo Driver 与应用开发和验证

本仓库维护 `@kairo/driver` 与 `@kairo/app`。Driver 是一个面向 KK9 Windows 客户端的事件驱动 CDP Driver。

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

以上四条根质量命令同时覆盖 `@kairo/driver` 与 `@kairo/app`；`pnpm format` 当前只格式化 Driver 文件。

`@kairo/app` 的 `typecheck` 使用 `apps/kairo/tsconfig.typecheck.json`，覆盖 `src`、`tests` 和 `vitest.config.ts`，不生成文件；`build` 仍使用 `apps/kairo/tsconfig.json`，只编译 `src`。应用直接声明 `@types/node` 与 `@types/pg`，数据库代码使用 `pg` 提供的类型接口，不再手写第三方模块声明。

默认 `pnpm test` 中的 App 测试排除 `tests/integration/**`，不要求 PostgreSQL 连接。显式执行 `pnpm --filter @kairo/app test:integration` 会加载仓库根目录 `.env` 并运行完整集成目录，覆盖发送操作存储与 Mastra 存储；缺少 `KAIRO_TEST_DATABASE_URL` 时 Mastra 集成测试会明确失败。请使用专用测试数据库：发送操作测试会在该库执行迁移和读写，Mastra 测试还需要创建、删除临时数据库的权限。

Driver 真机辅助命令：

```bash
pnpm verify
pnpm diagnose
pnpm e2e
```

运行真机命令前，先按 `KK9-STARTUP.md` 启动 KK9 与 CDP，并检查测试账号、会话和发送目标。`pnpm e2e` 还要求显式设置与实际用户、私聊 ID、群聊 ID 完全一致的 `KK9_REAL_TEST_CONFIRM`；离线测试不得替代真机验收。

### T12 延迟记忆合同

`createConversationMemory(storage, model)` 使用 thread 范围的 Observational Memory，Observer 和 Reflector 显式接收主 Agent 的同一个模型。默认只读生成，关闭语义召回、working memory 和自动标题；草稿不会通过这些路径写入正式上下文。

`commitDeliveredMemory(memory, delivery)` 只在 `status: 'delivered'` 时提交。调用方必须传入已通过检查、清洗后的员工正文和实际送达正文；不传整个模型响应、Tool 结果或 recalled history。消息 ID 由 `(threadId, taskId, role)` 确定，重放必须使用同一任务的原始正文与时间。保存完成后显式执行 `omEngine.observe()`，由 Mastra 按阈值决定是否需要压缩。错误直接向调用方传播。

正式 Memory 的时间表示送达轮次，不是原始入站时间：user 使用 `deliveredAt - 1ms`，assistant 使用 `deliveredAt`。这同时避免同毫秒问答倒序，以及排队期间收到的问题晚提交时被上一轮 observation 游标跳过。原始收发时间由业务记录保留；同任务重放必须沿用第一次确认的 `deliveredAt`。

本任务不实现任务恢复调度或会话队列。同一 thread 的正式提交由后续调用方串行执行；关闭时先 `await memory.settled()`，再 `await mastra.shutdown()`，最后关闭自行持有的存储连接。

定向运行（先进入 `apps/kairo` 目录）：

```bash
node --env-file=../../.env ../../node_modules/vitest/vitest.mjs run --config vitest.config.ts tests/integration/mastra-delayed-memory.spike.test.ts
```

默认使用真实 PostgreSQL 和确定性模型，只证明存储及框架合同，不代表真实模型放行。测试创建并删除随机临时数据库，覆盖只读输入、四种非送达状态、重复提交、save 前/save 后/observe 后的异常中断与新实例恢复、双员工隔离、新 thread 隔离及同模型观察/反思。这里模拟持久化边界中断，不是操作系统强杀进程；跨进程故障矩阵属于 T34。

真实模型门禁复用同一组测试。在本地 `.env` 配置以下变量，再执行上面的定向命令：

- `KAIRO_T12_REAL_MODEL=1`：显式启用真实模型；缺配置直接失败，不回退到替身。
- `KAIRO_T12_MODEL`：用户批准的 `供应商/模型` 标识。
- `KAIRO_T12_MODEL_URL`：批准的模型 API 地址。
- `KAIRO_T12_MODEL_API_KEY`：模型凭证，不提交到 Git。
- `KAIRO_TEST_DATABASE_URL`：有临时数据库创建和删除权限的专用 PostgreSQL 连接。
- `KAIRO_T12_MODEL_INTERVAL_MS`：可选的测试请求起始间隔，默认 `0`。遇到供应商每分钟 token 限流时可设为 `65000`；仅影响真实测试请求，不改变生产限流或重试策略。真实测试单项上限为 10 分钟，包含等待时间。

真实模式会将测试对话发送至指定模型，并产生模型调用费用。未使用最终批准模型通过该门禁前，不得以默认测试结果关闭 T12。

模型请求可因 429 重试，合同测试不固定请求尝试次数；仍要求重复正式提交不产生新的模型请求、正式消息不重复，以及观察和反思结果可读。限流导致最终调用失败时，测试继续明确失败。

接口依据：[Memory 只读配置](https://mastra.ai/reference/memory/memory-class)、[Observational Memory](https://mastra.ai/docs/memory/observational-memory)，并以锁定 `@mastra/core@1.63.2`、`@mastra/memory@1.28.1`、`@mastra/pg@1.22.2` 的类型和运行结果为准。

## 代码入口

| 任务                                                                                | 位置                                                            |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Driver 公开 API 与生命周期                                                          | `packages/driver/src/index.ts`, `packages/driver/src/driver.ts` |
| CDP 连接与底层调用                                                                  | `packages/driver/src/cdp/client.ts`                             |
| Bridge 底层 IPC 操作与原生事件直连桥（会话、消息、发送、撤回、图片/文件、组织架构） | `packages/driver/src/bridge/`                                   |
| DOM 辅助解析与兼容逻辑                                                              | `packages/driver/src/dom/`                                      |
| 离线测试                                                                            | `packages/driver/tests/`                                        |
| 真机脚本                                                                            | `packages/driver/examples/`                                     |

## 边界

- Driver 只负责 KK9 的 CDP、运行时桥接、消息规范化和 I/O。
- Driver 不持有数据库、Agent、Memory、知识库、审批或业务工作流。
- DOM、Vue 运行时对象和原始事件必须先规范化，再进入公开类型。
- 发送结果必须保留“触发前失败”和“触发后结果未知”的区别。
- 离线测试不得依赖 KK9、网络或真实账号。

### 原生发送关联键

KK9 的 `msgFlag` 上限为 64 个字符。原生 `searchMessages` 和 `queryChatMessage` 会过滤匹配 `%C%` 的消息，SQLite 的匹配也会命中小写 `c`，因此仅有发送成功或 `getRecentMessages` 回查成功不能证明原生历史可见。`createNativeMessageKey(kind, operationId)` 对超长操作 ID 使用 `k:op:` 加完整 SHA-256 摘要的 Base64URL 编码，并将 `C`、`c` 分别替换为 `.`、`~`，固定为 48 个 ASCII 字符，不截断操作 ID。两个替代字符不在 Base64URL 原字母表中，替换保持一一对应。发送、只读状态回查和 PostgreSQL 的 `native_key` 写入统一调用该函数，调用方仍保存完整 `operationId`。

五类新媒体（`url-card`、`biz-message`、`app-message`、`chat-record`、`voice`）的短操作 ID 若编码后含 `C/c`，同样使用安全摘要；其他短键保持不变。不传 `operationId` 时，完整随机键（包含类型名和 UUID）中的 `C/c` 也会替换为 `.`、`~`。因此不能只修复摘要或 UUID，而遗漏类型名里的 `c`。

原有文本、富文本、回复、图片和文件类型的短键及无操作 ID 键维持原规则，避免改变既有操作的回查身份；它们若含 `C/c`，仍可能被原生历史过滤。本次不改写已发送消息或旧存储记录，也不自动重发旧 `unknown` 操作；此前由新媒体 API 生成的旧不安全键同样不会被改写。服务端 `102` 或本地 `status: failed` 不能单独证明服务端未创建消息，仍遵守触发后结果未知的合同。

## 原生卡片与语音发送

`KK9Driver` 与 `IKK9Driver` 新增以下方法；第一个参数是消息内容，第二个参数沿用 `SendOptions`：

| 方法                               | 原生 contentType | 公开 messageType |
| ---------------------------------- | ---------------- | ---------------- |
| `sendUrlCard(card, options)`       | 10               | `url-card`       |
| `sendBizMessage(message, options)` | 17               | `biz-message`    |
| `sendAppMessage(message, options)` | 8                | `app-message`    |
| `sendChatRecord(record, options)`  | 15               | `chat-record`    |
| `sendVoice(voice, options)`        | 2                | `voice`          |

```typescript
await driver.sendUrlCard(
  { title: '部署报告', summary: '构建成功', linkUrl: 'https://example.com/report' },
  { targetSessionId: '0-3585', operationId: 'report-20260907' }
);
await driver.sendBizMessage(
  { title: '任务完成', content: '已完成部署', summary: ['负责人: 张三'] },
  { targetSessionId: '0-3585' }
);
await driver.sendAppMessage(
  { title: '应用通知', content: '<p>这是一条<b>微应用</b>通知</p>' },
  { targetSessionId: '0-3585' }
);
await driver.sendChatRecord(
  { title: '方案讨论', msgArray: [{ senderName: '张三', contentType: 0, content: '请确认方案' }] },
  { targetSessionId: '0-3585' }
);
await driver.sendVoice(
  { text: '任务已经完成', voice: 'zh-CN-XiaoxiaoNeural' },
  { targetSessionId: '0-3585', operationId: 'voice-20260907' }
);
await driver.sendVoice({ filePath: 'D:/audio/notice.wav' }, { targetSessionId: '0-3585' });
```

五类消息均复用发送操作存储：同一 `operationId` 不会重复发送；语音重放不会重复合成。准备失败为 `failed/isPreTrigger: true`，触发后不能确认送达为 `unknown`，不得据此自动重发。成功确认后返回正式消息 ID 和 `recall()`，并更新本机会话摘要及聊天窗口。五类消息均不支持 `replyTo` 或 `mentions`，显式传入会在发送前失败。

未传 `targetSessionId` 时，在开始准备消息前固定当前会话；TTS 期间切换聊天窗口不会改变接收目标，返回的 `recall()` 也绑定原会话。

直接调用公开的 `BridgeMessageOps.sendVoice()` 时也遵守上述目标绑定规则，包括不传 `operationId` 的路径。`ChatRecord` 在登记操作前取得完整 JSON 内容快照；调用方随后修改嵌套对象，不会改变本次发送正文或相同操作 ID 的重放身份。

`AppMsg.content` 原样交给 KK9 渲染 HTML，调用方应提供可信正文。`ChatRecord` 的 `contentType: 0` 纯文本记录会转换为 KK9 的原生图文节点，避免详情窗口对普通字符串执行 `JSON.parse` 而显示空白。其他记录类型按原生内容结构传入。`title` 保留在消息内容及 Driver 历史摘要中；KK9 当前客户端的可见记录标题仍由发送者和会话名称按原生模板生成。

语音输入必须二选一：`{ text, voice? }` 或 `{ filePath }`。本地文件支持 WAV、MP3；文本通过 `node-edge-tts` 使用 Microsoft Edge Read Aloud 服务，默认音色 `zh-CN-XiaoxiaoNeural`，也可指定 `zh-CN-YunxiNeural`。该服务需要网络连接，不是带可用性承诺的付费语音 API。Driver 将音频解码为单声道、重采样到 8kHz，调用当前 KK9 安装包的 `lib/amrnb` 编码；不需要 Python 或 FFmpeg。发送数据是 AMR-NB 文件字节的 Base64，`duration` 为向上取整的秒数。TTS 临时音频在读取后删除；本地输入文件不会被删除。KK9 未开放 `window.require` 或缺少内置编码器时，明确返回准备失败。

`pnpm-workspace.yaml` 的 `patchedDependencies` 固定应用两份依赖修补：`patches/node-edge-tts@1.2.10.patch` 让直连握手和合成共用超时期限，文件流错误进入正常拒绝路径，完成或失败时先关闭文件流和 WebSocket 再结束 Promise；`patches/@audio__decode-wav@1.5.0.patch` 修正 RIFF 奇数长度数据块的填充字节跳过规则。补丁文件、workspace 配置和 `pnpm-lock.yaml` 必须一起保存，通过 `pnpm install` 应用，不能仅手改 `node_modules`。升级这两个依赖时先确认上游是否已修复，并运行对应边界回归。

Driver 不提供或使用第三方 TTS 库的 HTTP 代理选项。额外探针发现，该库可选代理模式在 CONNECT 握手挂起时仍可能遗留代理 TCP 连接；这不是当前 Driver 的直连路径，本次没有扩展代理功能或其修复范围。

应用侧 PostgreSQL 发送状态表原有类型约束不接受新消息类型，因此新增 `000003-native-media-send-operations.sql`。使用 `PostgresSendOperationStore` 前需执行应用现有迁移流程；Driver 本身不持有数据库。回滚该迁移前，必须先处理表中新增类型的记录，否则旧约束会拒绝回滚，不会自动删除记录。

诊断命令（目标为真实会话，会实际发送）：

```bash
pnpm diagnose card 0-3585 url '{"title":"部署报告","summary":"构建成功","linkUrl":"https://example.com"}'
pnpm diagnose voice 0-3585 "任务已经完成"
pnpm diagnose voice-file 0-3585 D:/audio/notice.wav
```

`card` 的类型可选 `url`、`biz`、`app`、`record`；JSON 字段对应各公开 options 类型。Windows PowerShell 的引号规则可能不同，可优先使用上面的 TypeScript API。

真机验收：

```powershell
$env:KK9_MEDIA_CONFIRM = "5761:0-3585:int2024"
# 可选；设置后额外验证本地音频发送。
$env:KK9_MEDIA_AUDIO_FILE = "D:/audio/notice.wav"
pnpm --filter @kairo/driver e2e:media
# 也可以只运行指定类型，避免重复发送已验证的用例。
pnpm --filter @kairo/driver e2e:media ChatRecord VoiceFile
# 专门覆盖“不传 operationId”和“短含 c operationId”两条路径。
$env:KK9_MEDIA_KEY_CASES = "1"
pnpm --filter @kairo/driver e2e:media
```

脚本默认目标为 `int2024 / 0-3585`，通过 `KK9_MEDIA_TARGET_ID`、`KK9_MEDIA_TARGET_NAME` 可更改。确认值必须精确匹配当前登录 UID、目标 ID 和目标名称。每条消息除检查正式 ID、原生及公开类型外，还必须同时出现在 `queryChatMessage` 和 `searchMessages` 的真实 IPC 返回值中；不会再用 `getRecentMessages` 替代原生历史验收。设置 `KK9_MEDIA_KEY_CASES=1` 后，每种类型分别验证无操作 ID 和短含 c ID，有操作 ID 的路径同时检查防重和状态回查。单独运行一个类型时使用确切的 `task-complete-001`；多类型运行追加类型名以区分发送意图。默认撤回本次已知消息；设置 `KK9_MEDIA_KEEP=1` 可保留做界面检查，检查后自行撤回。脚本不把历史可见性等同于接收方界面或音频播放验收。

底层协议 spike 可执行 `pnpm --filter @kairo/driver exec tsx examples/spike-card-test.ts`。它沿用 `KK9_MEDIA_TARGET_ID`、`KK9_MEDIA_TARGET_NAME`、`KK9_MEDIA_CONFIRM` 和 `KK9_MEDIA_KEEP`，先按精确 ID 查找，再核对名称和登录 UID；缺少确认或身份冲突时不会发送。保留 UrlCard、BizMsg、AppMsg、GroupInfoShare 四类探针，只有取得正式落库 ID 才显示 `delivered`；仅收到发送 ack 而无落库证据时显示 `unknown`，以非零状态退出，不自动重发。默认撤回已知正式消息。

离线回归：`pnpm --filter @kairo/driver test`。`native-media.test.ts` 在 VM 中实际执行 renderer 发送脚本；`voice-ops.test.ts` 实际解码 WAV/MP3、重采样并执行编码调用脚本，仅替换网络 TTS 和 KK9 编码器边界。`tests/fixtures/voice.mp3` 为 Edge TTS 生成的“测试”二字，用于无网络的 MP3 回归。PostgreSQL 合同定向命令见 `apps/kairo/tests/integration/send-operation-store.test.ts`。

新增回归覆盖 ChatRecord 的嵌套内容快照、直接 Bridge 的语音目标绑定、合法 RIFF 填充以及 spike 的目标门禁和未知结果。`node-edge-tts-boundary.test.ts` 保留真实依赖与文件流，使用本地挂起的 TLS 连接或替换 WebSocket 网络边界，验证直连握手超时、合成超时、文件错误、异常关闭及正常结束后的资源释放；不访问外网。原生预插入、发送和正式 ID 确认统一由 renderer 的 `submitNativeMessage` 执行，各入口仍保留自己的内容准备、确认策略和 UI 通知。
