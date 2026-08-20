/**
 * Agent 认知内核自定义错误体系
 */

export class AgentError extends Error {
  public readonly code: string;
  public readonly originalCause?: Error;

  constructor(message: string, code = 'AGENT_ERROR', originalCause?: Error) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.originalCause = originalCause;
    if (originalCause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalCause.stack}`;
    }
  }
}

export class PromptCompileError extends AgentError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'PROMPT_COMPILE_ERROR', originalCause);
    this.name = 'PromptCompileError';
  }
}

export class SensitiveContentError extends AgentError {
  public readonly matchedRules: string[];

  constructor(message: string, matchedRules: string[] = [], originalCause?: Error) {
    super(message, 'SENSITIVE_CONTENT_ERROR', originalCause);
    this.name = 'SensitiveContentError';
    this.matchedRules = matchedRules;
  }
}

export class AgentAbortError extends AgentError {
  constructor(message = 'Agent 执行已被 AbortSignal 中断', originalCause?: Error) {
    super(message, 'AGENT_ABORTED', originalCause);
    this.name = 'AgentAbortError';
  }
}

export class LLMExecutionError extends AgentError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'LLM_EXECUTION_ERROR', originalCause);
    this.name = 'LLMExecutionError';
  }
}
