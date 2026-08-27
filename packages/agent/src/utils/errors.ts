/**
 * Mastra-native Agent 集成层的可诊断错误基类。
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

/** Tool 输入或执行相关错误。 */
export class ToolError extends AgentError {
  public readonly toolName?: string;

  constructor(message: string, toolName?: string, code = 'TOOL_ERROR', originalCause?: Error) {
    super(message, code, originalCause);
    this.name = 'ToolError';
    this.toolName = toolName;
  }
}

/** Tool 输入校验错误，保留底层校验结果。 */
export class ToolValidationError extends ToolError {
  public readonly validationErrors?: unknown;

  constructor(
    toolName: string,
    message: string,
    validationErrors?: unknown,
    originalCause?: Error
  ) {
    super(
      `工具 "${toolName}" 参数校验失败: ${message}`,
      toolName,
      'TOOL_VALIDATION_ERROR',
      originalCause
    );
    this.name = 'ToolValidationError';
    this.validationErrors = validationErrors;
  }
}
