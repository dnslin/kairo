/**
 * 存储层自定义错误体系
 */

export class StoreError extends Error {
  public readonly code: string;
  public readonly originalCause?: Error;

  constructor(message: string, code = 'STORE_ERROR', originalCause?: Error) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    this.originalCause = originalCause;
    if (originalCause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${originalCause.stack}`;
    }
  }
}

export class DatabaseConnectionError extends StoreError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'DB_CONNECTION_ERROR', originalCause);
    this.name = 'DatabaseConnectionError';
  }
}

export class SchemaInitError extends StoreError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'SCHEMA_INIT_ERROR', originalCause);
    this.name = 'SchemaInitError';
  }
}

export class TransactionError extends StoreError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'TRANSACTION_ERROR', originalCause);
    this.name = 'TransactionError';
  }
}

export class NotFoundError extends StoreError {
  constructor(message: string) {
    super(message, 'NOT_FOUND');
    this.name = 'NotFoundError';
  }
}
