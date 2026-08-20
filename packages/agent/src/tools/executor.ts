import type { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type {
  ReadWriteSplitExecutorOptions,
  ToolBatchExecutionResult,
  ToolCallRequest,
  ToolExecutionContext,
  ToolExecutionResult,
} from './types.js';
import { StepLimitExceededError } from '../utils/errors.js';
import { createChildLogger } from '../utils/logger.js';

const log = createChildLogger('tool-executor');

/**
 * 格式化 Zod 校验错误信息为易读的中文自愈提示
 */
function formatZodError(error: z.ZodError): string {
  const issues = error.issues.map(issue => {
    const pathStr = issue.path.length > 0 ? issue.path.join('.') : '根参数';
    return `字段 "${pathStr}": ${issue.message}`;
  });
  return issues.join('; ');
}

/**
 * KKBot 读写分流高并发工具调度执行引擎 (Read/Write Split ReAct)
 *
 * 核心调度策略：
 * 1. 只读工具 (readOnly: true，如 search/query) 采用 Promise.allSettled 并行并发调度，极大降低延迟；
 * 2. 写操作工具 (readOnly: false，如 file/send/update) 保持严格串行排队执行，杜绝竞态与状态错乱；
 * 3. 异常自愈回传：工具报错或参数不合法时不崩溃主进程，而是封装 { error: message } 返回给 LLM 进行纠错；
 * 4. 步数硬性熔断：严格锁定单轮 ReAct maxSteps: 5，防止死循环无限消耗 Token。
 */
export class ReadWriteSplitExecutor {
  private readonly registry: ToolRegistry;
  private readonly options: Required<ReadWriteSplitExecutorOptions>;
  private currentStep = 0;

  constructor(registry: ToolRegistry, options?: ReadWriteSplitExecutorOptions) {
    this.registry = registry;
    this.options = {
      maxSteps: options?.maxSteps ?? 5,
      timeoutMs: options?.timeoutMs ?? 30000,
      strictStepLimit: options?.strictStepLimit ?? true,
    };
  }

  /**
   * 记录并递增 ReAct 步数，超过 maxSteps (默认 5) 时触发硬性熔断
   * @param step 指定步数（若未传则在当前步数基础上自增 1）
   * @returns 当前步数
   */
  public recordStep(step?: number): number {
    this.currentStep = step !== undefined ? step : this.currentStep + 1;
    log.debug(
      { currentStep: this.currentStep, maxSteps: this.options.maxSteps },
      '记录 ReAct 工具调用步数'
    );

    if (this.currentStep > this.options.maxSteps) {
      log.warn(
        { currentStep: this.currentStep, maxSteps: this.options.maxSteps },
        '单轮 ReAct 步数已超过硬性熔断阈值，触发熔断阻断'
      );
      if (this.options.strictStepLimit) {
        throw new StepLimitExceededError(this.currentStep, this.options.maxSteps);
      }
    }

    return this.currentStep;
  }

  /**
   * 获取当前 ReAct 执行步数
   */
  public getCurrentStep(): number {
    return this.currentStep;
  }

  /**
   * 重置 ReAct 步数计数器
   */
  public resetSteps(): void {
    this.currentStep = 0;
    log.debug('已重置 ReAct 工具执行步数计数器');
  }

  /**
   * 执行单个工具调用（带参数校验、超时、异常捕获与自愈封装）
   */
  public async executeSingle(
    request: ToolCallRequest,
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const { callId, toolName, args } = request;

    // 检查 AbortSignal 中断信号
    if (context?.signal?.aborted) {
      log.warn({ callId, toolName }, '检测到 AbortSignal 已中断，取消工具执行');
      return {
        callId,
        toolName,
        success: false,
        isError: true,
        error: '工具调用已被 AbortSignal 中断',
        output: { error: '工具调用已被 AbortSignal 中断' },
        durationMs: Date.now() - startTime,
        readOnly: false,
      };
    }

    const tool = this.registry.get(toolName);
    if (!tool) {
      const errMsg = `未找到名称为 "${toolName}" 的工具，请检查工具名称是否正确或已注册`;
      log.warn({ callId, toolName }, errMsg);
      return {
        callId,
        toolName,
        success: false,
        isError: true,
        error: errMsg,
        output: { error: errMsg },
        durationMs: Date.now() - startTime,
        readOnly: false,
      };
    }

    const isReadOnly = tool.readOnly;

    try {
      // 1. Zod 参数强类型校验
      let validatedArgs: unknown = args;
      if (tool.inputSchema && typeof tool.inputSchema.safeParseAsync === 'function') {
        const parseRes = await tool.inputSchema.safeParseAsync(args ?? {});
        if (!parseRes.success) {
          const formattedErr = formatZodError(parseRes.error);
          log.warn(
            { callId, toolName, args, error: formattedErr },
            '工具入参未通过 Zod 校验'
          );
          return {
            callId,
            toolName,
            success: false,
            isError: true,
            error: `参数校验失败: ${formattedErr}`,
            output: { error: `工具 "${toolName}" 参数校验失败: ${formattedErr}` },
            durationMs: Date.now() - startTime,
            readOnly: isReadOnly,
          };
        }
        validatedArgs = parseRes.data;
      }

      // 2. 超时控制与真正执行
      const timeoutMs = this.options.timeoutMs;
      let timer: NodeJS.Timeout | undefined;

      const executePromise = tool.execute(validatedArgs, context);

      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`工具执行超时 (超过 ${timeoutMs}ms)`));
        }, timeoutMs);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });

      let output: unknown;
      try {
        output = await Promise.race([executePromise, timeoutPromise]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
      const durationMs = Date.now() - startTime;

      log.debug({ callId, toolName, durationMs }, '工具执行成功');

      return {
        callId,
        toolName,
        success: true,
        output,
        durationMs,
        readOnly: isReadOnly,
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const err = error instanceof Error ? error : new Error(String(error));
      log.error({ callId, toolName, err, durationMs }, '工具执行发生异常');

      return {
        callId,
        toolName,
        success: false,
        isError: true,
        error: err.message,
        output: { error: err.message },
        durationMs,
        readOnly: isReadOnly,
      };
    }
  }

  /**
   * 读写分流批量并发执行工具调用集
   * - 只读工具集合通过 Promise.allSettled 真正并发执行；
   * - 写操作工具集合严格按顺序串行执行；
   * - 最终合并所有结果并保持与输入请求的顺序一致。
   */
  public async executeBatch(
    requests: ToolCallRequest[],
    context?: ToolExecutionContext
  ): Promise<ToolBatchExecutionResult> {
    const startBatchTime = Date.now();
    log.debug({ requestCount: requests.length }, '开始调度执行批量工具调用');

    if (!requests || requests.length === 0) {
      return {
        results: [],
        totalDurationMs: 0,
        successCount: 0,
        failureCount: 0,
        readOnlyCount: 0,
        writeCount: 0,
      };
    }

    // 1. 分流归类：只读工具 vs 写工具
    const readRequests: Array<{ req: ToolCallRequest; originalIndex: number }> = [];
    const writeRequests: Array<{ req: ToolCallRequest; originalIndex: number }> = [];

    requests.forEach((req, idx) => {
      const tool = this.registry.get(req.toolName);
      if (tool && tool.readOnly) {
        readRequests.push({ req, originalIndex: idx });
      } else {
        writeRequests.push({ req, originalIndex: idx });
      }
    });

    const orderedResults: Array<ToolExecutionResult | null> = new Array<ToolExecutionResult | null>(requests.length).fill(null);

    // 2. 只读工具组：Promise.allSettled 并发执行
    if (readRequests.length > 0) {
      log.debug({ readCount: readRequests.length }, '正在并发调度只读工具集合...');
      const readPromises = readRequests.map(async ({ req, originalIndex }) => {
        const result = await this.executeSingle(req, context);
        orderedResults[originalIndex] = result;
      });
      await Promise.allSettled(readPromises);
    }

    // 3. 写操作工具组：严格串行排队执行
    if (writeRequests.length > 0) {
      log.debug({ writeCount: writeRequests.length }, '正在串行调度写操作工具集合...');
      for (const { req, originalIndex } of writeRequests) {
        const result = await this.executeSingle(req, context);
        orderedResults[originalIndex] = result;
      }
    }

    const finalResults: ToolExecutionResult[] = [];
    for (const r of orderedResults) {
      if (r !== null) {
        finalResults.push(r);
      }
    }

    const totalDurationMs = Date.now() - startBatchTime;
    const successCount = finalResults.filter(r => r.success).length;
    const failureCount = finalResults.filter(r => !r.success).length;

    log.info(
      {
        total: requests.length,
        successCount,
        failureCount,
        readOnlyCount: readRequests.length,
        writeCount: writeRequests.length,
        totalDurationMs,
      },
      '批量工具调度执行完成'
    );

    return {
      results: finalResults,
      totalDurationMs,
      successCount,
      failureCount,
      readOnlyCount: readRequests.length,
      writeCount: writeRequests.length,
    };
  }
}
