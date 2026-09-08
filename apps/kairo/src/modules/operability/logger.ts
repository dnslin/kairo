import { pino, type DestinationStream } from 'pino';
import { MastraLogger } from '@mastra/core/logger';
import { getErrorType } from './errors.js';
import type { AppErrorType } from './errors.js';

const events = {
  配置已加载: true,
  应用已启动: true,
  应用已关闭: true,
  应用启动失败: true,
  应用关闭失败: true,
  依赖检查失败: true,
  运行状态: true,
  运行失败: true,
} as const;

const statuses = {
  ready: true,
  not_ready: true,
  degraded: true,
  unknown: true,
  up: true,
  down: true,
  failed: true,
  started: true,
  closed: true,
} as const;

const errorTypes: Record<AppErrorType, true> = {
  configuration: true,
  identity: true,
  storage: true,
  driver: true,
  model: true,
  knowledge: true,
  timeout: true,
  cancelled: true,
  send_unknown: true,
  internal: true,
};

const correlationKeys = [
  'messageId',
  'sessionId',
  'employeeId',
  'contextId',
  'taskId',
  'runId',
  'toolId',
  'evidenceId',
] as const;

export type LogFields = Partial<Record<(typeof correlationKeys)[number], string>> & {
  event: keyof typeof events;
  durationMs?: number;
  status?: keyof typeof statuses;
  errorType?: AppErrorType;
  gitCommit?: string;
  configDigest?: string;
};

export interface AppLogger {
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

const sensitiveKeys = [
  'password',
  'token',
  'apiKey',
  'authorization',
  'Authorization',
  'question',
  'questionText',
  'answer',
  'answerText',
  'body',
  'content',
  'text',
  'prompt',
  'messages',
  'knowledge',
  'knowledgeSnippet',
  'snippet',
  'chunks',
  'err',
  'error',
  'cause',
  'stack',
  'msg',
];
const redactPaths = sensitiveKeys.flatMap(key => [key, `*.${key}`, `*.*.${key}`]);

function selectFields(fields: unknown): Record<string, string | number> {
  const selected: Record<string, string | number> = {};
  if (typeof fields !== 'object' || fields === null || fields instanceof Error) return selected;
  const source = fields as Record<string, unknown>;
  for (const key of correlationKeys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) selected[key] = value;
  }
  const event = source.event;
  if (typeof event === 'string' && Object.hasOwn(events, event)) selected.event = event;
  const status = source.status;
  if (typeof status === 'string' && Object.hasOwn(statuses, status)) selected.status = status;
  const errorType = source.errorType;
  if (typeof errorType === 'string' && Object.hasOwn(errorTypes, errorType)) {
    selected.errorType = errorType;
  }
  const durationMs = source.durationMs;
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    selected.durationMs = durationMs;
  }
  const gitCommit = source.gitCommit;
  if (typeof gitCommit === 'string' && /^[a-f0-9]{40}$/iu.test(gitCommit)) {
    selected.gitCommit = gitCommit;
  }
  const configDigest = source.configDigest;
  if (typeof configDigest === 'string' && /^[a-f0-9]{64}$/iu.test(configDigest)) {
    selected.configDigest = configDigest;
  }
  return selected;
}

export function createLogger(destination?: DestinationStream): AppLogger {
  const logger = pino({ base: null, redact: { paths: redactPaths, remove: true } }, destination);
  // Pino 的 formatter 先于 serializer 和 redact，但自由 msg 单独处理；白名单必须在调用前收紧。
  // 只传入已筛选的标量，不转发任意对象、原始异常、额外消息参数或底层 logger。
  return {
    info(fields): void {
      logger.info(selectFields(fields));
    },
    warn(fields): void {
      logger.warn(selectFields(fields));
    },
    error(fields): void {
      logger.error(selectFields(fields));
    },
  };
}

// Mastra 的 message 与附加参数可能含模型正文；只沿用关联字段，不转发原文。
export class MastraOperabilityLogger extends MastraLogger {
  constructor(private readonly output: AppLogger) {
    super({ name: 'Kairo' });
  }

  debug(_message: string, fields?: Record<string, unknown>): void {
    this.output.info({ ...selectFields(fields), event: '运行状态' });
  }

  info(_message: string, fields?: Record<string, unknown>): void {
    this.output.info({ ...selectFields(fields), event: '运行状态' });
  }

  warn(_message: string, fields?: Record<string, unknown>): void {
    this.output.warn({ ...selectFields(fields), event: '运行状态' });
  }

  error(_message: string, fields?: Record<string, unknown>): void {
    this.output.error({
      ...selectFields(fields),
      event: '运行失败',
      errorType: getErrorType(fields?.error),
    });
  }

  override trackException(error: Error, fields?: Record<string, unknown>): void {
    this.output.error({
      ...selectFields(fields),
      event: '运行失败',
      errorType: getErrorType(error),
    });
  }
}
