import type { KairoAgent } from '../../mastra/agent.js';
import { runAgent, type AgentRunDependencies } from '../agent-runtime/run-agent.js';
import type { SendDispatch, SendRequest } from '../im-transport/send-policy.js';
import type { SendService } from '../im-transport/send-service.js';
import { AppError, getErrorType } from '../operability/errors.js';
import type { PrivateChatStore } from '../private-chat-core/types.js';
import type { TaskExecutor, TaskExecutionResult } from '../task-lifecycle/task-runner.js';
import type { Task, TaskAttempt, TaskStore } from '../task-lifecycle/types.js';
import { validateAnswer } from './validate-answer.js';
import type {
  PostgresKnowledgeRecordStore,
  RecordPage,
  KnowledgeQuery,
  KnowledgeEvidence,
} from './knowledge-record-store.js';
export interface KnowledgeServiceOptions extends AgentRunDependencies {
  agent: KairoAgent;
  chat: Pick<PrivateChatStore, 'getBatchMessages' | 'getContext'>;
  tasks: TaskStore;
  knowledge: PostgresKnowledgeRecordStore;
}
export interface KnowledgeService {
  execute: TaskExecutor;
  send(
    request: SendRequest,
    sender: Pick<SendService, 'send' | 'recover'>,
    recovery?: boolean
  ): Promise<SendDispatch>;
  reconcileDelivered(botId: string, signal: AbortSignal): Promise<void>;
}

async function readAll<T>(readPage: (page: RecordPage) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let offset = 0; ; offset += 100) {
    const page = await readPage({ limit: 100, offset });
    rows.push(...page);
    if (page.length < 100) return rows;
  }
}

