import type {
  InputProcessorOrWorkflow,
  OutputProcessorOrWorkflow,
  Processor,
} from '@mastra/core/processors';
import { UnicodeNormalizer } from './unicode-normalizer.js';
import {
  PromptInjectionProcessor,
  type PromptInjectionProcessorOptions,
} from './prompt-injection-processor.js';
import {
  SensitiveInputProcessor,
  type SensitiveInputProcessorOptions,
} from './sensitive-input-processor.js';
import {
  QuotaAdmissionProcessor,
  type QuotaAdmissionProcessorOptions,
} from './quota-admission-processor.js';
import {
  ToolResultSafetyProcessor,
  type ToolResultSafetyProcessorOptions,
} from './tool-result-safety-processor.js';
import { QuotaUsageProcessor, type QuotaUsageProcessorOptions } from './quota-usage-processor.js';
import { ThinkingTagProcessor } from './thinking-tag-processor.js';
import {
  KnowledgeGroundingProcessor,
  type KnowledgeGroundingProcessorOptions,
} from './knowledge-grounding-processor.js';
import {
  OutputLengthProcessor,
  type OutputLengthProcessorOptions,
} from './output-length-processor.js';
import {
  SensitiveOutputProcessor,
  type SensitiveOutputProcessorOptions,
} from './sensitive-output-processor.js';

export const PROCESSOR_CHAIN_ORDER = [
  'unicode-normalizer',
  'prompt-injection',
  'sensitive-input',
  'quota-admission',
  'tool-result-safety',
  'quota-usage',
  'thinking-tag',
  'knowledge-grounding',
  'output-length',
  'sensitive-output',
] as const;

export interface KKBotProcessorsOptions {
  promptInjection?: PromptInjectionProcessorOptions;
  sensitiveInput?: SensitiveInputProcessorOptions;
  quotaAdmission?: QuotaAdmissionProcessorOptions;
  toolResultSafety?: ToolResultSafetyProcessorOptions;
  quotaUsage?: QuotaUsageProcessorOptions;
  knowledgeGrounding?: KnowledgeGroundingProcessorOptions;
  outputLength?: OutputLengthProcessorOptions;
  sensitiveOutput?: SensitiveOutputProcessorOptions;
}

/**
 * createKKBotProcessors: 创建满足 Spec §4.9 严格静态顺序的 Processor 全量管道
 */
export function createKKBotProcessors(options?: KKBotProcessorsOptions): Processor[] {
  return [
    new UnicodeNormalizer(),
    new PromptInjectionProcessor(options?.promptInjection),
    new SensitiveInputProcessor(options?.sensitiveInput),
    new QuotaAdmissionProcessor(options?.quotaAdmission),
    new ToolResultSafetyProcessor(options?.toolResultSafety),
    new QuotaUsageProcessor(options?.quotaUsage),
    new ThinkingTagProcessor(),
    new KnowledgeGroundingProcessor(options?.knowledgeGrounding),
    new OutputLengthProcessor(options?.outputLength),
    new SensitiveOutputProcessor(options?.sensitiveOutput),
  ];
}

/**
 * splitKKBotProcessors: 将固定管道拆分为 Mastra Agent 所需的 input 与 output 数组
 *
 * 顺序映射：
 * Input:
 * 1. UnicodeNormalizer
 * 2. PromptInjectionProcessor
 * 3. SensitiveInputProcessor
 * 4. QuotaAdmissionProcessor
 *
 * Output:
 * 5. ToolResultSafetyProcessor (processToolResult 位于 Tool 执行后，在 outputProcessors 队列首部执行)
 * 6. QuotaUsageProcessor
 * 7. ThinkingTagProcessor
 * 8. KnowledgeGroundingProcessor
 * 9. OutputLengthProcessor
 * 10. SensitiveOutputProcessor
 */
export function splitKKBotProcessors(options?: KKBotProcessorsOptions): {
  inputProcessors: InputProcessorOrWorkflow[];
  outputProcessors: OutputProcessorOrWorkflow[];
} {
  const normalizer = new UnicodeNormalizer();
  const promptInjection = new PromptInjectionProcessor(options?.promptInjection);
  const sensitiveInput = new SensitiveInputProcessor(options?.sensitiveInput);
  const quotaAdmission = new QuotaAdmissionProcessor(options?.quotaAdmission);

  const toolResultSafety = new ToolResultSafetyProcessor(options?.toolResultSafety);
  const quotaUsage = new QuotaUsageProcessor(options?.quotaUsage);
  const thinkingTag = new ThinkingTagProcessor();
  const knowledgeGrounding = new KnowledgeGroundingProcessor(options?.knowledgeGrounding);
  const outputLength = new OutputLengthProcessor(options?.outputLength);
  const sensitiveOutput = new SensitiveOutputProcessor(options?.sensitiveOutput);

  return {
    inputProcessors: [normalizer, promptInjection, sensitiveInput, quotaAdmission],
    outputProcessors: [
      toolResultSafety,
      quotaUsage,
      thinkingTag,
      knowledgeGrounding,
      outputLength,
      sensitiveOutput,
    ],
  };
}
