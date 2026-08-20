import type { z } from 'zod';
import type { ToolRegistry } from './registry.js';
import type {
  ApprovalManagerPort,
  LeaderApprovalRouterPort,
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
 * 1. 参数校验先于审批拦截：必须先经过 Zod 校验出合法规范的输入参数，再进行审批挂起或执行；
 * 2. 高危工具零信任拦截与原子消费：
 *    - 必须具备完整的申请人员工身份 (senderId) 与会话上下文 (threadId)；
 *    - 必须成功经由 LeaderApprovalRouter 解析出直属主管（或其显式配置的 fallbackLeaderId），严禁使用魔法值兜底，解析失败立即 Fail-Closed；
 *    - 携带 approvedTaskId 执行时必须经由 ApprovalManager 原子消费并深度核验 toolName 与 toolArgs 防篡改；
 * 3. 只读工具 (readOnly: true，如 search/query) 采用 Promise.allSettled 并行并发调度；
 * 4. 写操作工具 (readOnly: false，如 file/send/update) 保持严格串行排队执行；
 * 5. 异常自愈回传：工具报错或参数不合法时不崩溃主进程，而是封装 { error: message } 返回给 LLM 进行纠错；
 * 6. 步数硬性熔断：严格锁定单轮 ReAct maxSteps: 5，防止死循环无限消耗 Token。
 */
export class ReadWriteSplitExecutor {
  private readonly registry: ToolRegistry;
  private readonly options: Required<
    Omit<ReadWriteSplitExecutorOptions, 'approvalManager' | 'leaderRouter'>
  > & {
    approvalManager?: ApprovalManagerPort;
    leaderRouter?: LeaderApprovalRouterPort;
  };
  private currentStep = 0;

  constructor(registry: ToolRegistry, options?: ReadWriteSplitExecutorOptions) {
    this.registry = registry;
    this.options = {
      maxSteps: options?.maxSteps ?? 5,
      timeoutMs: options?.timeoutMs ?? 30000,
      strictStepLimit: options?.strictStepLimit ?? true,
      approvalManager: options?.approvalManager,
      leaderRouter: options?.leaderRouter,
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
   * 执行单个工具调用（带参数校验、高危零信任拦截、超时控制、异常捕获与自愈封装）
   */
  public async executeSingle(
    request: ToolCallRequest,
    context?: ToolExecutionContext
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const { callId, toolName, args } = request;

    // 1. 检查 AbortSignal 中断信号
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

    // 2. 检索已注册工具
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

    // 3. 参数校验优先：先校验出合法的 validatedInput，杜绝持久化非法入参
    const validationResult = tool.inputSchema.safeParse(args);
    if (!validationResult.success) {
      const formattedZodError = formatZodError(validationResult.error);
      const errMsg = `工具 "${toolName}" 输入参数校验失败: ${formattedZodError}`;
      log.warn({ callId, toolName, args, error: formattedZodError }, '参数校验不通过');
      return {
        callId,
        toolName,
        success: false,
        isError: true,
        error: errMsg,
        output: {
          error: errMsg,
          details: validationResult.error.issues,
        },
        durationMs: Date.now() - startTime,
        readOnly: isReadOnly,
      };
    }

    const validatedInput = validationResult.data;
    const validatedArgsRecord =
      typeof validatedInput === 'object' && validatedInput !== null
        ? (validatedInput as Record<string, unknown>)
        : { input: validatedInput };

    // 4. 高危工具零信任拦截与原子消费
    if (tool.requireApproval) {
      // 4.1 若携带 approvedTaskId：向 ApprovalManager 请求原子消费并执行防篡改校验
      if (context?.approvedTaskId && this.options.approvalManager) {
        try {
          const consumeResult = await this.options.approvalManager.consumeApprovedTask(
            context.approvedTaskId,
            {
              toolName,
              toolArgs: validatedArgsRecord,
            }
          );

          // 若此前已成功执行过，直接返回持久化结果 (防重复产生副作用)
          if (consumeResult.alreadyExecuted) {
            log.info(
              { callId, toolName, taskId: context.approvedTaskId },
              '任务此前已成功执行，直接返回持久化输出'
            );
            return {
              callId,
              toolName,
              success: true,
              output: consumeResult.task.toolExecutionResult,
              durationMs: Date.now() - startTime,
              readOnly: isReadOnly,
            };
          }
        } catch (authErr) {
          const errMsg = authErr instanceof Error ? authErr.message : String(authErr);
          log.warn({ callId, toolName, taskId: context.approvedTaskId, err: errMsg }, '高危工具消费拦截');
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
      } else if (this.options.approvalManager) {
        // 4.2 首次调用：必须具备完整的员工身份与会话上下文，必须能解析出直属主管 (Fail-Closed)
        const senderId = context?.senderId?.trim();
        const threadId = context?.threadId?.trim();

        if (!senderId || !threadId) {
          const missingCtxMsg = `高危操作拦截失败: 缺失必要的员工身份信息 (senderId) 或会话上下文 (threadId)，已强制阻断执行`;
          log.error({ callId, toolName, senderId, threadId }, missingCtxMsg);
          return {
            callId,
            toolName,
            success: false,
            isError: true,
            error: missingCtxMsg,
            output: { error: missingCtxMsg },
            durationMs: Date.now() - startTime,
            readOnly: false,
          };
        }

        if (!this.options.leaderRouter) {
          const missingRouterMsg = `高危操作拦截失败: 系统未配置 LeaderApprovalRouter，无法解析审批主管，已强制阻断执行`;
          log.error({ callId, toolName }, missingRouterMsg);
          return {
            callId,
            toolName,
            success: false,
            isError: true,
            error: missingRouterMsg,
            output: { error: missingRouterMsg },
            durationMs: Date.now() - startTime,
            readOnly: false,
          };
        }

        let leaderId: string;
        let leaderName: string | undefined;

        try {
          const leader = await this.options.leaderRouter.resolveLeader(senderId);
          leaderId = leader.leaderId;
          leaderName = leader.leaderName;
        } catch (routerErr) {
          const resolveFailMsg = `高危操作拦截失败: 无法解析员工 (ID: ${senderId}) 的审批主管，已强制阻断执行`;
          log.error({ callId, toolName, senderId, err: routerErr }, resolveFailMsg);
          return {
            callId,
            toolName,
            success: false,
            isError: true,
            error: resolveFailMsg,
            output: { error: resolveFailMsg },
            durationMs: Date.now() - startTime,
            readOnly: false,
          };
        }

        const { task } = await this.options.approvalManager.startApprovalWorkflow({
          toolCallId: callId,
          toolName,
          toolArgs: validatedArgsRecord,
          applicantId: senderId,
          applicantName: undefined,
          leaderId,
          leaderName,
          threadId,
        });

        log.info(
          { callId, toolName, taskId: task.id, leaderId },
          '高危工具已被 HITL 审批状态机挂起拦截'
        );

        return {
          callId,
          toolName,
          success: true,
          suspended: true,
          approvalTaskId: task.id,
          approvalStatus: 'pending',
          output: {
            suspended: true,
            approvalTaskId: task.id,
            message: `该操作涉及高危权限，已自动发起直属主管审批 (待办ID: ${task.id})，请等待审批通过。`,
          },
          durationMs: Date.now() - startTime,
          readOnly: isReadOnly,
        };
      }
    }

    // 5. 执行底层工具逻辑，注入超时 AbortSignal 级联中断与异常自愈控制
    const timeoutController = new AbortController();
    const effectiveSignal = context?.signal
      ? AbortSignal.any([context.signal, timeoutController.signal])
      : timeoutController.signal;

    const executionContext: ToolExecutionContext = {
      ...context,
      signal: effectiveSignal,
    };

    let timeoutTimer: NodeJS.Timeout | undefined;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => {
          const timeoutErr = new Error(
            `工具 "${toolName}" 执行超时 (超过 ${this.options.timeoutMs}ms)`
          );
          timeoutController.abort(timeoutErr);
          reject(timeoutErr);
        }, this.options.timeoutMs);
      });

      const executePromise = tool.execute(validatedInput, executionContext);

      const output = await Promise.race([executePromise, timeoutPromise]);

      // 若经由 approvedTaskId 授权执行成功，持久化执行结果
      if (context?.approvedTaskId && this.options.approvalManager) {
        await this.options.approvalManager.recordToolExecutionResult(
          context.approvedTaskId,
          output
        );
      }

      const durationMs = Date.now() - startTime;
      log.debug({ callId, toolName, durationMs, readOnly: isReadOnly }, '工具单次执行成功');

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
      log.error({ callId, toolName, err, durationMs }, '工具执行抛出异常');

      if (context?.approvedTaskId && this.options.approvalManager) {
        await this.options.approvalManager.recordToolExecutionError(
          context.approvedTaskId,
          err.message
        );
      }

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
    } finally {
      clearTimeout(timeoutTimer);
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
        suspendedCount: 0,
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

    const orderedResults: Array<ToolExecutionResult | null> = new Array<ToolExecutionResult | null>(
      requests.length
    ).fill(null);

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
    const successCount = finalResults.filter(r => r.success && !r.suspended).length;
    const suspendedCount = finalResults.filter(r => r.suspended).length;
    const failureCount = finalResults.filter(r => !r.success).length;

    log.info(
      {
        total: requests.length,
        successCount,
        suspendedCount,
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
      suspendedCount,
    };
  }
}
