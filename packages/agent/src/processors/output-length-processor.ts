import type {
  ProcessOutputResultArgs,
  Processor,
  ProcessorMessageResult,
} from '@mastra/core/processors';
import type { MastraDBMessage } from '@mastra/core/agent';
import { extractTextFromMastraContent, replaceMastraContentText } from './content-utils.js';

export interface OutputLengthProcessorOptions {
  maxLength?: number;
}

const DEFAULT_MAX_OUTPUT_LENGTH = 4000;
const SOURCE_BLOCK_REGEX = /(?:\[来源[^\]]*\]|【来源[^】]*】|来源[:：][^\n]+(?:\n[^\n]+)*)$/i;

/**
 * OutputLengthProcessor: 输出长度限制与来源保护处理器
 *
 * 核心契约 (Spec §4.9, §9.6):
 * 1. 限制单次回答最大字符长度，防止超长回复撑爆会话。
 * 2. 截断正文时，必须保留末尾的知识来源引用块 (如 [来源: ...])。
 */
export class OutputLengthProcessor implements Processor<'output-length'> {
  readonly id = 'output-length' as const;
  readonly name = '输出长度与来源保护器';
  private maxLength: number;

  constructor(options?: OutputLengthProcessorOptions) {
    this.maxLength = options?.maxLength ?? DEFAULT_MAX_OUTPUT_LENGTH;
  }

  processOutputResult(args: ProcessOutputResultArgs): ProcessorMessageResult {
    const updatedMessages: MastraDBMessage[] = args.messages.map(msg => {
      if (msg.role === 'assistant') {
        const text = extractTextFromMastraContent(msg.content);
        if (text.length > this.maxLength) {
          // 提取来源块
          let sourceBlock = '';
          const sourceMatch = text.match(SOURCE_BLOCK_REGEX);
          if (sourceMatch) {
            sourceBlock = sourceMatch[0];
          }

          const availableBodyLength = Math.max(0, this.maxLength - sourceBlock.length - 20);
          const truncatedBody = text.slice(0, availableBodyLength) + '...[已截断]';
          const finalText = sourceBlock ? `${truncatedBody}\n\n${sourceBlock}` : truncatedBody;

          return {
            ...msg,
            content: replaceMastraContentText(msg.content, finalText),
          };
        }
      }
      return msg;
    });

    return updatedMessages;
  }
}
