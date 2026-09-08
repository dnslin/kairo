import { describe, expect, it } from 'vitest';
import {
  AppError,
  getErrorType,
  getFailureMessage,
  type AppErrorType,
} from '../../src/modules/operability/errors.js';
import {
  createLogger,
  MastraOperabilityLogger,
  type LogFields,
} from '../../src/modules/operability/logger.js';

function captureLogs() {
  const lines: string[] = [];
  const logger = createLogger({ write: line => lines.push(line) });
  return {
    logger,
    output: () => lines.join(''),
    records: () => lines.map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

const correlationIds = {
  messageId: 'message-1',
  sessionId: 'session-1',
  employeeId: '3585',
  contextId: 'context-1',
  taskId: 'task-1',
  runId: 'run-1',
  toolId: 'tool-1',
  evidenceId: 'evidence-1',
};

const errorTypes: AppErrorType[] = [
  'configuration',
  'identity',
  'storage',
  'driver',
  'model',
  'knowledge',
  'timeout',
  'cancelled',
  'send_unknown',
  'internal',
];

describe('T17 运维结构化日志', () => {
  it('框架自由消息和异常经转接后只保留关联字段及稳定分类', () => {
    const { logger, records, output } = captureLogs();
    const framework = new MastraOperabilityLogger(logger);
    framework.info('禁止输出的模型正文', { runId: 'run-safe', question: '禁止输出的问题' });
    framework.error('禁止输出的异常正文', {
      taskId: 'task-safe',
      error: new AppError('model', { cause: new Error('禁止输出的凭证') }),
    });
    framework.trackException(new AppError('timeout'), {
      runId: 'run-timeout',
      token: '禁止输出的令牌',
    });
    expect(output()).not.toContain('禁止输出');
    expect(records()).toEqual([
      { level: 30, time: expect.any(Number), event: '运行状态', runId: 'run-safe' },
      {
        level: 50,
        time: expect.any(Number),
        event: '运行失败',
        taskId: 'task-safe',
        errorType: 'model',
      },
      {
        level: 50,
        time: expect.any(Number),
        event: '运行失败',
        runId: 'run-timeout',
        errorType: 'timeout',
      },
    ]);
  });
  it('不暴露底层 Pino、子日志或自由消息入口', () => {
    const { logger } = captureLogs();
    for (const key of ['child', 'bindings', 'raw', 'pino', 'fatal', 'debug', 'trace']) {
      expect(Reflect.get(logger, key)).toBeUndefined();
    }
  });

  it('三个级别均保留全部关联标识、耗时、稳定状态与错误分类', () => {
    const { logger, records } = captureLogs();
    for (const level of ['info', 'warn', 'error'] as const) {
      logger[level]({
        event: '运行失败',
        ...correlationIds,
        durationMs: 12.5,
        status: 'failed',
        errorType: 'storage',
      });
    }

    expect(records()).toEqual(
      [30, 40, 50].map(level => ({
        level,
        time: expect.any(Number),
        event: '运行失败',
        ...correlationIds,
        durationMs: 12.5,
        status: 'failed',
        errorType: 'storage',
      }))
    );
  });

  it('保留 T15 部署标识而不接受冒充摘要的正文或对象', () => {
    const { logger, records, output } = captureLogs();
    const gitCommit = 'abcdef0123456789'.repeat(2) + 'abcdef01';
    const configDigest = 'abcdef0123456789'.repeat(4);
    logger.info({ event: '配置已加载', gitCommit, configDigest });
    logger.info({
      event: '配置已加载',
      gitCommit: '禁止输出的部署正文',
      configDigest: { token: '禁止输出的摘要凭证' },
    } as unknown as LogFields);

    expect(records()[0]).toMatchObject({ event: '配置已加载', gitCommit, configDigest });
    expect(records()[1]).not.toHaveProperty('gitCommit');
    expect(records()[1]).not.toHaveProperty('configDigest');
    expect(output()).not.toContain('禁止输出');
  });

  it('顶层、多层对象和数组中的凭证与问答知识正文一律不进入日志', () => {
    const { logger, records, output } = captureLogs();
    const sensitive = Object.fromEntries(
      [
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
      ].map(key => [key, `禁止输出-${key}`])
    );
    for (const level of ['info', 'warn', 'error'] as const) {
      logger[level]({
        event: '运行状态',
        messageId: 'message-safe',
        ...sensitive,
        request: { headers: sensitive, payload: { ...sensitive } },
        results: [{ nested: { ...sensitive } }],
      } as LogFields);
    }

    expect(output()).not.toContain('禁止输出');
    for (const record of records()) {
      expect(record).toEqual({
        level: expect.any(Number),
        time: expect.any(Number),
        event: '运行状态',
        messageId: 'message-safe',
      });
    }
  });

  it('不序列化原始异常、cause、stack、自由消息或消息格式插值', () => {
    const { logger, output, records } = captureLogs();
    const cause = new Error('禁止输出的内部凭证');
    const error = new AppError('storage', { cause });
    error.stack = '禁止输出的调用栈';
    const unsafeError = logger.error as (...args: unknown[]) => void;
    unsafeError(
      {
        event: '运行失败',
        errorType: getErrorType(error),
        err: error,
        error,
        cause,
        stack: error.stack,
        msg: '禁止输出的正文',
      },
      '禁止输出的自由消息 %o',
      cause
    );
    unsafeError(error);
    unsafeError('禁止输出的字符串 %o', cause);

    expect(output()).not.toContain('禁止输出');
    expect(records()[0]).toMatchObject({ event: '运行失败', errorType: 'storage' });
    for (const record of records()) {
      for (const key of ['err', 'error', 'cause', 'stack', 'msg']) {
        expect(record).not.toHaveProperty(key);
      }
    }
    expect(error.cause).toBe(cause);
  });

  it('标识与状态拒绝对象且不调用对象序列化方法', () => {
    const { logger, records, output } = captureLogs();
    const unsafeValue = {
      token: '禁止输出的标识凭证',
      toJSON(): never {
        throw new Error('不得序列化对象');
      },
      toString(): never {
        throw new Error('不得转换对象');
      },
    };
    logger.warn({
      ...Object.fromEntries(Object.keys(correlationIds).map(key => [key, unsafeValue])),
      event: unsafeValue,
      status: unsafeValue,
      errorType: unsafeValue,
      durationMs: unsafeValue,
    } as unknown as LogFields);

    expect(records()).toEqual([{ level: 40, time: expect.any(Number) }]);
    expect(output()).not.toContain('禁止输出');
  });

  it('非枚举文本不能冒充事件、状态和错误分类，非法耗时不输出', () => {
    const { logger, records } = captureLogs();
    for (const durationMs of [-1, Number.NaN, Number.POSITIVE_INFINITY, '12']) {
      logger.info({
        event: '禁止输出的事件正文',
        status: '禁止输出的状态正文',
        errorType: '禁止输出的异常正文',
        durationMs,
      } as unknown as LogFields);
    }
    expect(records()).toEqual(
      Array.from({ length: 4 }, () => ({ level: 30, time: expect.any(Number) }))
    );
  });
});

describe('T17 稳定错误说明', () => {
  it('九类业务错误及内部错误均有独立固定中文说明并保留内存原因', () => {
    const messages = new Set<string>();
    for (const type of errorTypes) {
      const cause = new Error(`禁止输出-${type}`);
      const error = new AppError(type, { cause });
      const message = getFailureMessage(type);
      expect(message).toMatch(/[\u4e00-\u9fff]/u);
      expect(message).not.toContain('禁止输出');
      expect(error.message).toBe(message);
      expect(error.cause).toBe(cause);
      expect(getErrorType(error)).toBe(type);
      expect(new AppError(type).message).toBe(message);
      messages.add(message);
    }
    expect(messages.size).toBe(errorTypes.length);
  });

  it('发送结果不明保留不确定性且不宣称失败或建议自动重发', () => {
    const message = getFailureMessage('send_unknown');
    expect(message).toMatch(/不明|无法确认|尚未确认/u);
    expect(message).not.toMatch(/失败|自动重发|请重试|请重新发送/u);
  });

  it('识别标准取消和超时名称，不读取异常消息进行猜测', () => {
    expect(getErrorType(new DOMException('禁止输出的取消原因', 'AbortError'))).toBe('cancelled');
    expect(getErrorType(new DOMException('禁止输出的超时原因', 'TimeoutError'))).toBe('timeout');
    const timeout = new Error('禁止输出的底层原因');
    timeout.name = 'TimeoutError';
    expect(getErrorType(timeout, 'storage')).toBe('timeout');
    expect(getErrorType(new Error('timeout postgres driver configuration'))).toBe('internal');
    expect(getErrorType(new Error('timeout'), 'storage')).toBe('storage');
    expect(getErrorType(null)).toBe('internal');
    expect(getErrorType({ message: 'TimeoutError', type: 'storage' })).toBe('internal');
  });

  it('显式应用分类优先于错误名称、内存原因和调用方后备分类', () => {
    const error = new AppError('send_unknown', {
      cause: new DOMException('禁止输出的超时原因', 'TimeoutError'),
    });
    error.name = 'AbortError';
    expect(getErrorType(error, 'driver')).toBe('send_unknown');
    expect(getErrorType(new Error('禁止输出的外层原因', { cause: error }))).toBe('internal');
  });
});
