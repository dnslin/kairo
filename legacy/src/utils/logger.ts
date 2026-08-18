import pino from 'pino';

const isDev = process.env['NODE_ENV'] !== 'production';

export const logger = isDev
  ? pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
      transport: {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      },
    })
  : pino({
      level: process.env['LOG_LEVEL'] ?? 'info',
    });

export function createChildLogger(name: string): pino.Logger {
  return logger.child({ module: name });
}
