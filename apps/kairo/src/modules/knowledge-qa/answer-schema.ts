import { z } from 'zod';

const answerTypeSchema = z.enum([
  'enterprise',
  'general',
  'clarification',
  'no_evidence',
  'conflict',
  'service_error',
]);

/** 只检查模型输出结构；证据归属、通用知识授权和发送资格由后续业务检查负责。 */
export const answerSchema = z
  .object({
    answer: z.string().min(1).describe('完整答案正文，不包含内部引用编号或诊断信息'),
    answerType: answerTypeSchema.describe('企业知识、通用知识、追问、无资料、冲突或服务错误'),
    evidenceIds: z.array(z.string().min(1)).describe('本次知识 Tool 返回且用于回答的证据编号'),
    subQuestions: z.array(
      z
        .object({
          id: z.string().min(1),
          question: z.string().min(1),
          answer: z.string().min(1),
          answerType: answerTypeSchema,
          evidenceIds: z.array(z.string().min(1)),
        })
        .strict()
    ),
    diagnostics: z.array(z.string()).describe('内部问题或限制的简短说明，不记录推理过程'),
  })
  .strict();

export type AgentAnswer = z.infer<typeof answerSchema>;
