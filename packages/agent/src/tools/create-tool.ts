import { createTool, type Tool } from '@mastra/core/tools';
import type { z } from 'zod';

export type ToolEffect = 'read' | 'write';
export type ToolRisk = 'low';

export interface KkToolPolicy {
  readonly effect: ToolEffect;
  readonly risk: ToolRisk;
  readonly requiredPermission?: string;
  readonly serialKey?: 'session' | 'employee' | 'entity';
  readonly idempotencyField?: string;
  readonly timeoutMs?: number;
}

export type KkMastraTool<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> = Tool<z.infer<TInput>, z.infer<TOutput>> & {
  readonly policy: Readonly<KkToolPolicy>;
};

export interface CreateKkToolOptions<
  TInput extends z.ZodTypeAny = z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
> {
  id: string;
  description: string;
  inputSchema: TInput;
  outputSchema?: TOutput;
  effect: ToolEffect;
  risk: ToolRisk;
  requiredPermission?: string;
  serialKey?: 'session' | 'employee' | 'entity';
  idempotencyField?: string;
  timeoutMs?: number;
  execute: (params: {
    context: z.infer<TInput>;
    abortSignal?: AbortSignal;
    requestContext?: unknown;
  }) => Promise<z.infer<TOutput>>;
}

/**
 * createKkTool: KKBot 统一 Mastra Tool 工厂函数
 *
 * 核心契约 (Spec §4.10, RISK-01):
 * 1. 严格约束 risk 为 'low'，effect 为 'read' 或 'write'。
 * 2. 返回的 Mastra Tool 必须携带不可变的 policy 元数据，供 Ready Barrier 验证安全边界。
 * 3. 对写操作 (effect: 'write') 强制要求 low 风险与幂等/串行约束。
 * 4. 高风险写操作（删除、修改权限、资金、敏感数据变更等）严禁注册为 Tool。
 * 5. 本工厂只负责添加 Schema 校验、安全策略元数据与超时控制，不接管 Tool Call 执行循环。
 */
export function createKkTool<
  TInput extends z.ZodTypeAny,
  TOutput extends z.ZodTypeAny = z.ZodTypeAny,
>(options: CreateKkToolOptions<TInput, TOutput>): KkMastraTool<TInput, TOutput> {
  if (options.risk !== 'low') {
    throw new Error(
      `创建 Tool [${options.id}] 失败: risk 必须为 'low'，当前不允许注册高风险写工具`
    );
  }

  if (options.effect !== 'read' && options.effect !== 'write') {
    throw new Error(`创建 Tool [${options.id}] 失败: effect 必须为 'read' 或 'write'`);
  }

  const policy: KkToolPolicy = Object.freeze({
    effect: options.effect,
    risk: options.risk,
    requiredPermission: options.requiredPermission,
    serialKey: options.serialKey ?? (options.effect === 'write' ? 'entity' : undefined),
    idempotencyField:
      options.idempotencyField ?? (options.effect === 'write' ? 'idempotencyKey' : undefined),
    timeoutMs: options.timeoutMs,
  });

  const toolOpts = {
    id: options.id,
    description: options.description,
    inputSchema: options.inputSchema,
    outputSchema: options.outputSchema,
    execute: async (inputData: unknown, context?: unknown): Promise<z.infer<TOutput>> => {
      const parsedInput = inputData as z.infer<TInput>;
      const ctx = context as { abortSignal?: AbortSignal; requestContext?: unknown } | undefined;

      // 执行超时保护（若指定）
      if (options.timeoutMs && options.timeoutMs > 0) {
        let timer: NodeJS.Timeout | undefined;
        try {
          const timeoutPromise = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new Error(`Tool [${options.id}] 执行超时 (超过 ${options.timeoutMs}ms)`));
            }, options.timeoutMs);
          });

          const result = await Promise.race([
            options.execute({
              context: parsedInput,
              abortSignal: ctx?.abortSignal,
              requestContext: ctx?.requestContext,
            }),
            timeoutPromise,
          ]);
          return result;
        } finally {
          clearTimeout(timer);
        }
      }

      return await options.execute({
        context: parsedInput,
        abortSignal: ctx?.abortSignal,
        requestContext: ctx?.requestContext,
      });
    },
  };

  const baseTool = createTool(toolOpts as unknown as Parameters<typeof createTool>[0]);

  Object.defineProperty(baseTool, 'policy', {
    value: policy,
    writable: false,
    enumerable: true,
    configurable: false,
  });

  return baseTool as unknown as KkMastraTool<TInput, TOutput>;
}
