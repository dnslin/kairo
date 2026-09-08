import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DriverLogEntry } from '../src/index.js';

const require = createRequire(import.meta.url);
const loaderUrl = pathToFileURL(require.resolve('tsx')).href;
const sdkUrl = new URL('../src/index.ts', import.meta.url).href;
const sinkPrefix = '__DRIVER_LOG_SINK__';

// 独立进程同时捕获原始出口与接收函数结果，避免共享 Pino 状态或 mock 掩盖旁路。
function runLoggerScenario(script: string, level = 'trace') {
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      loaderUrl,
      '--input-type=module',
      '--eval',
      `import { logger, createChildLogger, setDriverLogSink } from ${JSON.stringify(sdkUrl)};
       const entries = [];
       ${script}
       logger.flush();
       process.stdout.write(${JSON.stringify(sinkPrefix)} + JSON.stringify(entries) + '\\n');`,
    ],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: level },
      encoding: 'utf8',
      timeout: 15_000,
    }
  );

  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe('');
  const lines = result.stdout.trim().split(/\r?\n/);
  const captured = lines.find(line => line.startsWith(sinkPrefix));
  expect(captured).toBeDefined();
  return {
    entries: JSON.parse(captured!.slice(sinkPrefix.length)) as DriverLogEntry[],
    output: lines.filter(line => !line.startsWith(sinkPrefix)),
    stdout: result.stdout,
  };
}

