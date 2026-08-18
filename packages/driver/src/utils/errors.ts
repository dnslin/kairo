/**
 * 驱动自定义错误体系
 */

export class DriverError extends Error {
  public readonly code: string;
  public readonly originalCause?: Error;

  constructor(message: string, code = 'DRIVER_ERROR', originalCause?: Error) {
    super(message);
    this.name = 'DriverError';
    this.code = code;
    this.originalCause = originalCause;
    if (originalCause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalCause.stack}`;
    }
  }
}

export class CdpError extends DriverError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'CDP_ERROR', originalCause);
    this.name = 'CdpError';
  }
}

export class DomError extends DriverError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'DOM_ERROR', originalCause);
    this.name = 'DomError';
  }
}

export class SendError extends DriverError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'SEND_ERROR', originalCause);
    this.name = 'SendError';
  }
}
