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

export class ToolError extends AgentError {
  public readonly toolName?: string;

  constructor(message: string, toolName?: string, code = 'TOOL_ERROR', originalCause?: Error) {
    super(message, code, originalCause);
    this.name = 'ToolError';
    this.toolName = toolName;
  }
}

export class ToolNotFoundError extends ToolError {
  constructor(toolName: string) {
    super(`未找到名称为 "${toolName}" 的工具`, toolName, 'TOOL_NOT_FOUND');
    this.name = 'ToolNotFoundError';
  }
}

export class ToolValidationError extends ToolError {
  public readonly validationErrors?: unknown;

  constructor(toolName: string, message: string, validationErrors?: unknown, originalCause?: Error) {
    super(`工具 "${toolName}" 参数校验失败: ${message}`, toolName, 'TOOL_VALIDATION_ERROR', originalCause);
    this.name = 'ToolValidationError';
    this.validationErrors = validationErrors;
  }
}

export class ToolExecutionError extends ToolError {
  constructor(toolName: string, message: string, originalCause?: Error) {
    super(`工具 "${toolName}" 执行失败: ${message}`, toolName, 'TOOL_EXECUTION_ERROR', originalCause);
    this.name = 'ToolExecutionError';
  }
}

export class McpClientError extends AgentError {
  public readonly serverId?: string;

  constructor(message: string, serverId?: string, originalCause?: Error) {
    super(message, 'MCP_CLIENT_ERROR', originalCause);
    this.name = 'McpClientError';
    this.serverId = serverId;
  }
}

export class StepLimitExceededError extends AgentError {
  public readonly maxSteps: number;
  public readonly currentStep: number;

  constructor(currentStep: number, maxSteps = 5) {
    super(`单轮 ReAct 步数 (${currentStep}) 超过硬性熔断阈值 (${maxSteps} 步)，已强制终止`, 'STEP_LIMIT_EXCEEDED');
    this.name = 'StepLimitExceededError';
    this.maxSteps = maxSteps;
    this.currentStep = currentStep;
  }
}
