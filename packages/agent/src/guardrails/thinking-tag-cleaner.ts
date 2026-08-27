interface ThinkingCleanResult {
  cleanedText: string;
  thinkingText: string;
  hasThinking: boolean;
}

/**
 * 思考标签剥离清洗器
 * 负责在静态及流式生成场景下，精确识别并剥离 <think>...</think> 标签，
 * 避免 DeepSeek R1 / 推理模型的内部思考链直接泄露给最终用户。
 */
export class ThinkingTagCleaner {
  private static readonly START_TAG = '<think>';
  private static readonly END_TAG = '</think>';

  private inThinking = false;
  private pendingBuffer = '';
  private accumulatedThinking = '';
  private accumulatedCleaned = '';

  /**
   * 静态全文清洗
   */
  public static clean(text: string): ThinkingCleanResult {
    if (!text) {
      return { cleanedText: '', thinkingText: '', hasThinking: false };
    }

    const thinkingBlocks: string[] = [];
    let cleanedText = text;

    // 匹配所有闭合的 <think>...</think> 标签 (不区分大小写，支持内部有空白或属性)
    const closedTagRegex = /<think(?:\s[^>]*)?>([\s\S]*?)<\/think\s*>/gi;
    cleanedText = cleanedText.replace(closedTagRegex, (_, thinkingContent: string) => {
      thinkingBlocks.push(thinkingContent.trim());
      return '';
    });

    // 匹配末尾未闭合的 <think>... 截断标签
    const unclosedTagRegex = /<think(?:\s[^>]*)?>([\s\S]*)$/i;
    cleanedText = cleanedText.replace(unclosedTagRegex, (_, thinkingContent: string) => {
      thinkingBlocks.push(thinkingContent.trim());
      return '';
    });

    const hasThinking = thinkingBlocks.length > 0;
    const thinkingText = thinkingBlocks.join('\n');

    return {
      cleanedText,
      thinkingText,
      hasThinking,
    };
  }

  /**
   * 接收增量流式 Chunk 并返回清洗输出与思考增量
   */
  public feed(chunk: string): { cleanedChunk: string; thinkingChunk: string } {
    if (!chunk) {
      return { cleanedChunk: '', thinkingChunk: '' };
    }

    let cleanedChunk = '';
    let thinkingChunk = '';

    const textToProcess = this.pendingBuffer + chunk;
    this.pendingBuffer = '';

    let i = 0;
    const len = textToProcess.length;

    while (i < len) {
      if (!this.inThinking) {
        // 当前在正常正文模式，寻找 <think>
        if (textToProcess[i] === '<') {
          const remaining = textToProcess.slice(i);
          const lowerRemaining = remaining.toLowerCase();

          // 检查是否为完整 <think> 或 <think ...>
          const startMatch = lowerRemaining.match(/^<think(?:\s[^>]*)?>/);
          if (startMatch && startMatch[0]) {
            this.inThinking = true;
            i += startMatch[0].length;
            continue;
          }

          // 检查是否可能为未接收完整的 <think...> 前缀
          if (
            ThinkingTagCleaner.START_TAG.startsWith(lowerRemaining) ||
            /^<think(?:\s[^>]*)?$/.test(lowerRemaining)
          ) {
            this.pendingBuffer = remaining;
            break;
          }

          // 无法匹配且不是前缀，按普通字符输出首字符
          const char = textToProcess[i] ?? '';
          cleanedChunk += char;
          this.accumulatedCleaned += char;
          i++;
        } else {
          const char = textToProcess[i] ?? '';
          cleanedChunk += char;
          this.accumulatedCleaned += char;
          i++;
        }
      } else {
        // 当前在思考模式，寻找 </think>
        if (textToProcess[i] === '<') {
          const remaining = textToProcess.slice(i);
          const lowerRemaining = remaining.toLowerCase();

          // 检查是否为完整 </think> 或 </think ...>
          const endMatch = lowerRemaining.match(/^<\/think\s*>/);
          if (endMatch && endMatch[0]) {
            this.inThinking = false;
            i += endMatch[0].length;
            continue;
          }

          // 检查是否可能为未接收完整的 </think...> 前缀
          if (
            ThinkingTagCleaner.END_TAG.startsWith(lowerRemaining) ||
            /^<\/think\s*$/.test(lowerRemaining)
          ) {
            this.pendingBuffer = remaining;
            break;
          }

          // 无法匹配且不是前缀，按思考内容输出首字符
          const char = textToProcess[i] ?? '';
          thinkingChunk += char;
          this.accumulatedThinking += char;
          i++;
        } else {
          const char = textToProcess[i] ?? '';
          thinkingChunk += char;
          this.accumulatedThinking += char;
          i++;
        }
      }
    }

    return { cleanedChunk, thinkingChunk };
  }

  /**
   * 快捷流式方法：仅返回清洗后的正文增量
   */
  public processChunk(chunk: string): string {
    return this.feed(chunk).cleanedChunk;
  }

  /**
   * 流结束时冲刷剩余暂存缓冲区
   */
  public flush(): { cleanedChunk: string; thinkingChunk: string } {
    let cleanedChunk = '';
    let thinkingChunk = '';

    if (this.pendingBuffer) {
      if (!this.inThinking) {
        cleanedChunk = this.pendingBuffer;
        this.accumulatedCleaned += this.pendingBuffer;
      } else {
        thinkingChunk = this.pendingBuffer;
        this.accumulatedThinking += this.pendingBuffer;
      }
      this.pendingBuffer = '';
    }

    return { cleanedChunk, thinkingChunk };
  }

  /**
   * 获取累计收集到的所有思考文本
   */
  public getAccumulatedThinking(): string {
    return this.accumulatedThinking;
  }

  /**
   * 获取累计收集到的所有清洗后正文文本
   */
  public getAccumulatedCleaned(): string {
    return this.accumulatedCleaned;
  }

  /**
   * 重置清洗器状态
   */
  public reset(): void {
    this.inThinking = false;
    this.pendingBuffer = '';
    this.accumulatedThinking = '';
    this.accumulatedCleaned = '';
  }
}
