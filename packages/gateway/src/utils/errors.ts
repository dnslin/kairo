/**
 * Gateway / Coordinator 自定义错误体系
 */

export class CoordinatorError extends Error {
  public readonly code: string;
  public readonly originalCause?: Error;

  constructor(message: string, code = 'COORDINATOR_ERROR', originalCause?: Error) {
    super(message);
    this.name = 'CoordinatorError';
    this.code = code;
    this.originalCause = originalCause;
    if (originalCause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalCause.stack}`;
    }
  }
}

export class TakeoverActiveError extends CoordinatorError {
  constructor(message: string) {
    super(message, 'TAKEOVER_ACTIVE');
    this.name = 'TakeoverActiveError';
  }
}

export class SessionDisabledError extends CoordinatorError {
  constructor(message: string) {
    super(message, 'SESSION_DISABLED');
    this.name = 'SessionDisabledError';
  }
}
