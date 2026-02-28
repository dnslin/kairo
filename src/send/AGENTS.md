# SEND MODULE

## OVERVIEW

消息发送器，通过 DOM 操作发送文本和图片。文本通过 setInputText + clickSendButton，图片通过剪贴板 API + 粘贴。

## KEY FILES

| File        | Lines | Purpose   |
| ----------- | ----- | --------- |
| `sender.ts` | 225   | Sender 类 |
| `index.ts`  | 2     | Re-export |

## WHERE TO LOOK

| Task           | Location                                                |
| -------------- | ------------------------------------------------------- |
| 发送文本       | `sender.ts:35` - `send(text)`                           |
| 发送图片       | `sender.ts:90` - `sendImage(imagePath)`                 |
| 验证文本已发送 | `sender.ts:165` - `verifySent(text)`                    |
| 写入剪贴板     | `sender.ts:183` - `writeImageToClipboard(base64, mime)` |
| 验证图片已发送 | `sender.ts:200` - `verifyImageSent()`                   |
| 文本脱敏       | `sender.ts:214` - `maskText(text)`                      |

## TEXT SEND FLOW

## IMAGE SEND FLOW

## CONSTANTS

## PUBLIC API

## DEPENDENCIES

**External**: `node:fs/promises`, `mime-types`  
**Internal**: `dom/locator.js` (DomLocator), `config/schema.js` (SenderConfig), `utils/logger.js`

## ANTI-PATTERNS

- **不要跳过验证步骤** - 发送可能静默失败
- **不要发送 >10MB 图片** - 会被拒绝
- **不要假设剪贴板立即可用** - 需要延迟等待
- **脱敏规则**：`logMasking: true` 时日志中保留前3后3字符，中间用 \* 替代
