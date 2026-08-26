import type { ProcessOutputResultArgs, Processor } from '@mastra/core/processors';
import type { MastraDBMessage } from '@mastra/core/agent';
import { replaceMastraContentText } from './content-utils.js';

export interface KnowledgeGroundingProcessorOptions {
  requireGrounding?: boolean;
  timeoutMs?: number;
  groundingHook?: (
    args: ProcessOutputResultArgs & { signal?: AbortSignal }
  ) => Promise<boolean | string> | boolean | string;
}

const DEFAULT_GROUNDING_TIMEOUT_MS = 5000;
const DEFAULT_NO_GROUNDING_TEXT = '未找到企业依据，KKBot 无法提供未经证实的企业制度答复。';

/**
 * KnowledgeGroundingProcessor: 知识来源与 Grounding 校验处理器
 *
 * 核心契约 (Spec §4.9, §9.6, Issue #179, #182):
 * 1. 验证本轮回答是否具备可信企业知识依据，防止模型常识编造企业规则。
 * 2. 传递结合了父 AbortSignal 与 timeoutMs 的 AbortSignal 给 hook。
 * 3. 适用但无可信来源时，返回固定“未找到企业依据”安全降级答复。
 * 4. 运行中父 Abort、自身异常、来源损坏或超时时 fail-closed。
 */
export class KnowledgeGroundingProcessor implements Processor<'knowledge-grounding'> {
  readonly id = 'knowledge-grounding' as const;
  readonly name = '知识库 Grounding 校验器';
  private requireGrounding: boolean;
  private timeoutMs: number;
  private groundingHook?: (
    args: ProcessOutputResultArgs & { signal?: AbortSignal }
  ) => Promise<boolean | string> | boolean | string;

  constructor(options?: KnowledgeGroundingProcessorOptions) {
    this.requireGrounding = options?.requireGrounding ?? false;
    this.timeoutMs = options?.timeoutMs ?? DEFAULT_GROUNDING_TIMEOUT_MS;
    this.groundingHook = options?.groundingHook;
  }

  async processOutputResult(args: ProcessOutputResultArgs): Promise<MastraDBMessage[]> {
    const parentSignal =
      args.abortSignal ??
      (args.requestContext && typeof args.requestContext.get === 'function'
        ? args.requestContext.get('abortSignal')
        : undefined);

    if (parentSignal?.aborted) {
      return args.messages;
    }

    if (this.groundingHook) {
      const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
      const combinedSignal = parentSignal
        ? AbortSignal.any([parentSignal, timeoutSignal])
        : timeoutSignal;

      if (combinedSignal.aborted) {
        if (parentSignal?.aborted) {
          return args.messages;
        }
        throw new Error(`KnowledgeGroundingProcessor 校验超时 (超过 ${this.timeoutMs}ms)`);
      }

      const abortPromise = new Promise<never>((_, reject) => {
        combinedSignal.addEventListener(
          'abort',
          () => {
            if (parentSignal?.aborted) {
              reject(new Error('KnowledgeGroundingProcessor 运行中被父 AbortSignal 中止'));
            } else {
              reject(new Error(`KnowledgeGroundingProcessor 校验超时 (超过 ${this.timeoutMs}ms)`));
            }
          },
          { once: true }
        );
      });

      const hookPromise = Promise.resolve(
        this.groundingHook({
          ...args,
          signal: combinedSignal,
        })
      );

      const hookResult = await Promise.race([hookPromise, abortPromise]);

      if (typeof hookResult === 'boolean') {
        if (!hookResult) {
          return this.replaceAssistantContent(args.messages, DEFAULT_NO_GROUNDING_TEXT);
        }
      } else if (typeof hookResult === 'string') {
        return this.replaceAssistantContent(args.messages, hookResult);
      }
    } else if (this.requireGrounding) {
      // 检查 steps 中是否有知识来源调用 (toolCalls)
      const hasKnowledgeSource = args.result.steps.some(step => {
        if (!step.toolCalls || !Array.isArray(step.toolCalls)) return false;
        return step.toolCalls.some(tc => {
          const rawTc = tc as unknown as Record<string, unknown>;
          const name = typeof rawTc.toolName === 'string' ? rawTc.toolName : '';
          return name.includes('knowledge') || name.includes('kb');
        });
      });

      if (!hasKnowledgeSource) {
        return this.replaceAssistantContent(args.messages, DEFAULT_NO_GROUNDING_TEXT);
      }
    }

    return args.messages;
  }

  private replaceAssistantContent(messages: MastraDBMessage[], newText: string): MastraDBMessage[] {
    return messages.map(msg => {
      if (msg.role === 'assistant') {
        return {
          ...msg,
          content: replaceMastraContentText(msg.content, newText),
        };
      }
      return msg;
    });
  }
}