/** T29 只裁决完整企业回答；采用、三态发送和取消仍由 T25/T21/T24 拥有。 */
export function createKnowledgeService(options: KnowledgeServiceOptions): KnowledgeService {
  const { tasks, chat, knowledge, logger } = options;
  async function facts(
    taskId: string
  ): Promise<{ queries: KnowledgeQuery[]; evidence: KnowledgeEvidence[] }> {
    const [queries, evidence] = await Promise.all([
      readAll(page => knowledge.listQueries(taskId, page)),
      readAll(page => knowledge.listEvidence(taskId, page)),
    ]);
    return { queries, evidence };
  }

  async function currentExecution(input: Parameters<TaskExecutor>[0]): Promise<void> {
    input.signal.throwIfAborted();
    const current = await tasks.withTaskOutput(
      {
        taskId: input.task.taskId,
        attemptId: input.attempt.attemptId,
        inputVersion: input.task.inputVersion,
        contextVersion: input.context.version,
      },
      task => {
        input.signal.throwIfAborted();
        if (
          task.status !== 'running' ||
          task.threadId !== input.context.threadId ||
          task.employeeId !== input.context.employeeId ||
          task.employeeId !== input.task.employeeId ||
          task.botId !== input.context.botId ||
          task.sessionId !== input.context.sessionId
        )
          return false;
        if (task.executionDeadline === null || Date.now() >= task.executionDeadline)
          throw new AppError('timeout');
        return true;
      }
    );
    if (!current?.value) throw new AppError('cancelled');
  }

  function matchesAttempt(task: Task, attempt: TaskAttempt | null): attempt is TaskAttempt {
    return (
      attempt !== null &&
      attempt.taskId === task.taskId &&
      attempt.attemptId === task.currentAttemptId &&
      attempt.inputVersion === task.inputVersion
    );
  }

  const execute: TaskExecutor = async input => {
    await currentExecution(input);
    const attempt = await tasks.getAttempt(input.attempt.attemptId);
    if (!matchesAttempt(input.task, attempt) || attempt.finishedAt !== null || attempt.adopted)
      throw new AppError('cancelled');
    const output = await runAgent(options.agent, input, options);
    const records = await facts(input.task.taskId);
    await currentExecution(input);
    const validation = validateAnswer(
      output,
      {
        taskId: input.task.taskId,
        attemptId: attempt.attemptId,
        datasetId: options.config.datasetId,
      },
      records
    );
    const saved = await knowledge.recordAnswerCheck({
      taskId: input.task.taskId,
      attemptId: attempt.attemptId,
      inputVersion: input.task.inputVersion,
      answer: validation.status === 'accepted' ? validation.answer : null,
      diagnostics: validation.diagnostics,
    });
    if (!saved) throw new AppError('storage');
    if (validation.status === 'rejected') {
      logger.warn({
        event: '运行失败',
        taskId: input.task.taskId,
        runId: attempt.runId,
        errorType: validation.errorType,
      });
      throw new AppError(validation.errorType);
    }
    await currentExecution(input);
    return { kind: 'answer', text: validation.answer.answer };
  };

  async function checkedTask(request: SendRequest): Promise<{ task: Task; attempt: TaskAttempt }> {
    if (request.subject.kind !== 'task') throw new AppError('knowledge');
    const task = await tasks.getTask(request.subject.taskId);
    if (
      !task ||
      task.inputVersion !== request.subject.inputVersion ||
      !['ready_to_send', 'sending', 'completed', 'failed', 'send_unconfirmed'].includes(
        task.status
      ) ||
      !task.currentAttemptId
    )
      throw new AppError('cancelled');
    const [attempt, check, context] = await Promise.all([
      tasks.getAttempt(task.currentAttemptId),
      knowledge.getAnswerCheck(task.currentAttemptId),
      chat.getContext(task.threadId),
    ]);
    if (
      !context ||
      context.invalidatedAt !== null ||
      !matchesAttempt(task, attempt) ||
      !attempt.adopted ||
      attempt.finishedAt === null ||
      attempt.errorType !== null
    )
      throw new AppError('cancelled');
    if (
      !check?.answer ||
      check.taskId !== task.taskId ||
      check.inputVersion !== task.inputVersion ||
      task.answerText !== request.text ||
      check.answer.answer !== request.text
    )
      throw new AppError('knowledge');
    const validation = validateAnswer(
      check.answer,
      {
        taskId: task.taskId,
        attemptId: attempt.attemptId,
        datasetId: options.config.datasetId,
      },
      await facts(task.taskId)
    );
    if (validation.status !== 'accepted') throw new AppError(validation.errorType);
    return { task, attempt };
  }

  return {
    async reconcileDelivered(botId, signal): Promise<void> {
      const pending = await readAll(page => knowledge.listPendingFormalAnswers(botId, page));
      for (const item of pending) {
        signal.throwIfAborted();
        const messages = await chat.getBatchMessages(item.batchId);
        if (
          !(await knowledge.recordCheckedDelivery({
            ...item,
            bootId: options.bootId,
            question: messages.map(message => message.text).join('\n'),
          }))
        )
          throw new AppError('storage');
      }
    },
    async execute(input): Promise<TaskExecutionResult> {
      try {
        return await execute(input);
      } catch (cause) {
        if (cause instanceof AppError || input.signal.aborted) throw cause;
        throw new AppError(getErrorType(cause, 'storage'), { cause });
      }
    },
    async send(request, sender, recovery = false): Promise<SendDispatch> {
      // 固定提示不冒充企业结论；同一调用捕获原sender，不在await后切到新generation。
      const checked = request.purpose === 'final' ? await checkedTask(request) : null;
      const dispatch = await (recovery ? sender.recover(request) : sender.send(request));
      if (dispatch.status !== 'delivered' || checked === null) return dispatch;
      const messages = await chat.getBatchMessages(checked.task.batchId);
      const saved = await knowledge.recordCheckedDelivery({
        taskId: checked.task.taskId,
        attemptId: checked.attempt.attemptId,
        inputVersion: checked.task.inputVersion,
        operationId: dispatch.operationId,
        bootId: options.bootId,
        question: messages.map(message => message.text).join('\n'),
      });
      if (!saved) {
        // /new 可在真实送达后先提交；不把旧结果写入新context，也不改写Driver送达事实。
        const context = await chat.getContext(checked.task.threadId);
        if (context !== null && context.invalidatedAt !== null) return dispatch;
        throw new AppError('storage');
      }
      return dispatch;
    },
  };
}
