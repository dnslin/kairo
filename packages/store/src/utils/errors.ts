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
export class DatabaseError extends StoreError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'DATABASE_ERROR', originalCause);
    this.name = 'DatabaseError';
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

export class MediaStorageError extends StoreError {
  constructor(message: string, originalCause?: Error) {
    super(message, 'MEDIA_STORAGE_ERROR', originalCause);
    this.name = 'MediaStorageError';
  }
}

export class InvalidPathError extends StoreError {
  constructor(message: string) {
    super(message, 'INVALID_PATH_ERROR');
    this.name = 'InvalidPathError';
  }
}

export class DeliveryStateTransitionError extends StoreError {
  public readonly deliveryId: string;
  public readonly fromStatus: string;
  public readonly toStatus: string;

  constructor(deliveryId: string, fromStatus: string, toStatus: string, message?: string) {
    super(
      message || `非法 Delivery 状态转换: 无法从 [${fromStatus}] 迁移至 [${toStatus}] (ID: ${deliveryId})`,
      'DELIVERY_STATE_TRANSITION_ERROR'
    );
    this.name = 'DeliveryStateTransitionError';
    this.deliveryId = deliveryId;
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
  }
}

export class MessageTombstonedError extends StoreError {
  public readonly sessionId: string;
  public readonly messageId: string;
  public readonly tombstoneType: string;

  constructor(sessionId: string, messageId: string, tombstoneType: string = 'compliance_deletion', message?: string) {
    super(
      message || `消息 [${sessionId}:${messageId}] 已处于墓碑状态 (${tombstoneType})，拒绝写入`,
      'MESSAGE_TOMBSTONED_ERROR'
    );
    this.name = 'MessageTombstonedError';
    this.sessionId = sessionId;
    this.messageId = messageId;
    this.tombstoneType = tombstoneType;
  }
}
