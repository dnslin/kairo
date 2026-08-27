import type { ProcessOutputResultArgs, Processor } from '@mastra/core/processors';
import { getProcessorParentSignal, runBoundedProcessorExecution } from './processor-utils.js';
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
    const parentSignal = getProcessorParentSignal(args);
    if (parentSignal?.aborted) {
      throw new Error('KnowledgeGroundingProcessor 校验前已被信号中止');
    }
    if (this.groundingHook) {
      const hookResult = await runBoundedProcessorExecution({
        parentSignal,
        timeoutMs: this.timeoutMs,
        timeoutMessage: `KnowledgeGroundingProcessor 校验超时 (超过 ${this.timeoutMs}ms)`,
        parentAbortMessage: 'KnowledgeGroundingProcessor 运行中被父 AbortSignal 中止',
        execute: signal => this.groundingHook!({ ...args, signal }),
      });
      if (typeof hookResult === 'boolean') {
        if (!hookResult) {
          return this.replaceAssistantContent(args.messages, DEFAULT_NO_GROUNDING_TEXT);
        }
      } else if (typeof hookResult === 'string') {
        return this.replaceAssistantContent(args.messages, hookResult);
      }
    } else if (this.requireGrounding && !this.hasGroundingSource(args.result.steps)) {
      return this.replaceAssistantContent(args.messages, DEFAULT_NO_GROUNDING_TEXT);
    }

    return args.messages;
  }

  private hasGroundingSource(steps: unknown[]): boolean {
    for (const rawStep of steps) {
      if (!rawStep || typeof rawStep !== 'object') continue;
      const step = rawStep as Record<string, unknown>;
      const toolCalls = Array.isArray(step.toolCalls) ? step.toolCalls : [];
      const knowledgeCallIds = new Set<string>();

      for (const rawCall of toolCalls) {
        if (!rawCall || typeof rawCall !== 'object') continue;
        const call = rawCall as Record<string, unknown>;
        const toolName =
          typeof call.toolName === 'string'
            ? call.toolName
            : typeof call.name === 'string'
              ? call.name
              : '';
        const callId =
          typeof call.toolCallId === 'string'
            ? call.toolCallId
            : typeof call.id === 'string'
              ? call.id
              : '';
        if (toolName.includes('knowledge') || toolName.includes('kb')) {
          if (callId) knowledgeCallIds.add(callId);
        }
      }

      const toolResults = Array.isArray(step.toolResults) ? step.toolResults : [];
      for (const rawResult of toolResults) {
        if (!rawResult || typeof rawResult !== 'object') continue;
        const toolResult = rawResult as Record<string, unknown>;
        const toolName = typeof toolResult.toolName === 'string' ? toolResult.toolName : '';
        const callId =
          typeof toolResult.toolCallId === 'string'
            ? toolResult.toolCallId
            : typeof toolResult.id === 'string'
              ? toolResult.id
              : '';
        if (
          !(toolName.includes('knowledge') || toolName.includes('kb') || knowledgeCallIds.has(callId))
        ) {
          continue;
        }
        const value = toolResult.result ?? toolResult.output ?? toolResult.content;
        if (this.hasGroundingEvidence(value)) return true;
      }
    }
    return false;
  }

  private hasGroundingEvidence(value: unknown): boolean {
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (!value || typeof value !== 'object') return false;

    const record = value as Record<string, unknown>;
    if (record.success === false) return false;
    if (typeof record.count === 'number') return record.count > 0;
    for (const key of ['chunks', 'sources', 'citations', 'results', 'content']) {
      const candidate = record[key];
      if (Array.isArray(candidate) && candidate.length > 0) return true;
      if (typeof candidate === 'string' && candidate.trim().length > 0) return true;
    }
    return false;
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
