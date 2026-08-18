# LLM MODULE

## OVERVIEW

OpenAI 兼容 LLM 客户端，支持对话回复生成和会话摘要。包含敏感词过滤和 `<think>` 标签清理。

## KEY FILES

| File        | Lines | Purpose      |
| ----------- | ----- | ------------ |
| `client.ts` | 169   | LlmClient 类 |
| `index.ts`  | 2     | Re-export    |

## WHERE TO LOOK

| Task         | Location                                                            |
| ------------ | ------------------------------------------------------------------- |
| 生成回复     | `client.ts:39` - `generateReply(message, history, summaryContext?)` |
| 生成摘要     | `client.ts:86` - `generateSummary(history, existingSummary?)`       |
| 构建消息列表 | `client.ts:126` - `buildMessages()`                                 |
| 敏感词检查   | `client.ts:149` - `containsSensitiveWords()`                        |
| 移除思考标签 | `client.ts:165` - `removeThinkingTags()`                            |
| 截断回复     | `client.ts:158` - `truncate()`                                      |

## MESSAGE CONSTRUCTION

## REPLY PIPELINE

## SUMMARY PIPELINE

## PUBLIC API

## DEPENDENCIES

**External**: `openai` (SDK, maxRetries=2)  
**Internal**: `config/schema.js` (LlmConfig, ValidationConfig), `dom/locator.js` (MessageInfo), `utils/logger.js`

## ANTI-PATTERNS

- **不要跳过 `<think>` 标签清理** - 某些模型输出包含推理过程
- **不要假设回复非空** - `generateReply()` 可返回 null（空内容或敏感词）
- **不要修改 temperature** - 回复用配置值，摘要固定 0.3
