import { AppError } from '../operability/errors.js';
import type { TaskOutputScope, TaskStore } from '../task-lifecycle/types.js';
import type { ContextScope, PreparedContext, PrivateChatStore } from './types.js';

export interface ContextServiceOptions {
  store: Pick<PrivateChatStore, 'prepareContext'>;
  tasks: Pick<TaskStore, 'withTaskOutput'>;
  /** 来自已加载 Bot 配置的 contextIdleMs。 */
  idleMs: number;
}

export interface ContextService {
  resolve(scope: ContextScope, reset: boolean): Promise<PreparedContext>;
  /** 登记实际传给 Agent 的控制器；执行方在 settled 后释放，不在这里启动执行。 */
  registerExecution(
    scope: Required<TaskOutputScope>,
    controller: AbortController
  ): Promise<() => void>;
}

export function createContextService(options: ContextServiceOptions): ContextService {
  const executions = new Set<{ threadId: string; controller: AbortController }>();
  return {
    async resolve(scope, reset): Promise<PreparedContext> {
      const result = await options.store.prepareContext(scope, () => Date.now(), {
        reset,
        idleMs: options.idleMs,
      });
      // 只有事务提交成功才停止旧执行；不等待 Agent、Tool 或 Python 退出。
      if (result.invalidatedThreadId !== null) {
        for (const execution of executions) {
          if (execution.threadId === result.invalidatedThreadId) {
            execution.controller.abort(new AppError('cancelled'));
          }
        }
      }
      return result;
    },
    async registerExecution(scope, controller): Promise<() => void> {
      let release: (() => void) | undefined;
      try {
        const registered = await options.tasks.withTaskOutput(scope, task => {
          if (
            task.status !== 'running' ||
            task.executionDeadline === null ||
            Date.now() >= task.executionDeadline ||
            controller.signal.aborted
          )
            return null;
          const execution = { threadId: task.threadId, controller };
          executions.add(execution);
          release = (): void => {
            executions.delete(execution);
          };
          return release;
        });
        if (!registered?.value) throw new AppError('cancelled');
        return registered.value;
      } catch (error) {
        // 登记回调完成后 COMMIT 仍可能失败；不能留下调用方无法释放的控制器。
        release?.();
        controller.abort(error);
        throw error;
      }
    },
  };
}
