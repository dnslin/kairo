import { z } from 'zod';

const requiredText = z.string().trim().min(1);
const positiveInteger = z.number().int().positive();
const uniqueNames = z.array(requiredText).refine(names => new Set(names).size === names.length);
const skillNames = z
  .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
  .refine(names => new Set(names).size === names.length);
const modelUrl = z.url({ protocol: /^https?$/, abort: true }).refine(value => {
  const url = new URL(value);
  return !url.username && !url.password;
});

// 全部对象拒绝未知字段，防止凭证或第二套模型配置被悄悄忽略。
export const botConfigSchema = z
  .strictObject({
    model: z.strictObject({
      id: z.string().regex(/^[^\s/]+\/\S+$/),
      url: modelUrl.optional(),
    }),
    datasetId: requiredText,
    employeeAllowlist: uniqueNames.refine(names => names.length > 0),
    tools: uniqueNames,
    skills: skillNames,
    agent: z.strictObject({ maxSteps: positiveInteger }),
    batching: z.strictObject({
      quietMs: positiveInteger,
      maxWaitMs: positiveInteger,
      maxMessages: positiveInteger.max(10),
      maxChars: positiveInteger.max(30000),
    }),
    concurrency: z.strictObject({ global: positiveInteger, perSessionQueue: positiveInteger }),
    timeouts: z.strictObject({
      queueMs: positiveInteger,
      executionMs: positiveInteger,
      progressMs: positiveInteger,
      sendQueryMs: positiveInteger,
      generalKnowledgeWaitMs: positiveInteger,
      contextIdleMs: positiveInteger,
    }),
  })
  .superRefine((config, context) => {
    if (config.batching.quietMs > config.batching.maxWaitMs) {
      context.addIssue({
        code: 'custom',
        path: ['batching', 'quietMs'],
        message: '静默不能超过合并窗口',
      });
    }
    if (config.timeouts.progressMs >= config.timeouts.executionMs) {
      context.addIssue({
        code: 'custom',
        path: ['timeouts', 'progressMs'],
        message: '提示必须早于执行截止',
      });
    }
  });

export type BotConfig = z.infer<typeof botConfigSchema>;
