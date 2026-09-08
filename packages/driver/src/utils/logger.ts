import pino from 'pino';

export interface DriverLogEntry {
  level: 'info' | 'warn' | 'error';
  event: 'Driver运行状态' | 'Driver运行异常' | 'Driver连接状态' | 'Driver发送结果';
  messageId?: string;
  sessionId?: string;
  employeeId?: string;
  runId?: string;
  durationMs?: number;
  status?: 'up' | 'down' | 'failed' | 'unknown' | 'delivered' | 'received';
  errorType?: 'driver' | 'send_unknown';
}

export type DriverLogSink = (entry: DriverLogEntry) => void;

let driverLogSink: DriverLogSink | undefined;

/** 替换进程级日志出口；传入 undefined 后恢复独立 Pino 输出。 */
export function setDriverLogSink(sink: DriverLogSink | undefined): void {
  driverLogSink = sink;
}

const identifierFields = ['messageId', 'sessionId', 'employeeId'] as const;

function createLogEntry(input: unknown, numericLevel: number): DriverLogEntry {
  const source =
    typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : undefined;
  const level = numericLevel >= 50 ? 'error' : numericLevel >= 40 ? 'warn' : 'info';
  const entry: DriverLogEntry = {
    level,
    event: level === 'info' ? 'Driver运行状态' : 'Driver运行异常',
  };

  switch (source?.['event']) {
    case 'Driver运行状态':
    case 'Driver运行异常':
    case 'Driver连接状态':
    case 'Driver发送结果':
      entry.event = source['event'];
  }

  for (const field of identifierFields) {
    const value = source?.[field];
    if (typeof value === 'string') entry[field] = value;
  }
  const runId = source?.['runId'];
  const startupGenerationId = source?.['startupGenerationId'];
  if (typeof runId === 'string') entry.runId = runId;
  else if (typeof startupGenerationId === 'string') entry.runId = startupGenerationId;

  const durationMs = source?.['durationMs'];
  if (typeof durationMs === 'number' && Number.isFinite(durationMs)) {
    entry.durationMs = durationMs;
  }
  switch (source?.['status']) {
    case 'up':
    case 'down':
    case 'failed':
    case 'unknown':
    case 'delivered':
    case 'received':
      entry.status = source['status'];
  }

  const errorType = source?.['errorType'];
  if (errorType === 'driver' || errorType === 'send_unknown') entry.errorType = errorType;
  else if (level !== 'info') entry.errorType = 'driver';
  return entry;
}

// Windows 终端编码防护：确保控制台以 UTF-8 输出
if (process.platform === 'win32' && process.stdout.isTTY) {
  try {
    process.stdout.setDefaultEncoding('utf-8');
    process.stderr.setDefaultEncoding('utf-8');
  } catch {
    // 忽略在部分子进程下的只读错误
  }
}

export const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  base: null,
  hooks: {
    logMethod(args, method, level) {
      // 在 Pino 读取异常、格式化正文或调用 toJSON 之前截断非白名单字段。
      const entry = createLogEntry(args[0], level);
      if (driverLogSink) {
        driverLogSink(entry);
      } else {
        // 独立输出保留 Pino 数字级别，避免与接收函数的归一化级别重名。
        method.apply(this, [{ ...entry, level: undefined }]);
      }
    },
  },
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'HH:MM:ss.l',
            ignore: 'pid,hostname',
            singleLine: false,
          },
        }
      : undefined,
});

export function createChildLogger(name: string): pino.Logger {
  // Pino 子日志默认会序列化 bindings，显式过滤以免绕过安全日志入口。
  return logger.child({ module: name }, { formatters: { bindings: () => ({}) } });
}
