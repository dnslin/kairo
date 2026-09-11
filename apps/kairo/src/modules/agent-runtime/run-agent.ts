import { RequestContext } from '@mastra/core/request-context';
import type { BotConfig } from '../../config/schema.js';
import type { AgentRequestContext, KairoAgent } from '../../mastra/agent.js';
import { answerSchema } from '../knowledge-qa/answer-schema.js';
import type { AgentAnswer } from '../knowledge-qa/answer-schema.js';
import type { PostgresKnowledgeRecordStore } from '../knowledge-qa/knowledge-record-store.js';
import { AppError, getErrorType } from '../operability/errors.js';
import type { AppLogger } from '../operability/logger.js';
import type { PrivateChatStore } from '../private-chat-core/types.js';
import { scheduleDeadline } from '../task-lifecycle/deadlines.js';
import type { TaskExecutor } from '../task-lifecycle/task-runner.js';
import type { TaskStore } from '../task-lifecycle/types.js';
import { createKnowledgeTool } from '../tool-integration/knowledge-tool.js';
import type { KnowledgeToolBinding } from '../tool-integration/knowledge-tool.js';
import { loadRetrievalSettings } from '../tool-integration/python-retrieval.js';

export interface AgentRunDependencies {
  config: BotConfig;
  bootId: string;
  chat: Pick<PrivateChatStore, 'getBatchMessages'>;
  knowledge: Pick<PostgresKnowledgeRecordStore, 'recordQuery' | 'getLastCallIndex'>;
  tasks: Pick<TaskStore, 'withTaskOutput'>;
  logger: AppLogger;
}

/** 输入复用 T25；输出尚未经过 T29，不能直接作为 TaskExecutor 的已检查 answer。 */
export async function runAgent(
  agent: KairoAgent,
  input: Parameters<TaskExecutor>[0],
  dependencies: AgentRunDependencies
): Promise<AgentAnswer> {
  const { task, attempt, context } = input;
  const { config, knowledge, logger } = dependencies;
  const deadline = task.executionDeadline;
  if (deadline === null) throw new AppError('internal');
  const lifetime = new AbortController();
  const signal = AbortSignal.any([input.signal, lifetime.signal]);
  const expire = (): void => lifetime.abort(new DOMException('任务执行截止', 'TimeoutError'));
  const stopDeadline = scheduleDeadline(deadline, expire);
  const checkExecution = (): void => {
    if (Date.now() >= deadline) expire();
    signal.throwIfAborted();
  };
  let binding: KnowledgeToolBinding | undefined;
  let answer: AgentAnswer | undefined;
  const errors: unknown[] = [];
  try {
    checkExecution();
    const knowledgeEnabled = config.tools.includes('knowledge-search');
    let messages;
    let callIndex: number;
    try {
      [messages, callIndex] = await Promise.all([
        dependencies.chat.getBatchMessages(task.batchId),
        knowledgeEnabled ? knowledge.getLastCallIndex(task.taskId) : 0,
      ]);
    } catch (cause) {
      throw new AppError('storage', { cause });
    }
    checkExecution();
    const requestContext = new RequestContext<AgentRequestContext>();
    if (knowledgeEnabled) {
      binding = createKnowledgeTool(
        loadRetrievalSettings(config.datasetId),
        {
          taskId: task.taskId,
          attemptId: attempt.attemptId,
          inputVersion: task.inputVersion,
          contextVersion: context.version,
          bootId: dependencies.bootId,
          executionDeadline: deadline,
          nextCallIndex: () => ++callIndex,
        },
        knowledge,
        logger,
        dependencies.tasks
      );
      requestContext.set('knowledgeTool', binding.tool);
    }
    // 同一个原始 deadline 覆盖模型、循环和所有 Tool；不使用新的相对执行预算。
    // 官方合同：https://mastra.ai/reference/agents/generate
    const response = await agent.generate(messages.map(message => message.text).join('\n'), {
      runId: attempt.attemptId,
      abortSignal: signal,
      requestContext,
      maxSteps: config.agent.maxSteps,
      memory: {
        resource: task.employeeId,
        thread: context.threadId,
        options: { readOnly: true },
      },
      structuredOutput: { schema: answerSchema, errorStrategy: 'strict' },
    });
    checkExecution();
    // 合法 JSON 不代表已完成：工具回合耗尽或模型截断仍不能作为最终结果。
    if (response.finishReason !== 'stop') throw new AppError('model');
    const parsed = answerSchema.safeParse(response.object);
    if (!parsed.success) throw new AppError('model', { cause: parsed.error });
    answer = parsed.data;
  } catch (cause) {
    const confirmedCancellation =
      signal.aborted &&
      (cause === signal.reason || (cause instanceof Error && cause.name === 'AbortError'));
    errors.push(
      confirmedCancellation
        ? signal.reason
        : cause instanceof AppError
          ? cause
          : new AppError(getErrorType(cause, 'model'), { cause })
    );
  } finally {
    // generate 取消可能先返回；停止新工作并等待真实 Python/落账，不能假释放执行名额。
    lifetime.abort();
    try {
      await binding?.settled();
    } catch (cause) {
      errors.push(cause);
    }
    stopDeadline();
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'Agent 生成及知识 Tool 收尾失败');
  input.signal.throwIfAborted();
  if (Date.now() >= deadline) throw new DOMException('任务执行截止', 'TimeoutError');
  if (!answer) throw new AppError('model');
  return answer;
}
