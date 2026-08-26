import type {
  ProcessOutputResultArgs,
  Processor,
  ProcessorMessageResult,
} from '@mastra/core/processors';
import type { MastraDBMessage } from '@mastra/core/agent';
import { ThinkingTagCleaner } from '../guardrails/thinking-tag-cleaner.js';
import { extractTextFromMastraContent, replaceMastraContentText } from './content-utils.js';

/**
 * ThinkingTagProcessor: 思考链标签清洗输出处理器
 *
 * 核心契约 (Spec §4.9):
 * 1. 剥离模型输出中的 <think>...</think> 内部推理过程，避免向最终用户泄漏。
 * 2. 纯同步无副作用清洗，不破坏后续 Processor 执行。
 */
export class ThinkingTagProcessor implements Processor<'thinking-tag'> {
  readonly id = 'thinking-tag' as const;
  readonly name = '思考标签清洗器';

  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult {
    const updatedMessages: MastraDBMessage[] = args.messages.map(msg => {
      if (msg.role === 'assistant') {
        const text = extractTextFromMastraContent(msg.content);
        if (text.length > 0 && text.includes('<think>')) {
          const cleaned = ThinkingTagCleaner.clean(text).cleanedText;
          return {
            ...msg,
            content: replaceMastraContentText(msg.content, cleaned),
          };
        }
      }
      return msg;
    });

    return updatedMessages;
  }
}