describe('Driver 进程级日志接收函数', () => {
  it('接管已创建子日志的所有级别，丢弃深层敏感字段、原始异常与自由文本且没有旁路', () => {
    const result = runLoggerScenario(`
      const child = createChildLogger('敏感模块名称');
      const secret = '正文令牌文件地址私密标记';
      const nested = { payload: { sender: { content: secret } } };
      const forbidden = { toJSON() { throw new Error('不应执行 toJSON'); } };
      const fields = {
        event: secret,
        messageId: 'message-1',
        sessionId: 'session-1',
        employeeId: 'employee-1',
        startupGenerationId: 'generation-1',
        durationMs: 12,
        err: new Error(secret, { cause: new Error(secret) }),
        error: new Error(secret),
        cause: nested,
        url: secret,
        payload: nested,
        sender: nested,
        content: secret,
        toJSON: forbidden.toJSON,
      };
      setDriverLogSink(entry => entries.push(entry));
      for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
        child[level](fields, secret + ' %j', forbidden);
      }
      logger.error(new Error(secret, { cause: new Error(secret) }));
      logger.info(secret + ' send_unknown 发送失败');
    `);

    expect(result.entries).toEqual([
      ...(['info', 'info', 'info', 'warn', 'error', 'error'] as const).map(level => ({
        level,
        event: level === 'info' ? 'Driver运行状态' : 'Driver运行异常',
        messageId: 'message-1',
        sessionId: 'session-1',
        employeeId: 'employee-1',
        runId: 'generation-1',
        durationMs: 12,
        ...(level === 'info' ? {} : { errorType: 'driver' }),
      })),
      { level: 'error', event: 'Driver运行异常', errorType: 'driver' },
      { level: 'info', event: 'Driver运行状态' },
    ]);
    expect(result.output).toEqual([]);
    expect(result.stdout).not.toContain('私密标记');
    expect(result.stdout).not.toContain('敏感模块名称');
  });

  it('保留显式事件、接收状态与关联标识，发送未知不变为失败也不从正文猜测错误类型', () => {
    const result = runLoggerScenario(`
      setDriverLogSink(entry => entries.push(entry));
      logger.info({ event: 'Driver连接状态', status: 'up', runId: 'run-1', startupGenerationId: '旧标识' });
      logger.warn({ event: 'Driver连接状态', status: 'down', startupGenerationId: 'run-2' });
      logger.debug({ event: 'Driver运行状态', status: 'received', messageId: 'inbound-1' });
      logger.info({ event: 'Driver发送结果', status: 'delivered', messageId: 'outbound-1' });
      logger.warn({ event: 'Driver发送结果', status: 'unknown', errorType: 'send_unknown' });
      logger.error({ event: 'Driver发送结果', status: 'unknown' }, 'send_unknown 发送结果未知');
      logger.error({ event: 'Driver运行异常', errorType: 'driver' });
      logger.error({ event: 'Driver发送结果', status: 'failed', errorType: '原始异常名称' });
    `);

    expect(result.entries).toEqual([
      { level: 'info', event: 'Driver连接状态', status: 'up', runId: 'run-1' },
      {
        level: 'warn',
        event: 'Driver连接状态',
        status: 'down',
        runId: 'run-2',
        errorType: 'driver',
      },
      { level: 'info', event: 'Driver运行状态', status: 'received', messageId: 'inbound-1' },
      { level: 'info', event: 'Driver发送结果', status: 'delivered', messageId: 'outbound-1' },
      { level: 'warn', event: 'Driver发送结果', status: 'unknown', errorType: 'send_unknown' },
      { level: 'error', event: 'Driver发送结果', status: 'unknown', errorType: 'driver' },
      { level: 'error', event: 'Driver运行异常', errorType: 'driver' },
      { level: 'error', event: 'Driver发送结果', status: 'failed', errorType: 'driver' },
    ]);
    expect(result.output).toEqual([]);
  });

  it('仅接受白名单字段的标量值，不执行对象的序列化方法', () => {
    const result = runLoggerScenario(`
      setDriverLogSink(entry => entries.push(entry));
      const forbidden = { toJSON() { throw new Error('不能序列化输入对象'); } };
      logger.info({
        event: forbidden,
        messageId: forbidden,
        sessionId: ['敏感会话'],
        employeeId: 42,
        runId: forbidden,
        startupGenerationId: forbidden,
        durationMs: Infinity,
        status: forbidden,
        errorType: forbidden,
        payload: forbidden,
      }, forbidden);
      logger.warn({ event: '任意正文', durationMs: NaN, status: '任意状态', errorType: '任意错误' });
    `);

    expect(result.entries).toEqual([
      { level: 'info', event: 'Driver运行状态' },
      { level: 'warn', event: 'Driver运行异常', errorType: 'driver' },
    ]);
    expect(result.output).toEqual([]);
  });

  it('未安装与重置后恢复同一独立出口，安装期间不重复输出且三阶段均无敏感原文', () => {
    const result = runLoggerScenario(`
      const child = createChildLogger('独立日志敏感模块');
      const forbidden = { toJSON() { throw new Error('不应执行独立出口序列化'); } };
      child.info({ event: 'Driver连接状态', status: 'up', payload: forbidden }, '敏感自由文本');
      setDriverLogSink(entry => entries.push(entry));
      child.warn({ event: 'Driver发送结果', status: 'unknown', errorType: 'send_unknown' }, '敏感自由文本');
      setDriverLogSink(undefined);
      child.error({ event: 'Driver连接状态', status: 'down', err: new Error('敏感异常原文'), toJSON: forbidden.toJSON });
    `);

    expect(result.entries).toEqual([
      { level: 'warn', event: 'Driver发送结果', status: 'unknown', errorType: 'send_unknown' },
    ]);
    expect(result.output.map(line => JSON.parse(line) as Record<string, unknown>)).toEqual([
      { level: 30, time: expect.any(Number), event: 'Driver连接状态', status: 'up' },
      {
        level: 50,
        time: expect.any(Number),
        event: 'Driver连接状态',
        status: 'down',
        errorType: 'driver',
      },
    ]);
    expect(result.stdout).not.toContain('敏感');
  });

  it('接收函数仍遵守进程 LOG_LEVEL 过滤而非重新放开低级别日志', () => {
    const result = runLoggerScenario(
      `
      const child = createChildLogger('级别过滤');
      setDriverLogSink(entry => entries.push(entry));
      child.trace('禁止输出');
      child.debug('禁止输出');
      child.info('禁止输出');
      child.warn({ event: 'Driver运行异常' });
      child.error({ event: 'Driver运行异常' });
    `,
      'warn'
    );

    expect(result.entries).toEqual([
      { level: 'warn', event: 'Driver运行异常', errorType: 'driver' },
      { level: 'error', event: 'Driver运行异常', errorType: 'driver' },
    ]);
    expect(result.output).toEqual([]);
  });
});
