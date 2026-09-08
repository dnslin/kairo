const failureMessages = {
  configuration: '应用配置不可用，请联系管理员检查配置。',
  identity: '当前身份未通过校验，请联系管理员确认访问权限。',
  storage: '数据存储暂时不可用，请联系管理员检查存储服务。',
  driver: '消息连接暂时不可用，请联系管理员检查客户端连接。',
  model: '模型服务暂时不可用，请联系管理员检查模型服务。',
  knowledge: '知识检索暂时不可用，请联系管理员检查知识服务。',
  timeout: '本次处理已超时，请确认任务状态。',
  cancelled: '本次处理已取消。',
  send_unknown: '消息发送结果尚未确认，请先核实会话中的实际送达情况。',
  internal: '应用发生内部异常，请联系管理员并提供关联任务标识。',
} as const;

export type AppErrorType = keyof typeof failureMessages;

export function getFailureMessage(type: AppErrorType): string {
  return Object.hasOwn(failureMessages, type) ? failureMessages[type] : failureMessages.internal;
}

export class AppError extends Error {
  constructor(
    public readonly type: AppErrorType,
    options?: ErrorOptions
  ) {
    super(getFailureMessage(type), options);
    this.name = 'AppError';
  }
}

export function getErrorType(error: unknown, fallback: AppErrorType = 'internal'): AppErrorType {
  if (error instanceof AppError && Object.hasOwn(failureMessages, error.type)) {
    return error.type;
  }
  if (error instanceof Error || error instanceof DOMException) {
    if (error.name === 'AbortError') return 'cancelled';
    if (error.name === 'TimeoutError') return 'timeout';
  }
  return Object.hasOwn(failureMessages, fallback) ? fallback : 'internal';
}
