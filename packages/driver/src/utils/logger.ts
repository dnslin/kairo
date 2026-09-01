import pino from 'pino';

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
  return logger.child({ module: name });
}
